import { runAIAction } from "./FlowAIResolver.mjs";
import { FLOW_PROMPT_SPEC_VERSION } from "./FlowPromptBuilder.mjs";
import rpaKind from "./rpa.mjs";

const KNOWN_ACTION_TYPES = new Set([
	"goto",
	"closePage",
	"click",
	"hover",
	"input",
	"press_key",
	"scroll",
	"scroll_show",
	"readPage",
	"readElement",
	"setChecked",
	"setSelect",
	"dialog",
	"uploadFile",
	"run_js",
	"run_ai",
	"ask_assist",
	"selector",
	"wait",
	"invoke",
	"invokeMany",
	"done",
	"abort",
	"branch",
	"download",
]);

const ACTION_SIGNATURES = {
	goto: `{ type: "goto", url: string, postWaitMs?: number }`,
	closePage: `{ type: "closePage", target?: "active"|"flow"|"contextId"|"urlMatch", contextId?: string, matchUrl?: string, ifLast?: "skip"|"fail"|"allow", activateAfterClose?: boolean, postWaitMs?: number }`,
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
	done: `{ type: "done", reason: string, conclusion: { status: "done", value: any }, postWaitMs?: number }`,
	abort: `{ type: "abort", reason: string, postWaitMs?: number }`,
	branch: `{ type: "branch", cases: Array<{ when: object, to: string }>, default?: string }`,
};

const ACTION_ALLOWED_KEYS = {
	goto: new Set(["type", "url", "postWaitMs"]),
	closePage: new Set(["type", "target", "contextId", "matchUrl", "ifLast", "activateAfterClose", "postWaitMs"]),
	click: new Set(["type", "query", "by", "pick", "intent", "expectInputFocus", "postWaitMs"]),
	hover: new Set(["type", "query", "by", "pick", "postWaitMs"]),
	input: new Set(["type", "text", "mode", "clear", "pressEnter", "preEnterWaitMs", "postWaitMs", "caret"]),
	press_key: new Set(["type", "key", "modifiers", "times", "postWaitMs"]),
	scroll: new Set(["type", "x", "y", "query", "by", "postWaitMs"]),
	scroll_show: new Set(["type", "query", "by", "postWaitMs"]),
	readPage: new Set(["type", "field", "postWaitMs"]),
	readElement: new Set(["type", "query", "by", "pick", "multi", "postWaitMs"]),
	setChecked: new Set(["type", "query", "by", "checked", "multi", "postWaitMs"]),
	setSelect: new Set(["type", "query", "by", "choice", "postWaitMs"]),
	dialog: new Set(["type", "op", "kind", "textContains", "value", "postWaitMs"]),
	uploadFile: new Set(["type", "query", "by", "files", "postWaitMs"]),
	run_js: new Set(["type", "scope", "code", "query", "args", "cache", "postWaitMs"]),
	run_ai: new Set(["type", "prompt", "input", "schema", "page", "model", "postWaitMs", "cache"]),
	ask_assist: new Set(["type", "reason", "waitUserAction", "persistAcrossNav", "persistTtlMs", "reopenDelayMs", "tipPollMs", "tipTimeoutMs", "postWaitMs"]),
	selector: new Set(["type", "query", "by", "state", "scope", "autoSwitch", "multi", "pick", "postWaitMs"]),
	wait: new Set(["type", "query", "by", "state", "scope", "autoSwitch", "pick", "timeoutMs", "pollMs", "postWaitMs"]),
	invoke: new Set(["type", "target", "find", "args", "timeoutMs", "onError", "returnTo", "fork", "forkWait", "postWaitMs"]),
	invokeMany: new Set(["type", "items", "target", "find", "args", "concurrency", "continueOnError", "itemVar", "indexVar", "totalVar", "itemTimeoutMs", "timeoutMs", "fork", "forkWait", "returnTo", "postWaitMs"]),
	done: new Set(["type", "reason", "conclusion", "postWaitMs"]),
	abort: new Set(["type", "reason", "postWaitMs"]),
	branch: new Set(["type", "cases", "default"]),
	download: new Set(["type", "url", "query", "by", "beginTimeoutMs", "endTimeoutMs", "waitForEnd", "matchContext", "timeoutMs", "postWaitMs"]),
};

const ACTION_REQUIRED_KEYS = {
	goto: ["url"],
	closePage: [],
	click: ["query"],
	hover: ["query"],
	input: ["text"],
	press_key: ["key"],
	readPage: ["field"],
	readElement: ["query", "pick"],
	setChecked: ["query", "checked"],
	setSelect: ["query", "choice"],
	dialog: ["op"],
	uploadFile: ["query", "files"],
	run_ai: ["prompt"],
	ask_assist: ["reason"],
	selector: ["query"],
	wait: [],
	invoke: [],
	done: ["reason", "conclusion"],
	abort: ["reason"],
	branch: ["cases"],
};

