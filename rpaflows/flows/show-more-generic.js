const capabilities = {
	must: ["showMore"],
	prefer: ["showMore.target", "showMore.checkOnly", "showMore.expand", "showMore.maxTries", "showMore.timeoutMs", "showMore.result"],
};

const filters = [
	{ key: "domain", value: "*" },
	{ key: "locale", value: "zh-CN" },
];

const ranks = {
	cost: 2,
	quality: 3,
	speed: 3,
};

const detectCode = `function(targetBy){
	function text(v){ return String(v == null ? "" : v).replace(/\\s+/g, " ").trim(); }
	function parseBy(raw){
		const s = text(raw);
		if(!s) return { kind: "css", expr: "" };
		if(/^css\\s*:/i.test(s)) return { kind: "css", expr: s.replace(/^css\\s*:/i, "").trim() };
		if(/^xpath\\s*:/i.test(s)) return { kind: "xpath", expr: s.replace(/^xpath\\s*:/i, "").trim() };
		if(/^(\\/\\/|\\/|\\(|\\.\\/|\\.\\.\\/)/.test(s)) return { kind: "xpath", expr: s };
		return { kind: "css", expr: s };
	}
	function q(root, parsed){
		if(!parsed.expr) return [];
		if(parsed.kind === "xpath"){
			try{
				const snap = document.evaluate(parsed.expr, root || document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
				const arr=[]; for(let i=0;i<snap.snapshotLength;i++){ const n=snap.snapshotItem(i); if(n && n.nodeType===1) arr.push(n); }
				return arr;
			}catch(_){ return []; }
		}
		try{ return Array.from((root||document).querySelectorAll(parsed.expr)); }catch(_){ return []; }
	}
	function visible(el){
		if(!el) return false;
		const st = window.getComputedStyle(el);
		if(!st) return false;
		if(st.display==="none" || st.visibility==="hidden" || Number(st.opacity||"1")<=0.02) return false;
		const r = el.getBoundingClientRect();
		return r.width>2 && r.height>2;
	}
	function scoreToggle(el){
		const t = text((el && (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title"))) || "").toLowerCase();
		const idc = text((el && (el.id + " " + el.className)) || "").toLowerCase();
		let s = 0;
		if(/展开|更多|全文|继续阅读|显示全部|read more|show more|more|expand|see more/.test(t)) s += 5;
		if(/expand|more|fold|collapsed|ellipsis|line-clamp/.test(idc)) s += 3;
		const aria = String((el && el.getAttribute("aria-expanded")) || "").toLowerCase();
		if(aria === "false") s += 4;
		return s;
	}
	const rootParsed = parseBy(targetBy);
	let root = document.body;
	if(rootParsed.expr){
		const roots = q(document, rootParsed);
		if(roots.length) root = roots[0];
	}
	const cands = Array.from(root.querySelectorAll("button,a,[role='button'],summary,.show-more,.read-more,.expand-more,[aria-expanded]")).filter(visible);
	const toggles = cands
		.map((el)=>({ el, score: scoreToggle(el), txt: text(el.innerText||el.textContent||el.getAttribute("aria-label")||"") }))
		.filter((x)=>x.score>=4)
		.sort((a,b)=>b.score-a.score);
	const blocked = toggles.length>0;
	const top = toggles[0] || null;
	return {
		blocked,
		expanded: !blocked,
		reason: blocked ? ("found expandable control: " + (top.txt || "(no text)")) : "no expandable control found",
		candidates: toggles.slice(0,8).map((x)=>({ score:x.score, text:x.txt })),
	};
}`;

