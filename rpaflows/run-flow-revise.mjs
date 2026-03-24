import pathLib from "path";
import { fileURLToPath } from "url";
import { promises as fsp } from "fs";
import dns from "node:dns/promises";
import dotenv from "dotenv";
import { reviseFlowDocumentByPrompt } from "./SkillToFlow.mjs";
import { createFlowLogger } from "./FlowLogger.mjs";
import { getProviderForPurpose } from "./AIProviderClient.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
dotenv.config({ path: pathLib.join(__dirname, ".env") });

function getArg(name, fallback = "") {
	const prefix = `--${name}=`;
	const found = process.argv.find((v) => v.startsWith(prefix));
	return found ? found.slice(prefix.length) : fallback;
}

function nowIso() {
	return new Date().toISOString();
}

function truncate(text, n = 600) {
	const s = String(text || "");
	if (s.length <= n) return s;
	return `${s.slice(0, Math.max(0, n - 20))} ...(truncated)`;
}

function stripLikelyJsonNoise(text) {
	let s = String(text || "");
	s = s.replace(/```json[\s\S]*?```/gi, "[json omitted]");
	s = s.replace(/```[\s\S]*?```/g, "[code omitted]");
	s = s.replace(/\{[^{}\n]{260,}\}/g, "{...}");
	s = s.replace(/\[[^[\]\n]{260,}\]/g, "[...]");
	return s;
}

function safeJsonClone(v) {
	try {
		return JSON.parse(JSON.stringify(v));
	} catch (_) {
		return null;
	}
}

function readFlowAndTemplateFromSource(srcObj) {
	if (srcObj && typeof srcObj === "object" && srcObj.flow && typeof srcObj.flow === "object") {
		const template = safeJsonClone(srcObj) || {};
		delete template.flow;
		return { flow: srcObj.flow, outputTemplate: template };
	}
	return { flow: srcObj, outputTemplate: null };
}

function buildOutputObject({ outputTemplate, flow }) {
	if (outputTemplate && typeof outputTemplate === "object") {
		return { ...safeJsonClone(outputTemplate), flow };
	}
	return flow;
}

function getStepChangedSummary(prevFlow, nextFlow) {
	const prevSteps = Array.isArray(prevFlow?.steps) ? prevFlow.steps : [];
	const nextSteps = Array.isArray(nextFlow?.steps) ? nextFlow.steps : [];
	const prevMap = new Map(prevSteps.map((s) => [String(s?.id || ""), s]));
	const nextMap = new Map(nextSteps.map((s) => [String(s?.id || ""), s]));
	const added = [];
	const removed = [];
	const changed = [];
	for (const id of nextMap.keys()) {
		if (!id) continue;
		if (!prevMap.has(id)) {
			added.push(id);
			continue;
		}
		const a = JSON.stringify(prevMap.get(id));
		const b = JSON.stringify(nextMap.get(id));
		if (a !== b) changed.push(id);
	}
	for (const id of prevMap.keys()) {
		if (!id) continue;
		if (!nextMap.has(id)) removed.push(id);
	}
	return { added, removed, changed };
}

function normalizeSessionData(raw) {
	const s = (raw && typeof raw === "object") ? raw : {};
	const turns = Array.isArray(s.turns) ? s.turns : [];
	const summaryPoints = Array.isArray(s.summaryPoints) ? s.summaryPoints : [];
	return {
		version: 1,
		createdAt: String(s.createdAt || nowIso()),
		updatedAt: String(s.updatedAt || nowIso()),
		currentFlow: s.currentFlow && typeof s.currentFlow === "object" ? s.currentFlow : null,
		outputTemplate: s.outputTemplate && typeof s.outputTemplate === "object" ? s.outputTemplate : null,
		currentOutPath: String(s.currentOutPath || "").trim(),
		turns,
		summaryPoints,
	};
}

function buildSessionContextText({ baseContext = "", sessionData, recentN = 3 }) {
	const recent = Array.isArray(sessionData?.turns) ? sessionData.turns.slice(-Math.max(1, recentN)) : [];
	const summaryPoints = Array.isArray(sessionData?.summaryPoints) ? sessionData.summaryPoints.slice(-10) : [];
	const lines = [];
	if (String(baseContext || "").trim()) {
		lines.push("原始上下文:");
		lines.push(String(baseContext || "").trim());
	}
	if (summaryPoints.length) {
		lines.push("");
		lines.push("历史摘要(压缩):");
		for (const p of summaryPoints) lines.push(`- ${String(p || "")}`);
	}
	if (recent.length) {
		lines.push("");
		lines.push("最近回合(保留原文片段):");
		for (const t of recent) {
			const user = truncate(stripLikelyJsonNoise(t?.user || ""), 360);
			const outcome = truncate(String(t?.outcome || ""), 220);
			lines.push(`- [${t?.ts || ""}] user: ${user}`);
			if (outcome) lines.push(`  outcome: ${outcome}`);
		}
	}
	return lines.join("\n").trim();
}

