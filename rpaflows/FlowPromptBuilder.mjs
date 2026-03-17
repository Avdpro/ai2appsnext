import { briefJSON } from "./FlowBrief.mjs";
import { parseFlowVal } from "./FlowExpr.mjs";
import rpaKind from "./rpa.mjs";

// Keep this in sync with `/Users/avdpropang/sdk/cchome/home/rpaflows/rpa-flow-spec-v0.55.md`.
const FLOW_PROMPT_SPEC_VERSION = "0.55";
const NEXT_ACTION_CTX_VERSION = 1;

const KNOWN_ACTIONS = {
	goto: `{ type: "goto", url: string, postWaitMs?: number }`,
	click: `{ type: "click", query: string, by?: string, pick?: number | string, intent?: "open"|"dismiss"|"submit", expectInputFocus?: boolean, postWaitMs?: number }`,
	hover: `{ type: "hover", query: string, by?: string, pick?: number | string, postWaitMs?: number }`,
	input: `{ type: "input", text: string, mode?: "fill"|"type"|"paste", clear?: boolean, pressEnter?: boolean, postWaitMs?: number }`,
	press_key: `{ type: "press_key", key: string, modifiers?: ("Shift"|"Alt"|"Control"|"Meta")[], times?: number, postWaitMs?: number }`,
	scroll: `{ type: "scroll", x?: number, y?: number, query?: string, by?: string, postWaitMs?: number }`,
	scroll_show: `{ type: "scroll_show", query?: string, by?: string, postWaitMs?: number }`,
	readPage: `{ type: "readPage", field: "url"|"title"|"html"|"article"|"screenshot" | {url?:boolean,title?:boolean,html?:boolean,article?:boolean,screenshot?:boolean}, postWaitMs?: number }`,
	readElement: `{ type: "readElement", query: string, by?: string, pick: "text"|"value"|"rect"|"html"|"html:inner"|("attr:"+string), multi?: boolean, postWaitMs?: number }`,
	setChecked: `{ type: "setChecked", query: string, by?: string, checked: boolean, multi?: boolean, postWaitMs?: number }`,
	setSelect: `{ type: "setSelect", query: string, by?: string, choice: {by:"value",value:string}|{by:"label",label:string}|{by:"index",index:number}, postWaitMs?: number }`,
	dialog: `{ type: "dialog", op: "accept"|"dismiss", kind?: "alert"|"confirm"|"prompt", textContains?: string, value?: string, postWaitMs?: number }`,
	uploadFile: `{ type: "uploadFile", query: string, by?: string, files: Array<{path?:string,filename?:string,data?:string}>, postWaitMs?: number }`,
	run_js: `{ type: "run_js", scope?: "page"|"agent", code?: string, query?: string, args?: any[], cache?: boolean, postWaitMs?: number }`,
	run_ai: `{ type: "run_ai", prompt: string, input?: any, schema?: object, page?: {url?:boolean,html?:boolean,screenshot?:boolean,article?:boolean}, model?: "fast"|"balanced"|"quality"|"vision"|"free", postWaitMs?: number }`,
	ask_assist: `{ type: "ask_assist", reason: string, waitUserAction?: boolean, persistAcrossNav?: boolean, persistTtlMs?: number, reopenDelayMs?: number, tipPollMs?: number, tipTimeoutMs?: number, postWaitMs?: number }`,
	selector: `{ type: "selector", query: string, by?: string, state?: "present"|"visible", scope?: "current"|"newest"|"any", autoSwitch?: boolean, multi?: boolean, pick?: number|string, postWaitMs?: number }`,
	wait: `{ type: "wait", query: string, by?: string, state?: "visible"|"present"|"hidden"|"gone", scope?: "current"|"newest"|"any", autoSwitch?: boolean, pick?: number|string, timeoutMs?: number, pollMs?: number, postWaitMs?: number }`,
	invoke: `{ type: "invoke", target?: string, find?: object, args?: Record<string, any>, timeoutMs?: number, onError?: "fail"|"return", returnTo?: "caller"|"keep", fork?: boolean|string, forkWait?: "none"|"interactive"|"complete", postWaitMs?: number }`,
	invokeMany: `{ type: "invokeMany", ... }`,
	done: `{ type: "done", reason: string, conclusion: string, postWaitMs?: number }`,
	abort: `{ type: "abort", reason: string, postWaitMs?: number }`,
};

function normalizeActionName(x) {
	return String(x || "").trim();
}

