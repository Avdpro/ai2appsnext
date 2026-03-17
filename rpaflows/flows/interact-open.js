const capabilities = {
	must: ["interact", "interact.open"],
	prefer: ["interact.action", "interact.target", "interact.control", "interact.result"],
};

const filters = [
	{ key: "domain", value: "*" },
	{ key: "locale", value: "zh-CN" },
];

const ranks = {
	cost: 1,
	quality: 2,
	speed: 3,
};

const flow = {
	id: "interact_open",
	start: "init_ctx",
	args: {
		interact: { type: "object", required: false, desc: "interact 参数，当前仅实现 action=open" },
	},
	steps: [
		{
			id: "init_ctx",
			action: {
				type: "run_js",
				scope: "agent",
				code: `function(input){
					function t(v){ return String(v == null ? "" : v).trim(); }
					function normPick(v){
						if(v == null || v === "") return null;
						if(typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
						const s = String(v).trim();
						if(!s) return null;
						if(/^[+-]?\\d+$/.test(s)) return Number.parseInt(s, 10);
						const low = s.toLowerCase();
						if(low === "first") return 1;
						if(low === "last") return -1;
						return s;
					}
					const interact = (input && input.interact) || {};
					const action = t(interact.action || "open").toLowerCase();
					const target = interact.target && typeof interact.target === "object" ? interact.target : {};
					const control = interact.control && typeof interact.control === "object" ? interact.control : {};
					const targetBy = t(target.selector || "");
					const targetQuery = t(target.query || "");
					const targetPick = normPick(target.pick);
					const controlBy = t(control.selector || "");
					const controlQuery = t(control.query || "");
					const controlPick = normPick(control.pick);
					const waitBy = t(interact.waitBy || interact.waitFor || "");
					const postWaitMsRaw = Number(interact.postWaitMs);
					const postWaitMs = Number.isFinite(postWaitMsRaw) ? Math.max(0, Math.min(15000, Math.floor(postWaitMsRaw))) : 1200;
					const waitTimeoutMsRaw = Number(interact.waitTimeoutMs);
					const waitTimeoutMs = Number.isFinite(waitTimeoutMsRaw) ? Math.max(200, Math.min(30000, Math.floor(waitTimeoutMsRaw))) : 8000;
					const openHint = t(controlQuery || interact.query || interact.value || "打开详情/原文");
					return {
						action,
						targetBy,
						targetQuery,
						targetPick,
						controlBy,
						controlQuery,
						controlPick,
						hasTarget: !!(targetBy || targetQuery),
						hasControl: !!(controlBy || controlQuery),
						waitBy,
						waitTimeoutMs,
						postWaitMs,
						openHint,
					};
				}`,
				args: ["${{ ({ interact: args.interact || {} }) }}"],
			},
			saveAs: "ctx",
			next: { done: "check_action", failed: "abort_failed" },
		},
		{
			id: "check_action",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "ctx.action", value: "open" }, to: "snapshot_before" },
				],
				default: "abort_unsupported",
			},
			next: {},
		},
		{
			id: "snapshot_before",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(){ return { url: String(location.href||''), title: String(document.title||''), ts: Date.now() }; }",
			},
			saveAs: "before",
			next: { done: "route_target", failed: "abort_failed" },
		},
		{
			id: "route_target",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "ctx.hasTarget", value: true }, to: "target_resolve_mode" },
				],
				default: "set_default_target",
			},
			next: {},
		},
		{
			id: "target_resolve_mode",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "truthy", source: "vars", path: "ctx.targetBy" }, to: "resolve_target_by" },
					{ when: { op: "truthy", source: "vars", path: "ctx.targetQuery" }, to: "resolve_target_query" },
				],
				default: "set_default_target",
			},
			next: {},
		},
		{
			id: "resolve_target_by",
			action: { type: "selector", by: "${vars.ctx.targetBy}", pick: "${vars.ctx.targetPick}", multi: true },
			saveAs: "targetSel",
			next: { done: "route_control", failed: "abort_target_not_found" },
		},
		{
			id: "resolve_target_query",
			action: {
				type: "selector",
				query: "${vars.ctx.targetQuery}",
				pick: "${vars.ctx.targetPick}",
				multi: true,
				cacheKeySuffix: "${vars.ctx.targetQuery}",
			},
			saveAs: "targetSel",
			next: { done: "route_control", failed: "abort_target_not_found" },
		},
		{
			id: "set_default_target",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(){ return { by: 'css: body', sigKey: null, fromCache: false }; }",
			},
			saveAs: "targetSel",
			next: { done: "route_control", failed: "abort_failed" },
		},
		{
			id: "route_control",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "ctx.hasControl", value: true }, to: "control_resolve_mode" },
				],
				default: "auto_find_control",
			},
			next: {},
		},
		{
			id: "control_resolve_mode",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "truthy", source: "vars", path: "ctx.controlBy" }, to: "resolve_control_by" },
					{ when: { op: "truthy", source: "vars", path: "ctx.controlQuery" }, to: "resolve_control_query" },
				],
				default: "auto_find_control",
			},
			next: {},
		},
		{
			id: "resolve_control_by",
			action: { type: "selector", by: "${vars.ctx.controlBy}", pick: "${vars.ctx.controlPick}", multi: true },
			saveAs: "controlSel",
			next: { done: "verify_control_in_target", failed: "abort_control_not_found" },
		},
		{
			id: "resolve_control_query",
			action: {
				type: "selector",
				query: "${vars.ctx.controlQuery}",
				pick: "${vars.ctx.controlPick}",
				multi: true,
				cacheKeySuffix: "${vars.ctx.controlQuery}",
			},
			saveAs: "controlSel",
			next: { done: "verify_control_in_target", failed: "auto_find_control" },
		},
		{
			id: "auto_find_control",
			action: {
				type: "run_js",
				scope: "page",
				code: `function(targetBy, hint){
					function asText(v){ return String(v == null ? "" : v).replace(/\\s+/g, " ").trim(); }
					function parseBy(raw){
						const s = asText(raw);
						if(!s) return { kind: "css", expr: "" };
						if(/^css\\s*:/i.test(s)) return { kind: "css", expr: s.replace(/^css\\s*:/i, "").trim() };
						if(/^xpath\\s*:/i.test(s)) return { kind: "xpath", expr: s.replace(/^xpath\\s*:/i, "").trim() };
						if(/^(\\/\\/|\\/|\\(|\\.\\/|\\.\\.\\/)/.test(s)) return { kind: "xpath", expr: s };
						return { kind: "css", expr: s };
					}
					function firstBy(raw){
						const p = parseBy(raw);
						if(!p.expr) return document.body;
						try{
							if(p.kind === "xpath"){
								const it = document.evaluate(p.expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
								return (it && it.singleNodeValue) || document.body;
							}
							return document.querySelector(p.expr) || document.body;
						}catch(_){ return document.body; }
					}
					function score(el, tokens){
						let s = 0;
						const tag = String(el.tagName || "").toLowerCase();
						if(tag === "a") s += 3;
						if(tag === "button") s += 2;
						const href = asText(el.getAttribute("href") || "");
						if(href && !/^javascript:/i.test(href)) s += 2;
						const hay = asText([
							el.innerText || "",
							el.getAttribute("aria-label") || "",
							el.getAttribute("title") || "",
							el.getAttribute("data-testid") || "",
							href
						].join(" ")).toLowerCase();
						for(const tk of tokens){ if(tk && hay.includes(tk)) s += 4; }
						if(/(read|detail|open|continue|more|原文|详情|阅读|查看|继续)/i.test(hay)) s += 2;
						return s;
					}
					function toXpath(el){
						if(!el || el.nodeType !== 1) return "";
						if(el.id){
							const safe = String(el.id).replace(/"/g, '\\"');
							return '//*[@id="' + safe + '"]';
						}
						const segs = [];
						let n = el;
						while(n && n.nodeType === 1 && n !== document.body){
							const tag = String(n.tagName || "").toLowerCase();
							if(!tag) break;
							let idx = 1;
							let p = n.previousElementSibling;
							while(p){
								if(String(p.tagName || "").toLowerCase() === tag) idx++;
								p = p.previousElementSibling;
							}
							segs.unshift(tag + "[" + idx + "]");
							n = n.parentElement;
						}
						return segs.length ? ("//" + segs.join("/")) : "";
					}
					const root = firstBy(targetBy);
					const hintTokens = asText(hint).toLowerCase().split(/[\\s,，。;；:：|/]+/).filter(Boolean).slice(0, 8);
					const candidates = Array.from((root || document).querySelectorAll("a[href],button,[role='button'],[role='link'],[onclick],summary,[data-click],[data-action]"));
					if(!candidates.length) return { ok: false, reason: "no clickable candidate in target" };
					let best = null;
					let bestScore = -1;
					for(const el of candidates){
						const sc = score(el, hintTokens);
						if(sc > bestScore){ bestScore = sc; best = el; }
					}
					if(!best) return { ok: false, reason: "no clickable picked" };
					const xp = toXpath(best);
					if(!xp) return { ok: false, reason: "cannot build selector for clickable" };
					return { ok: true, by: "xpath: " + xp, score: bestScore, hint: asText(best.innerText || best.textContent || "").slice(0, 120) };
				}`,
				args: ["${vars.targetSel.by}", "${vars.ctx.openHint}"],
			},
			saveAs: "controlAuto",
			next: { done: "check_auto_control", failed: "abort_control_not_found" },
		},
		{
			id: "check_auto_control",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "controlAuto.ok", value: true }, to: "set_control_from_auto" },
				],
				default: "abort_control_not_found",
			},
			next: {},
		},
		{
			id: "set_control_from_auto",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(v){ return { by: String((v&&v.by)||''), sigKey: null, fromCache: false, byAuto: true, hint: String((v&&v.hint)||'') }; }",
				args: ["${vars.controlAuto}"],
			},
			saveAs: "controlSel",
			next: { done: "verify_control_in_target", failed: "abort_control_not_found" },
		},
		{
			id: "verify_control_in_target",
			action: {
				type: "run_js",
				scope: "page",
				code: `function(targetBy, controlBy){
					function asText(v){ return String(v == null ? "" : v).trim(); }
					function parseBy(raw){
						const s = asText(raw);
						if(!s) return { kind:"css", expr:"" };
						if(/^css\\s*:/i.test(s)) return { kind:"css", expr:s.replace(/^css\\s*:/i,"").trim() };
						if(/^xpath\\s*:/i.test(s)) return { kind:"xpath", expr:s.replace(/^xpath\\s*:/i,"").trim() };
						if(/^(\\/\\/|\\/|\\(|\\.\\/|\\.\\.\\/)/.test(s)) return { kind:"xpath", expr:s };
						return { kind:"css", expr:s };
					}
					function firstBy(raw){
						const p=parseBy(raw);
						if(!p.expr) return null;
						try{
							if(p.kind==="xpath"){
								const it=document.evaluate(p.expr,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null);
								return it && it.singleNodeValue || null;
							}
							return document.querySelector(p.expr);
						}catch(_){ return null; }
					}
					const target = firstBy(targetBy);
					const control = firstBy(controlBy);
					if(!control) return { ok:false, reason:"control not found on page" };
					if(!target) return { ok:true, inTarget:true };
					return { ok: target===control || target.contains(control), inTarget: target===control || target.contains(control), reason: "control not inside target" };
				}`,
				args: ["${vars.targetSel.by}", "${vars.controlSel.by}"],
			},
			saveAs: "controlCheck",
			next: { done: "route_control_check", failed: "abort_control_not_found" },
		},
		{
			id: "route_control_check",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "controlCheck.ok", value: true }, to: "click_open" },
					{ when: { op: "truthy", source: "vars", path: "controlSel.byAuto" }, to: "abort_control_outside_target" },
				],
				default: "auto_find_control",
			},
			next: {},
		},
		{
			id: "click_open",
			action: {
				type: "click",
				by: "${vars.controlSel.by}",
				postWaitMs: "${vars.ctx.postWaitMs}",
			},
			next: { done: "route_wait_after", failed: "abort_failed" },
		},
		{
			id: "route_wait_after",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "truthy", source: "vars", path: "ctx.waitBy" }, to: "wait_after_open" },
				],
				default: "snapshot_after",
			},
			next: {},
		},
		{
			id: "wait_after_open",
			action: {
				type: "wait",
				by: "${vars.ctx.waitBy}",
				timeoutMs: "${vars.ctx.waitTimeoutMs}",
			},
			next: { done: "snapshot_after", timeout: "snapshot_after", failed: "snapshot_after" },
		},
		{
			id: "snapshot_after",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(){ return { url: String(location.href||''), title: String(document.title||''), ts: Date.now() }; }",
			},
			saveAs: "after",
			next: { done: "assess_result", failed: "abort_failed" },
		},
		{
			id: "assess_result",
			action: {
				type: "run_js",
				scope: "agent",
				code: `function(before, after, ctx, targetSel, controlSel){
					const b = (before && typeof before==="object") ? before : {};
					const a = (after && typeof after==="object") ? after : {};
					const urlChanged = String(b.url||"") !== String(a.url||"");
					const titleChanged = String(b.title||"") !== String(a.title||"");
					const changed = urlChanged || titleChanged;
					return {
						action: "open",
						changed,
						opened: changed,
						url: String(a.url||""),
						title: String(a.title||""),
						before: { url: String(b.url||""), title: String(b.title||"") },
						after: { url: String(a.url||""), title: String(a.title||"") },
						targetBy: String((targetSel&&targetSel.by)||""),
						controlBy: String((controlSel&&controlSel.by)||""),
						meta: {
							waitBy: String((ctx&&ctx.waitBy)||""),
							postWaitMs: Number((ctx&&ctx.postWaitMs)||0)
						}
					};
				}`,
				args: ["${vars.before}", "${vars.after}", "${vars.ctx}", "${vars.targetSel}", "${vars.controlSel}"],
			},
			saveAs: "openOut",
			next: { done: "done", failed: "abort_failed" },
		},
		{
			id: "done",
			action: {
				type: "done",
				reason: "interact.open ok",
				conclusion: "${vars.openOut}",
			},
			next: {},
		},
		{
			id: "abort_unsupported",
			action: { type: "abort", reason: "interact_open only supports interact.action=open" },
			next: {},
		},
		{
			id: "abort_target_not_found",
			action: { type: "abort", reason: "interact.open target not found" },
			next: {},
		},
		{
			id: "abort_control_not_found",
			action: { type: "abort", reason: "interact.open control not found" },
			next: {},
		},
		{
			id: "abort_control_outside_target",
			action: { type: "abort", reason: "interact.open control is outside target" },
			next: {},
		},
		{
			id: "abort_failed",
			action: { type: "abort", reason: "interact.open failed" },
			next: {},
		},
	],
	vars: {
		ctx: { type: "object", desc: "标准化参数上下文", from: "init_ctx.saveAs" },
		before: { type: "object", desc: "点击前页面快照", from: "snapshot_before.saveAs" },
		targetSel: { type: "object", desc: "目标容器 selector", from: "resolve_target_*.saveAs/set_default_target.saveAs" },
		controlSel: { type: "object", desc: "可点击控件 selector", from: "resolve_control_*.saveAs/set_control_from_auto.saveAs" },
		controlAuto: { type: "object", desc: "自动定位控件结果", from: "auto_find_control.saveAs" },
		controlCheck: { type: "object", desc: "控件是否位于目标容器内", from: "verify_control_in_target.saveAs" },
		after: { type: "object", desc: "点击后页面快照", from: "snapshot_after.saveAs" },
		openOut: { type: "object", desc: "打开结果", from: "assess_result.saveAs" },
	},
};

const interactOpenObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default interactOpenObject;
export { capabilities, filters, ranks, flow, interactOpenObject };