const ALLOWED_BRANCH_OPS = new Set(["exists", "truthy", "eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "match", "and", "or", "not"]);
const ALLOWED_COND_SOURCES = new Set(["args", "opts", "vars", "result"]);
const ALLOWED_FIND_KEYS = new Set(["kind", "must", "prefer", "filter", "rank"]);

function tryParseJSON(text) {
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

function getCapabilityKeys() {
	const caps = (rpaKind && typeof rpaKind === "object" && rpaKind.caps && typeof rpaKind.caps === "object")
		? rpaKind.caps
		: {};
	return Object.keys(caps).sort();
}

function getCapabilityCatalog() {
	const caps = (rpaKind && typeof rpaKind === "object" && rpaKind.caps && typeof rpaKind.caps === "object")
		? rpaKind.caps
		: {};
	const out = {};
	for (const key of Object.keys(caps)) {
		const meta = caps[key] && typeof caps[key] === "object" ? caps[key] : {};
		out[key] = {
			kind: String(meta.kind || ""),
			type: meta.type ? String(meta.type) : undefined,
			values: Array.isArray(meta.values) ? meta.values.slice(0, 24) : undefined,
			desc: typeof meta.desc === "string" ? truncate(meta.desc, 200) : "",
		};
	}
	return out;
}

function getCapabilityKind(key) {
	const caps = (rpaKind && typeof rpaKind === "object" && rpaKind.caps && typeof rpaKind.caps === "object")
		? rpaKind.caps
		: {};
	const meta = caps[String(key || "").trim()];
	return String(meta?.kind || "").trim().toLowerCase();
}

function isResultCapabilityKey(key) {
	const k = String(key || "").trim();
	if (!k) return false;
	const kind = getCapabilityKind(k);
	if (kind === "result") return true;
	return /\.result$/i.test(k);
}

function truncate(text, n = 6000) {
	const s = String(text || "");
	if (s.length <= n) return s;
	return `${s.slice(0, Math.max(0, n - 28))}\n...(truncated)...`;
}

function wrapSkillToFlowEnvelopePrompt(prompt) {
	const base = String(prompt || "").trim();
	const contract = [
		"[OUTPUT CONTRACT - MUST FOLLOW]",
		"Your final output MUST be a run_ai envelope JSON object only.",
		"Allowed envelope forms:",
		"- {\"status\":\"ok\",\"result\":<object>}",
		"- {\"status\":\"error\",\"reason\":\"...\"}",
		"Do NOT output bare result object at top level.",
		"Do NOT output markdown/code fences/explanations.",
	].join("\n");
	return `${contract}\n\n${base}`;
}

async function callAiJson({ prompt, inputValue, model = "advanced", session = null, logger = null, timeoutMs = 600000 }) {
	const debugPrompt = String(process.env.SKILL_TO_FLOW_DEBUG_PROMPT || "").trim() === "1";
	if (debugPrompt) {
		await logger?.info("skill_to_flow.ai.request", {
			model,
			prompt: String(prompt || ""),
			input: inputValue === undefined ? null : inputValue,
		});
	} else {
		await logger?.debug("skill_to_flow.ai.request", {
			model,
			promptLen: String(prompt || "").length,
			inputSize: (() => {
				try { return JSON.stringify(inputValue ?? null).length; } catch (_) { return -1; }
			})(),
		});
	}
	let timer = null;
	const timeoutP = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error("skill_to_flow ai timeout")), Math.max(5000, Number(timeoutMs || 600000)));
	});
	try {
		const p = runAIAction({
			action: { model, prompt: wrapSkillToFlowEnvelopePrompt(prompt), cache: false, timeoutMs },
			inputValue,
			webRpa: null,
			page: null,
			session,
			logger,
		});
		const ai = await Promise.race([p, timeoutP]);
		await logger?.debug("skill_to_flow.ai.response", {
			ok: !!ai?.ok,
			status: String(ai?.envelope?.status || ""),
			reason: ai?.reason || ai?.envelope?.reason || "",
			model: ai?.model || null,
		});
		if (!ai?.ok) return { ok: false, reason: ai?.reason || "ai failed" };
		if (String(ai?.envelope?.status || "").toLowerCase() !== "ok") {
			return { ok: false, reason: ai?.envelope?.reason || "ai envelope error" };
		}
		const res = ai.envelope.result;
		if (res && typeof res === "object") return { ok: true, result: res };
		if (typeof res === "string") {
			const parsed = tryParseJSON(res);
			if (parsed && typeof parsed === "object") return { ok: true, result: parsed };
		}
		return { ok: false, reason: "ai result is not json object" };
	} catch (e) {
		return { ok: false, reason: e?.message || String(e) };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function buildRegeneratePrompt({ capabilityKeys, skillText, plan, taskProfile = null, previousFlow = null, previousErrors = [] }) {
	const base = buildFlowPrompt({ capabilityKeys, skillText, plan, taskProfile });
	return [
		base,
		"",
		"Previous attempt failed validation. Regenerate a NEW full flow from scratch and fix all issues below.",
		"Do not reuse invalid structures from previous flow.",
		"Validation errors to fix:",
		JSON.stringify(previousErrors || [], null, 2),
		"Previous invalid flow (for reference only, do not copy blindly):",
		JSON.stringify(previousFlow || {}, null, 2),
	].join("\n");
}

function buildFlowRevisePrompt({
	capabilityKeys,
	currentFlow,
	userInstruction,
	contextText = "",
	taskProfile = null,
}) {
	const pseudoPlan = {
		goal: "根据用户提示修改现有 flow，输出可执行完整版本",
		steps: [
			{ idHint: "understand_changes", intent: "理解用户修改要求并映射到步骤变更" },
			{ idHint: "rewrite_flow", intent: "重写受影响步骤并保持整体连通性与可执行性" },
			{ idHint: "validate_constraints", intent: "确保 invoke/find/args/模板语法/done 结构符合规范" },
		],
	};
	const base = buildFlowPrompt({
		capabilityKeys,
		skillText: String(contextText || "").trim() || "在现有 flow 基础上按用户提示进行修改",
		plan: pseudoPlan,
		taskProfile,
	});
	return [
		base,
		"",
		"[FLOW REVISION MODE]",
		"你现在不是从零生成，而是修改现有 flow。",
		"必须输出完整 flow（不是 patch / diff）。",
		"尽量保留未被用户要求修改的步骤 id 与结构，降低回归风险。",
		"若步骤使用 saveAs / vars 引用，请同步维护 flow.vars 外壳声明（type/desc/from 可选但建议填写）。",
		"允许并鼓励使用嵌套 dotted args/vars 路径来增强可读性（例如 args.ctx.size、vars.login.ensure）。",
		"如果用户要求与现有逻辑冲突，以用户提示优先，但仍必须满足 RPA spec。",
		"若用户提示不完整，做保守可执行的最佳努力，并在 explanation 里简述假设。",
		"",
		"用户修改要求:",
		String(userInstruction || "").trim(),
		"",
		"当前 flow:",
		JSON.stringify(currentFlow || {}, null, 2),
	].join("\n");
}

function buildFlowReviseRegeneratePrompt({
	capabilityKeys,
	currentFlow,
	userInstruction,
	contextText = "",
	taskProfile = null,
	previousFlow = null,
	previousErrors = [],
}) {
	const base = buildFlowRevisePrompt({
		capabilityKeys,
		currentFlow,
		userInstruction,
		contextText,
		taskProfile,
	});
	return [
		base,
		"",
		"[REVISION REGENERATE MODE]",
		"你必须修复所有校验错误，但保持“修改模式”目标：尽量保留原 step id 与主干结构。",
		"不要从零发散重写；仅在必要范围内做结构调整。",
		"优先保持未涉及用户需求的步骤不变。",
		"",
		"上一次修订产物(有问题):",
		JSON.stringify(previousFlow || {}, null, 2),
		"",
		"必须修复的问题:",
		JSON.stringify(previousErrors || [], null, 2),
	].join("\n");
}

function buildPlanPrompt() {
	return [
		`You generate a compact execution plan for RPA Flow spec v${FLOW_PROMPT_SPEC_VERSION}.`,
		"Return strict JSON only.",
		"Output schema:",
		"{",
		'  "goal": "string",',
		'  "flowIdHint": "snake_case_id",',
		'  "steps": [',
		'    {"idHint":"snake_case","intent":"string","actionTypeHint":"string","why":"string"}',
		"  ],",
		'  "notes": ["string"],',
		'  "risks": ["string"]',
		"}",
		"Rules:",
		"- steps must be atomic and execution-oriented.",
		"- if uncertain, include ask_assist in plan.",
		"- if concrete runtime values are missing in skill text, plan should use parameterized args (do not treat as blocker).",
		"- never return 'insufficient information'; use best-effort query-based steps and ask_assist for uncertain DOM details.",
		"- keep 3-12 steps.",
	].join("\n");
}

function buildTaskProfilePrompt({ capabilityKeys, capabilityCatalog, skillText }) {
	const capsSnippet = capabilityKeys.slice(0, 320).join(", ");
	return [
		`You normalize skill intent against RPA capability catalog (spec v${FLOW_PROMPT_SPEC_VERSION}).`,
		"Return strict JSON only.",
		"Output schema:",
		"{",
		'  "recognized": boolean,',
		'  "reason": "string",',
		'  "mustCaps": string[],',
		'  "preferCaps": string[],',
		'  "allowedArgs": string[],',
		'  "requiredArgs": string[],',
		'  "argNamePolicy": { "primaryQueryArg": "query" }',
		"}",
		"Rules:",
		"- only use keys from capability catalog.",
		"- mustCaps/preferCaps are has-cap matching keys, not execution results.",
		"- NEVER put result-type keys (kind=result or suffix .result) into mustCaps/preferCaps.",
		"- allowedArgs/requiredArgs are FLOW arg names (simple identifiers) that map to arg-type capability keys.",
		"- when capability uses dotted arg key like search.query, normalize to flow arg name query.",
		"- keep arg names canonical and minimal; do NOT output both camelCase and snake_case aliases for same meaning.",
		"- if this is a search-like task, primaryQueryArg must be exactly \"query\".",
		"- requiredArgs should be minimal and strictly necessary.",
		"- if uncertain, still return best-effort recognized=true with conservative key set.",
		`Capability keys subset: ${capsSnippet}`,
		"Capability catalog (compact):",
		JSON.stringify(capabilityCatalog || {}, null, 2),
		"Skill text:",
		truncate(skillText, 12000),
	].join("\n");
}

function buildFlowPrompt({ capabilityKeys, skillText, plan, taskProfile = null }) {
	const capsSnippet = capabilityKeys.slice(0, 260).join(", ");
	const actionUnion = Object.values(ACTION_SIGNATURES).join("\n");
	return [
		`Generate one executable RPA Flow JSON (spec v${FLOW_PROMPT_SPEC_VERSION}) from provided skill text.`,
		"Return strict JSON only: {\"flow\": FlowObject, \"explanation\": string}",
		"FlowObject schema (must follow exactly):",
		"{",
		"  id: string,",
		"  start: string,",
		"  args?: Record<string,{type:string,required?:boolean,desc?:string}>,",
		"  vars?: Record<string,{type?:string,desc?:string,from?:string}>,",
		"  steps: Array<{",
		"    id: string,",
		"    action: ActionUnionMember,",
		"    next?: string | Record<string,string>,",
		"    saveAs?: string | Record<string,any>",
		"  }>",
		"}",
		"Step routing rules:",
		"- for non-branch actions, use next object like {done:'x',failed:'y',timeout:'z',default:'k'} as needed.",
		"- for branch action, route by action.cases/default and keep step.next empty or omitted.",
		"Top-level rules:",
		"- top-level output must have flow.id/start/steps, and can include flow.args/flow.vars as needed.",
		"- if steps use saveAs or reference vars.* templates, declare corresponding entries in flow.vars when possible for readability.",
		"Hard constraints:",
		"- flow must contain id/start/steps.",
		"- step ids unique, snake_case.",
		"- action.type must be valid known actions.",
		"- action fields must strictly match the corresponding action signature.",
		"- for branch action, each case must use structured condition fields (op/source/path/value/items/item/values). NEVER use when.expr.",
		"- branch.when.op must be one of: exists, truthy, eq, neq, gt, gte, lt, lte, in, contains, match, and, or, not.",
		"- branch.when.source must be exactly one of: args, opts, vars, result.",
		"- branch.when.source MUST NOT be interpolation/template string.",
		"- DO NOT use alias fields like selector/value/waitFor/branches/prompt/script/waitMs/read.fields/scrollRounds unless they are part of action signature.",
		"- next references must point to existing step ids when string values are used.",
		"- include done/abort terminal behavior.",
		"- interpolation must use ${path} or ${{...}} only; NEVER use {{...}}.",
		"- ${...} supports safe path only (e.g., ${args.query}, ${vars.x}, ${result.value}); do NOT put operators/logic in ${...}.",
		"- expressions/defaults must use ${{...}} (e.g., ${{ args.timeout || 45000 }}), not ${args.timeout || 45000}.",
		"- do not use markdown code fences.",
		"- invoke.find.must/prefer keys must come from capability keys list.",
		"- if skill text asks to input/search but does not provide concrete constant value, you MUST model it as flow args (e.g., args.query) instead of returning insufficient information.",
		"- do not require concrete runtime values inside skill text; produce reusable parameterized flow with args for missing business inputs.",
		"- for missing optional numbers (like min results), define optional args with sensible defaults in flow logic.",
		"- NEVER refuse with 'insufficient information'. You must output a best-effort executable flow.",
		"- when selectors are unknown, use query-based targeting and add ask_assist fallback; do not block generation.",
		"- when login indicators are unknown, use invoke login_check_current (or login_check_ensure) + ask_assist retry path.",
		"- for click/hover/readElement/setChecked/setSelect/uploadFile/wait actions that already support query, do NOT add an extra selector step just to feed its result into action.query.",
		"- if a selector step is used for probe/branching and its result is reused later, downstream element actions should consume selector via action.by (e.g., \"${vars.sel.by}\") rather than query.",
		"- when both query and by are present on element actions, by should usually reference prior selector output (e.g., \"${vars.sel.by}\"); avoid broad literal by like css:input[type='text'], which can override query and cause wrong target.",
		"- NEVER generate self-recursive invoke calls: if this flow's goal is search, do not invoke search.* from inside the flow.",
		"- NEVER invoke the current flow itself (by target id or by ambiguous find that can resolve back to this flow). For read/list, invoke dedicated sub-capability flows only.",
		"- for search-goal skills, implement with page actions + read.action=list (or equivalent primitives), not invoke search.*.",
		"- for list extraction tasks, prefer invoke + read.action=list over run_ai HTML scraping.",
		"- run_ai for list extraction is only allowed as fallback when read.action=list is impossible or repeatedly fails.",
		"- for main list-reading path, invoke.onError should default to \"fail\". Use onError:\"return\" only for explicit non-critical fallback branches.",
		"- for action.type=\"run_js\", action.code MUST be exactly one JavaScript function expression string (arrow/function), for example: \"(args, opts, vars, result) => { ...; return out; }\".",
		"- for run_js.code, DO NOT output plain function body statements; DO NOT use markdown code fences; DO NOT use IIFE/top-level invocation.",
		"- for run_js.code, assume args/opts/vars/result may be undefined; MUST guard with local defaults first (e.g., const a=args||{}, o=opts||{}, v=vars||{}, r=result||{}).",
		"- for run_js.code, avoid direct property access on raw args/opts/vars/result before null-guarding.",
		"- for action.type=\"input\" with pressEnter=true, action.postWaitMs MUST be a numeric literal between 1000 and 3000.",
		"- for element actions using by (click/hover/input/readElement/setChecked/setSelect/uploadFile/selector/wait), by must be full selector string starting with \"css:\" or \"xpath:\"; NEVER use bare \"css\" or \"xpath\" tokens.",
		"- for login decision: only route to manual login when there is explicit evidence user is not logged in (e.g., login_required flag, visible login wall). If evidence is missing/unknown/target flow not found, default to continue as logged in.",
		"- on weibo search pages, prefer center/main search box in content area; avoid top navigation/header search input.",
		"- for inputting search keyword, avoid relying on previously focused element only: provide explicit input target (query/by) bound to main search box, then submit (pressEnter or click search button) with fallback path.",
		"- when a click step is intended to focus an input before input action, set click.expectInputFocus=true.",
		"- for input-focus flows, do NOT use selector->click chain to focus the input. Prefer direct click query/by on the input (or ask_assist fallback) and keep selector for validation/branch only.",
		"- do NOT set click.query to ${vars.<selector>.query} when expectInputFocus=true; this pattern is brittle and often fails to focus.",
		"- for search-goal flows, standardize primary keyword arg name as flow.args.query and use ${args.query} in input.text.",
		"- after submitting keyword, if result list selector is not found, add fallback submit step (e.g., click search button) before concluding failure.",
		"- for action.type in {invoke,invokeMany}, action.find (if present) MUST be strict FindSpec object with keys only from {kind,must,prefer,filter,rank}.",
		"- for action.type in {invoke,invokeMany}, action.args keys MUST be capability arg keys only; NEVER place capability keys (kind=cap) or result keys (kind=result) inside invoke.args.",
		"- invoke args must use canonical dotted capability keys from rpa.mjs (e.g., \"login.ensure\", \"read.action\"); do NOT use nested objects like {login:{ensure:true}}.",
		"- for loadMore invoke args, only use canonical keys: \"loadMore.target\",\"loadMore.maxTries\",\"loadMore.minNewItems\"; do NOT invent keys like \"loadMore.scrollRounds\"/\"loadMore.waitAfter\".",
		"- for invoke read.* flows, args MUST use dotted read keys: \"read.action\",\"read.target\",\"read.fields\",\"read.requireFields\",\"read.minItems\", etc.",
		"- read.target and loadMore.target (when provided) should be structured objects, not plain strings.",
		"- NEVER use bare keys like \"action\",\"target\",\"fields\",\"requireFields\",\"minItems\" for read invoke args.",
		"- read.output (when provided) must be one of: raw|markdown|json|text.",
		"- for blocker handling, use blockers.clear as invoke arg when you intend to clear overlays; do NOT pass blockers.check as an arg key.",
		"- invoke/invokeMany MUST use capability-based find resolution by default; avoid target alias dependency.",
		"- when action.find.must/prefer uses capability keys from rpa.mjs, action.find.kind MUST be \"rpa\".",
		"- NEVER use action.find.kind=\"capability\"; the registry kind for capability-based matching is \"rpa\".",
		"- for login check and list reading invokes, MUST provide action.find and MUST NOT rely on target-only invoke.",
		"- prefer invoke-based login orchestration over manual login flow steps: use invoke with login capability and pass args.login.ensure=true when goal requires guaranteed login.",
		"- when flow needs login gating, do not implement custom branch/check UI logic as primary path; prefer one invoke login step with args.login.ensure=true, and only use ask_assist as fallback when invoke explicitly fails or reports not logged in.",
		"- NEVER place result-type capability keys (kind=result, usually suffix .result) into find.must or find.prefer; find is for executable capabilities/args matching only.",
		"- when login check invoke cannot resolve target/flow or returns unknown status, default branch should continue main flow (treat as logged-in-unknown), not force manual login.",
		"- flow.args keys MUST align with Task profile allowedArgs/requiredArgs; do not invent new arg names outside profile.",
		"- if Task profile requires query, flow.args.query must exist and input must use ${args.query}.",
		"- flow.args must be minimal: only keep args that are actually referenced by steps (plus required args). Avoid compatibility alias args unless explicitly required by skill text.",
		"- nested args/vars are supported and encouraged for clarity: you may use dotted keys/paths such as flow.args[\"ctx.size\"], flow.vars[\"login.ensure\"], ${args.ctx.size}, ${vars.login.ensure}.",
		"- when multiple related values belong to one concept, prefer grouped dotted naming over many flat unrelated names.",
		"- do NOT add compatibility alias args (e.g., 兼容参数/alias/fallback alias). Keep one canonical arg per meaning.",
		"- saveAs string key MUST be plain var key (e.g. \"center_search_selector\"); NEVER prefix with \"vars.\".",
		"- if capability-to-invoke mapping is uncertain, still generate best-effort invoke.find using canonical capability keys from Task profile; do not refuse generation.",
		"- for domain-specific skills with a clear start page (e.g., weibo search), open that page directly via one goto with absolute https URL constant.",
		"- do NOT add resolve_url/compute_url/url-builder steps unless skill explicitly requires dynamic URL input.",
		"- do NOT define flow.args.url for fixed-site tasks; keep start URL in action.goto.url literal.",
		"- DO NOT use ad-hoc find fields like domain/target/capabilities/required/optional/any/all, and do not use boolean values inside find.",
		"- if find.must/find.prefer is used, each item must be capability key string from the provided key list.",
		"- terminal done action MUST return structured conclusion object: {\"status\":\"done\",\"value\":...}; include main execution result in value (prefer vars.read_result or equivalent).",
		"- if find.filter is used, it must be array of {key:string,value:string}.",
		"- when using read.action=list, always provide read.fields and optionally read.requireFields/read.minItems/read.output.",
		"- when using invoke + read.action=list, choose read.fields based on current domain + entity type, not generic placeholders.",
		"- for social post list (e.g., Weibo/Xiaohongshu/X): prefer fields like postId, url, title/text, authorId, authorName, publishTime, likeCount, commentCount, repostCount, media.",
		"- for article/news list: prefer fields like url, title, summary/snippet, publishTime, source/siteName, author.",
		"- for product list: prefer fields like sku/productId, url, title, price, currency, sales, rating, seller/shop.",
		"- if skill text requests a concrete target (e.g., 微博帖子), read.fields must explicitly reflect that target and include at least one identity field + one content field.",
		"- if fields are uncertain, add read.requireFields for the minimal mandatory subset and keep optional fields in read.fields.",
		`Capability keys subset (from rpa.mjs): ${capsSnippet}`,
		"Action Union signatures:",
		actionUnion,
		"When task text is ambiguous, choose conservative flow and include ask_assist before risky actions.",
		"Input includes `skillText` and optional `plan` hints.",
		"Do not output comments in JSON.",
		"",
		"Task profile hint:",
		JSON.stringify(taskProfile || {}, null, 2),
		"",
		"Skill text:",
		truncate(skillText, 12000),
		"",
		"Plan hint:",
		JSON.stringify(plan || {}, null, 2),
	].join("\n");
}

function buildRepairPrompt({ flow, errors, taskProfile = null }) {
	return [
		`Repair this Flow JSON to satisfy RPA Flow spec v${FLOW_PROMPT_SPEC_VERSION}.`,
		"Return strict JSON only: {\"flow\": FlowObject}",
		"Fix all validation errors. Keep original intent.",
		"Respect Task profile hint when repairing args/capability mapping.",
		"Hard repair rules (must follow exactly):",
		"- for invoke + read capabilities, args MUST use dotted keys: \"read.action\",\"read.target\",\"read.fields\",\"read.requireFields\",\"read.minItems\",\"read.output\".",
		"- NEVER use bare read keys inside invoke.args: action/target/fields/requireFields/minItems/output.",
		"- invoke.find.must/prefer are capability keys; NEVER place result keys (e.g., *.result) there.",
		"- invoke.args keys MUST NOT be capability keys (kind=cap) or result keys (kind=result). Only arg-type capability keys are allowed in invoke.args.",
		"- read.output literal (if provided) must be one of raw|markdown|json|text.",
		"- read.target/loadMore.target (when present) must be object; do NOT use plain string.",
		"- for blocker cleanup intent, use args[\"blockers.clear\"]=true; NEVER use args[\"blockers.check\"].",
		"- done.action.conclusion must be object with {status:\"done\", value:any}; value should carry execution result payload.",
		"- ${...} is safe path only; use ${{...}} for expressions/default values.",
		"- flow.args must be object map: each arg value must be object with key \"type\" (optional: required, desc).",
		"- flow.vars (when present) must be object map: each var value is object (optional: type, desc, from).",
		"- if flow uses saveAs or ${vars.*}, repair should add/keep matching flow.vars entries when possible.",
		"- nested dotted names are valid and encouraged where clearer (e.g., \"ctx.size\", \"login.ensure\").",
		"- do NOT use raw primitive arg defaults in flow.args (e.g., \"query\": \"\").",
		"Mini examples:",
		"- bad: args:{\"action\":\"list\",\"fields\":[\"title\"]}",
		"- good: args:{\"read.action\":\"list\",\"read.fields\":[\"title\"]}",
		"- bad: \"${args.timeout || 45000}\"",
		"- good: \"${{ args.timeout || 45000 }}\"",
		"- bad: flow.args={\"query\":\"\"}",
		"- good: flow.args={\"query\":{\"type\":\"string\",\"required\":true,\"desc\":\"...\"}}",
		"- bad: invoke args includes {\"login.check\":true} (capability key in args)",
		"- good: invoke find.must=[\"login.check\"] + args may include only arg keys like {\"login.ensure\":true}",
		"- bad: done.conclusion=\"success\"",
		"- good: done.conclusion={\"status\":\"done\",\"value\":\"${vars.read_result}\"}",
		"- bad: click {query:\"中部搜索框\", by:\"css:input[type='text']\"}",
		"- good: click {by:\"${vars.middle_search_sel.by}\", expectInputFocus:true}",
		"- bad: selector(saveAs=middle_search_sel) -> click{query:\"${vars.middle_search_sel.query}\", by:\"${vars.middle_search_sel.by}\", expectInputFocus:true}",
		"- good: click{query:\"页面中部主搜索框\", expectInputFocus:true} with ask_assist fallback",
		"- bad: args:{\"loadMore.scrollRounds\":5}",
		"- good: args:{\"scrollRounds\":5} or use only loadMore.target/maxTries/minNewItems for loadMore invoke.",
		"- bad: flow.args contains both minItems and min_items for same meaning.",
		"- good: keep only one canonical arg name (prefer minItems).",
		"Task profile hint:",
		JSON.stringify(taskProfile || {}, null, 2),
		"Validation errors:",
		JSON.stringify(errors || [], null, 2),
		"Current flow:",
		JSON.stringify(flow || {}, null, 2),
	].join("\n");
}

function buildProfilePrompt({ capabilityKeys, skillText, flow }) {
	return [
		`Generate capabilities + filters for this RPA flow (spec v${FLOW_PROMPT_SPEC_VERSION}).`,
		"Return strict JSON only:",
		"{",
		'  "capabilities": { "must": string[], "prefer": string[] },',
		'  "filters": [{ "key": string, "value": string }]',
		"}",
		"Rules:",
		"- capability keys must come from provided capability key list.",
		"- must should be minimal and necessary; prefer can include optional helpful capabilities.",
		"- filters should include domain when task is domain-specific.",
		"- if no clear domain, include {key:\"domain\", value:\"*\"}.",
		"- do not invent keys not in list.",
		`Capability key list: ${capabilityKeys.slice(0, 300).join(", ")}`,
		"Skill text:",
		truncate(skillText, 8000),
		"Flow JSON:",
		JSON.stringify(flow || {}, null, 2),
	].join("\n");
}

function parseDomainsFromText(text) {
	const out = new Set();
	const s = String(text || "");
	const urlRe = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|$)/ig;
	let m;
	while ((m = urlRe.exec(s))) {
		const h = String(m[1] || "").toLowerCase();
		if (h) out.add(h);
	}
	const hostRe = /\b([a-z0-9-]+\.)+[a-z]{2,}\b/ig;
	while ((m = hostRe.exec(s))) {
		const h = String(m[0] || "").toLowerCase();
		if (h && !h.includes("...")) out.add(h);
	}
	return Array.from(out).sort();
}