const expandCode = `async function(targetBy, cfg){
	function sleep(ms){ return new Promise((r)=>setTimeout(r, ms)); }
	function text(v){ return String(v == null ? "" : v).replace(/\\s+/g, " ").trim(); }
	function parseBy(raw){
		const s = text(raw);
		if(!s) return { kind: "css", expr: "" };
		if(/^css\\s*:/i.test(s)) return { kind: "css", expr: s.replace(/^css\\s*:/i, "").trim() };
		if(/^xpath\\s*:/i.test(s)) return { kind: "xpath", expr: s.replace(/^xpath\\s*:/i, "").trim() };
		if(/^(\\/\\/|\\/|\\(|\\.\\/|\\.\\.\\/)/.test(s)) return { kind: "xpath", expr: s };
		return { kind: "css", expr: s };
	}
	function q(root, parsed){
		if(!parsed.expr) return [];
		if(parsed.kind === "xpath"){
			try{
				const snap = document.evaluate(parsed.expr, root || document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
				const arr=[]; for(let i=0;i<snap.snapshotLength;i++){ const n=snap.snapshotItem(i); if(n && n.nodeType===1) arr.push(n); }
				return arr;
			}catch(_){ return []; }
		}
		try{ return Array.from((root||document).querySelectorAll(parsed.expr)); }catch(_){ return []; }
	}
	function visible(el){
		if(!el) return false;
		const st = window.getComputedStyle(el);
		if(!st) return false;
		if(st.display==="none" || st.visibility==="hidden" || Number(st.opacity||"1")<=0.02) return false;
		const r = el.getBoundingClientRect();
		return r.width>2 && r.height>2;
	}
	function scoreToggle(el){
		const t = text((el && (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title"))) || "").toLowerCase();
		const idc = text((el && (el.id + " " + el.className)) || "").toLowerCase();
		let s = 0;
		if(/展开|更多|全文|继续阅读|显示全部|read more|show more|more|expand|see more/.test(t)) s += 5;
		if(/expand|more|fold|collapsed|ellipsis|line-clamp/.test(idc)) s += 3;
		const aria = String((el && el.getAttribute("aria-expanded")) || "").toLowerCase();
		if(aria === "false") s += 4;
		return s;
	}
	function collect(root){
		const cands = Array.from(root.querySelectorAll("button,a,[role='button'],summary,.show-more,.read-more,.expand-more,[aria-expanded]")).filter(visible);
		return cands
			.map((el)=>({ el, score: scoreToggle(el), txt: text(el.innerText||el.textContent||el.getAttribute("aria-label")||"") }))
			.filter((x)=>x.score>=4)
			.sort((a,b)=>b.score-a.score);
	}
	const maxTries = Math.max(1, Math.min(8, Number((cfg&&cfg.maxTries) || 2)));
	const timeoutMs = Math.max(1000, Math.min(60000, Number((cfg&&cfg.timeoutMs) || 8000)));
	const waitPerTry = Math.max(150, Math.min(1200, Math.floor(timeoutMs / Math.max(1, maxTries))));
	const rootParsed = parseBy(targetBy);
	let root = document.body;
	if(rootParsed.expr){
		const roots = q(document, rootParsed);
		if(roots.length) root = roots[0];
	}
	const beforeLen = text(root.innerText || "").length;
	let acted = false;
	let tries = 0;
	let lastReason = "no expandable control";
	for(tries = 1; tries <= maxTries; tries++){
		const toggles = collect(root);
		if(!toggles.length){
			lastReason = "no expandable control";
			break;
		}
		const top = toggles[0];
		lastReason = top.txt ? ("clicked: " + top.txt) : "clicked top expandable control";
		try{
			top.el.scrollIntoView({ block: "center", inline: "nearest" });
		}catch(_){}
		try{
			top.el.click();
			acted = true;
		}catch(_){}
		await sleep(waitPerTry);
		const afterToggles = collect(root);
		if(!afterToggles.length){
			lastReason = "expanded; no more toggles";
			break;
		}
	}
	const afterToggles = collect(root);
	const blocked = afterToggles.length > 0;
	const afterLen = text(root.innerText || "").length;
	const expanded = !blocked || afterLen > beforeLen;
	const newItems = afterLen > beforeLen ? 1 : 0;
	return {
		blocked,
		expanded,
		newItems,
		tries,
		reason: expanded ? lastReason : ("expand failed: " + lastReason),
	};
}`;

