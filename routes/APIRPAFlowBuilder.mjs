import { getFlowBuilderSessionManager } from "../rpaflows/FlowBuilderSessionManager.mjs";
import pathLib from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import { createFlowLogger } from "../rpaflows/FlowLogger.mjs";
import {
	getDefaultBuilderFlowsDir,
	listSavedBuilderFlows,
	loadSavedBuilderFlowFromPath,
	saveBuilderFlowToFile,
	runBuilderStepOnce,
} from "../rpaflows/FlowBuilderCore.mjs";
import { resolveSelectorByAI, runAIAction } from "../rpaflows/FlowAIResolver.mjs";
import { runFlowAgent } from "../rpaflows/flow-agent/index.mjs";
import rpaKindSpec from "../agentspec/kinds/rpa.mjs";
import { execRunJsAction, parseFlowVal } from "../rpaflows/FlowExpr.mjs";
import { runFlow } from "../rpaflows/FlowRunner.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
const PROJECT_ROOT = pathLib.resolve(__dirname, "..");
const BUILDER_PAGE_PATH = pathLib.join(PROJECT_ROOT, "public", "rpaflows", "builder.html");
const BUILDER_LOG_DIR = process.env.FLOW_LOG_DIR || pathLib.join(PROJECT_ROOT, "rpaflows", "flow-logs");
const BUILDER_FLOWS_DIR = getDefaultBuilderFlowsDir();
const AGENT_KIND_DIR = pathLib.join(PROJECT_ROOT, "agentspec", "kinds");
const BUILDER_ROUTES_BUILD_TAG = "builder-routes-2026-03-24-publish-tab-v1";
const kindSpecCache = new Map();
const flowRunStateBySession = new Map();

function nowIso() {
	return new Date().toISOString();
}

function newFlowRunId() {
	const rnd = Math.random().toString(36).slice(2, 8);
	return `fr_${Date.now().toString(36)}_${rnd}`;
}

function cloneJson(v, fallback = null) {
	try { return JSON.parse(JSON.stringify(v)); } catch (_) { return fallback; }
}

function normalizeFlowRunStatus(status) {
	const s = asText(status || "failed").toLowerCase();
	if (s === "running" || s === "done" || s === "failed" || s === "timeout" || s === "skipped") return s;
	return "failed";
}

function mergeAiUsage(stats, data) {
	const ai = stats && typeof stats === "object" ? stats : {};
	const src = data && typeof data === "object" ? data : {};
	const usage = (src.usage && typeof src.usage === "object")
		? src.usage
		: ((src.tokenUsage && typeof src.tokenUsage === "object") ? src.tokenUsage : null);
	if (usage) {
		const prompt = Number(usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? usage.inputTokens ?? 0);
		const completion = Number(usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? usage.outputTokens ?? 0);
		const total = Number(usage.total_tokens ?? usage.totalTokens ?? (prompt + completion));
		if (Number.isFinite(prompt) && prompt > 0) ai.promptTokens = Number(ai.promptTokens || 0) + prompt;
		if (Number.isFinite(completion) && completion > 0) ai.completionTokens = Number(ai.completionTokens || 0) + completion;
		if (Number.isFinite(total) && total > 0) ai.totalTokens = Number(ai.totalTokens || 0) + total;
	}
	const cost = Number(src.costUsd ?? src.costUSD ?? src.cost ?? NaN);
	if (Number.isFinite(cost) && cost > 0) {
		ai.costUsd = Number(ai.costUsd || 0) + cost;
	}
	return ai;
}

function onFlowRunLog(state, level, event, data = {}) {
	if (!state || typeof state !== "object") return;
	const ev = asText(event || "");
	const ts = Date.now();
	state.updatedAt = ts;
	state.updatedAtIso = nowIso();
	if (ev === "step.start") {
		state.currentStepId = asText(data.stepId || "");
		state.currentActionType = asText(data.actionType || "");
		state.currentStepStartedAt = ts;
		return;
	}
	if (ev === "step.end") {
		const rec = {
			stepId: asText(data.stepId || state.currentStepId || ""),
			actionType: asText(data.actionType || state.currentActionType || ""),
			status: normalizeFlowRunStatus(data.status || "failed"),
			reason: asText(data.reason || ""),
			startedAt: Number(state.currentStepStartedAt || 0),
			endedAt: ts,
			elapsedMs: Number(state.currentStepStartedAt || 0) > 0 ? Math.max(0, ts - Number(state.currentStepStartedAt || 0)) : null,
		};
		state.steps.push(rec);
		state.currentStepId = "";
		state.currentActionType = "";
		state.currentStepStartedAt = 0;
		return;
	}
	if (ev === "run_ai.start") {
		state.ai.calls = Number(state.ai.calls || 0) + 1;
		return;
	}
	if (ev === "run_ai.done" || ev === "run_ai.failed" || ev === "run_ai.invalid_envelope") {
		state.ai = mergeAiUsage(state.ai, data);
		return;
	}
	if (ev === "query.cache.hit" || ev === "run_ai.cache.hit") {
		state.queryCache.hits = Number(state.queryCache.hits || 0) + 1;
		state.queryCache.events.push({
			ts: nowIso(),
			type: "hit",
			event: ev,
			key: asText(data.cacheKey || data.key || ""),
			store: asText(data.store || data.cacheStore || ""),
			reason: "",
		});
		return;
	}
	if (ev === "query.cache.miss" || ev === "run_ai.cache.miss") {
		state.queryCache.misses = Number(state.queryCache.misses || 0) + 1;
		state.queryCache.events.push({
			ts: nowIso(),
			type: "miss",
			event: ev,
			key: asText(data.cacheKey || data.key || ""),
			store: asText(data.store || data.cacheStore || ""),
			reason: asText(data.reason || ""),
		});
	}
}

function buildFlowRunSummary(state) {
	const startedAt = Number(state?.startedAt || 0);
	const endedAt = Number(state?.endedAt || Date.now());
	const elapsedMs = Math.max(0, endedAt - (startedAt || endedAt));
	const result = state?.result && typeof state.result === "object" ? state.result : {};
	const status = normalizeFlowRunStatus(result.status || state?.status || "failed");
	const ai = state?.ai && typeof state.ai === "object" ? state.ai : {};
	const queryCache = state?.queryCache && typeof state.queryCache === "object" ? state.queryCache : { hits: 0, misses: 0, events: [] };
	return {
		ok: status === "done",
		status,
		elapsedMs,
		startedAt: state?.startedAtIso || "",
		endedAt: state?.endedAtIso || nowIso(),
		runId: asText(state?.runId || ""),
		reason: asText(result.reason || state?.error || ""),
		value: result.value,
		steps: Array.isArray(state?.steps) ? state.steps : [],
		queryCache: {
			hits: Number(queryCache.hits || 0),
			misses: Number(queryCache.misses || 0),
			events: Array.isArray(queryCache.events) ? queryCache.events.slice(-120) : [],
		},
		ai: {
			calls: Number(ai.calls || 0),
			promptTokens: Number(ai.promptTokens || 0),
			completionTokens: Number(ai.completionTokens || 0),
			totalTokens: Number(ai.totalTokens || 0),
			costUsd: Number(ai.costUsd || 0),
		},
		runMeta: cloneJson(result.meta || null, null),
	};
}

let builderLoggerPromise = null;
async function getBuilderLogger() {
	if (!builderLoggerPromise) {
		builderLoggerPromise = createFlowLogger({
			logDir: BUILDER_LOG_DIR,
			flowId: "builder_api",
			echoConsole: false,
			maxInMemory: 2000,
		});
		try {
			const logger = await builderLoggerPromise;
			console.log(`[RPAFLOWS][builder] log file: ${logger.filePath}`);
		} catch (_) {
		}
	}
	return builderLoggerPromise;
}

async function logBuilder(level, event, data = {}) {
	try {
		const logger = await getBuilderLogger();
		const fn = logger && typeof logger[level] === "function" ? logger[level] : logger?.info;
		if (typeof fn === "function") await fn(event, data);
	} catch (_) {
	}
}

function asText(v) {
	return String(v == null ? "" : v).trim();
}

function truncateText(text, n = 420) {
	const s = asText(text || "");
	if (s.length <= n) return s;
	return `${s.slice(0, Math.max(0, n - 18))} ...(truncated)`;
}

function shortList(arr, n = 8) {
	return (Array.isArray(arr) ? arr : []).map((x) => asText(x)).filter(Boolean).slice(0, Math.max(1, n));
}

function buildFlowAgentErrorReason(ret, fallback = "flow agent failed") {
	const base = asText(ret?.reason || fallback);
	const raw = (ret && typeof ret === "object" && ret.raw && typeof ret.raw === "object") ? ret.raw : null;
	const stderr = asText(raw?.stderr || "");
	const stdout = asText(raw?.stdout || "");
	if (stderr) return `${base}; stderr=${truncateText(stderr, 320)}`;
	if (stdout && base.includes("non-json")) return `${base}; stdout=${truncateText(stdout, 320)}`;
	return base;
}

function buildFlowAgentTraceFromRet(ret, hint = {}) {
	const trace = {
		engine: asText(ret?.engine || hint.engine || ""),
		mode: asText(ret?.mode || hint.mode || ""),
		ok: !!ret?.ok,
		reason: asText(ret?.reason || ""),
	};
	const errors = shortList(ret?.errors, 10);
	if (errors.length) trace.errors = errors;
	const raw = (ret && typeof ret === "object" && ret.raw && typeof ret.raw === "object") ? ret.raw : null;
	if (raw) {
		trace.raw = {
			reason: asText(raw.reason || ""),
			code: Number.isFinite(Number(raw.code)) ? Number(raw.code) : null,
			stderrPreview: asText(raw.stderr || ""),
			stdoutPreview: asText(raw.stdout || ""),
		};
	}
	const meta = (ret && typeof ret === "object" && ret.meta && typeof ret.meta === "object") ? ret.meta : null;
	if (meta) {
		trace.meta = {
			repairs: Number(meta.repairs || 0),
			regenerates: Number(meta.regenerates || 0),
			fallbackRepair: meta.fallbackRepair === true,
			originEngine: asText(meta.originEngine || ""),
			repairEngine: asText(meta.repairEngine || ""),
		};
		const cli = (meta.cli && typeof meta.cli === "object") ? meta.cli : null;
		if (cli) {
			trace.cli = {
				command: asText(cli.command || ""),
				code: Number.isFinite(Number(cli.code)) ? Number(cli.code) : null,
				sessionId: asText(cli.sessionId || ""),
				payloadPreview: asText(cli.payloadPreview || ""),
				stdoutPreview: asText(cli.stdoutPreview || ""),
				stderrPreview: asText(cli.stderrPreview || ""),
			};
		}
		const cliAttempts = Array.isArray(meta.cliAttempts) ? meta.cliAttempts : [];
		if (cliAttempts.length) {
			trace.cliAttempts = cliAttempts.slice(0, 6).map((x) => ({
				round: Number(x?.round || 0),
				ok: x?.ok === true,
				code: Number.isFinite(Number(x?.code)) ? Number(x.code) : null,
				sessionId: asText(x?.sessionId || ""),
				reason: asText(x?.reason || ""),
			}));
		}
		if (asText(meta.codexThreadSessionId || "")) trace.codexThreadSessionId = asText(meta.codexThreadSessionId || "");
		if (Number.isFinite(Number(meta.codexValidationRounds))) trace.codexValidationRounds = Number(meta.codexValidationRounds);
	}
	return trace;
}

function stableSortValue(input) {
	if (Array.isArray(input)) return input.map((x) => stableSortValue(x));
	if (input && typeof input === "object") {
		const out = {};
		for (const k of Object.keys(input).sort()) out[k] = stableSortValue(input[k]);
		return out;
	}
	return input;
}

function stableJson(input) {
	try { return JSON.stringify(stableSortValue(input)); } catch (_) { return ""; }
}

function extractFlowFromDocument(doc) {
	if (doc && typeof doc === "object" && doc.flow && typeof doc.flow === "object") return doc.flow;
	return (doc && typeof doc === "object") ? doc : null;
}

function getStepById(flow, stepId) {
	const sid = asText(stepId);
	if (!sid) return null;
	const steps = Array.isArray(flow?.steps) ? flow.steps : [];
	for (const s of steps) {
		if (asText(s?.id) === sid) return s;
	}
	return null;
}

function deepCloneJson(v, fallback = null) {
	try { return JSON.parse(JSON.stringify(v)); } catch (_) { return fallback; }
}

function rewriteStepLinksInObject(node, fromId, toId) {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const it of node) rewriteStepLinksInObject(it, fromId, toId);
		return;
	}
	for (const k of Object.keys(node)) {
		const v = node[k];
		if ((k === "done" || k === "failed" || k === "default" || k === "to") && asText(v) === fromId) {
			node[k] = toId;
			continue;
		}
		rewriteStepLinksInObject(v, fromId, toId);
	}
}

function applyStepIdRenameInFlow(flow, fromId, toId) {
	if (!flow || typeof flow !== "object") return flow;
	const from = asText(fromId);
	const to = asText(toId);
	if (!from || !to || from === to) return flow;
	if (asText(flow.start) === from) flow.start = to;
	const steps = Array.isArray(flow.steps) ? flow.steps : [];
	for (const step of steps) {
		if (!step || typeof step !== "object") continue;
		if (asText(step.id) === from) step.id = to;
		rewriteStepLinksInObject(step.next, from, to);
		const actionType = asText(step?.action?.type || "").toLowerCase();
		if (actionType === "branch") {
			rewriteStepLinksInObject(step.action, from, to);
		}
	}
	return flow;
}