function parseDomainsFromFlow(flow) {
	const out = new Set();
	const steps = Array.isArray(flow?.steps) ? flow.steps : [];
	for (const st of steps) {
		const url = String(st?.action?.url || "").trim();
		if (!url) continue;
		try {
			const u = new URL(url);
			if (u.hostname) out.add(String(u.hostname).toLowerCase());
		} catch (_) {
		}
	}
	return Array.from(out).sort();
}

function normalizeProfile(profile, capabilityKeys, skillText, flow) {
	const keySet = new Set(capabilityKeys || []);
	const p = (profile && typeof profile === "object") ? profile : {};
	const caps = (p.capabilities && typeof p.capabilities === "object") ? p.capabilities : {};
	const must = Array.isArray(caps.must) ? caps.must : [];
	const prefer = Array.isArray(caps.prefer) ? caps.prefer : [];
	const cleanMust = Array.from(new Set(must.map((x) => String(x || "").trim()).filter((k) => keySet.has(k) && !isResultCapabilityKey(k))));
	const cleanPrefer = Array.from(new Set(prefer.map((x) => String(x || "").trim()).filter((k) => keySet.has(k) && !cleanMust.includes(k) && !isResultCapabilityKey(k))));

	const inFilters = Array.isArray(p.filters) ? p.filters : [];
	const seen = new Set();
	const filters = [];
	for (const f of inFilters) {
		const key = String(f?.key || "").trim();
		const value = String(f?.value || "").trim();
		if (!key || !value) continue;
		const sig = `${key}|${value}`;
		if (seen.has(sig)) continue;
		seen.add(sig);
		filters.push({ key, value });
	}
	const domains = Array.from(new Set([...parseDomainsFromText(skillText), ...parseDomainsFromFlow(flow)]));
	if (!filters.some((f) => f.key === "domain")) {
		if (domains.length === 1) filters.push({ key: "domain", value: domains[0] });
		else filters.push({ key: "domain", value: "*" });
	}
	return {
		capabilities: { must: cleanMust, prefer: cleanPrefer },
		filters,
	};
}

