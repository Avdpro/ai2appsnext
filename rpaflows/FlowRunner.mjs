import { parseFlowVal } from "./FlowExpr.mjs";
import { executeStepAction } from "./FlowStepExecutor.mjs";
import { briefJSON } from "./FlowBrief.mjs";
import { callProviderText, getProviderForPurpose, resolveModelByTier } from "./AIProviderClient.mjs";

function asText(v) {
	return String(v == null ? "" : v).trim();
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeKeyToken(v) {
	return asText(v).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isPlainObject(v) {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function getByPath(obj, path) {
	if (!isPlainObject(obj)) return undefined;
	const p = asText(path);
	if (!p) return undefined;
	if (Object.prototype.hasOwnProperty.call(obj, p)) return obj[p];
	const parts = p.split(".").map((x) => asText(x)).filter(Boolean);
	if (!parts.length) return undefined;
	let cur = obj;
	for (let i = 0; i < parts.length; i += 1) {
		const k = parts[i];
		if (!cur || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
		cur = cur[k];
	}
	return cur;
}

function toObject(v, fallback = {}) {
	return isPlainObject(v) ? v : fallback;
}

function parseBool(raw, fallback = false) {
	if (raw === undefined || raw === null || raw === "") return !!fallback;
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "number") return Number.isFinite(raw) ? raw !== 0 : !!fallback;
	const s = asText(raw).toLowerCase();
	if (!s) return !!fallback;
	if (["1", "true", "yes", "y", "on"].includes(s)) return true;
	if (["0", "false", "no", "n", "off"].includes(s)) return false;
	return !!fallback;
}

function normalizeArgAlignOptions(opts = {}) {
	const raw = toObject(opts?.argAlign, {});
	const hasRaw = opts && typeof opts === "object" && opts.argAlign && typeof opts.argAlign === "object";
	const enabled = hasRaw ? parseBool(raw.enabled, true) : parseBool(process.env.FLOW_ARG_ALIGN_ENABLE, true);
	const aiEnabled = parseBool(raw.aiEnabled ?? raw.useAI ?? process.env.FLOW_ARG_ALIGN_AI_ENABLE, true);
	const aiProvider = asText(raw.aiProvider || process.env.FLOW_ARG_ALIGN_AI_PROVIDER || "");
	const aiModel = asText(raw.aiModel || process.env.FLOW_ARG_ALIGN_AI_MODEL || "");
	const aiTier = asText(raw.aiTier || process.env.FLOW_ARG_ALIGN_AI_TIER || "balanced") || "balanced";
	const aiTimeoutMs = Math.max(3000, Number(raw.aiTimeoutMs || process.env.FLOW_ARG_ALIGN_AI_TIMEOUT_MS || 30000));
	return { enabled, aiEnabled, aiProvider, aiModel, aiTier, aiTimeoutMs };
}

function normalizeArgDefs(flow) {
	const defs = (flow?.args && typeof flow.args === "object" && !Array.isArray(flow.args)) ? flow.args : {};
	const out = {};
	for (const [k, v] of Object.entries(defs)) {
		const key = asText(k);
		if (!key) continue;
		out[key] = toObject(v, {});
	}
	return out;
}

function buildArgErrorDetails({ missing = [], argDefs = {}, runtimeArgs = {}, alignRet = null }) {
	const miss = Array.isArray(missing) ? missing.map((x) => asText(x)).filter(Boolean) : [];
	const inArgs = isPlainObject(runtimeArgs) ? runtimeArgs : {};
	const keys = Object.keys(inArgs);
	const items = [];
	for (const k of miss) {
		const spec = toObject(argDefs?.[k], {});
		const type = asText(spec.type || "");
		const required = spec.required === true;
		const desc = asText(spec.desc || "");
		const topKey = k.split(".")[0] || k;
		const hasTop = Object.prototype.hasOwnProperty.call(inArgs, topKey);
		const hasExact = Object.prototype.hasOwnProperty.call(inArgs, k);
		const topVal = hasTop ? inArgs[topKey] : undefined;
		const topType = (topVal == null) ? "" : (Array.isArray(topVal) ? "array" : typeof topVal);
		const topKeys = isPlainObject(topVal) ? Object.keys(topVal).slice(0, 12) : [];
		items.push({
			key: k,
			type,
			required,
			desc,
			hasExact,
			hasTop,
			topKey,
			topType,
			topKeys,
		});
	}
	const alignMappings = Array.isArray(alignRet?.mappings) ? alignRet.mappings : [];
	const aiReason = asText(alignRet?.aiReason || "");
	return { missing: miss, receivedKeys: keys, missingDetails: items, alignMappings, alignAiReason: aiReason };
}

function collectMissingRequiredArgs({ argDefs, runtimeArgs, runtimeOpts, vars, lastResult }) {
	const missing = [];
	const readArgByDefKey = (defKey) => {
		const key = asText(defKey);
		if (!key) return undefined;
		if (runtimeArgs && typeof runtimeArgs === "object" && Object.prototype.hasOwnProperty.call(runtimeArgs, key)) return runtimeArgs[key];
		return parseFlowVal(`\${args.${key}}`, runtimeArgs, runtimeOpts, vars, lastResult);
	};
	for (const [key, spec] of Object.entries(argDefs || {})) {
		if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
		if (spec.required !== true) continue;
		const v = readArgByDefKey(key);
		if (v === undefined || v === null) {
			missing.push(key);
			continue;
		}
		if (typeof v === "string" && !v.trim()) missing.push(key);
	}
	return missing;
}

const ARG_ALIGN_SYNONYMS = {
	content: ["text", "body", "message", "article", "post", "desc", "description"],
	text: ["content", "body", "message", "desc", "description"],
	query: ["keyword", "kw", "search", "q", "term"],
	url: ["link", "href", "targeturl"],
	title: ["subject", "headline", "name"],
	desc: ["description", "summary", "intro"],
	description: ["desc", "summary", "intro"],
};

function scoreArgKeySimilarity(targetKey, sourceKey, targetDesc = "") {
	const t = normalizeKeyToken(targetKey);
	const srcName = asText(sourceKey).split(".").pop() || asText(sourceKey);
	const s = normalizeKeyToken(srcName);
	if (!t || !s) return 0;
	if (t === s) return 100;
	let score = 0;
	if (t.includes(s) || s.includes(t)) score += 25;
	const syn = ARG_ALIGN_SYNONYMS[t] || [];
	if (syn.includes(s)) score += 40;
	const rev = ARG_ALIGN_SYNONYMS[s] || [];
	if (rev.includes(t)) score += 35;
	const desc = asText(targetDesc).toLowerCase();
	if (desc) {
		if (desc.includes(sourceKey.toLowerCase())) score += 20;
		if (desc.includes(s)) score += 15;
	}
	return score;
}

function collectRuntimeArgSourcePaths(runtimeArgs, maxDepth = 3) {
	const out = [];
	const seen = new Set();
	const walk = (cur, prefix, depth) => {
		if (depth > maxDepth || !cur || typeof cur !== "object") return;
		if (!isPlainObject(cur)) return;
		for (const [k, v] of Object.entries(cur)) {
			const key = asText(k);
			if (!key) continue;
			const path = prefix ? `${prefix}.${key}` : key;
			if (!seen.has(path)) {
				seen.add(path);
				out.push(path);
			}
			if (isPlainObject(v)) walk(v, path, depth + 1);
		}
	};
	walk(runtimeArgs, "", 1);
	return out;
}

function isArgValueCompatibleWithTargetType(targetSpec, sourceVal) {
	const t = asText(targetSpec?.type || "").toLowerCase();
	if (!t) return true;
	if (sourceVal === undefined || sourceVal === null) return false;
	const isObj = typeof sourceVal === "object";
	switch (t) {
		case "string":
			return !isObj;
		case "number":
		case "int":
		case "float":
			if (typeof sourceVal === "number") return Number.isFinite(sourceVal);
			if (typeof sourceVal === "string") {
				const n = Number(sourceVal);
				return Number.isFinite(n);
			}
			return false;
		case "boolean":
		case "bool":
			if (typeof sourceVal === "boolean") return true;
			if (typeof sourceVal === "string") {
				const s = asText(sourceVal).toLowerCase();
				return ["1", "0", "true", "false", "yes", "no", "on", "off"].includes(s);
			}
			return false;
		case "object":
		case "json":
			return isObj && !Array.isArray(sourceVal);
		case "array":
			return Array.isArray(sourceVal);
		default:
			return true;
	}
}

function alignArgsByHeuristic({ argDefs, runtimeArgs, missingRequired }) {
	const mappings = [];
	if (!isPlainObject(runtimeArgs)) return mappings;
	const keys = collectRuntimeArgSourcePaths(runtimeArgs, 3);
	const requiredSet = new Set(Object.keys(argDefs || {}).filter((k) => argDefs[k]?.required === true));
	for (const missKey of missingRequired) {
		if (Object.prototype.hasOwnProperty.call(runtimeArgs, missKey) && runtimeArgs[missKey] != null && runtimeArgs[missKey] !== "") continue;
		const nestedDirect = getByPath(runtimeArgs, `search.${missKey}`);
		if (nestedDirect !== undefined && nestedDirect !== null && nestedDirect !== "" && isArgValueCompatibleWithTargetType(argDefs?.[missKey], nestedDirect)) {
			runtimeArgs[missKey] = nestedDirect;
			mappings.push({ target: missKey, source: `search.${missKey}`, confidence: 0.95, mode: "heuristic" });
			continue;
		}
		let best = "";
		let bestScore = 0;
		for (const srcKey of keys) {
			if (!srcKey || srcKey === missKey) continue;
			const srcVal = getByPath(runtimeArgs, srcKey);
			if (srcVal === undefined || srcVal === null || srcVal === "") continue;
			if (!isArgValueCompatibleWithTargetType(argDefs?.[missKey], srcVal)) continue;
			if (requiredSet.has(srcKey)) continue;
			const sc = scoreArgKeySimilarity(missKey, srcKey, argDefs?.[missKey]?.desc || "");
			if (sc > bestScore) {
				bestScore = sc;
				best = srcKey;
			}
		}
		if (best && bestScore >= 40) {
			runtimeArgs[missKey] = runtimeArgs[best];
			mappings.push({ target: missKey, source: best, confidence: Math.min(1, bestScore / 100), mode: "heuristic" });
		}
	}
	return mappings;
}

function tryParseJsonObject(text) {
	const s = asText(text);
	if (!s) return null;
	try { return JSON.parse(s); } catch (_) {}
	const m = s.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try { return JSON.parse(m[0]); } catch (_) {}
	return null;
}

async function alignArgsByAI({ flow, argDefs, runtimeArgs, missingRequired, options, logger = null }) {
	if (!options?.aiEnabled) return { ok: false, reason: "argAlign ai disabled", mappings: [] };
	if (!isPlainObject(runtimeArgs)) return { ok: false, reason: "runtimeArgs is not object", mappings: [] };
	const provider = asText(options.aiProvider) || getProviderForPurpose("run_ai");
	const model = asText(options.aiModel)
		|| resolveModelByTier({ provider, purpose: "run_ai", tier: options.aiTier || "balanced", fallback: false })
		|| resolveModelByTier({ provider, purpose: "run_ai", tier: options.aiTier || "balanced", fallback: true });
	const payload = {
		flowId: asText(flow?.id || ""),
		missingRequired,
		argDefs: Object.fromEntries(Object.entries(argDefs || {}).map(([k, v]) => [k, {
			type: asText(v?.type || ""),
			required: v?.required === true,
			desc: asText(v?.desc || ""),
		}])),
		receivedArgs: runtimeArgs,
	};
	const system = [
		"You are an argument alignment assistant for automation flow execution.",
		"Given flow arg definitions and received args, map source keys to missing required target keys when highly confident.",
		"Do not invent values. Do not modify target keys that are already present.",
		"Return strict JSON object only with schema:",
		`{"mappings":[{"target":"string","source":"string","reason":"string","confidence":0..1}],"cannotResolve":["targetKey"],"reason":"string"}`,
	].join("\n");
	const ret = await callProviderText({
		provider,
		model,
		purpose: "run_ai",
		forceJson: true,
		temperature: 0,
		timeoutMs: Number(options.aiTimeoutMs || 30000),
		logger,
		input: [
			{ role: "system", content: system },
			{ role: "user", content: JSON.stringify(payload, null, 2) },
		],
	});
	if (!ret?.ok) return { ok: false, reason: asText(ret?.reason || "argAlign ai call failed"), mappings: [] };
	const obj = tryParseJsonObject(ret.raw);
	if (!obj || typeof obj !== "object") return { ok: false, reason: "argAlign ai invalid json", mappings: [] };
	const mappingsIn = Array.isArray(obj.mappings) ? obj.mappings : [];
	const mappings = [];
	for (const m of mappingsIn) {
		const target = asText(m?.target);
		const source = asText(m?.source);
		const confidence = Math.max(0, Math.min(1, Number(m?.confidence ?? 0.5)));
		if (!target || !source) continue;
		if (!missingRequired.includes(target)) continue;
		const sourceVal = getByPath(runtimeArgs, source);
		if (sourceVal === undefined || sourceVal === null || sourceVal === "") continue;
		if (!isArgValueCompatibleWithTargetType(argDefs?.[target], sourceVal)) continue;
		if (!Object.prototype.hasOwnProperty.call(runtimeArgs, target) || runtimeArgs[target] == null || runtimeArgs[target] === "") {
			runtimeArgs[target] = sourceVal;
			mappings.push({ target, source, confidence, mode: "ai", reason: asText(m?.reason || "") });
		}
	}
	return { ok: mappings.length > 0, reason: asText(obj.reason || ""), mappings };
}

async function alignFlowArgsIfNeeded({ flow, runtimeArgs, runtimeOpts, vars, lastResult, logger = null }) {
	const argDefs = normalizeArgDefs(flow);
	if (!Object.keys(argDefs).length) return { changed: false, mappings: [], missingAfter: [] };
	const opts = normalizeArgAlignOptions(runtimeOpts);
	if (!opts.enabled) {
		const missing = collectMissingRequiredArgs({ argDefs, runtimeArgs, runtimeOpts, vars, lastResult });
		return { changed: false, mappings: [], missingAfter: missing, skipped: "argAlign disabled" };
	}
	const missing0 = collectMissingRequiredArgs({ argDefs, runtimeArgs, runtimeOpts, vars, lastResult });
	if (!missing0.length) return { changed: false, mappings: [], missingAfter: [] };
	const mappings = [];
	const h = alignArgsByHeuristic({ argDefs, runtimeArgs, missingRequired: missing0 });
	if (h.length) mappings.push(...h);
	let missing1 = collectMissingRequiredArgs({ argDefs, runtimeArgs, runtimeOpts, vars, lastResult });
	if (!missing1.length) return { changed: true, mappings, missingAfter: [] };
	const ai = await alignArgsByAI({
		flow,
		argDefs,
		runtimeArgs,
		missingRequired: missing1,
		options: opts,
		logger,
	});
	if (ai.mappings.length) mappings.push(...ai.mappings);
	missing1 = collectMissingRequiredArgs({ argDefs, runtimeArgs, runtimeOpts, vars, lastResult });
	return {
		changed: mappings.length > 0,
		mappings,
		missingAfter: missing1,
		aiReason: ai.reason || "",
	};
}

function normalizeStatus(status) {
	const s = String(status || "failed").toLowerCase();
	if (s === "done" || s === "failed" || s === "skipped" || s === "timeout" || s === "aborted") return s;
	return "failed";
}

function normalizeSaveAsVarKey(key) {
	const s = String(key || "").trim();
	if (!s) return "";
	if (s === "__proto__" || s === "constructor" || s === "prototype") return "";
	if (s.startsWith("vars.")) {
		const trimmed = s.slice(5).trim();
		if (!trimmed || trimmed === "__proto__" || trimmed === "constructor" || trimmed === "prototype") return "";
		return trimmed;
	}
	return s;
}

function mapSaveAs(saveAs, stepResult, args, opts, vars) {
	if (!saveAs) return;
	if (typeof saveAs === "string") {
		const k = normalizeSaveAsVarKey(saveAs);
		if (!k) return;
		vars[k] = stepResult?.value;
		return;
	}
	if (saveAs && typeof saveAs === "object") {
		for (const key of Object.keys(saveAs)) {
			const k = normalizeSaveAsVarKey(key);
			if (!k) continue;
			vars[k] = parseFlowVal(saveAs[key], args, opts, vars, stepResult);
		}
	}
}

function buildNextStepId(step, stepResult, args, vars, opts, stepsById) {
	const action = step.action || {};
	if (action.type === "branch") return stepResult?.value || null;

	const next = step.next;
	if (!next) return null;
	if (typeof next === "string") return next;
	if (typeof next !== "object") return null;

	if (next.router) {
		if (next.unsafe !== true || !(next.router instanceof Function)) {
			return next.failed || next.default || null;
		}
		try {
			const got = next.router(stepResult, args, vars, opts);
			if (typeof got === "string" && stepsById[got]) return got;
			return next.failed || next.default || null;
		} catch (_) {
			return next.failed || next.default || null;
		}
	}

	const status = normalizeStatus(stepResult?.status);
	return next[status] ?? next.default ?? next.failed ?? null;
}

function normalizeRiskLevelNum(raw, fallback = 1) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(1, Math.min(5, Math.floor(n)));
}

function resolveRiskControl(opts = {}) {
	const rc = toObject(opts?.riskControl, {});
	const hasRcInput = opts && typeof opts === "object" && opts.riskControl && typeof opts.riskControl === "object";
	const enabled = (rc.enabled === true) || (hasRcInput && rc.enabled !== false);
	const mode = ["off", "warn", "ask", "block"].includes(asText(rc.mode).toLowerCase())
		? asText(rc.mode).toLowerCase()
		: "warn";
	const askAboveLevel = normalizeRiskLevelNum(
		rc.askAboveLevel ?? rc.askLevel ?? process.env.FLOW_RISK_ASK_ABOVE_LEVEL ?? 2,
		2
	);
	const blockAboveLevel = normalizeRiskLevelNum(
		rc.blockAboveLevel ?? rc.maxAllowedLevel ?? process.env.FLOW_RISK_BLOCK_ABOVE_LEVEL ?? 5,
		5
	);
	const onAskUnavailable = ["block", "warn", "allow"].includes(asText(rc.onAskUnavailable).toLowerCase())
		? asText(rc.onAskUnavailable).toLowerCase()
		: "block";
	return {
		enabled,
		mode,
		askAboveLevel,
		blockAboveLevel: Math.max(askAboveLevel, blockAboveLevel),
		onAskUnavailable,
	};
}

function parsePromptChoice(ret) {
	if (Array.isArray(ret)) {
		for (const item of ret) {
			if (item && typeof item === "object" && asText(item.code)) return asText(item.code).toLowerCase();
			if (typeof item === "string" && asText(item)) return asText(item).toLowerCase();
		}
	}
	return asText(ret).toLowerCase();
}

async function checkCurrentFlowRiskGate({ flow, opts, webRpa, page, logger = null }) {
	if (opts?.__skipCurrentFlowRiskGate === true) return { ok: true };
	const rc = resolveRiskControl(opts || {});
	if (!rc.enabled || rc.mode === "off") return { ok: true };
	const risk = toObject(flow?.risk, null);
	const riskLevel = normalizeRiskLevelNum(risk?.level, 1);
	const riskDesc = asText(risk?.desc || risk?.description || "");

	if (riskLevel > rc.blockAboveLevel) {
		return {
			ok: false,
			reason: `flow blocked by riskControl: risk.level=${riskLevel} > blockAboveLevel=${rc.blockAboveLevel}`,
		};
	}
	if (rc.mode === "ask" && riskLevel > rc.askAboveLevel) {
		const activePage = webRpa?.currentPage || page || null;
		if (!webRpa || typeof webRpa.inPagePrompt !== "function" || !activePage) {
			if (rc.onAskUnavailable === "warn" || rc.onAskUnavailable === "allow") {
				await logger?.warn("flow.risk.ask_unavailable_bypass", { riskLevel, mode: rc.onAskUnavailable });
				return { ok: true };
			}
			return { ok: false, reason: "risk ask required but no active session/page" };
		}
		const flowId = asText(flow?.id || "");
		const prompt = [
			`当前 Flow 风险等级为 ${riskLevel}（1~5 越高越危险）。`,
			flowId ? `Flow: ${flowId}` : "",
			`风险说明: ${riskDesc || "无额外描述"}`,
			"",
			"请选择是否继续执行：",
		].filter(Boolean).join("\n");
		const ret = await webRpa.inPagePrompt(activePage, prompt, {
			modal: true,
			mask: "rgba(0,0,0,0.28)",
			showCancel: false,
			menu: [
				{ text: "继续执行", code: "allow" },
				{ text: "停止执行", code: "deny" },
			],
			multiSelect: false,
			allowEmpty: false,
			okText: "确认",
		});
		const choice = parsePromptChoice(ret);
		if (choice !== "allow") return { ok: false, reason: "user denied risk approval for current flow" };
		return { ok: true };
	}
	if (riskLevel > rc.askAboveLevel) {
		await logger?.warn("flow.risk.warn", { flowId: asText(flow?.id || ""), riskLevel, askAboveLevel: rc.askAboveLevel });
	}
	return { ok: true };
}

async function runFlow({
	flow,
	webRpa,
	page,
	session = null,
	args = {},
	opts = {},
	maxSteps = 200,
	logger = null,
	shouldStop = null,
	getStopReason = null,
}) {
	if (!flow || typeof flow !== "object") throw new Error("runFlow: missing flow");
	if (!Array.isArray(flow.steps) || !flow.start) throw new Error("runFlow: invalid flow structure");
	if (!webRpa) throw new Error("runFlow: missing webRpa");

	const runtimeSession = session || opts?.session || webRpa?.session || null;
	const runtimeOpts = (runtimeSession && (opts?.session === undefined))
		? { ...(opts || {}), session: runtimeSession }
		: (opts || {});
	const flowRunCtx = (runtimeOpts.__flowRunCtx && typeof runtimeOpts.__flowRunCtx === "object")
		? runtimeOpts.__flowRunCtx
		: { usedContextIds: new Set(), flowId: String(flow?.id || "") };
	if (!(flowRunCtx.usedContextIds instanceof Set)) {
		flowRunCtx.usedContextIds = new Set(Array.isArray(flowRunCtx.usedContextIds) ? flowRunCtx.usedContextIds : []);
	}
	runtimeOpts.__flowRunCtx = flowRunCtx;

	const stepsById = {};
	for (const s of flow.steps) stepsById[s.id] = s;

	let curStep = stepsById[flow.start];
	if (!curStep) throw new Error(`runFlow: start step not found: ${flow.start}`);
	let runtimePage = webRpa?.currentPage || page || null;
	let runtimeArgs = isPlainObject(args) ? { ...args } : (args || {});

	const vars = {};
	const history = [];
	let lastResult = { status: "done", value: true };
	let count = 0;
	await logger?.info("flow.start", { start: flow.start, maxSteps, argsKeys: Object.keys(runtimeArgs || {}) });

	const buildRunMeta = () => {
		const meta = {};
		try {
			const records = (typeof logger?.getRecords === "function") ? logger.getRecords() : [];
			if (records && records.length) {
				meta.logsCount = records.length;
				meta.logsTruncated = !!(typeof logger?.isRecordsTruncated === "function" && logger.isRecordsTruncated());
				meta.logsBrief = briefJSON(records, {
					maxDepth: 4,
					maxString: 260,
					maxElements: 160,
					maxKeys: 32,
					pretty: false,
				});
			}
			if (logger?.runId) meta.runId = logger.runId;
			if (logger?.filePath) meta.logFile = logger.filePath;
		} catch (_) {
		}
		return meta;
	};

	const withRunMeta = (obj) => ({
		...(obj || {}),
		meta: {
			...((obj && obj.meta && typeof obj.meta === "object") ? obj.meta : {}),
			...buildRunMeta(),
		},
	});

	const argDefs = normalizeArgDefs(flow);
	const alignRet = await alignFlowArgsIfNeeded({
		flow,
		runtimeArgs,
		runtimeOpts,
		vars,
		lastResult,
		logger,
	});
	if (alignRet?.changed) {
		await logger?.info("flow.args.aligned", {
			mappings: Array.isArray(alignRet.mappings) ? alignRet.mappings : [],
			argsKeys: Object.keys(runtimeArgs || {}),
		});
	}
	const missingRequiredArgs = Array.isArray(alignRet?.missingAfter)
		? alignRet.missingAfter
		: collectMissingRequiredArgs({
			argDefs,
			runtimeArgs,
			runtimeOpts,
			vars,
			lastResult,
		});
	if (missingRequiredArgs.length) {
		const argErr = buildArgErrorDetails({
			missing: missingRequiredArgs,
			argDefs,
			runtimeArgs,
			alignRet,
		});
		const reason = `missing required flow args: ${missingRequiredArgs.join(", ")}; arg_error: ${JSON.stringify(argErr)}`;
		await logger?.error("flow.args.missing_required", {
			missing: missingRequiredArgs,
			alignChanged: !!alignRet?.changed,
			alignMappings: Array.isArray(alignRet?.mappings) ? alignRet.mappings : [],
			alignAiReason: asText(alignRet?.aiReason || ""),
			argError: argErr,
		});
		return withRunMeta({ status: "failed", reason, vars: {}, history: [], lastResult: { status: "failed", reason } });
	}

	const riskGate = await checkCurrentFlowRiskGate({
		flow,
		opts: runtimeOpts,
		webRpa,
		page: runtimePage,
		logger,
	});
	if (!riskGate.ok) {
		const reason = asText(riskGate.reason || "flow blocked by riskControl");
		await logger?.warn("flow.risk.blocked", { flowId: asText(flow?.id || ""), reason });
		return withRunMeta({ status: "failed", reason, vars: {}, history: [], lastResult: { status: "failed", reason } });
	}

	while (curStep && count < maxSteps) {
		if (typeof shouldStop === "function" && shouldStop()) {
			const reason = String((typeof getStopReason === "function" ? getStopReason() : "") || "stopped by user");
			await logger?.warn("flow.end", { status: "aborted", reason });
			return withRunMeta({ status: "aborted", reason, vars, history, lastResult });
		}
		count++;
		if (webRpa?.currentPage || runtimePage || page) runtimePage = webRpa?.currentPage || runtimePage || page || null;
		const activeCtxBefore = String(runtimePage?.context || webRpa?.currentPage?.context || "").trim();
		if (activeCtxBefore) flowRunCtx.usedContextIds.add(activeCtxBefore);
		await logger?.info("step.start", { stepId: curStep.id, actionType: curStep.action?.type, index: count });
		const stepResult = await executeStepAction({
			webRpa,
			page: runtimePage,
			session: runtimeSession,
			action: curStep.action,
			args: runtimeArgs,
			opts: runtimeOpts,
			vars,
			lastResult,
			flowId: flow.id || "flow",
			stepId: curStep.id || `step_${count}`,
			logger,
		});

		const normalized = {
			...stepResult,
			status: normalizeStatus(stepResult?.status),
		};
		const activeCtxAfter = String(webRpa?.currentPage?.context || runtimePage?.context || "").trim();
		if (activeCtxAfter) flowRunCtx.usedContextIds.add(activeCtxAfter);
		lastResult = normalized;
		await logger?.info("step.end", { stepId: curStep.id, actionType: curStep.action?.type, status: normalized.status, reason: normalized.reason || "" });

		if (normalized.status === "done") {
			mapSaveAs(curStep.saveAs, normalized, runtimeArgs, runtimeOpts, vars);
			const postWaitMs = Number(curStep?.action?.postWaitMs || 0);
			if (postWaitMs > 0) {
				await logger?.debug("step.post_wait", { stepId: curStep.id, postWaitMs });
				await sleep(postWaitMs);
			}
		}

		history.push({
			stepId: curStep.id,
			actionType: curStep.action?.type,
			result: normalized,
		});

		if (curStep.action?.type === "done") {
			await logger?.info("flow.end", { status: "done", stepId: curStep.id });
			return withRunMeta({ status: "done", value: normalized.value, vars, history, lastResult: normalized });
		}
		if (curStep.action?.type === "abort") {
			await logger?.warn("flow.end", { status: "failed", stepId: curStep.id, reason: normalized.reason || "flow aborted" });
			return withRunMeta({ status: "failed", reason: normalized.reason || "flow aborted", vars, history, lastResult: normalized });
		}

		const nextId = buildNextStepId(curStep, normalized, runtimeArgs, vars, runtimeOpts, stepsById);
		if (!nextId) {
			await logger?.info("flow.end", { status: normalized.status, stepId: curStep.id, reason: normalized.reason || "" });
			return withRunMeta({ status: normalized.status, value: normalized.value, reason: normalized.reason, vars, history, lastResult: normalized });
		}
		await logger?.debug("step.route", { fromStepId: curStep.id, nextStepId: nextId, status: normalized.status });
		curStep = stepsById[nextId];
		if (!curStep) {
			await logger?.error("flow.end", { status: "failed", reason: `next step not found: ${nextId}` });
			return withRunMeta({ status: "failed", reason: `next step not found: ${nextId}`, vars, history, lastResult: normalized });
		}
	}

	if (count >= maxSteps) {
		await logger?.error("flow.end", { status: "failed", reason: `maxSteps exceeded: ${maxSteps}` });
		return withRunMeta({ status: "failed", reason: `maxSteps exceeded: ${maxSteps}`, vars, history, lastResult });
	}
	await logger?.info("flow.end", { status: lastResult.status || "failed" });
	return withRunMeta({ status: lastResult.status || "failed", vars, history, lastResult });
}

export { runFlow };
