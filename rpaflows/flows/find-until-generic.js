import { buildFindUntilDecisionPromptV053 } from "../FlowPromptBuilder.mjs";

const capabilities = {
	must: ["find.until", "find.goal"],
	prefer: ["find.allowedActions", "find.maxSteps", "find.result"],
};

const filters = [{ key: "domain", value: "*" }];

const ranks = {
	cost: 2,
	quality: 3,
	speed: 2,
};

const FIND_UNTIL_PROMPT = buildFindUntilDecisionPromptV053({
	goal: "${vars.findState.goal}",
	notes: [
		"这是一个通用 find-until 决策任务。",
		"你必须严格遵守 input.allowedActions。",
		"如果上一轮动作失败，请根据 input.state.lastError 与 input.state.history 修正策略，避免重复失败动作。",
		"当 decision=continue 时，nextAction 必须可执行且参数完整；否则应返回 failed。",
	].join("\n"),
	allowedActions: ["click", "scroll", "goto"],
});

const INIT_STATE_CODE = `function(input){
	function asText(v){ return String(v == null ? "" : v).trim(); }
	function asNum(v, d, min, max){
		let n = Number(v);
		if(!Number.isFinite(n)) n = d;
		if(Number.isFinite(min)) n = Math.max(min, n);
		if(Number.isFinite(max)) n = Math.min(max, n);
		return n;
	}
	function normalizeAllowed(raw){
		const all = ["click","scroll","goto"];
		const arr = Array.isArray(raw) ? raw : all;
		const out = [];
		const seen = new Set();
		for(const x of arr){
			const k = asText(x).toLowerCase();
			if(!all.includes(k) || seen.has(k)) continue;
			seen.add(k);
			out.push(k);
		}
		return out.length ? out : all;
	}
	const find = (input && typeof input.find === "object") ? input.find : {};
	const goal = asText(find.goal || input.goal || input["find.goal"] || "");
	if(!goal){
		throw new Error("find.goal is required");
	}
	const allowedActions = normalizeAllowed(find.allowedActions || input.allowedActions || input["find.allowedActions"]);
	const maxSteps = asNum(find.maxSteps ?? input.maxSteps ?? input["find.maxSteps"], 5, 1, 30);
	return {
		goal,
		allowedActions,
		maxSteps,
		stepsUsed: 0,
		limitReached: false,
		decision: "",
		pendingAction: null,
		answer: "",
		confidence: 0,
		evidence: [],
		lastError: "",
		lastOutcome: null,
		lastActionType: "",
		history: [],
	};
}`;

const MERGE_DECISION_CODE = `function(state, rawDecision){
	function asText(v){ return String(v == null ? "" : v).trim(); }
	function asNum(v, d){
		const n = Number(v);
		return Number.isFinite(n) ? n : d;
	}
	function validBy(v){
		const s = asText(v);
		if(!s) return true;
		if(/^css\\s*:/i.test(s)) return true;
		if(/^xpath\\s*:/i.test(s)) return true;
		return false;
	}
	function normDecision(v){
		const d = asText(v).toLowerCase();
		if(d === "done" || d === "continue" || d === "failed") return d;
		return "failed";
	}
	function cloneAction(a){
		if(!a || typeof a !== "object") return null;
		return {
			type: asText(a.type).toLowerCase(),
			query: asText(a.query),
			by: asText(a.by),
			pick: a.pick,
			intent: asText(a.intent),
			postWaitMs: asNum(a.postWaitMs, 0),
			x: a.x,
			y: a.y,
			url: asText(a.url),
		};
	}
	const s = (state && typeof state === "object") ? state : {};
	const d = (rawDecision && typeof rawDecision === "object") ? rawDecision : {};
	const allowed = Array.isArray(s.allowedActions) ? s.allowedActions : ["click","scroll","goto"];
	const decision = normDecision(d.decision);
	const nextAction = cloneAction(d.nextAction);
	const out = {
		...s,
		decision,
		answer: asText(d.answer),
		confidence: Math.max(0, Math.min(1, asNum(d.confidence, 0))),
		evidence: Array.isArray(d.evidence) ? d.evidence.map((x)=>asText(x)).filter(Boolean).slice(0, 8) : [],
		pendingAction: null,
	};

	if(decision === "continue"){
		if(!nextAction || !nextAction.type){
			out.decision = "failed";
			out.lastError = "decision=continue but nextAction is missing";
			return out;
		}
		if(!allowed.includes(nextAction.type)){
			out.decision = "failed";
			out.lastError = "nextAction.type is not allowed: " + nextAction.type;
			return out;
		}
		if(nextAction.type === "click"){
			if(nextAction.by && !validBy(nextAction.by)){
				nextAction.by = "";
			}
			if(!nextAction.query){
				out.decision = "failed";
				out.lastError = "click nextAction requires query";
				return out;
			}
		}
		if(nextAction.type === "scroll"){
			if(nextAction.by && !validBy(nextAction.by)){
				nextAction.by = "";
			}
		}
		if(nextAction.type === "goto"){
			if(!nextAction.url){
				out.decision = "failed";
				out.lastError = "goto nextAction requires url";
				return out;
			}
		}
		out.pendingAction = nextAction;
		out.lastActionType = nextAction.type;
	}
	if(decision === "failed" && !out.lastError){
		out.lastError = asText(d.reason || "ai reported failed");
	}
	return out;
}`;

