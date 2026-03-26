import pathLib from "path";
import { fileURLToPath } from "url";
import { promises as fsp } from "fs";
import { runFlow } from "./FlowRunner.mjs";
import { executeStepAction } from "./FlowStepExecutor.mjs";
import { parseFlowVal } from "./FlowExpr.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
const DEFAULT_FLOWS_DIR = pathLib.join(__dirname, "flows");

function getDefaultBuilderFlowsDir() {
	return DEFAULT_FLOWS_DIR;
}

function resolvePathAgainstFlowsDir(inPath, flowsDir = DEFAULT_FLOWS_DIR) {
	const raw = String(inPath || "").trim();
	if (!raw) return "";
	if (pathLib.isAbsolute(raw)) return raw;
	return pathLib.resolve(flowsDir, raw);
}

function parseObjectLike(raw, fallback = {}) {
	if (!raw) return fallback;
	if (typeof raw === "object" && !Array.isArray(raw)) return raw;
	if (typeof raw !== "string") return fallback;
	try {
		const obj = JSON.parse(raw);
		if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
		return fallback;
	} catch (_) {
		return fallback;
	}
}

function normalizeFlowIdHint(text) {
	const s = String(text || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
	if (s) return s.slice(0, 64);
	return `flow_${Date.now()}`;
}

function sanitizeBuilderFlowObject(raw) {
	const obj = (raw && typeof raw === "object") ? raw : {};
	const normalizeCapabilitiesList = (val) => {
		if (!val) return [];
		if (Array.isArray(val)) {
			return Array.from(new Set(
				val.map((x) => String(x || "").trim()).filter(Boolean),
			));
		}
		if (typeof val === "object") {
			const out = new Set();
			for (const k of ["must", "prefer", "can", "caps"]) {
				const rows = Array.isArray(val?.[k]) ? val[k] : [];
				for (const one of rows) {
					const s = String(one || "").trim();
					if (s) out.add(s);
				}
			}
			for (const [k, v] of Object.entries(val)) {
				if (["must", "prefer", "can", "caps"].includes(String(k))) continue;
				if (!v) continue;
				const s = String(k || "").trim();
				if (s) out.add(s);
			}
			return Array.from(out);
		}
		return [];
	};
	const id = normalizeFlowIdHint(obj.id || obj.flowId || obj.name || "builder_flow");
	const steps = Array.isArray(obj.steps) ? obj.steps : [];
	const filters = (Array.isArray(obj.filters) ? obj.filters : [])
		.map((x) => {
			const key = String(x?.key || "").trim();
			const value = String(x?.value || "").trim();
			return (key && value) ? { key, value } : null;
		})
		.filter(Boolean);
	const capabilities = normalizeCapabilitiesList(obj.capabilities);
	const cleanSteps = [];
	for (const one of steps) {
		if (!one || typeof one !== "object") continue;
		const sid = String(one.id || "").trim();
		const action = (one.action && typeof one.action === "object") ? one.action : null;
		if (!sid || !action || !String(action.type || "").trim()) continue;
		const next = (one.next && typeof one.next === "object") ? one.next : {};
		const row = { id: sid, action, next };
		const desc = String(one.desc || "").trim();
		if (desc) row.desc = desc;
		if (one.saveAs !== undefined) row.saveAs = one.saveAs;
		cleanSteps.push(row);
	}
	const vars = (obj.vars && typeof obj.vars === "object" && !Array.isArray(obj.vars))
		? obj.vars
		: undefined;
	return {
		id,
		start: String(obj.start || (cleanSteps[0]?.id || "")).trim(),
		args: (obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)) ? obj.args : {},
		...(vars ? { vars } : {}),
		...(filters.length ? { filters } : {}),
		...(capabilities.length ? { capabilities } : {}),
		steps: cleanSteps,
	};
}

async function listSavedBuilderFlows({ flowsDir = DEFAULT_FLOWS_DIR } = {}) {
	let names = [];
	try {
		names = await fsp.readdir(flowsDir);
	} catch (_) {
		return [];
	}
	const out = [];
	for (const name of names) {
		if (!/\.json$/i.test(String(name || ""))) continue;
		const fullPath = pathLib.join(flowsDir, name);
		try {
			const text = await fsp.readFile(fullPath, "utf8");
			const obj = parseObjectLike(text, {});
			const flow = (obj?.flow && typeof obj.flow === "object") ? obj.flow : ((obj && typeof obj === "object") ? obj : null);
			if (!flow || typeof flow !== "object") continue;
			const id = String(flow.id || "").trim() || String(name || "").replace(/\.json$/i, "");
			out.push({
				id,
				path: fullPath,
				file: String(name || ""),
			});
		} catch (_) {
		}
	}
	out.sort((a, b) => {
		const af = String(a.file || "").toLowerCase();
		const bf = String(b.file || "").toLowerCase();
		const byFile = af.localeCompare(bf, undefined, { numeric: true, sensitivity: "base" });
		if (byFile !== 0) return byFile;
		const ai = String(a.id || "").toLowerCase();
		const bi = String(b.id || "").toLowerCase();
		return ai.localeCompare(bi, undefined, { numeric: true, sensitivity: "base" });
	});
	return out;
}