const flow = {
	id: "show_more_generic",
	start: "init_ctx",
	args: {
		showMore: { type: "object", required: false, desc: "showMore 参数，支持 target/checkOnly/expand/maxTries/timeoutMs" },
	},
	steps: [
		{
			id: "init_ctx",
			action: {
				type: "run_js",
				scope: "agent",
				code: `function(input){
					function t(v){ return String(v == null ? "" : v).trim(); }
					const sm = (input && input.showMore) || {};
					const target = sm.target && typeof sm.target === "object" ? sm.target : {};
					const by = t(target.selector || target.bySelector || "");
					const query = t(target.query || "");
					const targetMode = by ? "selector" : (query ? "query" : "none");
					const checkOnly = !!((input && input["showMore.checkOnly"]) ?? sm.checkOnly ?? false);
					const expand = !!((input && input["showMore.expand"]) ?? sm.expand ?? true);
					const maxTries = Math.max(1, Math.min(8, Number((input && input["showMore.maxTries"]) ?? sm.maxTries ?? 2) || 2));
					const timeoutMs = Math.max(1000, Math.min(60000, Number((input && input["showMore.timeoutMs"]) ?? sm.timeoutMs ?? 8000) || 8000));
					return { targetMode, by, query, checkOnly, expand, maxTries, timeoutMs };
				}`,
				args: ["${{ ({ showMore: args.showMore || {}, 'showMore.checkOnly': args['showMore.checkOnly'], 'showMore.expand': args['showMore.expand'], 'showMore.maxTries': args['showMore.maxTries'], 'showMore.timeoutMs': args['showMore.timeoutMs'] }) }}"],
			},
			saveAs: "smCtx",
			next: { done: "route_target", failed: "abort" },
		},
		{
			id: "route_target",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "smCtx.targetMode", value: "selector" }, to: "resolve_target_by" },
					{ when: { op: "eq", source: "vars", path: "smCtx.targetMode", value: "query" }, to: "resolve_target_query" },
				],
				default: "check_collapsed",
			},
			next: {},
		},
		{
			id: "resolve_target_by",
			action: { type: "selector", by: "${vars.smCtx.by}" },
			saveAs: "targetSel",
			next: { done: "check_collapsed", failed: "abort" },
		},
		{
			id: "resolve_target_query",
			action: { type: "selector", query: "${vars.smCtx.query}" },
			saveAs: "targetSel",
			next: { done: "check_collapsed", failed: "abort" },
		},
		{
			id: "check_collapsed",
			action: {
				type: "run_js",
				scope: "page",
				code: detectCode,
				args: ["${{ vars.targetSel?.by || '' }}"],
			},
			saveAs: "checkOut",
			next: { done: "route_after_check", failed: "abort" },
		},
		{
			id: "route_after_check",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "checkOut.blocked", value: false }, to: "done_checked" },
					{ when: { op: "eq", source: "vars", path: "smCtx.checkOnly", value: true }, to: "done_checked" },
					{ when: { op: "eq", source: "vars", path: "smCtx.expand", value: false }, to: "done_checked" },
				],
				default: "expand_once",
			},
			next: {},
		},
		{
			id: "expand_once",
			action: {
				type: "run_js",
				scope: "page",
				code: expandCode,
				args: ["${{ vars.targetSel?.by || '' }}", "${{ ({ maxTries: vars.smCtx?.maxTries || 2, timeoutMs: vars.smCtx?.timeoutMs || 8000 }) }}"],
			},
			saveAs: "expandOut",
			next: { done: "route_after_expand", failed: "abort" },
		},
		{
			id: "route_after_expand",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "expandOut.expanded", value: true }, to: "done_expanded" },
				],
				default: "resolve_ai_toggle",
			},
			next: {},
		},
		{
			id: "resolve_ai_toggle",
			action: {
				type: "selector",
				query: "在当前页面或目标区域内，定位“展开更多/展开全文/显示全部/read more/show more/expand”按钮或链接。禁止选择导航菜单、登录入口、页脚链接。",
				cacheKeySuffix: "${{ vars.targetSel?.by || 'showmore_root' }}",
			},
			saveAs: "aiToggleSel",
			next: { done: "click_ai_toggle", failed: "done_expanded" },
		},
		{
			id: "click_ai_toggle",
			action: {
				type: "click",
				by: "${vars.aiToggleSel.by}",
				postWaitMs: 600,
			},
			saveAs: "aiToggleClickOut",
			next: { done: "recheck_after_ai", failed: "done_expanded" },
		},
		{
			id: "recheck_after_ai",
			action: {
				type: "run_js",
				scope: "page",
				code: detectCode,
				args: ["${{ vars.targetSel?.by || '' }}"],
			},
			saveAs: "checkAfterAi",
			next: { done: "merge_ai_expand_out", failed: "done_expanded" },
		},
		{
			id: "merge_ai_expand_out",
			action: {
				type: "run_js",
				scope: "agent",
				code: `function(prev, after){
					const p = (prev && typeof prev === "object") ? prev : {};
					const a = (after && typeof after === "object") ? after : {};
					const expanded = !!(p.expanded || !a.blocked);
					const blocked = !expanded;
					const reason = expanded
						? (a.reason ? ("ai fallback success: " + a.reason) : "ai fallback success")
						: (p.reason || "expand failed");
					return {
						blocked,
						expanded,
						newItems: expanded ? Math.max(1, Number(p.newItems || 0)) : Number(p.newItems || 0),
						tries: Number(p.tries || 0),
						reason,
						aiFallback: true,
					};
				}`,
				args: ["${{ vars.expandOut || {} }}", "${{ vars.checkAfterAi || {} }}"],
			},
			saveAs: "expandOut",
			next: { done: "done_expanded", failed: "done_expanded" },
		},
		{
			id: "done_checked",
			action: {
				type: "done",
				reason: "showMore checked",
				conclusion: "${{ ({ blocked: !!vars.checkOut?.blocked, expanded: !!vars.checkOut?.expanded, newItems: 0, reason: vars.checkOut?.reason || '' }) }}",
			},
			next: {},
		},
		{
			id: "done_expanded",
			action: {
				type: "done",
				reason: "showMore expand attempted",
				conclusion: "${{ ({ blocked: !!vars.expandOut?.blocked, expanded: !!vars.expandOut?.expanded, newItems: Number(vars.expandOut?.newItems || 0), reason: vars.expandOut?.reason || '' }) }}",
			},
			next: {},
		},
		{
			id: "abort",
			action: { type: "abort", reason: "showMore failed" },
			next: {},
		},
	],
	vars: {
		smCtx: { type: "object", desc: "normalized showMore args", from: "init_ctx.saveAs" },
		targetSel: { type: "object", desc: "resolved showMore target selector", from: "resolve_target_by.saveAs/resolve_target_query.saveAs" },
		checkOut: { type: "object", desc: "showMore check result", from: "check_collapsed.saveAs" },
		expandOut: { type: "object", desc: "showMore expand result", from: "expand_once.saveAs" },
		aiToggleSel: { type: "object", desc: "ai fallback selector for showMore toggle", from: "resolve_ai_toggle.saveAs" },
		checkAfterAi: { type: "object", desc: "showMore recheck result after ai fallback click", from: "recheck_after_ai.saveAs" },
	},
};

const showMoreGenericObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default showMoreGenericObject;
export { capabilities, filters, ranks, flow, showMoreGenericObject };