const RECORD_OUTCOME_CODE = `function(state, outcome){
	function asText(v){ return String(v == null ? "" : v).trim(); }
	function pickSummary(v){
		if(v == null) return null;
		if(typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
		try {
			return JSON.parse(JSON.stringify(v));
		} catch (_) {
			return asText(v).slice(0, 500);
		}
	}
	const s = (state && typeof state === "object") ? state : {};
	const o = (outcome && typeof outcome === "object") ? outcome : {};
	const status = asText(o.status || "failed").toLowerCase();
	const reason = asText(o.reason || "");
	const nextStepsUsed = Math.max(0, Number(s.stepsUsed || 0)) + 1;
	const maxSteps = Math.max(1, Number(s.maxSteps || 5));
	const hist = Array.isArray(s.history) ? s.history.slice(-11) : [];
	hist.push({
		step: nextStepsUsed,
		actionType: asText(s.lastActionType || (s.pendingAction && s.pendingAction.type) || ""),
		action: s.pendingAction || null,
		status,
		reason,
		value: pickSummary(o.value),
	});
	return {
		...s,
		stepsUsed: nextStepsUsed,
		limitReached: nextStepsUsed >= maxSteps,
		lastOutcome: { status, reason, value: pickSummary(o.value) },
		lastError: status === "done" ? "" : (reason || ("action failed: " + asText(s.lastActionType))),
		history: hist,
		pendingAction: null,
	};
}`;

const DONE_CONCLUSION_CODE = `function(state){
	const s = (state && typeof state === "object") ? state : {};
	return {
		found: true,
		answer: String(s.answer || ""),
		confidence: Number.isFinite(Number(s.confidence)) ? Number(s.confidence) : 0,
		evidence: Array.isArray(s.evidence) ? s.evidence : [],
		stepsUsed: Number(s.stepsUsed || 0),
		history: Array.isArray(s.history) ? s.history : [],
	};
}`;