function normalizeTaskProfile(raw, capabilityCatalog) {
	const cat = capabilityCatalog && typeof capabilityCatalog === "object" ? capabilityCatalog : {};
	const isKnown = (k) => Object.prototype.hasOwnProperty.call(cat, k);
	const kindOf = (k) => String(cat[k]?.kind || "").toLowerCase();
	const toFlowArgNames = (capKey) => {
		const key = String(capKey || "").trim();
		if (!key) return [];
		const names = new Set();
		const last = key.includes(".") ? key.split(".").pop() : key;
		if (last) {
			names.add(last);
		}
		if (/\.query$/i.test(key)) names.add("query");
		return Array.from(names).filter(Boolean);
	};
	const p = raw && typeof raw === "object" ? raw : {};
	const disallowFlowArgs = new Set(["url", "domain", "platform"]);
	const toClean = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).map((x) => String(x || "").trim()).filter(Boolean)));
	const mustCaps = toClean(p.mustCaps).filter((k) => isKnown(k) && !isResultCapabilityKey(k));
	const preferCaps = toClean(p.preferCaps).filter((k) => isKnown(k) && !isResultCapabilityKey(k) && !mustCaps.includes(k));
	const allowedCapArgs = toClean(p.allowedArgs).filter((k) => isKnown(k) && kindOf(k) === "arg");
	const requiredCapArgs = toClean(p.requiredArgs).filter((k) => allowedCapArgs.includes(k));
	const allowedArgs = Array.from(new Set(allowedCapArgs.flatMap((k) => toFlowArgNames(k)).filter((n) => !disallowFlowArgs.has(n))));
	const requiredArgs = Array.from(new Set(requiredCapArgs.flatMap((k) => toFlowArgNames(k)).filter((n) => allowedArgs.includes(n))));
	const primaryQueryArg = String(p?.argNamePolicy?.primaryQueryArg || "").trim() || "query";
	if (!allowedArgs.includes(primaryQueryArg)) allowedArgs.push(primaryQueryArg);
	if (!requiredArgs.includes(primaryQueryArg)) requiredArgs.push(primaryQueryArg);
	return {
		recognized: p.recognized !== false,
		reason: String(p.reason || ""),
		mustCaps,
		preferCaps,
		allowedArgs,
		requiredArgs,
		argNamePolicy: { primaryQueryArg },
	};
}

function deriveCapabilitiesHeuristic(flow, capabilityKeys) {
	const keySet = new Set(capabilityKeys || []);
	const must = new Set();
	const prefer = new Set();
	const steps = Array.isArray(flow?.steps) ? flow.steps : [];
	for (const st of steps) {
		const action = st?.action || {};
		const t = String(action.type || "");
		if (t === "invoke") {
			const invokeArgs = (action.args && typeof action.args === "object") ? action.args : {};
			for (const rawKey of Object.keys(invokeArgs)) {
				const key = String(rawKey || "").trim();
				if (!key) continue;
				if (keySet.has(key) && !isResultCapabilityKey(key)) must.add(key);
				const root = key.split(".")[0];
				if (root && keySet.has(root)) must.add(root);
			}
			const readAction = String(invokeArgs["read.action"] || "").trim();
			if (readAction && keySet.has(`read.${readAction}`)) must.add(`read.${readAction}`);
			const searchTarget = String(invokeArgs["search.target"] || "").trim();
			if (searchTarget && keySet.has("search.target")) must.add("search.target");
		}
		if (t === "invokeMany") {
			const invokeArgs = (action.args && typeof action.args === "object") ? action.args : {};
			for (const rawKey of Object.keys(invokeArgs)) {
				const key = String(rawKey || "").trim();
				if (!key) continue;
				if (keySet.has(key) && !isResultCapabilityKey(key)) must.add(key);
				const root = key.split(".")[0];
				if (root && keySet.has(root)) must.add(root);
			}
		}
		if (t === "run_ai" && keySet.has("ai")) prefer.add("ai");
		if (t === "download" && keySet.has("download.action")) must.add("download.action");
	}
	if (!must.size) {
		for (const st of steps) {
			const find = (st?.action?.find && typeof st.action.find === "object") ? st.action.find : {};
			for (const k of (Array.isArray(find.must) ? find.must : [])) {
				const s = String(k || "").trim();
				if (keySet.has(s)) must.add(s);
			}
		}
	}
	return {
		capabilities: {
			must: Array.from(must).sort(),
			prefer: Array.from(prefer).sort(),
		},
	};
}

function collectNextRefs(nextObj) {
	if (!nextObj || typeof nextObj !== "object") return [];
	const out = [];
	for (const v of Object.values(nextObj)) {
		if (typeof v === "string" && v.trim()) out.push(v.trim());
	}
	return out;
}

function collectStringLeaves(v, out = []) {
	if (typeof v === "string") {
		out.push(v);
		return out;
	}
	if (Array.isArray(v)) {
		for (const x of v) collectStringLeaves(x, out);
		return out;
	}
	if (v && typeof v === "object") {
		for (const x of Object.values(v)) collectStringLeaves(x, out);
	}
	return out;
}

function collectArgRefsFromFlow(flow) {
	const refs = new Set();
	const steps = Array.isArray(flow?.steps) ? flow.steps : [];
	for (const step of steps) {
		const leaves = collectStringLeaves(step);
		for (const s of leaves) {
			const text = String(s || "");
			for (const m of text.matchAll(/\bargs\.([A-Za-z0-9_][A-Za-z0-9_.\[\]-]*)\b/g)) {
				const k = String(m[1] || "").trim();
				if (k) refs.add(k);
			}
		}
	}
	return refs;
}

function hasArgDefForRef(argDefs, refPath) {
	const defs = (argDefs && typeof argDefs === "object" && !Array.isArray(argDefs)) ? argDefs : {};
	const ref = String(refPath || "").trim();
	if (!ref) return false;
	if (Object.prototype.hasOwnProperty.call(defs, ref)) return true;
	const segs = ref.split(".").filter(Boolean);
	if (!segs.length) return false;
	const root = segs[0];
	if (Object.prototype.hasOwnProperty.call(defs, root)) return true;
	for (let i = segs.length - 1; i >= 2; i -= 1) {
		const prefix = segs.slice(0, i).join(".");
		if (Object.prototype.hasOwnProperty.call(defs, prefix)) return true;
	}
	return false;
}

function isArgKeyAllowedByProfile(key, allowedArgs = []) {
	const k = String(key || "").trim();
	if (!k) return false;
	if (allowedArgs.includes(k)) return true;
	const root = k.split(".")[0];
	return !!root && allowedArgs.includes(root);
}

function isArgKeyReferenced(key, referencedArgs) {
	const k = String(key || "").trim();
	if (!k) return false;
	const refs = referencedArgs instanceof Set ? referencedArgs : new Set();
	if (refs.has(k)) return true;
	for (const ref of refs) {
		const r = String(ref || "").trim();
		if (!r) continue;
		if (r.startsWith(`${k}.`) || k.startsWith(`${r}.`)) return true;
	}
	return false;
}

function validateRunJsFunctionCode(codeStr) {
	const src = String(codeStr || "").trim();
	if (!src) return { ok: false, reason: "empty code" };
	if (/\)\s*\(\s*\)\s*;?\s*$/.test(src) || /\}\s*\(\s*\)\s*;?\s*$/.test(src)) {
		return { ok: false, reason: "top-level invocation (IIFE) is not allowed" };
	}
	try {
		const fn = new Function('"use strict"; return (' + src + ");")();
		if (typeof fn !== "function") return { ok: false, reason: "code does not evaluate to a function" };
		return { ok: true };
	} catch (_) {
		return { ok: false, reason: "cannot compile to a function" };
	}
}

function normalizeSaveAsVarKeyForValidation(key) {
	const s = String(key || "").trim();
	if (!s) return "";
	if (s.startsWith("vars.")) return String(s.slice(5)).trim();
	return s;
}

