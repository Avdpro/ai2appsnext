import { parseFlowVal } from "./FlowExpr.mjs";
import { executeStepAction } from "./FlowStepExecutor.mjs";
import { briefJSON } from "./FlowBrief.mjs";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(status) {
	const s = String(status || "failed").toLowerCase();
	if (s === "done" || s === "failed" || s === "skipped" || s === "timeout") return s;
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

async function runFlow({
	flow,
	webRpa,
	page,
	session = null,
	args = {},
	opts = {},
	maxSteps = 200,
	logger = null,
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

	const vars = {};
	const history = [];
	let lastResult = { status: "done", value: true };
	let count = 0;
	await logger?.info("flow.start", { start: flow.start, maxSteps, argsKeys: Object.keys(args || {}) });

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

	const validateRequiredArgs = () => {
		const defs = (flow?.args && typeof flow.args === "object" && !Array.isArray(flow.args)) ? flow.args : {};
		const missing = [];
		const readArgByDefKey = (defKey) => {
			const key = String(defKey || "").trim();
			if (!key) return undefined;
			// Prefer exact top-level key match for backward compatibility.
			if (args && typeof args === "object" && Object.prototype.hasOwnProperty.call(args, key)) {
				return args[key];
			}
			// Support nested-path required keys, e.g. "ctx.size" -> args.ctx.size.
			return parseFlowVal(`\${args.${key}}`, args, runtimeOpts, vars, lastResult);
		};
		for (const [key, spec] of Object.entries(defs)) {
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
	};

	const missingRequiredArgs = validateRequiredArgs();
	if (missingRequiredArgs.length) {
		const reason = `missing required flow args: ${missingRequiredArgs.join(", ")}`;
		await logger?.error("flow.args.missing_required", { missing: missingRequiredArgs });
		return withRunMeta({ status: "failed", reason, vars: {}, history: [], lastResult: { status: "failed", reason } });
	}

	while (curStep && count < maxSteps) {
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
			args,
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
			mapSaveAs(curStep.saveAs, normalized, args, runtimeOpts, vars);
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

		const nextId = buildNextStepId(curStep, normalized, args, vars, runtimeOpts, stepsById);
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