const flow = {
	id: "find_until_generic",
	start: "init_state",
	args: {
		find: { type: "object", required: false, desc: "find.* 参数对象（goal/allowedActions/maxSteps）" },
		goal: { type: "string", required: false, desc: "兼容参数：等价 find.goal" },
		allowedActions: { type: "array<string>", required: false, desc: "兼容参数：等价 find.allowedActions" },
		maxSteps: { type: "number", required: false, desc: "兼容参数：等价 find.maxSteps" },
	},
	steps: [
		{
			id: "init_state",
			desc: "初始化 find.until 运行状态",
			action: {
				type: "run_js",
				scope: "agent",
				code: INIT_STATE_CODE,
				args: ["${{ ({ find: args.find || {}, goal: args.goal, allowedActions: args.allowedActions, maxSteps: args.maxSteps }) }}"],
			},
			saveAs: "findState",
			next: { done: "clear_blockers", failed: "abort_bad_args" },
		},
		{
			id: "clear_blockers",
			desc: "find 前先尝试清理 cookie/遮罩类 blocker（失败不阻断）",
			action: {
				type: "invoke",
				target: "blockers_check_clear",
				args: {
					"blockers.clear": true,
				},
				onError: "return",
				returnTo: "caller",
			},
			saveAs: "blockersOut",
			next: { done: "decide_next", failed: "decide_next" },
		},
		{
			id: "decide_next",
			desc: "AI 决策：已找到/继续推进/失败（单轮只调一次 AI）",
			action: {
				type: "run_ai",
				model: "advanced",
				prompt: FIND_UNTIL_PROMPT,
				input: "${{ ({ goal: vars.findState.goal, state: vars.findState, allowedActions: vars.findState.allowedActions, limits: { maxSteps: vars.findState.maxSteps, remaining: Math.max(0, Number(vars.findState.maxSteps || 0) - Number(vars.findState.stepsUsed || 0)) } }) }}",
				page: { url: true, title: true, html: true },
				schema: {
					type: "object",
					required: ["decision", "answer", "confidence", "evidence", "nextAction", "reason"],
					properties: {
						decision: { type: "string", enum: ["done", "continue", "failed"] },
						answer: { type: "string" },
						confidence: { type: "number" },
						evidence: { type: "array", items: { type: "string" } },
						nextAction: { type: ["object", "null"] },
						reason: { type: "string" },
					},
					additionalProperties: true,
				},
			},
			saveAs: "aiDecision",
			next: { done: "merge_decision", failed: "abort_ai_error" },
		},
		{
			id: "merge_decision",
			desc: "校验并合并 AI 决策到状态机",
			action: {
				type: "run_js",
				scope: "agent",
				code: MERGE_DECISION_CODE,
				args: ["${vars.findState}", "${vars.aiDecision}"],
			},
			saveAs: "findState",
			next: { done: "route_decision", failed: "abort_ai_error" },
		},
		{
			id: "route_decision",
			desc: "按 decision 路由",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "findState.decision", value: "done" }, to: "done_conclusion" },
					{ when: { op: "eq", source: "vars", path: "findState.decision", value: "failed" }, to: "abort_failed" },
				],
				default: "route_action_type",
			},
			next: {},
		},
		{
			id: "route_action_type",
			desc: "按 nextAction.type 执行原子动作",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "findState.pendingAction.type", value: "click" }, to: "do_click" },
					{ when: { op: "eq", source: "vars", path: "findState.pendingAction.type", value: "scroll" }, to: "do_scroll" },
					{ when: { op: "eq", source: "vars", path: "findState.pendingAction.type", value: "goto" }, to: "do_goto" },
				],
				default: "abort_failed",
			},
			next: {},
		},
		{
			id: "do_click",
			desc: "执行 AI 建议的 click",
			action: {
				type: "click",
				query: "${vars.findState.pendingAction.query}",
				by: "${vars.findState.pendingAction.by}",
				pick: "${vars.findState.pendingAction.pick}",
				intent: "${vars.findState.pendingAction.intent}",
				postWaitMs: "${vars.findState.pendingAction.postWaitMs}",
			},
			next: { done: "record_action_outcome", failed: "record_action_outcome", timeout: "record_action_outcome" },
		},
		{
			id: "do_scroll",
			desc: "执行 AI 建议的 scroll",
			action: {
				type: "scroll",
				x: "${vars.findState.pendingAction.x}",
				y: "${vars.findState.pendingAction.y}",
				query: "${vars.findState.pendingAction.query}",
				by: "${vars.findState.pendingAction.by}",
				postWaitMs: "${vars.findState.pendingAction.postWaitMs}",
			},
			next: { done: "record_action_outcome", failed: "record_action_outcome", timeout: "record_action_outcome" },
		},
		{
			id: "do_goto",
			desc: "执行 AI 建议的 goto",
			action: {
				type: "goto",
				url: "${vars.findState.pendingAction.url}",
				postWaitMs: "${vars.findState.pendingAction.postWaitMs}",
			},
			next: { done: "record_action_outcome", failed: "record_action_outcome", timeout: "record_action_outcome" },
		},
		{
			id: "record_action_outcome",
			desc: "记录本轮动作结果（含失败原因），供下一轮 AI 修正策略",
			action: {
				type: "run_js",
				scope: "agent",
				code: RECORD_OUTCOME_CODE,
				args: ["${vars.findState}", "${result}"],
			},
			saveAs: "findState",
			next: { done: "route_limit", failed: "abort_failed" },
		},
		{
			id: "route_limit",
			desc: "检查是否达到最大轮数",
			action: {
				type: "branch",
				cases: [{ when: { op: "truthy", source: "vars", path: "findState.limitReached" }, to: "abort_limit" }],
				default: "decide_next",
			},
			next: {},
		},
		{
			id: "done_conclusion",
			desc: "成功返回结果",
			action: {
				type: "run_js",
				scope: "agent",
				code: DONE_CONCLUSION_CODE,
				args: ["${vars.findState}"],
			},
			saveAs: "findResult",
			next: { done: "done", failed: "abort_failed" },
		},
		{
			id: "done",
			action: {
				type: "done",
				reason: "find.until done",
				conclusion: "${vars.findResult}",
			},
			next: {},
		},
		{
			id: "abort_bad_args",
			action: {
				type: "abort",
				reason: "find.until invalid args: find.goal is required",
			},
			next: {},
		},
		{
			id: "abort_ai_error",
			action: {
				type: "abort",
				reason: "find.until ai decision failed",
			},
			next: {},
		},
		{
			id: "abort_limit",
			action: {
				type: "abort",
				reason: "find.until reached maxSteps without finding goal",
			},
			next: {},
		},
		{
			id: "abort_failed",
			action: {
				type: "abort",
				reason: "find.until failed: ${vars.findState.lastError}",
			},
			next: {},
		},
	],
	vars: {
		findState: { type: "object", desc: "find.until 状态机", from: "init_state.saveAs" },
		blockersOut: { type: "object", desc: "find 前 blocker 清理结果（best-effort）", from: "clear_blockers.saveAs" },
		aiDecision: { type: "object", desc: "单轮 AI 决策输出", from: "decide_next.saveAs" },
		findResult: { type: "object", desc: "最终成功结果", from: "done_conclusion.saveAs" },
	},
};

const findUntilGenericObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default findUntilGenericObject;
export { capabilities, filters, ranks, flow, findUntilGenericObject };