function parseVarsTemplatePath(raw) {
	const s = String(raw || "").trim();
	const m = s.match(/^\$\{vars\.([a-zA-Z0-9_.\[\]-]+)\}$/);
	return m ? String(m[1] || "").trim() : "";
}

function isSafeTemplatePathExpr(expr) {
	const s = String(expr || "").trim();
	if (!s) return false;
	const ident = "[A-Za-z_$][A-Za-z0-9_$]*";
	const token = `(?:\\.${ident}|\\[[0-9]+\\])`;
	const re = new RegExp(`^${ident}(?:${token})*$`);
	return re.test(s);
}

function validateFlow(flow, opts = {}) {
	const errors = [];
	const capabilityCatalog = (opts?.capabilityCatalog && typeof opts.capabilityCatalog === "object")
		? opts.capabilityCatalog
		: null;
	const isKnownCapabilityKey = (k) => !!(capabilityCatalog && Object.prototype.hasOwnProperty.call(capabilityCatalog, String(k || "").trim()));
	if (!flow || typeof flow !== "object") {
		return ["flow must be object"];
	}
	if (typeof flow.id !== "string" || !flow.id.trim()) errors.push("flow.id is required");
	if (typeof flow.start !== "string" || !flow.start.trim()) errors.push("flow.start is required");
	if (!Array.isArray(flow.steps) || !flow.steps.length) errors.push("flow.steps must be non-empty array");
	if (flow.args !== undefined) {
		if (!flow.args || typeof flow.args !== "object" || Array.isArray(flow.args)) {
			errors.push("flow.args must be an object when provided");
		} else {
			for (const [argName, argSpec] of Object.entries(flow.args)) {
				const name = String(argName || "").trim();
				if (!name) {
					errors.push("flow.args contains empty arg key");
					continue;
				}
				if (!argSpec || typeof argSpec !== "object" || Array.isArray(argSpec)) {
					errors.push(`flow.args.${name} must be object with at least {type}`);
					continue;
				}
				const t = String(argSpec.type || "").trim();
				if (!t) errors.push(`flow.args.${name}.type is required`);
				if (argSpec.required !== undefined && typeof argSpec.required !== "boolean") {
					errors.push(`flow.args.${name}.required must be boolean when provided`);
				}
				if (argSpec.desc !== undefined && typeof argSpec.desc !== "string") {
					errors.push(`flow.args.${name}.desc must be string when provided`);
				}
				for (const extraKey of Object.keys(argSpec)) {
					if (!["type", "required", "desc"].includes(String(extraKey || ""))) {
						errors.push(`flow.args.${name}.${extraKey} is not allowed (only type/required/desc)`);
					}
				}
				const descText = String(argSpec.desc || "").toLowerCase();
				if (descText && (descText.includes("兼容") || descText.includes("alias"))) {
					errors.push(`flow.args.${name} should not be a compatibility alias; keep canonical args only`);
				}
			}
		}
	}
	if (flow.vars !== undefined) {
		if (!flow.vars || typeof flow.vars !== "object" || Array.isArray(flow.vars)) {
			errors.push("flow.vars must be an object when provided");
		} else {
			for (const [varName, varSpec] of Object.entries(flow.vars)) {
				const name = String(varName || "").trim();
				if (!name) {
					errors.push("flow.vars contains empty var key");
					continue;
				}
				if (!varSpec || typeof varSpec !== "object" || Array.isArray(varSpec)) {
					errors.push(`flow.vars.${name} must be object (optional keys: type/desc/from)`);
					continue;
				}
				if (varSpec.type !== undefined && typeof varSpec.type !== "string") {
					errors.push(`flow.vars.${name}.type must be string when provided`);
				}
				if (varSpec.desc !== undefined && typeof varSpec.desc !== "string") {
					errors.push(`flow.vars.${name}.desc must be string when provided`);
				}
				if (varSpec.from !== undefined && typeof varSpec.from !== "string") {
					errors.push(`flow.vars.${name}.from must be string when provided`);
				}
				for (const extraKey of Object.keys(varSpec)) {
					if (!["type", "desc", "from"].includes(String(extraKey || ""))) {
						errors.push(`flow.vars.${name}.${extraKey} is not allowed (only type/desc/from)`);
					}
				}
			}
		}
	}
	if (errors.length) return errors;
	const ids = new Set();
	for (const step of flow.steps) {
		if (!step || typeof step !== "object") {
			errors.push("step must be object");
			continue;
		}
		const id = String(step.id || "").trim();
		if (!id) errors.push("step.id is required");
		if (id && ids.has(id)) errors.push(`duplicate step.id: ${id}`);
		if (id) ids.add(id);
		const saveAs = step.saveAs;
		if (typeof saveAs === "string" && String(saveAs || "").trim().startsWith("vars.")) {
			errors.push(`step ${id || "?"} saveAs must not start with "vars." (use key name only)`);
		}
		if (saveAs && typeof saveAs === "object" && !Array.isArray(saveAs)) {
			for (const k of Object.keys(saveAs)) {
				if (String(k || "").trim().startsWith("vars.")) {
					errors.push(`step ${id || "?"} saveAs key "${k}" must not start with "vars."`);
				}
			}
		}
		const actionType = String(step?.action?.type || "").trim();
		if (!actionType) errors.push(`step ${id || "?"} missing action.type`);
		else if (!KNOWN_ACTION_TYPES.has(actionType)) errors.push(`step ${id || "?"} has unknown action.type: ${actionType}`);
		if (actionType && KNOWN_ACTION_TYPES.has(actionType)) {
			const action = step.action && typeof step.action === "object" ? step.action : {};
			const allowed = ACTION_ALLOWED_KEYS[actionType];
			if (allowed) {
				for (const k of Object.keys(action)) {
					if (!allowed.has(k)) errors.push(`step ${id || "?"} action.${k} is not allowed for type=${actionType}`);
				}
			}
			const req = ACTION_REQUIRED_KEYS[actionType] || [];
			for (const k of req) {
				if (!(k in action)) errors.push(`step ${id || "?"} missing required action.${k} for type=${actionType}`);
			}
			if (typeof action.by === "string" && action.by.trim()) {
				const by = action.by.trim();
				const byIsVarRef = /^\$\{vars\.[A-Za-z0-9_.\[\]-]+\}$/.test(by);
				if (!byIsVarRef && !by.startsWith("css:") && !by.startsWith("xpath:")) {
					errors.push(`step ${id || "?"} action.by must start with "css:" or "xpath:"`);
				}
			}
			if (actionType === "wait" && !("query" in action) && !("by" in action)) {
				errors.push(`step ${id || "?"} wait requires query or by`);
			}
			if (actionType === "closePage") {
				const target = String(action.target || "active").trim();
				if (!["active", "flow", "contextId", "urlMatch"].includes(target)) {
					errors.push(`step ${id || "?"} closePage.target must be active|flow|contextId|urlMatch`);
				}
				if (target === "contextId" && !String(action.contextId || "").trim()) {
					errors.push(`step ${id || "?"} closePage target=contextId requires action.contextId`);
				}
				if (target === "urlMatch" && !String(action.matchUrl || "").trim()) {
					errors.push(`step ${id || "?"} closePage target=urlMatch requires action.matchUrl`);
				}
				if (action.ifLast !== undefined) {
					const ifLast = String(action.ifLast || "").trim();
					if (!["skip", "fail", "allow"].includes(ifLast)) {
						errors.push(`step ${id || "?"} closePage.ifLast must be skip|fail|allow`);
					}
				}
			}
			if ((actionType === "click" || actionType === "hover" || actionType === "readElement" || actionType === "setChecked" || actionType === "setSelect" || actionType === "uploadFile" || actionType === "wait")) {
				const by = String(action.by || "").trim();
				const hasQuery = Object.prototype.hasOwnProperty.call(action, "query");
				const hasBy = !!by;
				const byLooksLiteralSelector = /^css\s*:|^xpath\s*:|^(\/\/|\/|\(|\.\/|\.\.\/)/i.test(by);
				const byLooksVarsRef = /^\$\{vars\.[A-Za-z0-9_.\[\]-]+\}$/.test(by);
				if (hasQuery && hasBy && byLooksLiteralSelector && !byLooksVarsRef) {
					errors.push(`step ${id || "?"} has both query and literal by; use query only, or use by as selector var ref like \${vars.xxx.by}`);
				}
			}
			if (actionType === "run_js") {
				if (typeof action.code !== "string" || !action.code.trim()) {
					errors.push(`step ${id || "?"} run_js requires non-empty action.code`);
				} else {
					const runJsCheck = validateRunJsFunctionCode(action.code);
					if (!runJsCheck.ok) {
						errors.push(`step ${id || "?"} run_js.code invalid: ${runJsCheck.reason}`);
					}
				}
			}
			if (actionType === "input" && action.pressEnter === true) {
				const w = action.postWaitMs;
				if (typeof w !== "number" || !Number.isFinite(w) || w < 1000 || w > 3000) {
					errors.push(`step ${id || "?"} input with pressEnter=true requires action.postWaitMs in [1000,3000]`);
				}
			}
			if (actionType === "invoke" || actionType === "invokeMany") {
				const find = action.find;
				const argsObj = action.args && typeof action.args === "object" && !Array.isArray(action.args) ? action.args : null;
				if (argsObj && argsObj.login && typeof argsObj.login === "object" && !Array.isArray(argsObj.login) && Object.prototype.hasOwnProperty.call(argsObj.login, "ensure")) {
					errors.push(`step ${id || "?"} invoke args must use dotted key "login.ensure" instead of nested args.login.ensure`);
				}
				if (argsObj) {
					for (const rawArgKey of Object.keys(argsObj)) {
						const argKey = String(rawArgKey || "").trim();
						if (!argKey) continue;
						if (capabilityCatalog && !isKnownCapabilityKey(argKey)) {
							errors.push(`step ${id || "?"} invoke args contains unknown capability key "${argKey}"`);
						}
						const kind = getCapabilityKind(argKey);
						if (kind === "cap") {
							errors.push(`step ${id || "?"} invoke args must not include capability key "${argKey}" (kind=cap)`);
						}
						if (kind === "result") {
							errors.push(`step ${id || "?"} invoke args must not include result key "${argKey}" (kind=result)`);
						}
					}
					const hasBareReadKeys = ["action", "target", "fields", "requireFields", "minItems", "maxItems", "filter", "sort", "output"]
						.some((k) => Object.prototype.hasOwnProperty.call(argsObj, k));
					if (hasBareReadKeys) {
						errors.push(`step ${id || "?"} invoke read args must use dotted keys (e.g. "read.action"), not bare keys like action/target/fields`);
					}
					if (Object.prototype.hasOwnProperty.call(argsObj, "blockers.check")) {
						errors.push(`step ${id || "?"} should not pass invoke arg "blockers.check"; use "blockers.clear" for cleanup intent`);
					}
					if (Object.prototype.hasOwnProperty.call(argsObj, "read.output")) {
						const ro = String(argsObj["read.output"] || "").trim();
						if (ro && !ro.startsWith("${") && !["raw", "markdown", "json", "text"].includes(ro)) {
							errors.push(`step ${id || "?"} args["read.output"] must be one of raw|markdown|json|text`);
						}
					}
					if (Object.prototype.hasOwnProperty.call(argsObj, "read.target")) {
						const rt = argsObj["read.target"];
						if (rt !== undefined && (typeof rt !== "object" || rt === null || Array.isArray(rt))) {
							errors.push(`step ${id || "?"} args["read.target"] must be object when provided`);
						}
					}
					if (Object.prototype.hasOwnProperty.call(argsObj, "loadMore.target")) {
						const lt = argsObj["loadMore.target"];
						if (lt !== undefined && (typeof lt !== "object" || lt === null || Array.isArray(lt))) {
							errors.push(`step ${id || "?"} args["loadMore.target"] must be object when provided`);
						}
					}
				}
				if (actionType === "invoke" && !find) {
					errors.push(`step ${id || "?"} invoke should use action.find (target-only invoke is not allowed in generated skill flow)`);
				}
				if (find !== undefined) {
					if (!find || typeof find !== "object" || Array.isArray(find)) {
						errors.push(`step ${id || "?"} action.find must be object when provided`);
					} else {
						for (const k of Object.keys(find)) {
							if (!ALLOWED_FIND_KEYS.has(k)) {
								errors.push(`step ${id || "?"} action.find.${k} is not allowed`);
							}
						}
						for (const [k, v] of Object.entries(find)) {
							if (typeof v === "boolean") {
								errors.push(`step ${id || "?"} action.find.${k} must not be boolean`);
							}
						}
						if ("must" in find && !Array.isArray(find.must)) {
							errors.push(`step ${id || "?"} action.find.must must be array`);
						} else if (Array.isArray(find.must)) {
							for (const capKey of find.must) {
								if (isResultCapabilityKey(capKey)) {
									errors.push(`step ${id || "?"} action.find.must must not contain result-type key: ${String(capKey || "")}`);
								}
							}
						}
						if ("prefer" in find && !Array.isArray(find.prefer)) {
							errors.push(`step ${id || "?"} action.find.prefer must be array`);
						} else if (Array.isArray(find.prefer)) {
							for (const capKey of find.prefer) {
								if (isResultCapabilityKey(capKey)) {
									errors.push(`step ${id || "?"} action.find.prefer must not contain result-type key: ${String(capKey || "")}`);
								}
							}
						}
						const mustCaps = Array.isArray(find.must) ? find.must.filter((x) => String(x || "").trim()) : [];
						const preferCaps = Array.isArray(find.prefer) ? find.prefer.filter((x) => String(x || "").trim()) : [];
						if (mustCaps.length || preferCaps.length) {
							const kind = String(find.kind || "").trim();
							if (kind !== "rpa") {
								errors.push(`step ${id || "?"} action.find.kind must be "rpa" when using find.must/find.prefer`);
							}
						}
						const allCaps = [...mustCaps, ...preferCaps].map((x) => String(x || "").trim());
						const isReadInvoke = allCaps.some((k) => k === "read" || k.startsWith("read."));
						if (isReadInvoke && argsObj && !Object.prototype.hasOwnProperty.call(argsObj, "read.action")) {
							errors.push(`step ${id || "?"} invoke with read capability must provide args["read.action"]`);
						}
						if ("filter" in find) {
							if (!Array.isArray(find.filter)) {
								errors.push(`step ${id || "?"} action.find.filter must be array`);
							} else {
								find.filter.forEach((f, idx) => {
									if (!f || typeof f !== "object" || Array.isArray(f)) {
										errors.push(`step ${id || "?"} action.find.filter[${idx}] must be object`);
										return;
									}
									if (typeof f.key !== "string" || !f.key.trim()) {
										errors.push(`step ${id || "?"} action.find.filter[${idx}].key must be non-empty string`);
									}
									if (typeof f.value !== "string" || !f.value.trim()) {
										errors.push(`step ${id || "?"} action.find.filter[${idx}].value must be non-empty string`);
									}
								});
							}
						}
					}
				}
			}
			if (actionType === "branch") {
				if (!Array.isArray(action.cases) || !action.cases.length) {
					errors.push(`step ${id || "?"} branch.cases must be non-empty array`);
				} else {
					const walkCond = (cond, pathLabel) => {
						if (!cond || typeof cond !== "object") {
							errors.push(`step ${id || "?"} ${pathLabel} must be object`);
							return;
						}
						const op = String(cond.op || "").trim();
						if (!ALLOWED_BRANCH_OPS.has(op)) {
							errors.push(`step ${id || "?"} ${pathLabel}.op invalid: ${op || "(empty)"}`);
							return;
						}
						if (op === "and" || op === "or") {
							if (!Array.isArray(cond.items) || !cond.items.length) {
								errors.push(`step ${id || "?"} ${pathLabel}.items must be non-empty array for op=${op}`);
								return;
							}
							cond.items.forEach((c, idx) => walkCond(c, `${pathLabel}.items[${idx}]`));
							return;
						}
						if (op === "not") {
							if (!cond.item || typeof cond.item !== "object") {
								errors.push(`step ${id || "?"} ${pathLabel}.item must be object for op=not`);
								return;
							}
							walkCond(cond.item, `${pathLabel}.item`);
							return;
						}
						const source = String(cond.source || "args").trim();
						if (!ALLOWED_COND_SOURCES.has(source)) {
							errors.push(`step ${id || "?"} ${pathLabel}.source invalid: ${source}`);
						}
						if (source.includes("${")) {
							errors.push(`step ${id || "?"} ${pathLabel}.source must not be interpolation`);
						}
						if (typeof cond.path !== "string" || !String(cond.path).trim()) {
							errors.push(`step ${id || "?"} ${pathLabel}.path is required for op=${op}`);
						}
						if (op === "eq" || op === "neq" || op === "contains" || op === "gt" || op === "gte" || op === "lt" || op === "lte") {
							if (!Object.prototype.hasOwnProperty.call(cond, "value")) {
								errors.push(`step ${id || "?"} ${pathLabel}.value is required for op=${op}`);
							}
						}
						if (op === "in") {
							if (!Array.isArray(cond.values) || !cond.values.length) {
								errors.push(`step ${id || "?"} ${pathLabel}.values must be non-empty array for op=in`);
							}
						}
						if (op === "match") {
							const rx = String(cond.regex || cond.pattern || "").trim();
							if (!rx) {
								errors.push(`step ${id || "?"} ${pathLabel}.regex is required for op=match`);
							}
						}
					};
					action.cases.forEach((c, idx) => {
						if (!c || typeof c !== "object") {
							errors.push(`step ${id || "?"} branch.cases[${idx}] must be object`);
							return;
						}
						if (typeof c.to !== "string" || !c.to.trim()) {
							errors.push(`step ${id || "?"} branch.cases[${idx}].to is required`);
						}
						walkCond(c.when, `branch.cases[${idx}].when`);
					});
				}
			}
			if (actionType === "done") {
				const c = action.conclusion;
				if (!c || typeof c !== "object" || Array.isArray(c)) {
					errors.push(`step ${id || "?"} done.conclusion must be object {status:\"done\", value:any}`);
				} else {
					if (String(c.status || "").trim().toLowerCase() !== "done") {
						errors.push(`step ${id || "?"} done.conclusion.status must be "done"`);
					}
					if (!Object.prototype.hasOwnProperty.call(c, "value")) {
						errors.push(`step ${id || "?"} done.conclusion.value is required`);
					}
				}
			}
		}
		const strings = collectStringLeaves(step);
		for (const s of strings) {
			// Disallow raw mustache like {{x}}, but keep spec-compliant ${{...}}.
			if (/(^|[^$])\{\{/.test(s)) {
				errors.push(`step ${id || "?"} contains non-spec interpolation '{{...}}', use \${...} or \${{...}}`);
				break;
			}
			const singles = String(s).matchAll(/\$\{(?!\{)([^}]+)\}/g);
			for (const m of singles) {
				const expr = String(m[1] || "").trim();
				if (!isSafeTemplatePathExpr(expr)) {
					errors.push(`step ${id || "?"} uses non-path interpolation "\${${expr}}"; use safe path in \${...} or move expression to \${{...}}`);
					break;
				}
			}
		}
	}
	const selectorSaveAsRoots = new Set();
	for (const step of flow.steps) {
		const actionType = String(step?.action?.type || "").trim();
		if (actionType !== "selector") continue;
		const saveAs = step?.saveAs;
		if (typeof saveAs === "string") {
			const key = normalizeSaveAsVarKeyForValidation(saveAs);
			if (!key) continue;
			const root = key.split(".")[0] || key;
			if (root) selectorSaveAsRoots.add(root);
			continue;
		}
		if (saveAs && typeof saveAs === "object" && !Array.isArray(saveAs)) {
			for (const k of Object.keys(saveAs)) {
				const key = normalizeSaveAsVarKeyForValidation(k);
				if (!key) continue;
				const root = key.split(".")[0] || key;
				if (root) selectorSaveAsRoots.add(root);
			}
		}
	}
	const queryAwareTypes = new Set(["click", "hover", "readElement", "setChecked", "setSelect", "uploadFile", "wait", "selector"]);
	for (const step of flow.steps) {
		const sid = String(step?.id || "?");
		const action = step?.action && typeof step.action === "object" ? step.action : {};
		const actionType = String(action.type || "").trim();
		if (!queryAwareTypes.has(actionType)) continue;
		const queryPath = parseVarsTemplatePath(action.query);
		if (!queryPath) continue;
		const root = queryPath.split(".")[0] || "";
		if (!root || !selectorSaveAsRoots.has(root)) continue;
		const byPath = parseVarsTemplatePath(action.by);
		if (byPath && byPath.startsWith(`${root}.by`)) continue;
		errors.push(`step ${sid} uses selector-result var "${root}" as action.query; use action.by (e.g. \${vars.${root}.by}) or direct natural-language query`);
	}
	const stepById = new Map(flow.steps.map((s) => [String(s?.id || ""), s]));
	for (const step of flow.steps) {
		const sid = String(step?.id || "?");
		const action = step?.action && typeof step.action === "object" ? step.action : {};
		const actionType = String(action.type || "").trim();
		if (actionType === "click" && action.expectInputFocus === true) {
			const qPath = parseVarsTemplatePath(action.query);
			if (qPath) {
				errors.push(`step ${sid} click.expectInputFocus should not use selector-var query (${String(action.query || "")}); use direct query/by strategy`);
			}
		}
		if (actionType === "selector") {
			const nextDone = typeof step?.next?.done === "string" ? String(step.next.done) : "";
			const nxt = nextDone ? stepById.get(nextDone) : null;
			const nextAction = nxt?.action && typeof nxt.action === "object" ? nxt.action : null;
			if (nextAction && String(nextAction.type || "") === "click" && nextAction.expectInputFocus === true) {
				errors.push(`step ${sid} should not feed selector directly into click.expectInputFocus chain; use direct click query/by with fallback`);
			}
		}
	}
	if (flow.start && !ids.has(String(flow.start))) errors.push("flow.start not found in steps");
	const argDefs = (flow.args && typeof flow.args === "object" && !Array.isArray(flow.args)) ? flow.args : {};
	const referencedArgs = collectArgRefsFromFlow(flow);
	const aliasGroup = new Map();
	for (const k of Object.keys(argDefs)) {
		const norm = String(k || "").toLowerCase().replace(/_/g, "");
		if (!norm) continue;
		if (!aliasGroup.has(norm)) aliasGroup.set(norm, []);
		aliasGroup.get(norm).push(k);
	}
	for (const names of aliasGroup.values()) {
		if (names.length > 1) {
			errors.push(`flow.args has redundant alias names for same meaning: ${names.join(", ")}`);
		}
	}
	const taskProfile = (opts && typeof opts === "object" && opts.taskProfile && typeof opts.taskProfile === "object")
		? opts.taskProfile
		: null;
	if (taskProfile) {
		const allowedArgs = Array.isArray(taskProfile.allowedArgs) ? taskProfile.allowedArgs : [];
		const requiredArgs = Array.isArray(taskProfile.requiredArgs) ? taskProfile.requiredArgs : [];
		const primaryQueryArg = String(taskProfile?.argNamePolicy?.primaryQueryArg || "").trim();
		if (allowedArgs.length) {
			for (const k of Object.keys(argDefs)) {
				if (!isArgKeyAllowedByProfile(k, allowedArgs)) {
					errors.push(`flow.args.${k} is not allowed by task profile`);
				}
			}
		}
		for (const req of requiredArgs) {
			if (!(req in argDefs)) errors.push(`flow.args.${req} is required by task profile`);
		}
		for (const k of Object.keys(argDefs)) {
			if (!requiredArgs.includes(k) && !isArgKeyReferenced(k, referencedArgs)) {
				errors.push(`flow.args.${k} is unused; remove redundant arg definitions`);
			}
		}
		if (primaryQueryArg && primaryQueryArg === "query" && !("query" in argDefs)) {
			errors.push("flow.args.query is required by task profile primaryQueryArg=query");
		}
	}
	for (const ref of referencedArgs) {
		if (!hasArgDefForRef(argDefs, ref)) {
			errors.push(`flow references args.${ref} but flow.args.${ref} is not defined`);
		}
	}
	for (const step of flow.steps) {
		const sid = String(step?.id || "?");
		const action = step?.action || {};
		if (String(action?.type || "") === "input" && typeof action.text === "string") {
			const refs = Array.from(action.text.matchAll(/\$\{args\.([A-Za-z0-9_][A-Za-z0-9_.\[\]-]*)\}/g)).map((m) => String(m[1] || "").trim()).filter(Boolean);
			for (const ref of refs) {
				if (!hasArgDefForRef(argDefs, ref)) {
					errors.push(`step ${sid} references args.${ref} in action.text but flow.args.${ref} is not defined`);
				}
			}
		}
	}
	for (const step of flow.steps) {
		const sid = String(step?.id || "?");
		for (const ref of collectNextRefs(step?.next)) {
			if (!ids.has(ref)) errors.push(`step ${sid} next references unknown step: ${ref}`);
		}
	}
	const actionTypes = new Set(flow.steps.map((s) => String(s?.action?.type || "")));
	const hasLoginEnsureInvoke = flow.steps.some((s) => {
		const action = s?.action;
		if (!action || String(action.type || "") !== "invoke") return false;
		const argsObj = action.args && typeof action.args === "object" && !Array.isArray(action.args) ? action.args : {};
		const v = argsObj["login.ensure"];
		return v === true || String(v || "").trim().toLowerCase() === "true";
	});
	const hasLoginAskAssist = flow.steps.some((s) => {
		const action = s?.action;
		if (!action || String(action.type || "") !== "ask_assist") return false;
		const reason = String(action.reason || "").toLowerCase();
		return reason.includes("登录") || reason.includes("login");
	});
	const hasLoginCheckInvoke = flow.steps.some((s) => {
		const action = s?.action;
		if (!action || String(action.type || "") !== "invoke") return false;
		const find = action.find && typeof action.find === "object" ? action.find : {};
		const must = Array.isArray(find.must) ? find.must : [];
		const prefer = Array.isArray(find.prefer) ? find.prefer : [];
		const tokens = [...must, ...prefer].map((x) => String(x || "").trim());
		return tokens.includes("login.check") || tokens.includes("login.ensure");
	});
	if (hasLoginAskAssist && hasLoginCheckInvoke && !hasLoginEnsureInvoke) {
		errors.push("login flow should use invoke args.login.ensure=true as primary gating path; do not rely on manual login assist as primary");
	}
	if (!actionTypes.has("done") && !actionTypes.has("abort")) {
		errors.push("flow should include terminal action done or abort");
	}
	return errors;
}

function buildHeuristicFallbackFlow(skillText) {
	const s = String(skillText || "").toLowerCase();
	const isWeibo = s.includes("weibo") || s.includes("微博");
	const startUrl = isWeibo ? "https://s.weibo.com" : "about:blank";
	const flowId = isWeibo ? "weibo_search_basic" : "skill_generated_basic_search";
	return {
		id: flowId,
		start: "open_search_page",
		args: {
			query: { type: "string", required: true, desc: "搜索关键词" },
			minResults: { type: "number", required: false, desc: "期望最少结果数（best-effort）" },
		},
		steps: [
			{
				id: "open_search_page",
				action: { type: "goto", url: startUrl, postWaitMs: 600 },
				next: { done: "focus_search_input", failed: "abort_failed" },
			},
			{
				id: "focus_search_input",
				action: { type: "click", query: "搜索输入框", postWaitMs: 200 },
				next: { done: "input_query", failed: "ask_assist_focus" },
			},
			{
				id: "ask_assist_focus",
				action: {
					type: "ask_assist",
					reason: "未能自动定位搜索输入框，请手动点击搜索框后继续。",
					waitUserAction: true,
				},
				next: { done: "input_query", failed: "abort_failed" },
			},
			{
				id: "input_query",
				action: {
					type: "input",
					text: "${query}",
					mode: "paste",
					clear: true,
					pressEnter: true,
					postWaitMs: 800,
				},
				next: { done: "run_search", failed: "abort_failed" },
			},
			{
				id: "run_search",
				action: {
					type: "invoke",
					find: {
						kind: "rpa",
						must: ["read.list", "read.action"],
						prefer: ["read.fields", "read.requireFields", "read.minItems", "read.output"],
						filter: [{ key: "domain", value: "*" }],
					},
					args: {
						"read.action": "list",
						"read.minItems": "${minResults}",
						"read.fields": ["postId", "url", "text", "authorId", "authorName", "publishTime", "likeCount", "commentCount", "repostCount", "media"],
						"read.requireFields": ["url", "text"],
						"read.output": "json",
					},
					onError: "return",
					returnTo: "caller",
				},
				saveAs: "searchResult",
				next: { done: "ensure_results", failed: "abort_failed" },
			},
			{
				id: "ensure_results",
				action: {
					type: "branch",
					cases: [
						{ when: { op: "truthy", source: "vars", path: "searchResult.urls" }, to: "done" },
					],
					default: "scroll_then_retry",
				},
				next: {},
			},
			{
				id: "scroll_then_retry",
				action: { type: "scroll", y: 1200, postWaitMs: 800 },
				next: { done: "run_search_retry", failed: "abort_failed" },
			},
			{
				id: "run_search_retry",
				action: {
					type: "invoke",
					find: {
						kind: "rpa",
						must: ["read.list", "read.action"],
						prefer: ["read.fields", "read.requireFields", "read.minItems", "read.output"],
						filter: [{ key: "domain", value: "*" }],
					},
					args: {
						"read.action": "list",
						"read.minItems": "${minResults}",
						"read.fields": ["postId", "url", "text", "authorId", "authorName", "publishTime", "likeCount", "commentCount", "repostCount", "media"],
						"read.requireFields": ["url", "text"],
						"read.output": "json",
					},
					onError: "return",
					returnTo: "caller",
				},
				saveAs: "searchResult",
				next: { done: "done", failed: "abort_failed" },
			},
			{
				id: "done",
				action: {
					type: "done",
					reason: "search flow completed",
					conclusion: { status: "done", value: "${vars.searchResult}" },
				},
				next: {},
			},
			{
				id: "abort_failed",
				action: { type: "abort", reason: "search flow failed" },
				next: {},
			},
		],
	};
}

function hasLikelySelfRecursiveSearchInvoke(flow, skillText) {
	const text = String(skillText || "").toLowerCase();
	const isSearchGoal = text.includes("search") || text.includes("搜索");
	if (!isSearchGoal) return false;
	const steps = Array.isArray(flow?.steps) ? flow.steps : [];
	for (const st of steps) {
		const action = st?.action || {};
		if (String(action.type || "") !== "invoke") continue;
		const args = (action.args && typeof action.args === "object") ? action.args : {};
		const keys = Object.keys(args).map((k) => String(k || ""));
		if (keys.some((k) => k === "search" || k.startsWith("search."))) return true;
		const must = Array.isArray(action.find?.must) ? action.find.must : [];
		if (must.some((k) => String(k || "") === "search" || String(k || "").startsWith("search."))) return true;
	}
	return false;
}

async function skillToFlow({
	skillText,
	session = null,
	model = "advanced",
	logger = null,
	maxRepair = 1,
	maxRegenerate = 1,
	timeoutMs = 600000,
} = {}) {
	const text = String(skillText || "").trim();
	if (!text) return { ok: false, reason: "skillText is required" };
	const capabilityKeys = getCapabilityKeys();
	const capabilityCatalog = getCapabilityCatalog();
	const taskProfileRet = await callAiJson({
		prompt: buildTaskProfilePrompt({ capabilityKeys, capabilityCatalog, skillText: text }),
		inputValue: { skillText: text, capabilityCatalog },
		model,
		session,
		logger,
		timeoutMs,
	});
	if (!taskProfileRet.ok) {
		return { ok: false, reason: `task profile generation failed: ${taskProfileRet.reason || "unknown"}` };
	}
	const taskProfile = normalizeTaskProfile(taskProfileRet.result || {}, capabilityCatalog);
	const planRet = await callAiJson({
		prompt: buildPlanPrompt(),
		inputValue: { skillText: text, taskProfile },
		model,
		session,
		logger,
		timeoutMs,
	});
	if (!planRet.ok) {
		return { ok: false, reason: `plan generation failed: ${planRet.reason || "unknown"}` };
	}
	const plan = planRet.result || null;
	const draftRet = await callAiJson({
		prompt: buildFlowPrompt({ capabilityKeys, skillText: text, plan, taskProfile }),
		inputValue: { skillText: text, plan, taskProfile },
		model,
		session,
		logger,
		timeoutMs,
	});
	let flow = null;
	if (!draftRet.ok) {
		return {
			ok: false,
			reason: `flow generation failed: ${draftRet.reason || "unknown"}`,
			plan,
		};
	}
	flow = draftRet.result?.flow || draftRet.result;
	let errors = validateFlow(flow, { taskProfile, capabilityCatalog });
	if (!errors.length && hasLikelySelfRecursiveSearchInvoke(flow, text)) {
		errors.push("flow likely self-recursive: search-goal flow must not invoke search.* internally");
	}
	let repairs = 0;
	while (errors.length && repairs < Math.max(0, Number(maxRepair || 0))) {
		const fixRet = await callAiJson({
			prompt: buildRepairPrompt({ flow, errors, taskProfile }),
			inputValue: { flow, errors, taskProfile },
			model,
			session,
			logger,
			timeoutMs,
		});
		if (!fixRet.ok) {
			return {
				ok: false,
				reason: `flow repair failed: ${fixRet.reason || "unknown"}`,
				errors,
				flow,
				plan,
				repairs,
			};
		}
		flow = fixRet.result?.flow || fixRet.result;
		errors = validateFlow(flow, { taskProfile, capabilityCatalog });
		if (!errors.length && hasLikelySelfRecursiveSearchInvoke(flow, text)) {
			errors.push("flow likely self-recursive: search-goal flow must not invoke search.* internally");
		}
		repairs += 1;
	}
	let regenerates = 0;
	while (errors.length && regenerates < Math.max(0, Number(maxRegenerate || 0))) {
		const regenRet = await callAiJson({
			prompt: buildRegeneratePrompt({
				capabilityKeys,
				skillText: text,
				plan,
				taskProfile,
				previousFlow: flow,
				previousErrors: errors,
			}),
			inputValue: {
				skillText: text,
				plan,
				taskProfile,
				validationErrors: errors,
				previousFlow: flow,
			},
			model,
			session,
			logger,
			timeoutMs,
		});
		if (!regenRet.ok) {
			return {
				ok: false,
				reason: `flow regenerate failed: ${regenRet.reason || "unknown"}`,
				errors,
				flow,
				plan,
				repairs,
				regenerates,
			};
		}
		flow = regenRet.result?.flow || regenRet.result;
		errors = validateFlow(flow, { taskProfile, capabilityCatalog });
		if (!errors.length && hasLikelySelfRecursiveSearchInvoke(flow, text)) {
			errors.push("flow likely self-recursive: search-goal flow must not invoke search.* internally");
		}
		regenerates += 1;
	}
	if (errors.length) {
		return { ok: false, reason: "flow validation failed", errors, flow, plan, repairs, regenerates };
	}
	const heuristic = deriveCapabilitiesHeuristic(flow, capabilityKeys);
	const mergedProfile = normalizeProfile(
		{
			capabilities: heuristic.capabilities || { must: [], prefer: [] },
			filters: [],
		},
		capabilityKeys,
		text,
		flow
	);
	return {
		ok: true,
		flow,
		taskProfile,
		plan,
		repairs,
		regenerates,
		capabilities: mergedProfile.capabilities,
		filters: mergedProfile.filters,
		result: {
			capabilities: mergedProfile.capabilities,
			filters: mergedProfile.filters,
			flow,
		},
	};
}

async function reviseFlowByPrompt({
	flow,
	userInstruction,
	contextText = "",
	session = null,
	model = "advanced",
	logger = null,
	maxRepair = 1,
	maxRegenerate = 1,
	timeoutMs = 600000,
} = {}) {
	const currentFlow = (flow && typeof flow === "object") ? flow : null;
	if (!currentFlow) return { ok: false, reason: "flow is required" };
	const instruction = String(userInstruction || "").trim();
	if (!instruction) return { ok: false, reason: "userInstruction is required" };

	const capabilityKeys = getCapabilityKeys();
	const capabilityCatalog = getCapabilityCatalog();
	const taskProfileRet = await callAiJson({
		prompt: buildTaskProfilePrompt({
			capabilityKeys,
			capabilityCatalog,
			skillText: [
				String(contextText || "").trim(),
				"",
				"用户修改要求：",
				instruction,
			].join("\n"),
		}),
		inputValue: {
			contextText: String(contextText || ""),
			userInstruction: instruction,
			capabilityCatalog,
		},
		model,
		session,
		logger,
		timeoutMs,
	});
	const taskProfile = taskProfileRet.ok
		? normalizeTaskProfile(taskProfileRet.result || {}, capabilityCatalog)
		: null;

	const draftRet = await callAiJson({
		prompt: buildFlowRevisePrompt({
			capabilityKeys,
			currentFlow,
			userInstruction: instruction,
			contextText,
			taskProfile,
		}),
		inputValue: {
			flow: currentFlow,
			userInstruction: instruction,
			contextText: String(contextText || ""),
			taskProfile,
		},
		model,
		session,
		logger,
		timeoutMs,
	});
	if (!draftRet.ok) {
		return {
			ok: false,
			reason: `flow revise failed: ${draftRet.reason || "unknown"}`,
		};
	}

	let revisedFlow = draftRet.result?.flow || draftRet.result;
	let errors = validateFlow(revisedFlow, { taskProfile, capabilityCatalog });
	const scopeText = `${String(contextText || "")}\n${instruction}`;
	if (!errors.length && hasLikelySelfRecursiveSearchInvoke(revisedFlow, scopeText)) {
		errors.push("flow likely self-recursive: search-goal flow must not invoke search.* internally");
	}

	let repairs = 0;
	while (errors.length && repairs < Math.max(0, Number(maxRepair || 0))) {
		const fixRet = await callAiJson({
			prompt: buildRepairPrompt({ flow: revisedFlow, errors, taskProfile }),
			inputValue: { flow: revisedFlow, errors, taskProfile },
			model,
			session,
			logger,
			timeoutMs,
		});
		if (!fixRet.ok) {
			return {
				ok: false,
				reason: `flow revise repair failed: ${fixRet.reason || "unknown"}`,
				errors,
				flow: revisedFlow,
				repairs,
			};
		}
		revisedFlow = fixRet.result?.flow || fixRet.result;
		errors = validateFlow(revisedFlow, { taskProfile, capabilityCatalog });
		if (!errors.length && hasLikelySelfRecursiveSearchInvoke(revisedFlow, scopeText)) {
			errors.push("flow likely self-recursive: search-goal flow must not invoke search.* internally");
		}
		repairs += 1;
	}

	let regenerates = 0;
	while (errors.length && regenerates < Math.max(0, Number(maxRegenerate || 0))) {
		const regenRet = await callAiJson({
			prompt: buildFlowReviseRegeneratePrompt({
				capabilityKeys,
				currentFlow,
				userInstruction: instruction,
				contextText,
				taskProfile,
				previousFlow: revisedFlow,
				previousErrors: errors,
			}),
			inputValue: {
				currentFlow,
				flow: revisedFlow,
				userInstruction: instruction,
				contextText: String(contextText || ""),
				taskProfile,
				validationErrors: errors,
			},
			model,
			session,
			logger,
			timeoutMs,
		});
		if (!regenRet.ok) {
			return {
				ok: false,
				reason: `flow revise regenerate failed: ${regenRet.reason || "unknown"}`,
				errors,
				flow: revisedFlow,
				repairs,
				regenerates,
			};
		}
		revisedFlow = regenRet.result?.flow || regenRet.result;
		errors = validateFlow(revisedFlow, { taskProfile, capabilityCatalog });
		if (!errors.length && hasLikelySelfRecursiveSearchInvoke(revisedFlow, scopeText)) {
			errors.push("flow likely self-recursive: search-goal flow must not invoke search.* internally");
		}
		regenerates += 1;
	}

	if (errors.length) {
		return {
			ok: false,
			reason: "flow revise validation failed",
			errors,
			flow: revisedFlow,
			repairs,
			regenerates,
		};
	}
	return {
		ok: true,
		flow: revisedFlow,
		repairs,
		regenerates,
		taskProfile,
	};
}

async function reviseFlowDocumentByPrompt({
	flowDocument,
	userInstruction,
	contextText = "",
	session = null,
	model = "advanced",
	logger = null,
	maxRepair = 1,
	maxRegenerate = 1,
	timeoutMs = 600000,
} = {}) {
	const doc = (flowDocument && typeof flowDocument === "object") ? flowDocument : null;
	if (!doc) return { ok: false, reason: "flowDocument is required" };
	const hasEnvelope = !!(doc && typeof doc === "object" && doc.flow && typeof doc.flow === "object");
	const currentFlow = hasEnvelope ? doc.flow : doc;
	const mergeFlowInnerShell = (oldFlow, newFlow) => {
		const oldF = (oldFlow && typeof oldFlow === "object") ? oldFlow : {};
		const newF = (newFlow && typeof newFlow === "object") ? newFlow : {};
		const out = { ...newF };
		// Preserve non-core inner-shell fields when AI output omits them.
		const reservedCore = new Set(["id", "start", "args", "steps"]);
		for (const [k, v] of Object.entries(oldF)) {
			if (reservedCore.has(k)) continue;
			if (Object.prototype.hasOwnProperty.call(out, k)) continue;
			out[k] = v;
		}
		return out;
	};
	const baseTemplate = hasEnvelope ? (() => {
		try {
			const c = JSON.parse(JSON.stringify(doc));
			delete c.flow;
			return c;
		} catch (_) {
			return {};
		}
	})() : null;
	const ret = await reviseFlowByPrompt({
		flow: currentFlow,
		userInstruction,
		contextText,
		session,
		model,
		logger,
		maxRepair,
		maxRegenerate,
		timeoutMs,
	});
	if (!ret?.ok) return ret;
	const mergedFlow = mergeFlowInnerShell(currentFlow, ret.flow);
	const document = hasEnvelope ? { ...(baseTemplate || {}), flow: mergedFlow } : mergedFlow;
	return { ...ret, document };
}

export { skillToFlow, reviseFlowByPrompt, reviseFlowDocumentByPrompt, validateFlow };