function normalizeActions(actions, defaults = []) {
	const raw = Array.isArray(actions) ? actions : defaults;
	const out = [];
	const seen = new Set();
	for (const item of raw) {
		const a = normalizeActionName(item);
		if (!a || !KNOWN_ACTIONS[a] || seen.has(a)) continue;
		seen.add(a);
		out.push(a);
	}
	if (!seen.has("done")) out.push("done");
	if (!seen.has("abort")) out.push("abort");
	return out;
}

function buildActionUnionLines(actions) {
	return actions.map((a, idx) => `${idx === 0 ? "  " : "| "}${KNOWN_ACTIONS[a]}`);
}

function buildEnvBlock(opts = {}) {
	const env = opts?.env && typeof opts.env === "object" ? opts.env : null;
	if (!env) {
		return [
			"【运行上下文（本次未提供）】",
			"- 可选对象：args / vars / opts / result",
			"- 这些对象均只读；持久化只能通过 saveAs 写入 vars",
		].join("\n");
	}
	const compact = briefJSON(env, {
		maxDepth: 4,
		maxString: 220,
		maxElements: 24,
		maxKeys: 64,
	});
	return [
		"【运行上下文（已压缩）】",
		"- 仅用于决策与参数构造；禁止修改",
		compact,
	].join("\n");
}

function buildHistoryBlock(opts = {}) {
	const usedStepIds = Array.isArray(opts?.usedStepIds) ? opts.usedStepIds : [];
	const history = Array.isArray(opts?.history) ? opts.history : [];
	if (!usedStepIds.length && !history.length) {
		return [
			"【历史（本次未提供）】",
			"- 若宿主提供 history，请避免重复失败动作",
		].join("\n");
	}
	const compact = briefJSON(
		{ usedStepIds, history },
		{ maxDepth: 4, maxString: 180, maxElements: 32, maxKeys: 80 }
	);
	return [
		"【历史（已压缩）】",
		"- 若同 type+by 刚失败，下一步必须换策略",
		compact,
	].join("\n");
}

function isPlainObject(v) {
	if (!v || typeof v !== "object") return false;
	const p = Object.getPrototypeOf(v);
	return p === Object.prototype || p === null;
}

function limitText(text, maxLen = 1200) {
	const s = String(text || "");
	if (s.length <= maxLen) return s;
	return `${s.slice(0, Math.max(0, maxLen - 24))}\n...(truncated)`;
}