async function loadSessionFile(sessionPath) {
	try {
		const raw = await fsp.readFile(sessionPath, "utf8");
		return normalizeSessionData(JSON.parse(raw));
	} catch (_) {
		return normalizeSessionData(null);
	}
}

function getProviderBaseURL(provider) {
	const p = String(provider || "").trim().toLowerCase();
	if (p === "openrouter") return String(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").trim().replace(/\/+$/, "");
	if (p === "ollama") return String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
	if (p === "google") return "https://generativelanguage.googleapis.com";
	if (p === "anthropic") return "https://api.anthropic.com";
	return String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
}

function assertProviderCredentials(provider) {
	const p = String(provider || "").trim().toLowerCase();
	if (p === "ollama") return;
	if (p === "openrouter") {
		if (!String(process.env.OPENROUTER_API_KEY || "").trim()) throw new Error("OPENROUTER_API_KEY is required when AI_PROVIDER_RUN_AI=openrouter");
		return;
	}
	if (p === "google") {
		if (!String(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "").trim()) throw new Error("GOOGLE_API_KEY (or GEMINI_API_KEY) is required when AI_PROVIDER_RUN_AI=google");
		return;
	}
	if (p === "anthropic") {
		if (!String(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "").trim()) throw new Error("ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is required when AI_PROVIDER_RUN_AI=anthropic");
		return;
	}
	if (!String(process.env.OPENAI_API_KEY || "").trim()) throw new Error("OPENAI_API_KEY is required when AI_PROVIDER_RUN_AI=openai");
}

async function assertNetworkReady() {
	const allowSandbox = String(process.env.SKILL_TO_FLOW_ALLOW_SANDBOX || "").trim() === "1";
	const sandboxName = String(process.env.CODEX_SANDBOX || "").trim().toLowerCase();
	if (!allowSandbox && sandboxName && sandboxName !== "none") {
		throw new Error(`flow:revise must run outside sandbox (detected CODEX_SANDBOX=${sandboxName})`);
	}
	const provider = getProviderForPurpose("run_ai");
	assertProviderCredentials(provider);
	const base = getProviderBaseURL(provider);
	const host = new URL(base).hostname;
	await dns.lookup(host);
}

async function readPromptText() {
	const turnText = String(getArg("turn", "") || "");
	if (turnText.trim()) return turnText;
	const text = String(getArg("prompt", "") || "");
	if (text.trim()) return text;
	const promptPath = String(getArg("prompt-file", "") || "").trim();
	if (!promptPath) throw new Error("missing prompt: provide --prompt=... or --prompt-file=/path/to/file.txt");
	const abs = pathLib.isAbsolute(promptPath) ? promptPath : pathLib.join(process.cwd(), promptPath);
	return await fsp.readFile(abs, "utf8");
}

async function readContextText() {
	const text = String(getArg("context", "") || "");
	if (text.trim()) return text;
	const contextPath = String(getArg("context-file", "") || "").trim();
	if (!contextPath) return "";
	const abs = pathLib.isAbsolute(contextPath) ? contextPath : pathLib.join(process.cwd(), contextPath);
	return await fsp.readFile(abs, "utf8");
}

async function main() {
	const aiProvider = String(getArg("ai-provider", "") || "").trim().toLowerCase();
	const aiProviderFallback = String(getArg("ai-provider-fallback", "") || "").trim().toLowerCase();
	if (aiProvider) process.env.AI_PROVIDER_RUN_AI = aiProvider;
	if (aiProviderFallback) process.env.AI_PROVIDER_RUN_AI_FALLBACK = aiProviderFallback;
	await assertNetworkReady();

	const sessionPathArg = String(getArg("session", "") || "").trim();
	const sessionPath = sessionPathArg
		? (pathLib.isAbsolute(sessionPathArg) ? sessionPathArg : pathLib.join(process.cwd(), sessionPathArg))
		: "";
	const flowPathArg = String(getArg("flow", "") || "").trim();
	const outPathArg = String(getArg("out", "") || "").trim();
	const model = String(getArg("model", "advanced") || "advanced").trim() || "advanced";
	const maxRepair = Number(getArg("max-repair", "1") || 1);
	const maxRegenerate = Number(getArg("max-regenerate", "1") || 1);
	const timeoutMs = Number(getArg("timeout-ms", "600000") || 600000);
	const recentN = Number(getArg("history-recent", "3") || 3);
	const prompt = await readPromptText();
	const baseContextText = await readContextText();

	const enableLog = String(process.env.SKILL_TO_FLOW_LOG || "").trim() === "1";
	let logger = null;
	if (enableLog) {
		const logDir = process.env.FLOW_LOG_DIR || pathLib.join(__dirname, "flow-logs");
		logger = await createFlowLogger({
			logDir,
			flowId: "flow_revise",
			runId: getArg("run-id", ""),
			echoConsole: process.env.FLOW_LOG_CONSOLE !== "0",
		});
	}

	try {
		const sessionMode = !!sessionPath;
		let flow = null;
		let outputTemplate = null;
		let sessionData = normalizeSessionData(null);

		if (sessionMode) {
			sessionData = await loadSessionFile(sessionPath);
		}

		if (flowPathArg) {
			const flowPath = pathLib.isAbsolute(flowPathArg) ? flowPathArg : pathLib.join(process.cwd(), flowPathArg);
			const raw = await fsp.readFile(flowPath, "utf8");
			const srcObj = JSON.parse(raw);
			const parsed = readFlowAndTemplateFromSource(srcObj);
			flow = parsed.flow;
			outputTemplate = parsed.outputTemplate;
			if (sessionMode) {
				sessionData.currentFlow = flow;
				sessionData.outputTemplate = outputTemplate;
			}
		} else if (sessionMode && sessionData.currentFlow) {
			flow = sessionData.currentFlow;
			outputTemplate = sessionData.outputTemplate || null;
		} else {
			throw new Error("missing flow source: provide --flow=... (or use --session with existing currentFlow)");
		}

		const contextText = sessionMode
			? buildSessionContextText({ baseContext: baseContextText, sessionData, recentN })
			: baseContextText;

		const flowDocument = buildOutputObject({ outputTemplate, flow });
		const ret = await reviseFlowDocumentByPrompt({
			flowDocument,
			userInstruction: prompt,
			contextText,
			model,
			maxRepair: Number.isFinite(maxRepair) ? maxRepair : 1,
			maxRegenerate: Number.isFinite(maxRegenerate) ? maxRegenerate : 1,
			timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 600000,
			logger,
		});
		if (!ret?.ok) {
			console.error("[flow:revise] failed:", ret?.reason || "unknown");
			if (Array.isArray(ret?.errors) && ret.errors.length) {
				console.error("[flow:revise] validation errors:");
				for (const e of ret.errors) console.error("-", e);
			}
			process.exitCode = 2;
			return;
		}

		let outPath = "";
		if (outPathArg) {
			outPath = pathLib.isAbsolute(outPathArg) ? outPathArg : pathLib.join(process.cwd(), outPathArg);
		} else if (sessionMode && sessionData.currentOutPath) {
			outPath = sessionData.currentOutPath;
		} else {
			throw new Error("missing --out=/path/to/revised-flow.json (or keep session currentOutPath)");
		}

		const outObj = (ret && Object.prototype.hasOwnProperty.call(ret, "document")) ? ret.document : buildOutputObject({ outputTemplate, flow: ret.flow });
		await fsp.writeFile(outPath, `${JSON.stringify(outObj, null, 2)}\n`, "utf8");
		console.log("[flow:revise] wrote:", outPath);

		if (sessionMode) {
			const diff = getStepChangedSummary(flow, ret.flow);
			const outcome = `repairs=${ret.repairs || 0}, regenerates=${ret.regenerates || 0}, changed=${diff.changed.length}, added=${diff.added.length}, removed=${diff.removed.length}`;
			const turnRecord = {
				ts: nowIso(),
				user: truncate(stripLikelyJsonNoise(prompt), 1200),
				outcome,
				change: {
					changed: diff.changed.length,
					added: diff.added.length,
					removed: diff.removed.length,
					changedSample: diff.changed.slice(0, 8),
					addedSample: diff.added.slice(0, 5),
					removedSample: diff.removed.slice(0, 5),
				},
			};
			sessionData.turns.push(turnRecord);
			if (sessionData.turns.length > 30) sessionData.turns = sessionData.turns.slice(-30);
			sessionData.summaryPoints.push(`${turnRecord.ts}: ${truncate(turnRecord.user, 140)} | ${outcome}`);
			if (sessionData.summaryPoints.length > 40) sessionData.summaryPoints = sessionData.summaryPoints.slice(-40);
			sessionData.currentFlow = ret.flow;
			sessionData.outputTemplate = outputTemplate;
			sessionData.currentOutPath = outPath;
			sessionData.updatedAt = nowIso();
			await fsp.writeFile(sessionPath, `${JSON.stringify(sessionData, null, 2)}\n`, "utf8");
			console.log("[flow:revise] session updated:", sessionPath);
		}

		if (logger?.filePath) console.log("[flow:revise] log file:", logger.filePath);
	} finally {
		if (logger) await logger.close();
	}
}

main().catch((err) => {
	console.error("[flow:revise] fatal:", err?.message || err);
	process.exitCode = 1;
});