function getStepReviseActionGuidance(targetType) {
	const t = asText(targetType).toLowerCase();
	const full = {
		goto: "goto: 必须是 {type:'goto', url:string[, newPage:boolean]}。url 建议绝对 https URL。不要改成其它动作类型。",
		closePage: "closePage: 常用键 {target,contextId,matchUrl,ifLast,activateAfterClose,postWaitMs}。target 仅 active|flow|contextId|urlMatch；contextId/urlMatch 按 target 填写。",
		click: "click: 常用键 {query,by,expectInputFocus,timeoutMs}。若 by 存在必须以 css:/xpath: 开头。query 与 by 并存时要确保一致指向。",
		hover: "hover: 常用键 {query,by,timeoutMs}。by 规则同 click。",
		input: "input: 常用键 {query/by,text,pressEnter,timeoutMs,postWaitMs}。若 pressEnter=true，postWaitMs 建议 1000~3000。",
		press_key: "press_key: 常用键 {key,modifiers,times,timeoutMs}。key 需可执行（如 Enter/Escape）。",
		wait: "wait: 常用键 {timeoutMs[,query/by]}。query/by 用于等待某元素出现。",
		scroll: "scroll: 常用键 {deltaX,deltaY,behavior,timeoutMs}。",
		invoke: "invoke: 优先使用 action.find(kind/must/prefer/filter/rank) + args(点号键)，避免 target-only。不要把 cap/result 键塞进 args。",
		run_js: "run_js: code 必须是单个函数表达式字符串，不要 IIFE；query/args/scope/cache 按需使用。",
		run_ai: "run_ai: 常用键 {prompt,input,schema,model,page}，page 仅在需要注入页面材料时提供。",
		branch: "branch: 必须包含 default 与 cases；cases 为 [{when,to}]。不要改动为其它动作类型。",
		ask_assist: "ask_assist: 用于人工兜底，常用 text/reason。",
		done: "done: 终止成功，建议 conclusion 返回结构化对象。",
		abort: "abort: 终止失败，建议给出清晰 reason。",
	};
	const briefList = Object.entries(full)
		.filter(([k]) => k !== t)
		.map(([k, v]) => `- ${k}: ${v.split("。")[0]}。`)
		.join("\n");
	return {
		target: full[t] || `${t}: 仅修改该类型内部参数，保持 type 不变。`,
		others: briefList,
	};
}

function buildStepReviseContextText({ flow, targetStep, extraContext = "" }) {
	const actionType = asText(targetStep?.action?.type || "");
	const g = getStepReviseActionGuidance(actionType);
	const flowSummary = {
		id: asText(flow?.id || ""),
		start: asText(flow?.start || ""),
		args: flow?.args && typeof flow.args === "object" ? flow.args : {},
		vars: flow?.vars && typeof flow.vars === "object" ? flow.vars : {},
		stepCount: Array.isArray(flow?.steps) ? flow.steps.length : 0,
	};
	return [
		"[STEP-REVISE MODE]",
		`目标步骤: ${asText(targetStep?.id || "")}`,
		`硬约束: 只能修改该步骤，action.type 必须保持为 "${actionType}"，禁止新增/删除步骤，禁止修改其他步骤。`,
		"step.id 默认保持不变；若确有必要可仅重命名当前步骤，但新 id 必须唯一且可路由。",
		"若无法满足，返回最小修改方案，但仍必须保持 type 不变。",
		"",
		`当前 action.type 详细说明:\n${g.target}`,
		"",
		`其它 action.type 简要说明:\n${g.others}`,
		"",
		"当前目标步骤(JSON):",
		JSON.stringify(targetStep || {}, null, 2),
		"",
		"当前完整 Flow 摘要（含 args/vars）:",
		JSON.stringify(flowSummary, null, 2),
		"",
		"当前完整 Flow JSON:",
		JSON.stringify(flow || {}, null, 2),
		"",
		String(extraContext || "").trim(),
	].filter(Boolean).join("\n");
}

function buildStepOnlyRevisePrompt({ stepId, actionType, currentStep, userInstruction, contextText = "" }) {
	return [
		"You are revising ONE flow step only.",
		"Return strict JSON only (no markdown, no explanation).",
		"Output schema: {\"status\":\"ok\",\"result\":{\"step\":{...}}} OR {\"status\":\"error\",\"reason\":\"...\"}",
		`Target step id: ${stepId}`,
		`Hard constraints: only revise this step; action.type must remain \"${actionType}\"; keep id unchanged unless user explicitly asks rename; do not output full flow.`,
		"",
		"Current step JSON:",
		JSON.stringify(currentStep || {}, null, 2),
		"",
		`User instruction: ${asText(userInstruction)}`,
		"",
		`Extra context: ${asText(contextText || "")}`,
	].join("\n");
}

async function runStepOnlyReviseByAI({ stepId, actionType, currentStep, userInstruction, contextText = "", model = "advanced", timeoutMs = 600000, logger = null }) {
	const prompt = buildStepOnlyRevisePrompt({ stepId, actionType, currentStep, userInstruction, contextText });
	const ai = await runAIAction({
		action: { model, prompt, cache: false, timeoutMs: Number(timeoutMs || 600000) },
		inputValue: {
			stepId,
			actionType,
			currentStep,
			userInstruction: asText(userInstruction),
			contextText: asText(contextText || ""),
		},
		webRpa: null,
		page: null,
		session: null,
		logger,
	});
	if (!ai?.ok) return { ok: false, reason: asText(ai?.reason || "step-only revise ai failed") };
	const env = (ai?.envelope && typeof ai.envelope === "object") ? ai.envelope : {};
	if (String(env.status || "").toLowerCase() !== "ok") {
		return { ok: false, reason: asText(env.reason || "step-only revise ai envelope error") };
	}
	const out = env.result;
	const step = (out && typeof out === "object" && out.step && typeof out.step === "object") ? out.step : out;
	if (!step || typeof step !== "object") return { ok: false, reason: "step-only revise ai returned invalid step" };
	return { ok: true, step };
}

function normalizeFlowAgentEngine(rawEngine) {
	const s = asText(rawEngine || "default").toLowerCase();
	if (s === "codex") return "codex";
	if (s === "claude_code" || s === "claude-code" || s === "cc") return "claude_code";
	return "default";
}