function normalizeStepStatus(status) {
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

function initNextActionCtx(ctx = null) {
	const inCtx = isPlainObject(ctx) ? ctx : {};
	const vars = isPlainObject(inCtx.vars) ? { ...inCtx.vars } : {};
	const history = Array.isArray(inCtx.history) ? inCtx.history.slice() : [];
	const lastStep = isPlainObject(inCtx.lastStep) ? { ...inCtx.lastStep } : null;
	const lastErrorLogs = String(inCtx.lastErrorLogs || "");
	return {
		kind: "next_action_ctx",
		version: NEXT_ACTION_CTX_VERSION,
		vars,
		history,
		lastStep,
		lastErrorLogs,
	};
}

function collectInvokeCapsCatalog() {
	const caps = isPlainObject(rpaKind?.caps) ? rpaKind.caps : {};
	const capKeys = [];
	const rootMap = new Map();
	for (const [rawKey, def] of Object.entries(caps)) {
		if (!def || def.kind !== "cap") continue;
		const key = String(rawKey || "").trim();
		if (!key) continue;
		capKeys.push(key);
		const root = key.split(".")[0] || key;
		if (!rootMap.has(root)) rootMap.set(root, []);
		rootMap.get(root).push(key);
	}
	capKeys.sort();
	for (const arr of rootMap.values()) arr.sort();
	return { capKeys, rootMap };
}

const INVOKE_CAPS_CATALOG = collectInvokeCapsCatalog();

function resolveActionScope(actionScope = null) {
	const all = Object.keys(KNOWN_ACTIONS);
	if (actionScope === "all") return normalizeActions(all, all);
	if (Array.isArray(actionScope)) return normalizeActions(actionScope, ["goto", "click", "scroll", "wait", "invoke", "done", "abort"]);
	if (isPlainObject(actionScope) && Array.isArray(actionScope.allow)) {
		return normalizeActions(actionScope.allow, ["goto", "click", "scroll", "wait", "invoke", "done", "abort"]);
	}
	return normalizeActions(["goto", "click", "scroll", "wait", "invoke", "done", "abort"]);
}

function resolveInvokeScope(invokeScope = null) {
	const allCaps = INVOKE_CAPS_CATALOG.capKeys;
	if (invokeScope === "all" || invokeScope == null) {
		return {
			mode: "all",
			tokens: ["all"],
			capKeys: allCaps.slice(),
			roots: Array.from(INVOKE_CAPS_CATALOG.rootMap.keys()).sort(),
		};
	}
	const rawTokens = Array.isArray(invokeScope)
		? invokeScope
		: (isPlainObject(invokeScope) && Array.isArray(invokeScope.allow) ? invokeScope.allow : []);
	const tokens = rawTokens.map((x) => String(x || "").trim()).filter(Boolean);
	const allow = new Set();
	for (const token of tokens) {
		for (const cap of allCaps) {
			if (cap === token || cap.startsWith(`${token}.`)) allow.add(cap);
		}
	}
	const capKeys = Array.from(allow).sort();
	const roots = Array.from(new Set(capKeys.map((k) => k.split(".")[0] || k))).sort();
	return { mode: "restricted", tokens, capKeys, roots };
}

function buildNextActionPageBlock(pageState) {
	if (!pageState || typeof pageState !== "object") {
		return [
			"【当前页面状态】",
			"- pageState: null（当前还没有可用页面上下文）",
			"- 下一步应优先考虑打开初始页面：若可从 goal/ctx 推断 URL，输出 goto；若无法推断，输出 ask_assist 请求用户提供入口 URL。",
		].join("\n");
	}
	const url = String(pageState.url || "");
	const title = String(pageState.title || "");
	const htmlRaw = String(pageState.html || "");
	const html = limitText(htmlRaw, 22000);
	const compact = briefJSON(
		{ url, title, html, htmlLen: htmlRaw.length },
		{ maxDepth: 3, maxString: 22000, maxElements: 16, maxKeys: 24 }
	);
	return [
		"【当前页面状态（已压缩）】",
		compact,
	].join("\n");
}

function buildNextActionCtxBlock(ctx) {
	const c = initNextActionCtx(ctx);
	const recentHistory = c.history.slice(-12);
	const usedStepIds = recentHistory.map((h) => String(h?.id || "")).filter(Boolean);
	const compact = briefJSON(
		{
			vars: c.vars,
			usedStepIds,
			history: recentHistory,
			lastStep: c.lastStep || null,
			lastErrorLogs: limitText(c.lastErrorLogs || "", 1800),
		},
		{ maxDepth: 4, maxString: 1800, maxElements: 40, maxKeys: 100 }
	);
	return [
		"【执行上下文 ctx（已压缩）】",
		"- ctx 用于跨轮记忆：history / vars / lastStep / lastErrorLogs",
		compact,
	].join("\n");
}

function buildInvokeScopeBlock(invokeScopeInfo) {
	const info = invokeScopeInfo || resolveInvokeScope("all");
	const capKeys = Array.isArray(info.capKeys) ? info.capKeys : [];
	const capPreview = info.mode === "all" ? capKeys.slice(0, 80) : capKeys;
	const compact = briefJSON(
		{
			mode: info.mode,
			roots: info.roots || [],
			capCount: capKeys.length,
			caps: capPreview,
			capsTruncated: info.mode === "all" && capKeys.length > capPreview.length,
		},
		{ maxDepth: 4, maxString: 240, maxElements: 120, maxKeys: 40 }
	);
	return [
		"【invoke 范围（按 rpa.mjs 能力裁剪）】",
		"- invoke 可用结构：{ type:\"invoke\", target?: string, find?: { kind?: \"rpa\", must?: string[], prefer?: string[], filter?: object[], rank?: string }, args?: object, timeoutMs?: number, onError?: \"fail\"|\"return\", returnTo?: \"caller\"|\"keep\", fork?: boolean|string, forkWait?: \"none\"|\"interactive\"|\"complete\" }",
		"- 若使用 invoke.find.must，must 中的能力键必须来自下方允许的 caps。",
		"- 若使用 invoke.find.must/prefer（capability 键），find.kind 必须为 \"rpa\"；禁止 \"capability\"。",
		compact,
	].join("\n");
}

function buildAtomicActionDeciderPromptV053({
	goal,
	notes = "",
	actions = null,
	opts = null,
} = {}) {
	if (typeof goal !== "string" || !goal.trim()) {
		throw new Error("buildAtomicActionDeciderPromptV053: goal must be non-empty string");
	}
	const allow = normalizeActions(
		actions,
		["click", "scroll", "goto", "done", "abort"]
	);
	const unionLines = buildActionUnionLines(allow);
	const options = opts && typeof opts === "object" ? opts : {};
	const notesText = String(notes || "").trim() || "暂无。";

	return `
Decide Next Atomic Action (RPA micro-decider, spec v${FLOW_PROMPT_SPEC_VERSION})

你是网页 RPA 的微决策器。你必须只返回“一个原子动作”。
禁止多步规划、禁止返回动作数组、禁止输出 markdown。

【goal】
${goal.trim()}

【notes】
${notesText}

────────────────────────────────────────────────────────
${buildEnvBlock(options)}

────────────────────────────────────────────────────────
${buildHistoryBlock(options)}

────────────────────────────────────────────────────────
【硬性规则】
1) 你只能从下面 Action Union 里选一个 action.type。
2) 不得编造字段：参数必须严格符合对应 action 定义。
3) 对元素动作（click/hover/input/readElement/setChecked/setSelect/uploadFile/selector/wait）：
   - query 必须是 string（自然语言描述）
   - by 可选；若提供 by，必须是符合 spec 的 selector：以 "css:" 或 "xpath:" 开头
   - 若 click 的目标是“激活输入框以便后续 input”，优先设置 expectInputFocus:true
   - 若不确定 by，留空让执行器 resolve
4) run_js 仅可用于只读提取/计算，不得产生页面副作用。
5) 若已达到 goal，优先返回 done；只有确定无法完成时才返回 abort。
6) id 必填，格式 [a-z0-9_]+，长度 <= 48，且不应与 usedStepIds 重复。
7) saveAs 若使用字符串键名，不要写 "vars." 前缀（写 "foo"，不要写 "vars.foo"）。
8) click/hover 等已支持 query 的动作，通常不需要先做 selector 再把 selector 结果塞回 query；如需复用 selector 结果，优先放到 by（例如 "\${vars.sel.by}"）。
8.1) 若同时提供 query 和 by，by 应优先是前序 selector 产物（如 "\${vars.sel.by}"）；避免使用宽泛字面量 by（例如 "css:input[type='text']"）覆盖 query 导致误点。
8.2) 对“先聚焦输入框再 input”的场景，不要生成 selector->click(expectInputFocus) 链；优先直接 click query/by（失败再 ask_assist）。
9) \${...} 只能是安全 path（如 \${args.query}）；默认值/逻辑表达式必须使用 \${{...}}，禁止 \${args.timeout || 45000} 这种写法。
10) flow.args（若返回多步 flow）应保持最小集：仅保留步骤中实际引用的参数（加上必要 required），不要同时给 camelCase+snake_case 同义别名。

────────────────────────────────────────────────────────
【Action Union】
Action =
${unionLines.join("\n")}

────────────────────────────────────────────────────────
【输出格式（严格 JSON）】
{
  "id": string,
  "action": Action,
  "saveAs": string | object | null,
  "reason": string,
  "summary": string
}
`.trim();
}

function buildFindUntilDecisionPromptV053({
	goal,
	notes = "",
	allowedActions = null,
	opts = null,
} = {}) {
	if (typeof goal !== "string" || !goal.trim()) {
		throw new Error("buildFindUntilDecisionPromptV053: goal must be non-empty string");
	}
	const allow = normalizeActions(
		allowedActions,
		["click", "scroll", "goto", "done", "abort"]
	).filter((a) => a === "click" || a === "scroll" || a === "goto" || a === "done" || a === "abort");
	const nextTypes = allow.filter((a) => a !== "done" && a !== "abort");
	const options = opts && typeof opts === "object" ? opts : {};
	const notesText = String(notes || "").trim() || "暂无。";

	return `
Find-Until Decision (RPA, spec v${FLOW_PROMPT_SPEC_VERSION})

你需要根据当前页面判断：
- 是否已经找到目标信息；
- 若未找到，下一步应该执行哪个“原子动作”。

你只能输出 JSON envelope，不得输出任何额外文本。

【goal】
${goal.trim()}

【notes】
${notesText}

────────────────────────────────────────────────────────
${buildEnvBlock(options)}

────────────────────────────────────────────────────────
${buildHistoryBlock(options)}

────────────────────────────────────────────────────────
【可用 nextAction.type】
${nextTypes.join(" | ") || "(none)"}

【nextAction 参数定义（严格）】
- click:
  { "type":"click", "query": string, "by"?: string, "pick"?: number|string, "intent"?: "open"|"dismiss"|"submit", "expectInputFocus"?: boolean, "postWaitMs"?: number }
- scroll:
  { "type":"scroll", "x"?: number, "y"?: number, "query"?: string, "by"?: string, "postWaitMs"?: number }
- goto:
  { "type":"goto", "url": string, "postWaitMs"?: number }

────────────────────────────────────────────────────────
【决策要求】
1) 若已找到目标信息：
   - decision = "done"
   - nextAction = null
   - answer/evidence 必须给出关键依据
2) 若未找到但可继续：
   - decision = "continue"
   - nextAction 必须且只能是一个对象，type 必须来自可用列表
3) 若无法继续：
   - decision = "failed"
   - nextAction = null
4) 不得猜测不存在的参数，不得输出未定义字段。
5) 若 nextAction.by 非空，必须为合法 selector 字符串，且以 "css:" 或 "xpath:" 开头；严禁输出 "css" / "xpath" / "text" 这类枚举词。

────────────────────────────────────────────────────────
【输出格式（严格 JSON envelope）】
{
  "status": "ok",
  "result": {
    "decision": "done" | "continue" | "failed",
    "answer": string,
    "confidence": number,
    "evidence": string[],
    "nextAction": object | null,
    "reason": string
  }
}
`.trim();
}

function buildNextActionDeciderPromptV053({
	goal,
	notes = "",
	pageState = null,
	ctx = null,
	actionScope = null,
	invokeScope = null,
} = {}) {
	if (typeof goal !== "string" || !goal.trim()) {
		throw new Error("buildNextActionDeciderPromptV053: goal must be non-empty string");
	}
	const allowActions = resolveActionScope(actionScope);
	const unionLines = buildActionUnionLines(allowActions);
	const notesText = String(notes || "").trim() || "暂无。";
	const invokeInfo = resolveInvokeScope(invokeScope);
	const hasInvoke = allowActions.includes("invoke");
	return `
Next Action Decision (RPA single-step decider, spec v${FLOW_PROMPT_SPEC_VERSION})

你是网页 RPA 的“下一步动作决策器”。
你每次只能输出一个下一步 action（可以是 invoke），不得输出多步计划。
不得输出 markdown，不得输出解释性散文。

【goal】
${goal.trim()}

【notes】
${notesText}

────────────────────────────────────────────────────────
${buildNextActionPageBlock(pageState)}

────────────────────────────────────────────────────────
${buildNextActionCtxBlock(ctx)}

────────────────────────────────────────────────────────
${hasInvoke ? buildInvokeScopeBlock(invokeInfo) : "【invoke 范围】\n- 本轮不允许 invoke。"}

────────────────────────────────────────────────────────
【硬性规则】
1) 你只能从下面 Action Union 里选择一个 action.type。
2) 输出必须是“一个 action”，禁止输出动作数组、禁止输出多步计划。
3) 字段必须严格符合 action 定义，不得编造字段。
4) 如果上一步失败（ctx.lastStep.status=failed/timeout），下一步必须显式换策略，避免重复相同 type + query/by 组合。
5) 对元素动作（click/hover/input/readElement/setChecked/setSelect/uploadFile/selector/wait）：
   - query 必须是 string（自然语言描述）
   - by 若提供，必须为 selector 字符串并以 "css:" 或 "xpath:" 开头
   - 若 click 的意图是激活输入框，优先设置 expectInputFocus:true
6) 如果 pageState 为 null：
   - 可推断入口 URL 时，优先输出 goto
   - 无法推断 URL 时，输出 ask_assist 请求用户提供 URL
7) 若目标已完成，返回 done；明确无法完成时返回 abort。
8) 若 action.type=invoke 且使用 find.must，must 里的 capability key 必须来自允许的 invoke caps。
9) 若使用 find.must/find.prefer（capability 键），find.kind 必须为 "rpa"，禁止使用 "capability"。
9.1) 禁止 invoke 自调用：不要把当前 flow 作为 invoke 目标，也不要用会解析回当前 flow 的模糊 find。
10) saveAs 若使用字符串键名，不要写 "vars." 前缀（写 "foo"，不要写 "vars.foo"）。
11) click/hover/readElement/setChecked/setSelect/uploadFile/wait 已支持 query，不要额外插入 selector 步骤再把其结果作为 query；若复用 selector 结果，应通过 by 传入（如 "\${vars.sel.by}"）。
11.1) 当 query 与 by 共存时，by 应为 selector 变量引用（如 "\${vars.sel.by}"），不要给宽泛字面量 by（如 "css:input[type='text']"）。
11.2) 若 click.expectInputFocus=true，避免把 click.query 写成 "\${vars.xxx.query}"；这类 selector 变量 query 容易导致焦点确认失败。
12) 需要登录保障时，优先使用 invoke + args.login.ensure=true，不要手写登录判断/登录流程作为主路径。
13) 调用 read.* 能力时，invoke.args 必须使用点号键（如 "read.action"/"read.fields"），禁止裸键 "action"/"fields"/"target"。
14) \${...} 只能是安全 path；需要默认值或表达式时必须使用 \${{...}}，禁止 \${args.timeout || 45000}。
15) 参数最小化：不要输出未被 action 使用的 args；不要同时输出同义别名（如 minItems + min_items）。
16) 对 loadMore 相关 invoke.args，仅使用 loadMore.target/loadMore.maxTries/loadMore.minNewItems；不要编造 loadMore.scrollRounds/loadMore.waitAfter 这类键。
17) 不要定义“兼容参数/alias/fallback alias”这类 flow.args；每个语义只保留一个 canonical 参数。

────────────────────────────────────────────────────────
【Action Union】
Action =
${unionLines.join("\n")}

────────────────────────────────────────────────────────
【输出格式（严格 JSON）】
{
  "id": string,
  "action": Action,
  "saveAs": string | object | null,
  "reason": string,
  "summary": string
}
`.trim();
}

function updateNextActionDecisionCtx({
	ctx = null,
	step = null,
	stepResult = null,
	args = {},
	opts = {},
	maxHistory = 24,
	maxErrorLogsChars = 1800,
} = {}) {
	const next = initNextActionCtx(ctx);
	if (!step || typeof step !== "object") return next;

	const safeArgs = isPlainObject(args) ? args : {};
	const safeOpts = isPlainObject(opts) ? opts : {};
	const result = isPlainObject(stepResult) ? stepResult : { status: "failed", reason: "missing stepResult" };
	const status = normalizeStepStatus(result.status);

	const stepId = String(step.id || "").trim();
	const action = isPlainObject(step.action) ? step.action : {};
	const actionType = String(action.type || "").trim();
	const saveAs = step.saveAs === undefined ? null : step.saveAs;

	if (typeof saveAs === "string" && saveAs.trim()) {
		const k = normalizeSaveAsVarKey(saveAs);
		if (k) next.vars[k] = result?.value;
	} else if (isPlainObject(saveAs)) {
		for (const key of Object.keys(saveAs)) {
			const outKey = normalizeSaveAsVarKey(key);
			if (!outKey) continue;
			try {
				next.vars[outKey] = parseFlowVal(saveAs[key], safeArgs, safeOpts, next.vars, result);
			} catch (_) {
			}
		}
	}

	const reason = limitText(result?.reason || "", 420);
	const entry = {
		id: stepId || `step_${Date.now()}`,
		type: actionType || "unknown",
		status,
		reason,
		summary: limitText(result?.summary || "", 220),
		saveAs: typeof saveAs === "string"
			? normalizeSaveAsVarKey(saveAs)
			: (isPlainObject(saveAs) ? Object.keys(saveAs).map((k) => normalizeSaveAsVarKey(k)).filter(Boolean) : null),
		value: briefJSON(result?.value, { maxDepth: 3, maxString: 300, maxElements: 12, maxKeys: 24 }),
		meta: briefJSON(result?.meta, { maxDepth: 3, maxString: 200, maxElements: 10, maxKeys: 20 }),
		time: Date.now(),
	};
	next.history.push(entry);
	if (next.history.length > Math.max(1, Number(maxHistory || 24))) {
		next.history.splice(0, next.history.length - Math.max(1, Number(maxHistory || 24)));
	}

	const errorRaw = result?.logs
		|| result?.errorLogs
		|| result?.meta?.logs
		|| result?.meta?.invoke?.reason
		|| result?.reason
		|| "";
	next.lastStep = {
		id: entry.id,
		type: entry.type,
		status: entry.status,
		reason: entry.reason,
		saveAs: entry.saveAs,
	};
	next.lastErrorLogs = status === "done" ? "" : limitText(errorRaw, Math.max(300, Number(maxErrorLogsChars || 1800)));
	return next;
}

export {
	FLOW_PROMPT_SPEC_VERSION,
	NEXT_ACTION_CTX_VERSION,
	buildAtomicActionDeciderPromptV053,
	buildFindUntilDecisionPromptV053,
	buildNextActionDeciderPromptV053,
	updateNextActionDecisionCtx,
};