async function loadSavedBuilderFlowFromPath(inPath) {
	const p = resolvePathAgainstFlowsDir(inPath, DEFAULT_FLOWS_DIR);
	if (!p) throw new Error("path is required");
	const text = await fsp.readFile(p, "utf8");
	const obj = parseObjectLike(text, {});
	const hasWrapper = !!(obj && typeof obj === "object" && obj.flow && typeof obj.flow === "object");
	const flow = hasWrapper
		? obj.flow
		: ((obj && typeof obj === "object") ? obj : null);
	if (!flow || typeof flow !== "object") throw new Error("invalid flow file");
	const merged = {
		...flow,
		capabilities: (hasWrapper && obj.capabilities !== undefined) ? obj.capabilities : flow.capabilities,
		filters: (hasWrapper && obj.filters !== undefined) ? obj.filters : flow.filters,
	};
	const clean = sanitizeBuilderFlowObject(merged);
	if (!clean.id || !Array.isArray(clean.steps)) throw new Error("invalid flow object");
	return { ...clean, sourcePath: p };
}

async function saveBuilderFlowToFile(flow, options = {}) {
	const obj = sanitizeBuilderFlowObject(flow);
	if (!obj.id || !obj.start || !Array.isArray(obj.steps) || !obj.steps.length) {
		throw new Error(`flow object incomplete(id=${String(obj.id || "-")}, start=${String(obj.start || "-")}, steps=${Array.isArray(obj.steps) ? obj.steps.length : 0})`);
	}
	const flowsDir = String(options?.flowsDir || "").trim() || DEFAULT_FLOWS_DIR;
	const sourcePath = String(options?.sourcePath || flow?.sourcePath || "").trim();
	const outPath = sourcePath
		? resolvePathAgainstFlowsDir(sourcePath, flowsDir)
		: pathLib.join(flowsDir, `${obj.id}.json`);
	const wrapper = {
		...(Array.isArray(obj.capabilities) && obj.capabilities.length ? { capabilities: obj.capabilities } : {}),
		...(Array.isArray(obj.filters) && obj.filters.length ? { filters: obj.filters } : {}),
		flow: {
			...obj,
			capabilities: [],
			filters: [],
		},
	};
	if (Array.isArray(wrapper.flow.capabilities) && !wrapper.flow.capabilities.length) delete wrapper.flow.capabilities;
	if (Array.isArray(wrapper.flow.filters) && !wrapper.flow.filters.length) delete wrapper.flow.filters;
	const content = `${JSON.stringify(wrapper, null, 2)}\n`;
	await fsp.writeFile(outPath, content, "utf8");
	return outPath;
}

function buildSingleStepProbeFlow(step) {
	const sid = String(step?.id || "step_1").trim() || "step_1";
	const action = (step && step.action && typeof step.action === "object") ? { ...step.action } : {};
	const type = String(action.type || "").trim();
	if (!type) throw new Error("step.action.type is required");
	const runtimeStep = {
		id: sid,
		action,
		next: {
			done: "__builder_end__",
			skipped: "__builder_end__",
			failed: "__builder_abort__",
			timeout: "__builder_abort__",
			default: "__builder_abort__",
		},
	};
	return {
		id: "__flow_builder_probe__",
		start: sid,
		steps: [
			runtimeStep,
			{ id: "__builder_end__", action: { type: "done", conclusion: "builder step executed" }, next: {} },
			{ id: "__builder_abort__", action: { type: "abort", reason: "builder step failed" }, next: {} },
		],
	};
}

async function runBuilderStepOnce({ webRpa, page, session, step, args: inputArgs = {}, opts: inputOpts = {}, vars: inputVars = {}, lastResult: inputLastResult = null, logger = null }) {
	const normalizeObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {});
	const normalizeStatus = (status) => {
		const s = String(status || "failed").toLowerCase();
		return (s === "done" || s === "failed" || s === "skipped" || s === "timeout") ? s : "failed";
	};
	const normalizeSaveAsVarKey = (key) => {
		const s = String(key || "").trim();
		if (!s) return "";
		if (s === "__proto__" || s === "constructor" || s === "prototype") return "";
		if (s.startsWith("vars.")) {
			const trimmed = s.slice(5).trim();
			if (!trimmed || trimmed === "__proto__" || trimmed === "constructor" || trimmed === "prototype") return "";
			return trimmed;
		}
		return s;
	};
	const mapSaveAs = (saveAs, stepResult, args, opts, vars) => {
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
	};

	const action = (step && step.action && typeof step.action === "object") ? step.action : null;
	if (!action) throw new Error("step.action is required");
	const stepId = String(step?.id || "step_1").trim() || "step_1";
	const args = normalizeObj(inputArgs);
	const opts = normalizeObj(inputOpts);
	const vars = normalizeObj(inputVars);
	const lastResultRaw = inputLastResult;
	const lastResult = (lastResultRaw && typeof lastResultRaw === "object" && !Array.isArray(lastResultRaw))
		? { ...lastResultRaw }
		: { status: "done", value: true };

	const stepResult = await executeStepAction({
		webRpa,
		page,
		session,
		action,
		args,
		opts,
		vars,
		lastResult,
		stepId,
		logger,
	});
	const normalized = {
		...(stepResult || {}),
		status: normalizeStatus(stepResult?.status),
	};
	if (normalized.status === "done") {
		mapSaveAs(step?.saveAs, normalized, args, opts, vars);
	}
	const nextStepId = (String(action?.type || "").toLowerCase() === "branch")
		? String(normalized?.value || "").trim()
		: "";
	return {
		status: normalized.status,
		reason: normalized.reason || "",
		value: normalized.value,
		vars,
		history: [{ stepId, actionType: action?.type, result: normalized }],
		lastResult: normalized,
		...(nextStepId ? { nextStepId } : {}),
		meta: {
			mode: "single_step",
			stepId,
			actionType: String(action?.type || ""),
		},
	};
}

export {
	getDefaultBuilderFlowsDir,
	normalizeFlowIdHint,
	sanitizeBuilderFlowObject,
	listSavedBuilderFlows,
	loadSavedBuilderFlowFromPath,
	saveBuilderFlowToFile,
	buildSingleStepProbeFlow,
	runBuilderStepOnce,
};
