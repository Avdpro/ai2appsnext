import { executeStepAction } from "./FlowStepExecutor.mjs";
import { runAIAction } from "./FlowAIResolver.mjs";
import {
	buildNextActionDeciderPromptV053,
	updateNextActionDecisionCtx,
} from "./FlowPromptBuilder.mjs";

function isPlainObject(v) {
	if (!v || typeof v !== "object") return false;
	const p = Object.getPrototypeOf(v);
	return p === Object.prototype || p === null;
}

function withTimeout(promise, ms, label = "timeout") {
	const n = Math.max(1000, Number(ms || 60000));
	let timer = null;
	const timeoutP = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(label)), n);
	});
	return Promise.race([promise, timeoutP]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function normalizeActionScope(actionScope) {
	if (actionScope === "all" || actionScope == null) return null;
	const raw = Array.isArray(actionScope)
		? actionScope
		: (isPlainObject(actionScope) && Array.isArray(actionScope.allow) ? actionScope.allow : []);
	const allow = new Set(raw.map((x) => String(x || "").trim()).filter(Boolean));
	return allow.size ? allow : null;
}

function normalizeInvokeScope(invokeScope) {
	if (invokeScope === "all" || invokeScope == null) return null;
	const raw = Array.isArray(invokeScope)
		? invokeScope
		: (isPlainObject(invokeScope) && Array.isArray(invokeScope.allow) ? invokeScope.allow : []);
	const tokens = raw.map((x) => String(x || "").trim()).filter(Boolean);
	if (!tokens.length) return null;
	return tokens;
}

function capAllowed(cap, tokens) {
	const c = String(cap || "").trim();
	if (!c) return false;
	for (const t of tokens || []) {
		if (c === t || c.startsWith(`${t}.`)) return true;
	}
	return false;
}

function safeParseJSON(text) {
	const s = String(text || "").trim();
	if (!s) return null;
	try {
		return JSON.parse(s);
	} catch (_) {
	}
	const m = s.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try {
		return JSON.parse(m[0]);
	} catch (_) {
		return null;
	}
}

function coerceStepId(id, idx) {
	const s = String(id || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
	const fallback = `s_${idx}`;
	if (!s) return fallback;
	if (s.length > 48) return s.slice(0, 48);
	return s;
}

function extractDecisionResult(aiRet) {
	if (!aiRet?.ok) return { ok: false, reason: aiRet?.reason || "ai request failed" };
	const env = aiRet.envelope;
	if (!env || String(env.status || "").toLowerCase() !== "ok") {
		return { ok: false, reason: env?.reason || "ai envelope error" };
	}
	const res = env.result;
	if (isPlainObject(res)) return { ok: true, result: res };
	if (typeof res === "string") {
		const parsed = safeParseJSON(res);
		if (isPlainObject(parsed)) return { ok: true, result: parsed };
	}
	return { ok: false, reason: "invalid ai decision result" };
}

function validateDecisionStep(decision, { index, actionAllowSet, invokeScopeTokens }) {
	if (!isPlainObject(decision)) return { ok: false, reason: "decision must be object" };
	if (!isPlainObject(decision.action)) return { ok: false, reason: "decision.action must be object" };
	const actionType = String(decision.action.type || "").trim();
	if (!actionType) return { ok: false, reason: "action.type is required" };
	if (actionAllowSet && !actionAllowSet.has(actionType)) {
		return { ok: false, reason: `action.type not allowed: ${actionType}` };
	}
	if (actionType === "invoke" && invokeScopeTokens) {
		const find = isPlainObject(decision.action.find) ? decision.action.find : {};
		const must = Array.isArray(find.must) ? find.must.map((x) => String(x || "").trim()).filter(Boolean) : [];
		const prefer = Array.isArray(find.prefer) ? find.prefer.map((x) => String(x || "").trim()).filter(Boolean) : [];
		const checkList = [...must, ...prefer];
		for (const cap of checkList) {
			if (!capAllowed(cap, invokeScopeTokens)) {
				return { ok: false, reason: `invoke.find capability not allowed: ${cap}` };
			}
		}
		if (!String(decision.action.target || "").trim() && !must.length) {
			return { ok: false, reason: "restricted invoke requires target or find.must" };
		}
	}
	const step = {
		id: coerceStepId(decision.id, index),
		action: decision.action,
		saveAs: ("saveAs" in decision) ? decision.saveAs : null,
		reason: String(decision.reason || ""),
		summary: String(decision.summary || ""),
	};
	return { ok: true, step };
}

async function collectPageState(webRpa, page) {
	const p = webRpa?.currentPage || page || null;
	if (!p) return null;
	let url = "";
	let title = "";
	let html = "";
	try { url = await p.url(); } catch (_) {}
	try { title = await p.title(); } catch (_) {}
	try {
		if (webRpa && typeof webRpa.readInnerHTML === "function") {
			html = await webRpa.readInnerHTML(p, null, { removeHidden: true });
		} else if (typeof p.content === "function") {
			html = await p.content();
		}
	} catch (_) {}
	return { url: String(url || ""), title: String(title || ""), html: String(html || "") };
}

const DECISION_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["id", "action", "reason", "summary"],
	properties: {
		id: { type: "string", minLength: 1, maxLength: 64 },
		action: { type: "object" },
		saveAs: {
			anyOf: [
				{ type: "string" },
				{ type: "object" },
				{ type: "null" },
			],
		},
		reason: { type: "string" },
		summary: { type: "string" },
	},
};

async function runGoalDrivenLoop({
	goal,
	webRpa,
	page = null,
	session = null,
	args = {},
	opts = {},
	notes = "",
	actionScope = "all",
	invokeScope = "all",
	maxSteps = 20,
	maxConsecutiveFails = 3,
	aiModel = "advanced",
	aiTimeoutMs = 60000,
	logger = null,
	onStep = null,
	onBeforeAI = null,
	onAfterAI = null,
} = {}) {
	if (!goal || !String(goal).trim()) throw new Error("runGoalDrivenLoop: goal is required");
	if (!webRpa) throw new Error("runGoalDrivenLoop: webRpa is required");
	const flowId = `goal_loop_${Date.now()}`;
	const actionAllowSet = normalizeActionScope(actionScope);
	const invokeScopeTokens = normalizeInvokeScope(invokeScope);
	let ctx = null;
	let lastResult = null;
	let consecutiveFails = 0;

	for (let i = 1; i <= Math.max(1, Number(maxSteps || 20)); i += 1) {
		const activePage = webRpa?.currentPage || page || null;
		const pageState = await collectPageState(webRpa, activePage);
		const prompt = buildNextActionDeciderPromptV053({
			goal: String(goal || ""),
			notes: String(notes || ""),
			pageState,
			ctx,
			actionScope,
			invokeScope,
		});
		await onBeforeAI?.({ index: i, ctx, pageState, prompt });
		await logger?.info?.("goal_loop.decide.start", { flowId, index: i });
		const aiRet = await withTimeout(runAIAction({
			action: {
				model: aiModel,
				prompt,
				schema: DECISION_SCHEMA,
				cache: false,
			},
			inputValue: null,
			webRpa,
			page: activePage,
			session,
			aiOptions: opts?.ai || null,
			logger,
		}), aiTimeoutMs, "goal_loop ai timeout");
		await onAfterAI?.({ index: i, aiRet });
		const extracted = extractDecisionResult(aiRet);
		if (!extracted.ok) {
			return {
				status: "failed",
				reason: `ai_decision_failed: ${extracted.reason}`,
				stepsUsed: i - 1,
				ctx,
				lastResult,
				history: Array.isArray(ctx?.history) ? ctx.history : [],
			};
		}
		const valid = validateDecisionStep(extracted.result, { index: i, actionAllowSet, invokeScopeTokens });
		if (!valid.ok) {
			return {
				status: "failed",
				reason: `invalid_next_action: ${valid.reason}`,
				stepsUsed: i - 1,
				ctx,
				lastResult,
				history: Array.isArray(ctx?.history) ? ctx.history : [],
			};
		}

		const step = valid.step;
		await logger?.info?.("goal_loop.step.start", { flowId, index: i, stepId: step.id, actionType: step.action?.type || "" });
		const stepResult = await executeStepAction({
			webRpa,
			page: activePage,
			session,
			action: step.action,
			args: isPlainObject(args) ? args : {},
			opts: isPlainObject(opts) ? opts : {},
			vars: isPlainObject(ctx?.vars) ? ctx.vars : {},
			lastResult,
			flowId,
			stepId: step.id,
			logger,
		});
		lastResult = stepResult;
		ctx = updateNextActionDecisionCtx({
			ctx,
			step,
			stepResult,
			args: isPlainObject(args) ? args : {},
			opts: isPlainObject(opts) ? opts : {},
		});
		await onStep?.({ index: i, step, stepResult, ctx });

		const status = String(stepResult?.status || "failed").toLowerCase();
		if (status === "done") {
			consecutiveFails = 0;
		} else {
			consecutiveFails += 1;
		}

		if (step.action?.type === "done" && status === "done") {
			return {
				status: "done",
				reason: "",
				stepsUsed: i,
				ctx,
				lastResult,
				history: Array.isArray(ctx?.history) ? ctx.history : [],
				value: stepResult?.value,
			};
		}
		if (step.action?.type === "abort") {
			return {
				status: "aborted",
				reason: String(stepResult?.reason || step.action?.reason || "aborted by ai decision"),
				stepsUsed: i,
				ctx,
				lastResult,
				history: Array.isArray(ctx?.history) ? ctx.history : [],
			};
		}
		if (consecutiveFails >= Math.max(1, Number(maxConsecutiveFails || 3))) {
			return {
				status: "failed",
				reason: `too_many_failures: ${consecutiveFails}`,
				stepsUsed: i,
				ctx,
				lastResult,
				history: Array.isArray(ctx?.history) ? ctx.history : [],
			};
		}
	}
	return {
		status: "max_steps",
		reason: `reached maxSteps=${Math.max(1, Number(maxSteps || 20))}`,
		stepsUsed: Math.max(1, Number(maxSteps || 20)),
		ctx,
		lastResult,
		history: Array.isArray(ctx?.history) ? ctx.history : [],
	};
}

export { runGoalDrivenLoop };