function extractCommandBin(rawCommand, fallbackBin = "") {
	const raw = asText(rawCommand || "");
	if (!raw) return asText(fallbackBin || "");
	const first = raw.split(/\s+/).filter(Boolean)[0] || "";
	return first.replace(/^['"]|['"]$/g, "");
}

function isCommandAvailable(rawCommand, fallbackBin = "") {
	const cmdBin = extractCommandBin(rawCommand, fallbackBin);
	if (!cmdBin) return false;
	if (cmdBin.includes(pathLib.sep)) {
		try {
			fs.accessSync(cmdBin, fs.constants.X_OK);
			return true;
		} catch (_) {
			return false;
		}
	}
	try {
		const ret = spawnSync("which", [cmdBin], { stdio: "ignore" });
		return ret && ret.status === 0;
	} catch (_) {
		return false;
	}
}

function detectFlowAgentEngines() {
	const codexCmdRaw = asText(process.env.FLOW_AGENT_CODEX_CMD || "");
	const codexCmd = codexCmdRaw || "codex";
	const codexAvailable = isCommandAvailable(codexCmd, "codex");
	const ccCmdRaw = asText(process.env.FLOW_AGENT_CC_CMD || "");
	const ccCmd = ccCmdRaw || "claude";
	const ccAvailable = isCommandAvailable(ccCmd, "claude");
	return {
		default: {
			key: "default",
			label: "直接AI（内置）",
			available: true,
			reason: "",
			command: "",
		},
		codex: {
			key: "codex",
			label: "Codex",
			available: codexAvailable,
			reason: codexAvailable ? "" : "未检测到 codex 命令（可设置 FLOW_AGENT_CODEX_CMD）",
			command: codexCmd,
		},
		claude_code: {
			key: "claude_code",
			label: "Claude Code",
			available: ccAvailable,
			reason: ccAvailable ? "" : "未检测到 claude 命令（可设置 FLOW_AGENT_CC_CMD）",
			command: ccCmd,
		},
	};
}

function toObject(v, fallback = {}) {
	if (v && typeof v === "object" && !Array.isArray(v)) return v;
	if (typeof v === "string" && v.trim()) {
		try {
			const obj = JSON.parse(v);
			if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
		} catch (_) {}
	}
	return fallback;
}

function fail(res, status, reason) {
	res.status(status).json({ ok: false, reason: asText(reason || "request failed") });
}

function toDisplayFlowPath(inPath) {
	const abs = asText(inPath);
	if (!abs) return "";
	const rel = pathLib.relative(BUILDER_FLOWS_DIR, abs);
	if (!rel) return "";
	if (rel.startsWith("..") || pathLib.isAbsolute(rel)) return abs;
	return rel.split(pathLib.sep).join("/");
}

function getMgr() {
	return getFlowBuilderSessionManager();
}

function hashSHA256Hex(text) {
	return createHash("sha256").update(String(text == null ? "" : text)).digest("hex");
}

async function buildServerFlowVersionInfo(flowId, sourcePath = "") {
	const id = asText(flowId);
	if (!id) throw new Error("flowId is required");
	const rows = await listSavedBuilderFlows();
	const matched = [];
	for (const one of (Array.isArray(rows) ? rows : [])) {
		let flow = null;
		try {
			flow = await loadSavedBuilderFlowFromPath(one.path);
		} catch (_) {
			flow = null;
		}
		if (!flow || asText(flow.id) !== id) continue;
		let mtimeMs = 0;
		try {
			const st = await fs.promises.stat(one.path);
			mtimeMs = Number(st?.mtimeMs || 0);
		} catch (_) {
		}
		const version = Number(flow?.version || 0);
		const digest = hashSHA256Hex(stableJson(flow));
		matched.push({
			path: asText(one.path),
			version: Number.isFinite(version) ? version : 0,
			mtimeMs,
			digest,
		});
	}
	matched.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
	const latest = matched[0] || null;
	const candidatePath = asText(sourcePath || "");
	return {
		flowId: id,
		matchedCount: matched.length,
		currentVersion: latest ? Number(latest.version || 0) : 0,
		nextVersion: (latest ? Number(latest.version || 0) : 0) + 1,
		latestPath: latest ? asText(latest.path) : "",
		latestTime: latest && latest.mtimeMs ? new Date(latest.mtimeMs).toISOString() : "",
		latestDigest: latest ? asText(latest.digest) : "",
		candidatePath: candidatePath || "",
	};
}

function getReqOrigin(req) {
	const xf = asText(req?.headers?.["x-forwarded-proto"] || "");
	const proto = xf ? xf.split(",")[0].trim() : asText(req?.protocol || "http");
	const host = asText(req?.get?.("host") || req?.headers?.host || "");
	return `${proto || "http"}://${host || "127.0.0.1"}`;
}

function resolveWsUrl(req, apiPath = "") {
	const origin = getReqOrigin(req);
	const raw = asText(apiPath || "/ws/");
	try {
		return new URL(raw || "/ws/", origin).toString();
	} catch (_) {
		return new URL("/ws/", origin).toString();
	}
}

async function callTabosWs(req, { msg = "", vo = {}, timeoutMs = 0, apiPath = "" } = {}) {
	const useMsg = asText(msg);
	if (!useMsg) throw new Error("msg is required");
	const payload = { msg: useMsg, vo: toObject(vo, {}), seq: Date.now() };
	const url = resolveWsUrl(req, apiPath);
	const ctrl = new AbortController();
	let timer = null;
	const toMs = Math.max(0, Number(timeoutMs || 0));
	if (toMs > 0) {
		timer = setTimeout(() => {
			try { ctrl.abort(); } catch (_) {}
		}, toMs);
	}
	try {
		const resp = await fetch(url, {
			method: "POST",
			cache: "no-cache",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: ctrl.signal,
		});
		const text = await resp.text();
		let data = {};
		try { data = JSON.parse(text || "{}"); } catch (_) { data = { code: resp.status, info: text || "invalid json response" }; }
		if (!Object.prototype.hasOwnProperty.call(data, "code")) data.code = resp.status;
		return data;
	} catch (err) {
		if (String(err?.name || "") === "AbortError") return { code: 503, info: "Web API call time out." };
		return { code: 0, info: asText(err?.message || err || "network error") };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function ensureSystemAuth(session) {
	if (!session.systemAuth || typeof session.systemAuth !== "object") {
		session.systemAuth = {
			loginDone: false,
			loginVO: null,
			lastAccount: "",
		};
	}
	return session.systemAuth;
}

function getTokenExpireTs(loginVO) {
	const a = Number(loginVO?.tokenExpire || 0);
	const b = Number(loginVO?.tokenExipre || 0);
	return Number.isFinite(a) && a > 0 ? a : (Number.isFinite(b) && b > 0 ? b : 0);
}

function toSystemAuthView(auth) {
	const vo = (auth?.loginVO && typeof auth.loginVO === "object") ? auth.loginVO : null;
	const token = asText(vo?.token || "");
	const tokenPreview = token ? `${token.slice(0, 4)}...${token.slice(-4)}` : "";
	return {
		loginDone: !!auth?.loginDone,
		lastAccount: asText(auth?.lastAccount || ""),
		loginVO: vo ? {
			userId: asText(vo.userId || vo.userid || ""),
			userid: asText(vo.userId || vo.userid || ""),
			email: asText(vo.email || ""),
			name: asText(vo.name || vo.nick || ""),
			apiPath: asText(vo.apiPath || ""),
			token,
			tokenExpire: Number(getTokenExpireTs(vo) || 0),
			tokenExipre: Number(getTokenExpireTs(vo) || 0),
			tokenPreview,
			coins: Number(vo.coins || 0),
			points: Number(vo.points || 0),
		} : null,
	};
}

function normalizeKindName(rawKind) {
	const raw = asText(rawKind).toLowerCase();
	if (!raw) return "rpa";
	if (!/^[a-z0-9_-]+$/.test(raw)) return "rpa";
	return raw;
}

async function loadKindSpec(kindName) {
	const normalized = normalizeKindName(kindName);
	if (normalized === "rpa") {
		return { requestedKind: normalized, resolvedKind: "rpa", source: "agentspec/kinds/rpa.mjs", fallback: false, spec: rpaKindSpec };
	}
	if (kindSpecCache.has(normalized)) return kindSpecCache.get(normalized);
	const relFile = `${normalized}.mjs`;
	const fullPath = pathLib.join(AGENT_KIND_DIR, relFile);
	try {
		const mod = await import(pathToFileURL(fullPath).href);
		const spec = (mod && (mod.default || mod[normalized] || mod.kind)) ? (mod.default || mod[normalized] || mod.kind) : mod?.default;
		const ret = {
			requestedKind: normalized,
			resolvedKind: normalized,
			source: `agentspec/kinds/${relFile}`,
			fallback: false,
			spec: spec && typeof spec === "object" ? spec : {},
		};
		kindSpecCache.set(normalized, ret);
		return ret;
	} catch (_) {
		const ret = {
			requestedKind: normalized,
			resolvedKind: "rpa",
			source: "agentspec/kinds/rpa.mjs",
			fallback: true,
			spec: rpaKindSpec,
		};
		kindSpecCache.set(normalized, ret);
		return ret;
	}
}

function listInvokeFindKeysFromSpec(specPack) {
	const spec = specPack && typeof specPack === "object" ? specPack.spec : null;
	const caps = (spec && typeof spec === "object" && spec.caps && typeof spec.caps === "object")
		? spec.caps
		: {};
	const capKeys = [];
	const argKeys = [];
	const capDefs = {};
	const argDefs = {};
	for (const k of Object.keys(caps)) {
		const key = asText(k);
		if (!key) continue;
		const def = caps[k];
		const kind = asText(def?.kind || "").toLowerCase();
		if (kind === "cap") {
			capKeys.push(key);
			capDefs[key] = {
				desc: asText(def?.desc || ""),
			};
		}
		else if (kind === "arg") {
			argKeys.push(key);
			argDefs[key] = {
				type: asText(def?.type || ""),
				desc: asText(def?.desc || ""),
				values: Array.isArray(def?.values) ? def.values : [],
			};
		}
	}
	capKeys.sort();
	argKeys.sort();
	const items = [];
	for (const key of capKeys) {
		const def = capDefs[key] || {};
		items.push({
			key,
			kind: "cap",
			desc: asText(def.desc || ""),
		});
	}
	for (const key of argKeys) {
		const def = argDefs[key] || {};
		items.push({
			key,
			kind: "arg",
			type: asText(def.type || ""),
			desc: asText(def.desc || ""),
			values: Array.isArray(def.values) ? def.values : [],
		});
	}
	return {
		requestedKind: asText(specPack?.requestedKind || "rpa"),
		kind: asText(specPack?.resolvedKind || "rpa"),
		source: asText(specPack?.source || "agentspec/kinds/rpa.mjs"),
		fallback: specPack?.fallback === true,
		capKeys,
		argKeys,
		capDefs,
		argDefs,
		items,
	};
}

async function getActivePageRuntime(mgr, sessionId, { autoOpenPage = false } = {}) {
	const session = mgr.getSessionRuntime(sessionId);
	if (session.status !== "ready" || !session.webRpa) {
		throw new Error(`session is not ready (status=${session.status})`);
	}
	try {
		await mgr.listContexts(sessionId);
	} catch (_) {
	}
	const webRpa = session.webRpa;
	let page = null;
	if (session.activeContextId) {
		page = webRpa.getPageByContextId(session.activeContextId);
	}
	if (!page) page = webRpa.currentPage || null;
	if (!page && autoOpenPage && session.browser && typeof webRpa.openPage === "function") {
		const opened = await webRpa.openPage(session.browser);
		try { await opened.goto("about:blank"); } catch (_) {}
		webRpa.setCurrentPage(opened);
		session.activeContextId = asText(opened?.context || "");
		page = opened;
		console.log(`[RPAFLOWS][builder] runtime fallback opened page session=${sessionId} context=${session.activeContextId}`);
	}
	if (!page) throw new Error("no active page");
	return {
		webRpa,
		page,
		session: webRpa.session || null,
		activeContextId: asText(page?.context || session.activeContextId || ""),
	};
}

async function readPickedElementDetails(page, pickedHandle) {
	if (!page || !pickedHandle) return null;
	return await page.callFunction(
		function (ret) {
			if (!ret || ret.ok !== true) return null;
			const el = ret.element || null;
			const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
			const attr = (name) => {
				try {
					return el ? clean(el.getAttribute(name) || "") : "";
				} catch (_) {
					return "";
				}
			};
			const text = el ? clean(el.innerText || el.textContent || "").slice(0, 240) : "";
			return {
				ok: true,
				selector: clean(ret.selector || ""),
				text,
				tagName: clean(ret.tagName || ""),
				id: clean(ret.id || ""),
				className: clean(ret.className || ""),
				name: attr("name"),
				role: attr("role"),
				ariaLabel: attr("aria-label"),
				title: attr("title"),
			};
		},
		[pickedHandle],
		{ awaitPromise: true }
	);
}

function buildSelectorAiQuery(details, actionType = "click") {
	const picked = (details && typeof details === "object") ? details : {};
	const textHint = asText(picked.text);
	const action = asText(actionType || "click").toLowerCase();
	return [
		"我已经人工选中了一个网页元素，请给出稳定可用的 selector。",
		"要求：单元素唯一定位优先，避免脆弱的 nth-child 长链。",
		`当前动作类型: ${action}（请在可行时给出与该动作匹配的语义 query，若不确定可留空）`,
		"可在 css: / xpath: 中自行选择最稳健方案。",
		`已选元素信息：tag=${asText(picked.tagName)}, id=${asText(picked.id)}, class=${asText(picked.className)}, name=${asText(picked.name)}, role=${asText(picked.role)}, aria-label=${asText(picked.ariaLabel)}, title=${asText(picked.title)}`,
		`简易 selector: ${asText(picked.selector)}`,
		`元素文本: ${textHint || "(空)"}`,
	].join("\n");
}

function buildPickToken() {
	return `pick_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

async function dismissTipSafe(webRpa, page, tipId) {
	try {
		if (!webRpa || !page || !tipId) return;
		if (typeof webRpa.inPageTipDismiss === "function") {
			await webRpa.inPageTipDismiss(page, String(tipId));
		}
	} catch (_) {
	}
}

async function showTipSafe(webRpa, page, text, tipId = "") {
	try {
		if (!webRpa || !page || typeof webRpa.inPageTip !== "function") return;
		await webRpa.inPageTip(page, String(text || ""), {
			id: tipId || undefined,
			position: "top",
			stack: false,
			timeout: tipId ? 0 : 1800,
			opacity: 0.96,
			persistAcrossNav: !!tipId,
			persistTtlMs: tipId ? 90000 : 0,
			pollMs: 400,
		});
	} catch (_) {
	}
}

async function verifySelectorHitsPicked(page, selector, pickAttrKey, pickToken) {
	const out = await page.callFunction(
		function (rawSelector, attrKey, attrValue) {
			const sel = String(rawSelector || "").trim();
			const key = String(attrKey || "").trim();
			const val = String(attrValue || "").trim();
			if (!sel) return { ok: false, reason: "empty selector", count: 0, hit: false };
			if (!key || !val) return { ok: false, reason: "missing pick marker", count: 0, hit: false };
			const parseSelector = (s) => {
				if (!s) return { mode: "css", expr: "" };
				if (/^css:/i.test(s)) return { mode: "css", expr: s.replace(/^css:/i, "").trim() };
				if (/^xpath:/i.test(s)) return { mode: "xpath", expr: s.replace(/^xpath:/i, "").trim() };
				if (/^(\/\/|\/|\(|\.\/|\.\.\/)/.test(s)) return { mode: "xpath", expr: s };
				return { mode: "css", expr: s };
			};
			const parsed = parseSelector(sel);
			if (!parsed.expr) return { ok: false, reason: "empty selector expr", count: 0, hit: false };
			let list = [];
			try {
				if (parsed.mode === "xpath") {
					const r = document.evaluate(parsed.expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
					for (let i = 0; i < r.snapshotLength; i += 1) {
						const n = r.snapshotItem(i);
						if (n && n.nodeType === 1) list.push(n);
					}
				} else {
					list = Array.from(document.querySelectorAll(parsed.expr));
				}
			} catch (err) {
				return { ok: false, reason: `selector parse failed: ${String(err?.message || err)}`, count: 0, hit: false };
			}
			const count = list.length;
			if (!count) return { ok: false, reason: "selector matched 0 elements", count, hit: false };
			let hit = false;
			for (const el of list) {
				try {
					if (String(el.getAttribute(key) || "") === val) {
						hit = true;
						break;
					}
				} catch (_) {
				}
			}
			if (hit) return { ok: true, reason: "", count, hit: true };
			return { ok: false, reason: `selector matched ${count} elements but not the picked one`, count, hit: false };
		},
		[selector, pickAttrKey, pickToken],
		{ awaitPromise: true }
	);
	return (out && typeof out === "object") ? out : { ok: false, reason: "invalid verify result", count: 0, hit: false };
}

async function countSelectorMatches(page, selector) {
	const out = await page.callFunction(
		function (rawSelector) {
			const sel = String(rawSelector || "").trim();
			if (!sel) return { ok: false, count: 0, reason: "empty selector" };
			const parseSelector = (s) => {
				if (!s) return { mode: "css", expr: "" };
				if (/^css:/i.test(s)) return { mode: "css", expr: s.replace(/^css:/i, "").trim() };
				if (/^xpath:/i.test(s)) return { mode: "xpath", expr: s.replace(/^xpath:/i, "").trim() };
				if (/^(\/\/|\/|\(|\.\/|\.\.\/)/.test(s)) return { mode: "xpath", expr: s };
				return { mode: "css", expr: s };
			};
			const parsed = parseSelector(sel);
			if (!parsed.expr) return { ok: false, count: 0, reason: "empty selector expr" };
			try {
				if (parsed.mode === "xpath") {
					const r = document.evaluate(parsed.expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
					return { ok: true, count: Number(r.snapshotLength || 0), reason: "" };
				}
				const arr = document.querySelectorAll(parsed.expr);
				return { ok: true, count: Number(arr?.length || 0), reason: "" };
			} catch (err) {
				return { ok: false, count: 0, reason: String(err?.message || err || "selector parse failed") };
			}
		},
		[selector],
		{ awaitPromise: true }
	);
	return (out && typeof out === "object") ? out : { ok: false, count: 0, reason: "invalid count result" };
}

async function verifySelectorByWebRpa({ webRpa, page, selector, pickAttrKey, pickToken }) {
	const s = asText(selector);
	if (!s) return { ok: false, reason: "empty selector", count: 0, hit: false };
	let count = 0;
	try {
		if (webRpa && typeof webRpa.inPageShowSelector === "function") {
			count = Number(await webRpa.inPageShowSelector(page, s, { color: "#1890ff", thickness: 2 })) || 0;
		}
	} catch (err) {
		return { ok: false, reason: `show selector failed: ${asText(err?.message || err)}`, count: 0, hit: false };
	}
	let hitRet = { ok: false, reason: "verify failed", count, hit: false };
	try {
		hitRet = await verifySelectorHitsPicked(page, s, pickAttrKey, pickToken);
		hitRet.count = Number(hitRet?.count || count || 0);
	} finally {
		try {
			if (webRpa && typeof webRpa.inPageDismissSelector === "function") {
				await webRpa.inPageDismissSelector(page);
			}
		} catch (_) {
		}
	}
	return hitRet;
}

async function clearPickedMarker(page, pickAttrKey, pickToken) {
	try {
		await page.callFunction(
			function (attrKey, attrValue) {
				const key = String(attrKey || "").trim();
				const val = String(attrValue || "").trim();
				if (!key || !val) return 0;
				const esc = (s) => {
					try { return CSS.escape(s); } catch (_) { return s.replace(/["\\]/g, "\\$&"); }
				};
				const list = Array.from(document.querySelectorAll(`[${esc(key)}="${esc(val)}"]`));
				for (const el of list) {
					try { el.removeAttribute(key); } catch (_) {}
				}
				return list.length;
			},
			[pickAttrKey, pickToken],
			{ awaitPromise: true }
		);
	} catch (_) {
	}
}

async function trySwitchBackToBuilderApp(runtime) {
	try {
		const session = runtime?.session;
		const webRpa = runtime?.webRpa;
		const browser = webRpa?.browser || null;
		const browserId = asText(browser?.browserId || browser?.aaeBrowserId || "");
		if (session && typeof session.callHub === "function" && browserId) {
			await session.callHub("WebDriveBackToApp", { browserId });
		}
	} catch (_) {
	}
}

export default function setupRpaFlowBuilderRoutes(app, router) {
	console.log(`[RPAFLOWS][builder] routes init buildTag=${BUILDER_ROUTES_BUILD_TAG}`);
	void logBuilder("info", "builder.routes.loaded", {
		buildTag: BUILDER_ROUTES_BUILD_TAG,
		page: BUILDER_PAGE_PATH,
		logDir: BUILDER_LOG_DIR,
		flowsDir: BUILDER_FLOWS_DIR,
	});

	router.get("/builder", async (req, res) => {
		res.sendFile(BUILDER_PAGE_PATH);
	});

	router.get("/api/builder/log-meta", async (req, res) => {
		try {
			const logger = await getBuilderLogger();
			res.json({ ok: true, data: { filePath: logger.filePath, runId: logger.runId } });
		} catch (err) {
			fail(res, 500, err?.message || err);
		}
	});

	router.get("/api/builder/invoke-find-keys", async (req, res) => {
		try {
			const kind = asText(req.query?.kind || "rpa");
			const specPack = await loadKindSpec(kind);
			const data = listInvokeFindKeysFromSpec(specPack);
			res.json({ ok: true, data });
		} catch (err) {
			fail(res, 500, err?.message || err);
		}
	});

	router.get("/api/builder/flow-agent/engines", async (req, res) => {
		try {
			const data = detectFlowAgentEngines();
			res.json({ ok: true, data });
		} catch (err) {
			fail(res, 500, err?.message || err);
		}
	});

	router.post("/api/builder/session/start", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const mgr = getMgr();
			const data = await mgr.startSession({
				alias: asText(body.alias),
				launchMode: asText(body.launchMode),
				startUrl: asText(body.startUrl),
			});
			await logBuilder("info", "session.start", {
				sessionId: data?.id || "",
				alias: data?.alias || "",
				launchMode: data?.launchMode || "",
				startUrl: data?.startUrl || "",
				reused: data?.reused === true,
				elapsedMs: Date.now() - t0,
			});
			res.json({ ok: true, data });
		} catch (err) {
			await logBuilder("error", "session.start.error", { reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 400, err?.message || err);
		}
	});

	router.get("/api/builder/session/:id", async (req, res) => {
		try {
			const mgr = getMgr();
			const runtime = mgr.getSessionRuntime(req.params.id);
			const data = mgr.getSession(req.params.id);
			const auth = ensureSystemAuth(runtime);
			data.systemAuth = toSystemAuthView(auth);
			await logBuilder("debug", "session.get", { sessionId: req.params.id, status: data?.status || "" });
			res.json({ ok: true, data });
		} catch (err) {
			await logBuilder("warn", "session.get.error", { sessionId: req.params.id, reason: asText(err?.message || err) });
			fail(res, 404, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/close", async (req, res) => {
		const t0 = Date.now();
		try {
			const mgr = getMgr();
			const data = await mgr.closeSession(req.params.id);
			await logBuilder("info", "session.close", { sessionId: req.params.id, elapsedMs: Date.now() - t0 });
			res.json({ ok: true, data });
		} catch (err) {
			await logBuilder("warn", "session.close.error", { sessionId: req.params.id, reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 404, err?.message || err);
		}
	});

	router.get("/api/builder/session/:id/contexts", async (req, res) => {
		try {
			const mgr = getMgr();
			const data = await mgr.listContexts(req.params.id);
			await logBuilder("debug", "contexts.list", {
				sessionId: req.params.id,
				count: Array.isArray(data?.contexts) ? data.contexts.length : 0,
				activeContextId: data?.activeContextId || "",
			});
			res.json({ ok: true, data });
		} catch (err) {
			await logBuilder("warn", "contexts.list.error", { sessionId: req.params.id, reason: asText(err?.message || err) });
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/contexts/select", async (req, res) => {
		try {
			const body = toObject(req.body, {});
			const mgr = getMgr();
			const data = mgr.selectContext(req.params.id, asText(body.contextId));
			await logBuilder("info", "contexts.select", {
				sessionId: req.params.id,
				contextId: asText(body.contextId),
				activeContextId: data?.activeContextId || "",
			});
			res.json({ ok: true, data });
		} catch (err) {
			await logBuilder("warn", "contexts.select.error", {
				sessionId: req.params.id,
				contextId: asText(req?.body?.contextId),
				reason: asText(err?.message || err),
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/open", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const mgr = getMgr();
			const data = await mgr.openPage(req.params.id, {
				url: asText(body.url),
				setActive: body.setActive !== false,
			});
			await logBuilder("info", "contexts.open", {
				sessionId: req.params.id,
				contextId: data?.contextId || "",
				url: data?.url || "",
				activeContextId: data?.activeContextId || "",
				elapsedMs: Date.now() - t0,
			});
			res.json({ ok: true, data });
		} catch (err) {
			await logBuilder("warn", "contexts.open.error", { sessionId: req.params.id, reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/activate", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		try {
			const body = toObject(req.body, {});
			const contextId = asText(body.contextId || "");
			const mgr = getMgr();
			if (contextId) {
				try {
					mgr.selectContext(sessionId, contextId);
				} catch (_) {
				}
			}
			const runtime = await getActivePageRuntime(mgr, sessionId, { autoOpenPage: true });
			runtime.webRpa.setCurrentPage(runtime.page);
			try {
				await runtime.webRpa.browser?.activate?.();
			} catch (_) {
			}
			try {
				await runtime.page?.bringToFront?.({ focusBrowser: true });
			} catch (_) {
			}
			await logBuilder("info", "session.activate", {
				sessionId,
				contextId: runtime.activeContextId,
				elapsedMs: Date.now() - t0,
			});
			res.json({
				ok: true,
				data: {
					ok: true,
					sessionId,
					contextId: runtime.activeContextId,
				},
			});
		} catch (err) {
			await logBuilder("warn", "session.activate.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.get("/api/builder/session/:id/system/status", async (req, res) => {
		try {
			const mgr = getMgr();
			const runtime = mgr.getSessionRuntime(req.params.id);
			const auth = ensureSystemAuth(runtime);
			res.json({ ok: true, data: toSystemAuthView(auth) });
		} catch (err) {
			await logBuilder("warn", "system.status.error", {
				sessionId: asText(req.params.id),
				reason: asText(err?.message || err),
			});
			fail(res, 404, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/system/login", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		try {
			const body = toObject(req.body, {});
			const mgr = getMgr();
			const runtime = mgr.getSessionRuntime(sessionId);
			const auth = ensureSystemAuth(runtime);

			const email = asText(body.email || "");
			const password = String(body.password == null ? "" : body.password);
			const passwordSHA = asText(body.passwordSHA || "");
			const userId = asText(body.userId || "");
			const token = asText(body.token || "");
			let callVO = null;

			if (email && (password || passwordSHA)) {
				const baseSha = passwordSHA || hashSHA256Hex(password);
				const time = Date.now();
				callVO = {
					email,
					time,
					passwordSHA: hashSHA256Hex(`${time}${baseSha}`),
				};
			} else if (userId && token) {
				callVO = {
					userId,
					token,
					time: Date.now(),
				};
			} else {
				const saved = (auth.loginVO && typeof auth.loginVO === "object") ? auth.loginVO : null;
				if (!saved) throw new Error("请提供 email + password，或 userId + token");
				const exp = getTokenExpireTs(saved);
				if (exp > 0 && Date.now() > exp) {
					auth.loginDone = false;
					auth.loginVO = null;
					throw new Error("保存的登录 token 已过期");
				}
				callVO = {
					userId: asText(saved.userId || saved.userid || ""),
					token: asText(saved.token || ""),
					time: Date.now(),
				};
			}

			const pathRet = await callTabosWs(req, {
				msg: "apiPath",
				vo: {},
				apiPath: asText(body.apiPath || auth?.loginVO?.apiPath || ""),
				timeoutMs: 15000,
			});
			const apiPath = asText(pathRet?.path || "");
			if (Number(pathRet?.code || 0) !== 200 || !apiPath) {
				throw new Error(`获取 apiPath 失败: ${asText(pathRet?.info || pathRet?.code || "unknown")}`);
			}

			const loginRet = await callTabosWs(req, {
				msg: "userLogin",
				vo: callVO,
				apiPath,
				timeoutMs: 30000,
			});
			if (Number(loginRet?.code || 0) !== 200) {
				auth.loginDone = false;
				auth.loginVO = null;
				throw new Error(`登录失败: ${asText(loginRet?.info || loginRet?.code || "unknown")}`);
			}

			auth.loginVO = { ...loginRet, apiPath };
			auth.loginDone = true;
			if (email) auth.lastAccount = email;
			else if (asText(loginRet?.email || "")) auth.lastAccount = asText(loginRet.email);

			await logBuilder("info", "system.login", {
				sessionId,
				userId: asText(loginRet?.userId || loginRet?.userid || ""),
				email: asText(loginRet?.email || ""),
				elapsedMs: Date.now() - t0,
			});
			res.json({ ok: true, data: { ok: true, info: "登录成功", systemAuth: toSystemAuthView(auth) } });
		} catch (err) {
			await logBuilder("warn", "system.login.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/system/check", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		try {
			const body = toObject(req.body, {});
			const checkNT = body.checkNT === true;
			const mgr = getMgr();
			const runtime = mgr.getSessionRuntime(sessionId);
			const auth = ensureSystemAuth(runtime);
			const saved = (auth.loginVO && typeof auth.loginVO === "object") ? auth.loginVO : null;

			if (!saved) {
				auth.loginDone = false;
				res.json({ ok: true, data: { ok: true, loginDone: false, info: "未登录", systemAuth: toSystemAuthView(auth) } });
				return;
			}

			const userId = asText(saved.userId || saved.userid || "");
			const tk = asText(saved.token || "");
			const apiPath = asText(saved.apiPath || "");
			const exp = getTokenExpireTs(saved);
			if (!userId || !tk || !apiPath || (exp > 0 && Date.now() > exp)) {
				auth.loginDone = false;
				auth.loginVO = null;
				res.json({ ok: true, data: { ok: true, loginDone: false, info: "登录已失效", systemAuth: toSystemAuthView(auth) } });
				return;
			}

			let checkRet = null;
			if (checkNT) {
				checkRet = await callTabosWs(req, {
					msg: "userCurrency",
					vo: { userId, token: tk },
					apiPath,
					timeoutMs: 15000,
				});
				if (Number(checkRet?.code || 0) !== 200) {
					if (Number(checkRet?.code || 0) === 403) auth.loginVO = null;
					auth.loginDone = false;
					res.json({
						ok: true,
						data: { ok: true, loginDone: false, info: asText(checkRet?.info || "Offline"), checkRet, systemAuth: toSystemAuthView(auth) },
					});
					return;
				}
				auth.loginVO = { ...auth.loginVO, coins: Number(checkRet?.coins || 0), points: Number(checkRet?.points || 0) };
			}
			auth.loginDone = true;
			await logBuilder("debug", "system.check", { sessionId, checkNT, elapsedMs: Date.now() - t0 });
			res.json({
				ok: true,
				data: { ok: true, loginDone: true, info: "登录有效", checkRet, systemAuth: toSystemAuthView(auth) },
			});
		} catch (err) {
			await logBuilder("warn", "system.check.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/system/logout", async (req, res) => {
		const sessionId = asText(req.params.id);
		try {
			const mgr = getMgr();
			const runtime = mgr.getSessionRuntime(sessionId);
			const auth = ensureSystemAuth(runtime);
			const email = asText(auth?.loginVO?.email || "");
			if (email) auth.lastAccount = email;
			auth.loginDone = false;
			auth.loginVO = null;
			await logBuilder("info", "system.logout", { sessionId });
			res.json({ ok: true, data: { ok: true, info: "已退出登录", systemAuth: toSystemAuthView(auth) } });
		} catch (err) {
			await logBuilder("warn", "system.logout.error", { sessionId, reason: asText(err?.message || err) });
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/system/call", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		try {
			const body = toObject(req.body, {});
			const msg = asText(body.msg || "");
			if (!msg) throw new Error("msg is required");
			const vo = toObject(body.vo, {});
			const timeoutMs = Math.max(0, Math.min(120000, Number(body.timeoutMs || 0)));
			const mgr = getMgr();
			const runtime = mgr.getSessionRuntime(sessionId);
			const auth = ensureSystemAuth(runtime);
			const loginVO = (auth.loginVO && typeof auth.loginVO === "object") ? auth.loginVO : null;
			const apiPath = asText(body.apiPath || loginVO?.apiPath || "");
			if (loginVO) {
				vo.userId = asText(loginVO.userId || loginVO.userid || "");
				vo.token = asText(loginVO.token || "");
			}
			const ret = await callTabosWs(req, { msg, vo, timeoutMs, apiPath });
			if (Number(ret?.code || 0) === 403) {
				auth.loginDone = false;
				auth.loginVO = null;
			}
			await logBuilder("info", "system.call", {
				sessionId,
				msg,
				code: Number(ret?.code || 0),
				elapsedMs: Date.now() - t0,
			});
			res.json({
				ok: true,
				data: {
					ok: true,
					msg,
					response: ret,
					systemAuth: toSystemAuthView(auth),
				},
			});
		} catch (err) {
			await logBuilder("warn", "system.call.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/run-step", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const step = (body.step && typeof body.step === "object" && !Array.isArray(body.step)) ? body.step : null;
			if (!step) throw new Error("step is required");
			if (!asText(step?.id)) throw new Error("step.id is required");
			if (!asText(step?.action?.type)) throw new Error("step.action.type is required");

			const mgr = getMgr();
			const runtime = await getActivePageRuntime(mgr, req.params.id, { autoOpenPage: true });
			const runRet = await runBuilderStepOnce({
				webRpa: runtime.webRpa,
				page: runtime.page,
				session: runtime.session,
				step,
			});
			const elapsedMs = Date.now() - t0;
			console.log(
				`[RPAFLOWS][builder] run-step session=${req.params.id} context=${runtime.activeContextId} ` +
				`step=${asText(step.id)} type=${asText(step?.action?.type)} status=${asText(runRet?.status || "failed")} elapsedMs=${elapsedMs}`
			);
			await logBuilder("info", "step.run", {
				sessionId: req.params.id,
				contextId: runtime.activeContextId,
				stepId: asText(step.id),
				actionType: asText(step?.action?.type),
				status: asText(runRet?.status || "failed"),
				reason: asText(runRet?.reason || ""),
				elapsedMs,
			});
			res.json({ ok: true, data: runRet });
		} catch (err) {
			await logBuilder("error", "step.run.error", { sessionId: req.params.id, reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/run-flow/start", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		try {
			const prev = flowRunStateBySession.get(sessionId);
			if (prev && prev.status === "running") {
				throw new Error(`flow is already running (runId=${asText(prev.runId)})`);
			}
			const body = toObject(req.body, {});
			const flow = (body.flow && typeof body.flow === "object" && !Array.isArray(body.flow)) ? cloneJson(body.flow, null) : null;
			if (!flow) throw new Error("flow is required");
			if (!asText(flow.id || "")) throw new Error("flow.id is required");
			if (!asText(flow.start || "")) throw new Error("flow.start is required");
			if (!Array.isArray(flow.steps) || !flow.steps.length) throw new Error("flow.steps is required");

			const runArgs = (body.args && typeof body.args === "object" && !Array.isArray(body.args)) ? cloneJson(body.args, {}) : {};
			const runOpts = (body.opts && typeof body.opts === "object" && !Array.isArray(body.opts)) ? cloneJson(body.opts, {}) : {};
			const maxSteps = Number.isFinite(Number(body.maxSteps)) ? Math.max(1, Math.min(2000, Number(body.maxSteps))) : 400;

			const mgr = getMgr();
			const runtime = await getActivePageRuntime(mgr, sessionId, { autoOpenPage: true });
			runtime.webRpa.setCurrentPage(runtime.page);
			try { await runtime.webRpa.browser?.activate?.(); } catch (_) {}
			try { await runtime.page?.bringToFront?.({ focusBrowser: true }); } catch (_) {}

			const runId = newFlowRunId();
			const state = {
				runId,
				sessionId,
				status: "running",
				startedAt: Date.now(),
				startedAtIso: nowIso(),
				endedAt: 0,
				endedAtIso: "",
				updatedAt: Date.now(),
				updatedAtIso: nowIso(),
				flowId: asText(flow.id || ""),
				currentStepId: "",
				currentActionType: "",
				currentStepStartedAt: 0,
				steps: [],
				queryCache: { hits: 0, misses: 0, events: [] },
				ai: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 },
				result: null,
				error: "",
			};
			flowRunStateBySession.set(sessionId, state);
			await logBuilder("info", "flow.run.start", {
				sessionId,
				runId,
				flowId: state.flowId,
				contextId: runtime.activeContextId,
				maxSteps,
				elapsedMs: Date.now() - t0,
			});
			console.log(`[RPAFLOWS][builder] run-flow start session=${sessionId} runId=${runId} flowId=${state.flowId} context=${runtime.activeContextId}`);

			void (async () => {
				try {
					const logger = await getBuilderLogger();
					const runLogger = {
						info: async (event, data = {}) => {
							onFlowRunLog(state, "info", event, data);
							await logBuilder("info", `flow.run.${event}`, { sessionId, runId, ...toObject(data, {}) });
							if (logger?.info) await logger.info(`flow.run.${event}`, { sessionId, runId, ...toObject(data, {}) });
						},
						debug: async (event, data = {}) => {
							onFlowRunLog(state, "debug", event, data);
							if (logger?.debug) await logger.debug(`flow.run.${event}`, { sessionId, runId, ...toObject(data, {}) });
						},
						warn: async (event, data = {}) => {
							onFlowRunLog(state, "warn", event, data);
							await logBuilder("warn", `flow.run.${event}`, { sessionId, runId, ...toObject(data, {}) });
							if (logger?.warn) await logger.warn(`flow.run.${event}`, { sessionId, runId, ...toObject(data, {}) });
						},
						error: async (event, data = {}) => {
							onFlowRunLog(state, "error", event, data);
							await logBuilder("error", `flow.run.${event}`, { sessionId, runId, ...toObject(data, {}) });
							if (logger?.error) await logger.error(`flow.run.${event}`, { sessionId, runId, ...toObject(data, {}) });
						},
					};
					const ret = await runFlow({
						flow,
						webRpa: runtime.webRpa,
						page: runtime.page,
						session: runtime.session,
						args: runArgs,
						opts: runOpts,
						maxSteps,
						logger: runLogger,
					});
					state.result = ret;
					state.status = normalizeFlowRunStatus(ret?.status || "failed");
				} catch (err) {
					state.error = asText(err?.message || err);
					state.status = "failed";
					state.result = {
						status: "failed",
						reason: state.error || "run-flow error",
						value: null,
						history: [],
						meta: null,
					};
					await logBuilder("error", "flow.run.crash", { sessionId, runId, reason: state.error });
				} finally {
					state.endedAt = Date.now();
					state.endedAtIso = nowIso();
					state.updatedAt = state.endedAt;
					state.updatedAtIso = state.endedAtIso;
					const summary = buildFlowRunSummary(state);
					await logBuilder(summary.ok ? "info" : "warn", "flow.run.done", {
						sessionId,
						runId,
						status: summary.status,
						ok: summary.ok,
						elapsedMs: summary.elapsedMs,
						stepCount: Array.isArray(summary.steps) ? summary.steps.length : 0,
						cacheHits: summary?.queryCache?.hits || 0,
						cacheMisses: summary?.queryCache?.misses || 0,
						aiCalls: summary?.ai?.calls || 0,
						aiTotalTokens: summary?.ai?.totalTokens || 0,
						aiCostUsd: summary?.ai?.costUsd || 0,
					});
					console.log(`[RPAFLOWS][builder] run-flow done session=${sessionId} runId=${state.runId} status=${summary.status} elapsedMs=${summary.elapsedMs}`);
				}
			})();

			res.json({
				ok: true,
				data: {
					runId,
					status: "running",
					startedAt: state.startedAtIso,
				},
			});
		} catch (err) {
			await logBuilder("error", "flow.run.start.error", { sessionId, reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 400, err?.message || err);
		}
	});

	router.get("/api/builder/session/:id/run-flow/status", async (req, res) => {
		try {
			const sessionId = asText(req.params.id);
			const runId = asText(req.query?.runId || "");
			const state = flowRunStateBySession.get(sessionId);
			if (!state) throw new Error("no flow run state");
			if (runId && runId !== asText(state.runId)) throw new Error(`runId not found: ${runId}`);
			const summary = buildFlowRunSummary(state);
			res.json({
				ok: true,
				data: {
					runId: asText(state.runId),
					status: asText(state.status),
					running: state.status === "running",
					currentStepId: asText(state.currentStepId),
					currentActionType: asText(state.currentActionType),
					startedAt: asText(state.startedAtIso),
					updatedAt: asText(state.updatedAtIso),
					endedAt: asText(state.endedAtIso),
					summary,
				},
			});
		} catch (err) {
			fail(res, 404, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/pick-selector", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		const pickAttrKey = "data-rpaflows-picked-token";
		const pickToken = buildPickToken();
		let runtimeForCleanup = null;
		try {
			const body = toObject(req.body, {});
			const contextId = asText(body.contextId || "");
			const actionType = asText(body.actionType || "click").toLowerCase();
			const mgr = getMgr();
			if (contextId) {
				try {
					mgr.selectContext(sessionId, contextId);
				} catch (_) {
				}
			}
			const runtime = await getActivePageRuntime(mgr, sessionId, { autoOpenPage: true });
			runtimeForCleanup = runtime;
			if (contextId && runtime.activeContextId !== contextId) {
				throw new Error(`context not active: ${contextId}`);
			}
			runtime.webRpa.setCurrentPage(runtime.page);
			try {
				await runtime.webRpa.browser?.activate?.();
			} catch (_) {
			}
			try {
				await runtime.page?.bringToFront?.({ focusBrowser: true });
			} catch (_) {
			}
			console.log(`[RPAFLOWS][builder] pick-selector begin session=${sessionId} context=${runtime.activeContextId}`);
			await logBuilder("info", "selector.pick.begin", {
				sessionId,
				contextId: runtime.activeContextId,
			});
			await showTipSafe(runtime.webRpa, runtime.page, "请选择目标元素（Esc 取消）");
			const pickedHandle = await runtime.webRpa.inPagePickDomElement(runtime.page, {
				preventPageClick: true,
				ignoreSelectors: ["#__ai2apps_prompt_root__", "#__ai2apps_tip_root__", "#__ai2apps_selector_root__"],
				attr: { key: pickAttrKey, value: pickToken },
			});
			if (!pickedHandle) {
				const elapsedMs = Date.now() - t0;
				console.log(`[RPAFLOWS][builder] pick-selector cancel session=${sessionId} context=${runtime.activeContextId} elapsedMs=${elapsedMs}`);
				await logBuilder("info", "selector.pick.cancel", { sessionId, contextId: runtime.activeContextId, elapsedMs });
				return res.json({ ok: true, data: { cancelled: true } });
			}
			let details = null;
			try {
				details = await readPickedElementDetails(runtime.page, pickedHandle);
			} finally {
				try { await runtime.page.disown(pickedHandle); } catch (_) {}
			}
			if (!details || !details.ok || !asText(details.selector)) {
				throw new Error("pick failed: empty selector");
			}
			const aiQuery = buildSelectorAiQuery(details, actionType);
			let selector = "";
			let query = "";
			let aiUsed = false;
			let aiReason = "";
			const verifyFails = [];
			const maxPass = 3;
			let feedbackNote = "";
			const logger = await getBuilderLogger();
			for (let pass = 1; pass <= maxPass && !selector; pass += 1) {
				const tipId = `__builder_pick_ai_${Date.now()}_${pass}__`;
				await showTipSafe(runtime.webRpa, runtime.page, `AI 正在生成并验证 selector（第 ${pass}/${maxPass} 轮）...`, tipId);
				let ai = null;
				try {
					ai = await resolveSelectorByAI({
						query: aiQuery,
						webRpa: runtime.webRpa,
						page: runtime.page,
						session: runtime.session,
						expectedMulti: false,
						feedbackNote,
						logger,
					});
				} finally {
					await dismissTipSafe(runtime.webRpa, runtime.page, tipId);
				}
				aiUsed = true;
				aiReason = asText(ai?.reason || "");
				const aiQueryCandidate = asText(ai?.query || "");
				const cands = Array.isArray(ai?.selectors) ? ai.selectors.map((x) => asText(x)).filter(Boolean) : [];
				console.log(
					`[RPAFLOWS][builder] pick-selector ai session=${sessionId} context=${runtime.activeContextId} ` +
					`pass=${pass} aiOk=${!!ai?.ok} selectors=${cands.length} aiQuery=${aiQueryCandidate ? "yes" : "no"}`
				);
				if (!ai?.ok || !cands.length) {
					verifyFails.push(`pass${pass}: ai failed (${asText(ai?.reason || "unknown")})`);
					feedbackNote = `上一轮生成失败：${asText(ai?.reason || "unknown")}。请重新生成。`;
					continue;
				}
				for (let i = 0; i < cands.length; i += 1) {
					const cand = cands[i];
					const verify = await verifySelectorByWebRpa({
						webRpa: runtime.webRpa,
						page: runtime.page,
						selector: cand,
						pickAttrKey,
						pickToken,
					});
					await logBuilder("debug", "selector.pick.verify", {
						sessionId,
						contextId: runtime.activeContextId,
						pass,
						candidateIndex: i + 1,
						selector: cand,
						ok: !!verify?.ok,
						count: Number(verify?.count || 0),
						reason: asText(verify?.reason || ""),
					});
					if (verify?.ok) {
						selector = cand;
						query = aiQueryCandidate;
						break;
					}
					verifyFails.push(`pass${pass}/cand${i + 1}: ${asText(verify?.reason || "not hit")}`);
				}
				if (!selector) {
					const tail = verifyFails.slice(-2).join(" | ");
					feedbackNote = `上轮候选都没命中已选元素。失败原因：${tail}。请重新生成更稳健且能命中该元素本身的 selector。`;
				}
			}
			if (!selector) {
				const fallback = asText(details.selector);
				const verifyFallback = fallback
					? await verifySelectorByWebRpa({
						webRpa: runtime.webRpa,
						page: runtime.page,
						selector: fallback,
						pickAttrKey,
						pickToken,
					})
					: { ok: false, reason: "empty fallback selector" };
				if (verifyFallback?.ok) {
					selector = fallback;
					query = "";
					aiReason = `${aiReason ? `${aiReason}; ` : ""}fallback used`;
					await logBuilder("warn", "selector.pick.fallback", {
						sessionId,
						contextId: runtime.activeContextId,
						selector,
						reason: "ai candidates not validated; use fallback picked selector",
					});
				} else {
					const brief = verifyFails.slice(-4).join(" | ");
					throw new Error(`selector 验证失败：未能锁定已选元素。${brief || asText(verifyFallback?.reason || "")}`);
				}
			}
			await showTipSafe(runtime.webRpa, runtime.page, "selector 生成并验证成功");
			await trySwitchBackToBuilderApp(runtime);
			const elapsedMs = Date.now() - t0;
			console.log(
				`[RPAFLOWS][builder] pick-selector done session=${sessionId} context=${runtime.activeContextId} ` +
				`selector=${selector} query=${query ? "yes" : "no"} aiUsed=${aiUsed} elapsedMs=${elapsedMs}`
			);
			await logBuilder("info", "selector.pick.done", {
				sessionId,
				contextId: runtime.activeContextId,
				selector,
				query,
				actionType,
				aiUsed,
				aiReason,
				tagName: asText(details.tagName),
				elapsedMs,
			});
			res.json({
				ok: true,
				data: {
					cancelled: false,
					contextId: runtime.activeContextId,
					selector,
					query,
					actionType,
					aiUsed,
					aiReason,
					picked: details,
				},
				});
		} catch (err) {
			await logBuilder("error", "selector.pick.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		} finally {
			if (runtimeForCleanup?.page) {
				await clearPickedMarker(runtimeForCleanup.page, pickAttrKey, pickToken);
			}
		}
	});

	router.post("/api/builder/session/:id/query-selector", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		try {
			const body = toObject(req.body, {});
			const contextId = asText(body.contextId || "");
			const actionType = asText(body.actionType || "click").toLowerCase();
			const query = asText(body.query || "");
			if (!query) throw new Error("query is required");
			const mgr = getMgr();
			if (contextId) {
				try { mgr.selectContext(sessionId, contextId); } catch (_) {}
			}
			const runtime = await getActivePageRuntime(mgr, sessionId, { autoOpenPage: true });
			if (contextId && runtime.activeContextId !== contextId) {
				throw new Error(`context not active: ${contextId}`);
			}
			runtime.webRpa.setCurrentPage(runtime.page);
			try { await runtime.webRpa.browser?.activate?.(); } catch (_) {}
			try { await runtime.page?.bringToFront?.({ focusBrowser: true }); } catch (_) {}

			const tipId = `__builder_query_ai_${Date.now()}__`;
			await showTipSafe(runtime.webRpa, runtime.page, "AI 正在根据 query 生成 selector，请稍候...", tipId);
			let ai = null;
			try {
				const logger = await getBuilderLogger();
				ai = await resolveSelectorByAI({
					query,
					webRpa: runtime.webRpa,
					page: runtime.page,
					session: runtime.session,
					expectedMulti: false,
					logger,
				});
			} finally {
				await dismissTipSafe(runtime.webRpa, runtime.page, tipId);
			}
			const cands = Array.isArray(ai?.selectors) ? ai.selectors.map((x) => asText(x)).filter(Boolean) : [];
			let selector = "";
			let matchedCount = 0;
			const checks = [];
			for (let i = 0; i < cands.length; i += 1) {
				const cand = cands[i];
				const cc = await countSelectorMatches(runtime.page, cand);
				checks.push({ selector: cand, ok: !!cc?.ok, count: Number(cc?.count || 0), reason: asText(cc?.reason || "") });
				if (cc?.ok && Number(cc?.count || 0) > 0) {
					selector = cand;
					matchedCount = Number(cc.count || 0);
					break;
				}
			}
			if (!selector) {
				const reason = asText(ai?.reason || "") || "AI 未返回可用 selector";
				throw new Error(reason);
			}
			await showTipSafe(runtime.webRpa, runtime.page, `已生成 selector（匹配 ${matchedCount} 个元素）`);
			await trySwitchBackToBuilderApp(runtime);
			const elapsedMs = Date.now() - t0;
			await logBuilder("info", "selector.query.done", {
				sessionId,
				contextId: runtime.activeContextId,
				actionType,
				query,
				selector,
				matchedCount,
				candidates: cands.length,
				elapsedMs,
			});
			res.json({
				ok: true,
				data: {
					sessionId,
					contextId: runtime.activeContextId,
					actionType,
					query,
					selector,
					matchedCount,
					aiUsed: true,
					aiReason: asText(ai?.reason || ""),
					aiQuery: asText(ai?.query || ""),
					candidates: cands,
					checks,
				},
			});
		} catch (err) {
			await logBuilder("error", "selector.query.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/run-js-generate", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		try {
			const body = toObject(req.body, {});
			const contextId = asText(body.contextId || "");
			const query = asText(body.query || "");
			const scope = asText(body.scope || "page").toLowerCase() === "agent" ? "agent" : "page";
			const argsArr = Array.isArray(body.args) ? body.args : [];
			const cacheEnabled = !(body.cache === false);
			if (!query) throw new Error("query is required");
			await logBuilder("info", "run_js.generate.begin", {
				sessionId,
				contextId,
				scope,
				cacheEnabled,
				argsCount: argsArr.length,
				queryPreview: query.slice(0, 180),
			});
			const mgr = getMgr();
			if (contextId) {
				try { mgr.selectContext(sessionId, contextId); } catch (_) {}
			}
			const runtime = await getActivePageRuntime(mgr, sessionId, { autoOpenPage: true });
			if (contextId && runtime.activeContextId !== contextId) {
				throw new Error(`context not active: ${contextId}`);
			}
			runtime.webRpa.setCurrentPage(runtime.page);
			try { await runtime.webRpa.browser?.activate?.(); } catch (_) {}
			try { await runtime.page?.bringToFront?.({ focusBrowser: true }); } catch (_) {}

			const { resolveRunJsCode } = await import("../rpaflows/FlowRunJsResolver.mjs");
			const verifyInput = (argsArr[0] && typeof argsArr[0] === "object" && !Array.isArray(argsArr[0])) ? argsArr[0] : {};
			const cacheKey = cacheEnabled
				? `builder_${sessionId}_${runtime.activeContextId || "ctx"}_run_js`
				: `builder_${sessionId}_${runtime.activeContextId || "ctx"}_run_js_nocache_${Date.now()}`;
			const logger = await getBuilderLogger();
			const tr = Date.now();
			const codeResolved = await resolveRunJsCode({
				cacheKey,
				query,
				verifyInput,
				webRpa: runtime.webRpa,
				page: runtime.page,
				session: runtime.session,
				scope,
				aiOptions: {},
				logger,
			});
			await logBuilder("info", "run_js.generate.resolved", {
				sessionId,
				contextId: runtime.activeContextId,
				scope,
				cacheEnabled,
				cacheKey,
				status: asText(codeResolved?.status || "failed"),
				fromCache: !!codeResolved?.value?.fromCache,
				model: asText(codeResolved?.value?.model || ""),
				elapsedMs: Date.now() - tr,
			});
			if (!codeResolved || codeResolved.status !== "done") {
				throw new Error(asText(codeResolved?.reason || "run_js code resolve failed"));
			}
			const code = asText(codeResolved?.value?.code || "");
			if (!code) throw new Error("AI 未返回 run_js.code");
			const runRet = await execRunJsAction({
				type: "run_js",
				code,
				scope,
				args: argsArr,
			}, {
				args: {},
				opts: {},
				vars: {},
				result: {},
				parseVal: parseFlowVal,
				pageEval: async (codeStr, callArgs) => {
					return runtime.page.callFunction(codeStr, callArgs, { awaitPromise: true });
				},
			});
			await logBuilder("info", "run_js.generate.exec", {
				sessionId,
				contextId: runtime.activeContextId,
				runStatus: asText(runRet?.status || "failed"),
				runReason: asText(runRet?.reason || ""),
				codeChars: code.length,
			});
			await trySwitchBackToBuilderApp(runtime);
			const elapsedMs = Date.now() - t0;
			await logBuilder("info", "run_js.generate.done", {
				sessionId,
				contextId: runtime.activeContextId,
				scope,
				query: query.slice(0, 160),
				cacheEnabled,
				codeFromCache: !!codeResolved?.value?.fromCache,
				runStatus: asText(runRet?.status || "failed"),
				elapsedMs,
			});
			res.json({
				ok: true,
				data: {
					sessionId,
					contextId: runtime.activeContextId,
					scope,
					query,
					cacheEnabled,
					code,
					codeFromCache: !!codeResolved?.value?.fromCache,
					model: asText(codeResolved?.value?.model || ""),
					runResult: runRet || { status: "failed", reason: "empty run result" },
				},
			});
		} catch (err) {
			await logBuilder("error", "run_js.generate.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/skill-to-flow", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const skillText = asText(body.skillText || body.skill || body.text);
			if (!skillText) throw new Error("skillText is required");
			const engine = normalizeFlowAgentEngine(body.engine);
			const model = asText(body.model || "advanced") || "advanced";
			const maxRepairRaw = Number(body.maxRepair);
			const maxRegenerateRaw = Number(body.maxRegenerate);
			const timeoutMsRaw = Number(body.timeoutMs);
			const maxRepair = Number.isFinite(maxRepairRaw) ? Math.max(0, Math.min(5, Math.floor(maxRepairRaw))) : 1;
			const maxRegenerate = Number.isFinite(maxRegenerateRaw) ? Math.max(0, Math.min(5, Math.floor(maxRegenerateRaw))) : 1;
			const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(5000, Math.min(1800000, Math.floor(timeoutMsRaw))) : 600000;
			await logBuilder("info", "skill_to_flow.begin", {
				engine,
				model,
				maxRepair,
				maxRegenerate,
				timeoutMs,
				skillChars: skillText.length,
			});
			const logger = await getBuilderLogger();
			const ret = await runFlowAgent({
				mode: "generate",
				engine,
				input: {
					skillText,
				},
				options: {
					model,
					maxRepair,
					maxRegenerate,
					timeoutMs,
				},
				logger,
			});
			if (!ret?.ok) {
				const errs = Array.isArray(ret?.errors) ? ret.errors.map((x) => asText(x)).filter(Boolean) : [];
				const reason = buildFlowAgentErrorReason(ret, "skill to flow failed");
				await logBuilder("warn", "skill_to_flow.failed", {
					engine,
					reason,
					errors: errs.slice(0, 12),
					errorCount: errs.length,
					model,
					elapsedMs: Date.now() - t0,
				});
				return fail(res, 400, errs.length ? `${reason}: ${errs.slice(0, 2).join(" | ")}` : reason);
			}
			const outDoc = (ret?.document && typeof ret.document === "object") ? ret.document : { flow: ret?.flow };
			const flowObj = (ret?.flow && typeof ret.flow === "object" && !Array.isArray(ret.flow))
				? { ...ret.flow }
				: ((outDoc?.flow && typeof outDoc.flow === "object" && !Array.isArray(outDoc.flow)) ? { ...outDoc.flow } : null);
			if (!flowObj) throw new Error("skill_to_flow 返回结果缺少 flow");
			const docCaps = (outDoc?.capabilities && typeof outDoc.capabilities === "object") ? outDoc.capabilities : null;
			const capsObj = docCaps || { must: [], prefer: [] };
			const docFilters = Array.isArray(outDoc?.filters) ? outDoc.filters : [];
			const filters = docFilters;
			const capsFlat = Array.from(new Set([
				...(Array.isArray(capsObj.must) ? capsObj.must : []),
				...(Array.isArray(capsObj.prefer) ? capsObj.prefer : []),
			].map((x) => asText(x)).filter(Boolean)));
			if (!Array.isArray(flowObj.capabilities) || !flowObj.capabilities.length) flowObj.capabilities = capsFlat;
			if (!Array.isArray(flowObj.filters) || !flowObj.filters.length) flowObj.filters = filters;
			const elapsedMs = Date.now() - t0;
			const repairs = Number(ret?.meta?.repairs || 0);
			const regenerates = Number(ret?.meta?.regenerates || 0);
			await logBuilder("info", "skill_to_flow.done", {
				engine,
				model,
				flowId: asText(flowObj.id || ""),
				stepCount: Array.isArray(flowObj.steps) ? flowObj.steps.length : 0,
				repairs,
				regenerates,
				capabilityCount: capsFlat.length,
				filterCount: Array.isArray(filters) ? filters.length : 0,
				elapsedMs,
			});
			res.json({
				ok: true,
				data: {
					flow: flowObj,
					capabilities: capsObj,
					filters,
					taskProfile: ret?.meta?.taskProfile || null,
					plan: ret?.meta?.plan || null,
					repairs,
					regenerates,
					engine,
					model,
					elapsedMs,
				},
			});
		} catch (err) {
			await logBuilder("error", "skill_to_flow.error", {
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/flow-revise", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const userInstruction = asText(body.userInstruction || body.prompt || body.message);
			if (!userInstruction) throw new Error("userInstruction is required");
			const engine = normalizeFlowAgentEngine(body.engine);
			const model = asText(body.model || "advanced") || "advanced";
			const contextText = asText(body.contextText || body.context || "");
			const maxRepairRaw = Number(body.maxRepair);
			const maxRegenerateRaw = Number(body.maxRegenerate);
			const timeoutMsRaw = Number(body.timeoutMs);
			const codexThreadSessionId = asText(body.codexThreadSessionId || "");
			const maxRepair = Number.isFinite(maxRepairRaw) ? Math.max(0, Math.min(5, Math.floor(maxRepairRaw))) : 1;
			const maxRegenerate = Number.isFinite(maxRegenerateRaw) ? Math.max(0, Math.min(5, Math.floor(maxRegenerateRaw))) : 1;
			const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(5000, Math.min(1800000, Math.floor(timeoutMsRaw))) : 600000;
			const flowDocument = (body.flowDocument && typeof body.flowDocument === "object" && !Array.isArray(body.flowDocument))
				? body.flowDocument
				: ((body.flow && typeof body.flow === "object" && !Array.isArray(body.flow)) ? body.flow : null);
			if (!flowDocument) throw new Error("flowDocument is required");

			const currentFlow = (flowDocument && typeof flowDocument === "object" && flowDocument.flow && typeof flowDocument.flow === "object")
				? flowDocument.flow
				: flowDocument;
			const currentStepCount = Array.isArray(currentFlow?.steps) ? currentFlow.steps.length : 0;
			await logBuilder("info", "flow_revise.begin", {
				engine,
				model,
				maxRepair,
				maxRegenerate,
				timeoutMs,
				codexThreadSessionId: codexThreadSessionId || "",
				stepCount: currentStepCount,
				contextChars: contextText.length,
				instructionPreview: truncateText(userInstruction, 220),
			});

			const logger = await getBuilderLogger();
			const ret = await runFlowAgent({
				mode: "revise",
				engine,
				input: {
					flowDocument,
					userInstruction,
					contextText,
				},
				options: {
					model,
					maxRepair,
					maxRegenerate,
					timeoutMs,
					codexThreadSessionId,
				},
				logger,
			});
			const trace = {
				request: {
					engine,
					model,
					timeoutMs,
					maxRepair,
					maxRegenerate,
					codexThreadSessionId: codexThreadSessionId || "",
					stepCount: currentStepCount,
					contextChars: contextText.length,
					instructionPreview: truncateText(userInstruction, 180),
				},
				attempts: [buildFlowAgentTraceFromRet(ret, { engine, mode: "revise" })],
			};
			let finalRet = ret;
			const shouldFallbackRepair = (
				!finalRet?.ok &&
				engine !== "default" &&
				Array.isArray(finalRet?.errors) &&
				finalRet.errors.length > 0 &&
				finalRet?.document &&
				typeof finalRet.document === "object"
			);
			if (shouldFallbackRepair) {
				const repairErrors = finalRet.errors.map((x) => asText(x)).filter(Boolean).slice(0, 8);
				const repairInstruction = [
					"请仅修复下列 Flow 校验错误，尽量保持原步骤结构和用户意图：",
					...repairErrors.map((x, i) => `${i + 1}. ${x}`),
					`原用户指令：${userInstruction}`,
				].join("\n");
				await logBuilder("info", "flow_revise.repair_fallback.begin", {
					fromEngine: engine,
					toEngine: "default",
					errorCount: repairErrors.length,
					errors: repairErrors,
				});
				const repaired = await runFlowAgent({
					mode: "revise",
					engine: "default",
					input: {
						flowDocument: finalRet.document,
						userInstruction: repairInstruction,
						contextText,
					},
					options: {
						model,
						maxRepair,
						maxRegenerate,
						timeoutMs,
						codexThreadSessionId: "",
					},
					logger,
				});
				trace.attempts.push(buildFlowAgentTraceFromRet(repaired, { engine: "default", mode: "revise" }));
				if (repaired?.ok) {
					finalRet = {
						...repaired,
						meta: {
							...(repaired.meta && typeof repaired.meta === "object" ? repaired.meta : {}),
							fallbackRepair: true,
							originEngine: engine,
							repairEngine: "default",
							codexThreadSessionId: asText(ret?.meta?.codexThreadSessionId || ""),
						},
					};
					await logBuilder("info", "flow_revise.repair_fallback.done", {
						fromEngine: engine,
						toEngine: "default",
						stepCount: Array.isArray(finalRet?.flow?.steps) ? finalRet.flow.steps.length : 0,
					});
				} else {
					await logBuilder("warn", "flow_revise.repair_fallback.failed", {
						fromEngine: engine,
						toEngine: "default",
						reason: buildFlowAgentErrorReason(repaired, "fallback repair failed"),
						errors: Array.isArray(repaired?.errors) ? repaired.errors.slice(0, 8) : [],
					});
				}
			}
			if (!finalRet?.ok) {
				const errs = Array.isArray(finalRet?.errors) ? finalRet.errors.map((x) => asText(x)).filter(Boolean) : [];
				const reason = buildFlowAgentErrorReason(finalRet, "flow revise failed");
				trace.final = buildFlowAgentTraceFromRet(finalRet, { engine, mode: "revise" });
				await logBuilder("warn", "flow_revise.failed", {
					engine,
					model,
					reason,
					errorCount: errs.length,
					errors: errs.slice(0, 10),
					elapsedMs: Date.now() - t0,
				});
				return res.status(400).json({
					ok: false,
					reason: errs.length ? `${reason}: ${errs.slice(0, 2).join(" | ")}` : reason,
					trace,
				});
			}

			const revisedDocument = (finalRet && Object.prototype.hasOwnProperty.call(finalRet, "document"))
				? finalRet.document
				: flowDocument;
			const revisedFlow = (revisedDocument && typeof revisedDocument === "object" && revisedDocument.flow && typeof revisedDocument.flow === "object")
				? revisedDocument.flow
				: revisedDocument;
			const nextStepCount = Array.isArray(revisedFlow?.steps) ? revisedFlow.steps.length : 0;
			const repairs = Number(finalRet?.meta?.repairs || 0);
			const regenerates = Number(finalRet?.meta?.regenerates || 0);
			await logBuilder("info", "flow_revise.done", {
				engine,
				model,
				flowId: asText(revisedFlow?.id || ""),
				stepCount: nextStepCount,
				repairs,
				regenerates,
				elapsedMs: Date.now() - t0,
			});
			trace.final = buildFlowAgentTraceFromRet(finalRet, { engine: asText(finalRet?.engine || engine), mode: "revise" });
			res.json({
				ok: true,
				data: {
					document: revisedDocument,
					flow: revisedFlow,
					repairs,
					regenerates,
					taskProfile: finalRet?.meta?.taskProfile || null,
					requestedEngine: engine,
					engine: asText(finalRet?.engine || engine),
					repairEngine: asText(finalRet?.meta?.repairEngine || ""),
					originEngine: asText(finalRet?.meta?.originEngine || ""),
					codexThreadSessionId: asText(finalRet?.meta?.codexThreadSessionId || ""),
					fallbackRepair: finalRet?.meta?.fallbackRepair === true,
					trace,
					model,
					elapsedMs: Date.now() - t0,
				},
			});
		} catch (err) {
			await logBuilder("error", "flow_revise.error", {
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/step-revise", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const engine = normalizeFlowAgentEngine(body.engine);
			const model = asText(body.model || "advanced") || "advanced";
			const timeoutMs = Number(body.timeoutMs || 600000);
			const maxRepair = Number(body.maxRepair || 1);
			const maxRegenerate = Number(body.maxRegenerate || 1);
			const userInstruction = asText(body.userInstruction || "");
			const extraContext = asText(body.contextText || "");
			const stepId = asText(body.stepId || "");
			const flowDocument = (body.flowDocument && typeof body.flowDocument === "object" && !Array.isArray(body.flowDocument))
				? body.flowDocument
				: null;
			if (!flowDocument) throw new Error("flowDocument is required");
			if (!stepId) throw new Error("stepId is required");
			if (!userInstruction) throw new Error("userInstruction is required");

			const currentFlow = extractFlowFromDocument(flowDocument);
			if (!currentFlow) throw new Error("invalid flowDocument");
			const currentStep = getStepById(currentFlow, stepId);
			if (!currentStep) throw new Error(`step not found: ${stepId}`);
			const currentType = asText(currentStep?.action?.type || "");
			if (!currentType) throw new Error(`step ${stepId} missing action.type`);
			const stepContextText = buildStepReviseContextText({
				flow: currentFlow,
				targetStep: currentStep,
				extraContext,
			});

			await logBuilder("info", "step_revise.begin", {
				engine,
				model,
				timeoutMs,
				maxRepair,
				maxRegenerate,
				stepId,
				actionType: currentType,
				stepCount: Array.isArray(currentFlow?.steps) ? currentFlow.steps.length : 0,
				instructionPreview: truncateText(userInstruction, 220),
			});

			const validateStepReviseCandidate = (revisedDocument) => {
				const revisedFlow = extractFlowFromDocument(revisedDocument);
				if (!revisedFlow) return { ok: false, reason: "step revise returned invalid flow" };
				const revisedSteps = Array.isArray(revisedFlow.steps) ? revisedFlow.steps : [];
				const currentSteps = Array.isArray(currentFlow.steps) ? currentFlow.steps : [];
				const oldIdSet = new Set(currentSteps.map((s) => asText(s?.id || "")).filter(Boolean));
				const newIdSet = new Set(revisedSteps.map((s) => asText(s?.id || "")).filter(Boolean));
				let renamedTo = "";
				let revisedStep = getStepById(revisedFlow, stepId);
				if (!revisedStep) {
					const removed = Array.from(oldIdSet).filter((id) => !newIdSet.has(id));
					const added = Array.from(newIdSet).filter((id) => !oldIdSet.has(id));
					if (removed.length === 1 && added.length === 1 && removed[0] === stepId) {
						renamedTo = asText(added[0]);
						revisedStep = getStepById(revisedFlow, renamedTo);
					}
				}
				if (!revisedStep) return { ok: false, reason: `step revise removed target step: ${stepId}` };
				const revisedType = asText(revisedStep?.action?.type || "");
				if (revisedType !== currentType) {
					return { ok: false, reason: `step ${stepId} action.type cannot change (${currentType} -> ${revisedType || "-"})` };
				}
				const candidateId = asText(revisedStep?.id || "");
				if (!candidateId) return { ok: false, reason: "target step id cannot be empty" };
				renamedTo = renamedTo || (candidateId !== stepId ? candidateId : "");
				if (renamedTo) {
					const occupied = currentSteps.some((s) => asText(s?.id || "") === renamedTo && asText(s?.id || "") !== stepId);
					if (occupied) return { ok: false, reason: `step id conflict: ${renamedTo}` };
				}
				const normalizedFlow = deepCloneJson(currentFlow, null);
				if (!normalizedFlow) return { ok: false, reason: "step revise normalize failed" };
				const idx = currentSteps.findIndex((s) => asText(s?.id || "") === stepId);
				if (idx < 0) return { ok: false, reason: `step not found: ${stepId}` };
				const targetClone = deepCloneJson(revisedStep, null);
				if (!targetClone || typeof targetClone !== "object") return { ok: false, reason: "invalid revised step payload" };
				normalizedFlow.steps[idx] = targetClone;
				if (renamedTo) applyStepIdRenameInFlow(normalizedFlow, stepId, renamedTo);
				const seen = new Set();
				for (const s of Array.isArray(normalizedFlow.steps) ? normalizedFlow.steps : []) {
					const sid = asText(s?.id || "");
					if (!sid) return { ok: false, reason: "step id cannot be empty" };
					if (seen.has(sid)) return { ok: false, reason: `duplicated step id: ${sid}` };
					seen.add(sid);
				}
				const changedStepIds = [];
				const outSteps = Array.isArray(normalizedFlow.steps) ? normalizedFlow.steps : [];
				for (let i = 0; i < currentSteps.length; i += 1) {
					const a = currentSteps[i];
					const b = outSteps[i];
					if (stableJson(a) !== stableJson(b)) changedStepIds.push(asText(b?.id || a?.id || `#${i + 1}`));
				}
				return { ok: true, revisedFlow: normalizedFlow, changedStepIds, renamedStepIdTo: renamedTo };
			};

			const trace = {
				request: {
					engine,
					model,
					timeoutMs,
					maxRepair,
					maxRegenerate,
					stepId,
					actionType: currentType,
					instructionPreview: truncateText(userInstruction, 220),
				},
				attempts: [],
			};
			const stepRuleRetryMax = 1;
			let finalRet = null;
			let revisedDocument = null;
			let revisedFlow = null;
			let changedStepIds = [];
			let renamedStepIdTo = "";
			let codexThreadSessionId = (engine === "codex") ? asText(body.codexThreadSessionId || "") : "";
			let currentInstruction = userInstruction;
			for (let i = 0; i <= stepRuleRetryMax; i += 1) {
				const ret = await runFlowAgent({
					mode: "revise",
					engine,
					input: {
						flowDocument,
						userInstruction: currentInstruction,
						contextText: stepContextText,
					},
					options: {
						model,
						timeoutMs,
						maxRepair,
						maxRegenerate,
						codexThreadSessionId: (engine === "codex") ? codexThreadSessionId : "",
					},
				});
				trace.attempts.push(buildFlowAgentTraceFromRet(ret, { engine, mode: "revise" }));
				if (engine === "codex") {
					const sid = asText(ret?.meta?.codexThreadSessionId || "");
					if (sid) codexThreadSessionId = sid;
				}
				if (!ret?.ok) {
					const reason = buildFlowAgentErrorReason(ret, "step revise failed");
					const validationErrors = shortList(ret?.errors, 10);
					const rawReason = asText(ret?.reason || "");
					const isValidationFail = /validation failed/i.test(reason)
						|| /validation failed/i.test(rawReason)
						|| validationErrors.length > 0;
					if (engine === "default" && isValidationFail) {
						await logBuilder("warn", "step_revise.step_only_fallback_try", {
							stepId,
							actionType: currentType,
							model,
							reason,
							validationErrors,
						});
						const stepOnly = await runStepOnlyReviseByAI({
							stepId,
							actionType: currentType,
							currentStep,
							userInstruction: currentInstruction,
							contextText: stepContextText,
							model,
							timeoutMs,
							logger: null,
						});
						if (!stepOnly.ok) {
							await logBuilder("warn", "step_revise.step_only_fallback_ai_error", {
								stepId,
								actionType: currentType,
								reason: asText(stepOnly.reason || "step-only fallback ai failed"),
							});
						}
						if (stepOnly.ok) {
							const fallbackFlow = deepCloneJson(currentFlow, null);
							if (fallbackFlow && Array.isArray(fallbackFlow.steps)) {
								const idx = fallbackFlow.steps.findIndex((s) => asText(s?.id || "") === stepId);
								if (idx >= 0) {
									fallbackFlow.steps[idx] = stepOnly.step;
									const checked = validateStepReviseCandidate(fallbackFlow);
									if (checked.ok) {
										await logBuilder("info", "step_revise.step_only_fallback_ok", {
											stepId,
											actionType: currentType,
											model,
											reason,
										});
										finalRet = {
											ok: true,
											engine: "default",
											mode: "revise",
											meta: {
												repairs: 0,
												regenerates: 0,
												stepOnlyFallback: true,
											},
										};
										revisedFlow = checked.revisedFlow;
										changedStepIds = checked.changedStepIds || [];
										renamedStepIdTo = asText(checked.renamedStepIdTo || "");
										revisedDocument = (flowDocument && typeof flowDocument === "object" && flowDocument.flow && typeof flowDocument.flow === "object")
											? { ...flowDocument, flow: revisedFlow }
											: revisedFlow;
										break;
									} else {
										await logBuilder("warn", "step_revise.step_only_fallback_invalid", {
											stepId,
											actionType: currentType,
											reason: asText(checked.reason || "step-only fallback validation failed"),
										});
									}
								} else {
									await logBuilder("warn", "step_revise.step_only_fallback_invalid", {
										stepId,
										actionType: currentType,
										reason: "target step not found when applying step-only fallback",
									});
								}
							} else {
								await logBuilder("warn", "step_revise.step_only_fallback_invalid", {
									stepId,
									actionType: currentType,
									reason: "cannot clone current flow for step-only fallback",
								});
							}
						}
					}
					if (isValidationFail && i < stepRuleRetryMax) {
						await logBuilder("warn", "step_revise.validation_retry", {
							stepId,
							actionType: currentType,
							round: i + 1,
							reason,
							validationErrors,
						});
						currentInstruction = [
							userInstruction,
							"",
							"[系统校验反馈]",
							"你上一轮输出没有通过 flow 校验，请仅修复以下错误后返回完整 JSON：",
							...validationErrors.map((e, idx) => `${idx + 1}. ${e}`),
							"其它约束保持不变：仅允许修改目标步骤，action.type 不可变。",
						].join("\n");
						continue;
					}
					trace.final = buildFlowAgentTraceFromRet(ret, { engine, mode: "revise" });
					await logBuilder("warn", "step_revise.error", {
						stepId,
						actionType: currentType,
						reason,
						validationErrors,
						elapsedMs: Date.now() - t0,
					});
					fail(res, 400, reason);
					return;
				}
				revisedDocument = (ret && Object.prototype.hasOwnProperty.call(ret, "document")) ? ret.document : flowDocument;
				const checked = validateStepReviseCandidate(revisedDocument);
				if (checked.ok) {
					finalRet = ret;
					revisedFlow = checked.revisedFlow;
					changedStepIds = checked.changedStepIds || [];
					renamedStepIdTo = asText(checked.renamedStepIdTo || "");
					revisedDocument = (flowDocument && typeof flowDocument === "object" && flowDocument.flow && typeof flowDocument.flow === "object")
						? { ...flowDocument, flow: revisedFlow }
						: revisedFlow;
					break;
				}
				const violation = asText(checked.reason || "step revise validation failed");
				await logBuilder("warn", "step_revise.policy_retry", {
					stepId,
					actionType: currentType,
					round: i + 1,
					violation,
				});
				if (i >= stepRuleRetryMax) {
					throw new Error(violation);
				}
				currentInstruction = `${userInstruction}\n\n[系统约束反馈]\n${violation}\n请仅修复上述约束问题，并返回完整 flow JSON。禁止修改除目标步骤外的任何步骤。`;
			}
			if (!finalRet || !revisedFlow) {
				throw new Error("step revise failed after policy retries");
			}

			trace.final = buildFlowAgentTraceFromRet(finalRet, { engine: asText(finalRet?.engine || engine), mode: "revise" });
			await logBuilder("info", "step_revise.done", {
				engine: asText(finalRet?.engine || engine),
				model,
				stepId,
				actionType: currentType,
				changedStepIds,
				renamedStepIdTo,
				stepOnlyFallback: finalRet?.meta?.stepOnlyFallback === true,
				repairs: Number(finalRet?.meta?.repairs || 0),
				regenerates: Number(finalRet?.meta?.regenerates || 0),
				elapsedMs: Date.now() - t0,
			});
			res.json({
				ok: true,
				data: {
					ok: true,
					stepId,
					actionType: currentType,
					engine: asText(finalRet?.engine || engine),
					requestedEngine: engine,
					document: revisedDocument,
					flow: revisedFlow,
					changedStepIds,
					renamedStepIdTo,
					stepOnlyFallback: finalRet?.meta?.stepOnlyFallback === true,
					repairs: Number(finalRet?.meta?.repairs || 0),
					regenerates: Number(finalRet?.meta?.regenerates || 0),
					codexThreadSessionId: asText(finalRet?.meta?.codexThreadSessionId || codexThreadSessionId || ""),
					trace,
				},
			});
		} catch (err) {
			await logBuilder("warn", "step_revise.error", {
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/pick-element", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		try {
			const body = toObject(req.body, {});
			const contextId = asText(body.contextId || "");
			const selector = asText(body.selector || "");
			if (!selector) throw new Error("selector is required");
			const mgr = getMgr();
			if (contextId) {
				try {
					mgr.selectContext(sessionId, contextId);
				} catch (_) {
				}
			}
			const runtime = await getActivePageRuntime(mgr, sessionId, { autoOpenPage: true });
			if (contextId && runtime.activeContextId !== contextId) {
				throw new Error(`context not active: ${contextId}`);
			}
			runtime.webRpa.setCurrentPage(runtime.page);
			try {
				await runtime.webRpa.browser?.activate?.();
			} catch (_) {
			}
			try {
				await runtime.page?.bringToFront?.({ focusBrowser: true });
			} catch (_) {
			}
			await logBuilder("info", "selector.pick_element.begin", {
				sessionId,
				contextId: runtime.activeContextId,
				selector,
			});

			let matchedCount = 0;
			try {
				if (typeof runtime.webRpa?.inPageShowSelector === "function") {
					matchedCount = Number(await runtime.webRpa.inPageShowSelector(runtime.page, selector, {
						color: "#1890ff",
						thickness: 2,
					})) || 0;
				}
			} finally {
				// keep highlight for confirmation prompt, do not dismiss here
			}
			if (!(matchedCount > 0)) {
				try {
					if (typeof runtime.webRpa?.inPageDismissSelector === "function") {
						await runtime.webRpa.inPageDismissSelector(runtime.page);
					}
				} catch (_) {
				}
				await showTipSafe(runtime.webRpa, runtime.page, "没有选中任何元素");
				await trySwitchBackToBuilderApp(runtime);
				const elapsedMs = Date.now() - t0;
				await logBuilder("info", "selector.pick_element.empty", {
					sessionId,
					contextId: runtime.activeContextId,
					selector,
					elapsedMs,
				});
				return res.json({
					ok: true,
					data: { cancelled: false, matched: false, matchedCount: 0, message: "没有选中任何元素", selector },
				});
			}

			let choiceCode = "";
			let choiceText = "";
			try {
				const ret = await runtime.webRpa.inPagePrompt(runtime.page, `当前 selector 匹配 ${matchedCount} 个元素，请确认是否使用`, {
					modal: true,
					mask: false,
					showCancel: false,
					menu: [
						{ text: "确认使用", code: "fit" },
						{ text: "不合适", code: "reject" },
						{ text: "放弃", code: "cancel" },
					],
				});
				choiceCode = asText(ret?.code || "");
				choiceText = asText(ret?.text || "");
			} finally {
				try {
					if (typeof runtime.webRpa?.inPageDismissSelector === "function") {
						await runtime.webRpa.inPageDismissSelector(runtime.page);
					}
				} catch (_) {
				}
			}
			const confirmed = choiceCode === "fit";
			await showTipSafe(runtime.webRpa, runtime.page, confirmed ? "已确认 selector" : "未确认 selector");
			await trySwitchBackToBuilderApp(runtime);
			const elapsedMs = Date.now() - t0;
			await logBuilder("info", "selector.pick_element.done", {
				sessionId,
				contextId: runtime.activeContextId,
				selector,
				matchedCount,
				confirmed,
				choiceCode,
				choiceText,
				elapsedMs,
			});
			res.json({
				ok: true,
				data: {
					cancelled: choiceCode === "cancel",
					matched: true,
					confirmed,
					contextId: runtime.activeContextId,
					selector,
					matchedCount,
					choiceCode,
				},
			});
		} catch (err) {
			await logBuilder("error", "selector.pick_element.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/save-flow", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const flow = (body.flow && typeof body.flow === "object" && !Array.isArray(body.flow)) ? body.flow : null;
			if (!flow) throw new Error("flow is required");
			const sourcePath = asText(body.sourcePath || flow?.sourcePath || "");
			const outPath = await saveBuilderFlowToFile(flow, { sourcePath });
			const elapsedMs = Date.now() - t0;
			console.log(
				`[RPAFLOWS][builder] save-flow session=${req.params.id} flowId=${asText(flow?.id || "")} ` +
				`out=${outPath} elapsedMs=${elapsedMs}`
			);
				await logBuilder("info", "flow.save", {
					sessionId: req.params.id,
					flowId: asText(flow?.id || ""),
					path: outPath,
					elapsedMs,
				});
				res.json({
					ok: true,
					data: {
						path: toDisplayFlowPath(outPath),
						absPath: outPath,
						baseDir: BUILDER_FLOWS_DIR,
					},
				});
			} catch (err) {
			await logBuilder("error", "flow.save.error", { sessionId: req.params.id, reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/flows/save", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const flow = (body.flow && typeof body.flow === "object" && !Array.isArray(body.flow)) ? body.flow : null;
			if (!flow) throw new Error("flow is required");
			const sourcePath = asText(body.sourcePath || flow?.sourcePath || "");
			const outPath = await saveBuilderFlowToFile(flow, { sourcePath });
			const elapsedMs = Date.now() - t0;
			console.log(
				`[RPAFLOWS][builder] save-flow flowId=${asText(flow?.id || "")} ` +
				`out=${outPath} elapsedMs=${elapsedMs}`
			);
			await logBuilder("info", "flow.save", {
				sessionId: "",
				flowId: asText(flow?.id || ""),
				path: outPath,
				elapsedMs,
			});
			res.json({
				ok: true,
				data: {
					path: toDisplayFlowPath(outPath),
					absPath: outPath,
					baseDir: BUILDER_FLOWS_DIR,
				},
			});
		} catch (err) {
			await logBuilder("error", "flow.save.error", { sessionId: "", reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 400, err?.message || err);
		}
	});

		router.get("/api/builder/flows", async (req, res) => {
			try {
				const flows = await listSavedBuilderFlows();
				await logBuilder("debug", "flow.list", { count: Array.isArray(flows) ? flows.length : 0 });
				res.json({
					ok: true,
					data: {
						baseDir: BUILDER_FLOWS_DIR,
						flows: (Array.isArray(flows) ? flows : []).map((one) => ({
							...one,
							path: toDisplayFlowPath(one?.path),
							absPath: asText(one?.path),
						})),
					},
				});
			} catch (err) {
			await logBuilder("warn", "flow.list.error", { reason: asText(err?.message || err) });
			fail(res, 500, err?.message || err);
		}
	});

	router.post("/api/builder/flows/load", async (req, res) => {
		try {
			const body = toObject(req.body, {});
				const path = asText(body.path);
				if (!path) throw new Error("path is required");
				const flow = await loadSavedBuilderFlowFromPath(path);
				await logBuilder("info", "flow.load", {
					path,
					flowId: asText(flow?.id || ""),
					stepCount: Array.isArray(flow?.steps) ? flow.steps.length : 0,
				});
				res.json({
					ok: true,
					data: {
						baseDir: BUILDER_FLOWS_DIR,
						flow: {
							...flow,
							sourcePath: toDisplayFlowPath(flow?.sourcePath),
							sourcePathAbs: asText(flow?.sourcePath),
						},
					},
				});
			} catch (err) {
			await logBuilder("warn", "flow.load.error", { path: asText(req?.body?.path), reason: asText(err?.message || err) });
			fail(res, 400, err?.message || err);
		}
	});

	router.get("/api/builder/publish/version", async (req, res) => {
		try {
			const flowId = asText(req.query?.flowId || "");
			const sourcePath = asText(req.query?.sourcePath || "");
			const info = await buildServerFlowVersionInfo(flowId, sourcePath);
			res.json({ ok: true, data: info });
		} catch (err) {
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/publish", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const flowIn = (body.flow && typeof body.flow === "object" && !Array.isArray(body.flow)) ? cloneJson(body.flow, null) : null;
			if (!flowIn) throw new Error("flow is required");
			const flowId = asText(flowIn.id || "");
			if (!flowId) throw new Error("flow.id is required");
			const sourcePath = asText(body.sourcePath || flowIn.sourcePath || "");
			const releaseNote = asText(body.releaseNote || "");
			const developerSigner = asText(body.developerSigner || "");
			const systemSigner = asText(body.systemSigner || "");
			const versionInfo = await buildServerFlowVersionInfo(flowId, sourcePath);
			const nextVersion = Math.max(1, Number(versionInfo.nextVersion || 1));
			const now = nowIso();
			const publishPayload = {
				flowId,
				version: nextVersion,
				releasedAt: now,
				releaseNote,
			};
			const signatures = (flowIn.signatures && typeof flowIn.signatures === "object" && !Array.isArray(flowIn.signatures))
				? { ...flowIn.signatures }
				: {};
			if (developerSigner) {
				signatures.developer = {
					signer: developerSigner,
					sig: hashSHA256Hex(`dev:${developerSigner}:${stableJson(publishPayload)}`),
					payload: publishPayload,
				};
			}
			if (systemSigner) {
				signatures.system = {
					signer: systemSigner,
					sig: hashSHA256Hex(`sys:${systemSigner}:${stableJson(publishPayload)}`),
					payload: publishPayload,
				};
			}
			const flowOut = {
				...flowIn,
				version: nextVersion,
				releasedAt: now,
				releaseNote,
				signatures,
				publishMeta: {
					source: "builder.publish",
					publishedAt: now,
					auditSummary: (body.auditSummary && typeof body.auditSummary === "object" && !Array.isArray(body.auditSummary))
						? cloneJson(body.auditSummary, {})
						: null,
				},
			};
			const outPath = await saveBuilderFlowToFile(flowOut, { sourcePath });
			const elapsedMs = Date.now() - t0;
			await logBuilder("info", "flow.publish", {
				flowId,
				version: nextVersion,
				path: outPath,
				developerSigner,
				systemSigner,
				elapsedMs,
			});
			res.json({
				ok: true,
				data: {
					flowId,
					version: nextVersion,
					path: toDisplayFlowPath(outPath),
					absPath: outPath,
					publishedAt: now,
					releaseNote,
					flow: {
						...flowOut,
						sourcePath: toDisplayFlowPath(outPath),
						sourcePathAbs: outPath,
					},
				},
			});
		} catch (err) {
			await logBuilder("error", "flow.publish.error", { reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 400, err?.message || err);
		}
	});
}
