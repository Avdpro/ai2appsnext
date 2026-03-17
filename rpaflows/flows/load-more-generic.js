const capabilities = {
	must: ["loadMore"],
	prefer: ["loadMore.target", "loadMore.minNewItems", "loadMore.maxTries", "loadMore.result"],
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

const initCode = `function(input){
	function toNum(v, d, min, max){
		let n = Number(v);
		if(!Number.isFinite(n)) n = d;
		if(Number.isFinite(min)) n = Math.max(min, n);
		if(Number.isFinite(max)) n = Math.min(max, n);
		return n;
	}
	function text(v){ return String(v == null ? "" : v).trim(); }
	function visible(el){
		if(!el) return false;
		const st = window.getComputedStyle(el);
		if(!st) return false;
		if(st.display === "none" || st.visibility === "hidden" || Number(st.opacity || "1") <= 0.02) return false;
		const r = el.getBoundingClientRect();
		return r.width > 2 && r.height > 2;
	}
	function pickItems(selector){
		if(selector){
			const root = document.querySelector(selector);
			if(!root) return [];
			const tries = [":scope > li", ":scope > article", ":scope > .item", ":scope > .card", ":scope > *"];
			for(const q of tries){
				const arr = Array.from(root.querySelectorAll(q)).filter(visible);
				if(arr.length >= 2) return arr;
			}
			return Array.from(root.children || []).filter(visible);
		}
		const scopes = [document.querySelector("main"), document.body].filter(Boolean);
		const sels = ["article", "li", "[role='listitem']", ".list-item", ".item", ".card"];
		for(const scope of scopes){
			let best = [];
			for(const s of sels){
				const arr = Array.from(scope.querySelectorAll(s)).filter(visible);
				if(arr.length > best.length) best = arr;
			}
			if(best.length >= 2) return best;
		}
		return [];
	}
	const lm = (input && input.loadMore) || {};
	const rd = (input && input.read) || {};
	const target = lm.target || rd.target || {};
	const selector = text(target.selector || "");
	const items = pickItems(selector);
	return {
		tries: 0,
		maxTries: toNum(lm.maxTries, 3, 1, 10),
		minNewItems: toNum(lm.minNewItems, 1, 1, 200),
		selector,
		aiTried: false,
		aiSelector: "",
		preferredAction: "",
		decisionReason: "",
		count: items.length,
		totalNew: 0,
		newItems: 0,
		hasMore: true,
		done: false,
		lastAction: "init",
		reason: "initialized",
		url: String(location.href || ""),
	};
}`;

const attemptCode = `async function(state){
	function sleep(ms){ return new Promise((r)=>setTimeout(r, ms)); }
	function text(v){ return String(v == null ? "" : v).trim(); }
	function visible(el){
		if(!el) return false;
		const st = window.getComputedStyle(el);
		if(!st) return false;
		if(st.display === "none" || st.visibility === "hidden" || Number(st.opacity || "1") <= 0.02) return false;
		const r = el.getBoundingClientRect();
		return r.width > 2 && r.height > 2;
	}
	function pickItems(selector){
		if(selector){
			const root = document.querySelector(selector);
			if(!root) return [];
			const tries = [":scope > li", ":scope > article", ":scope > .item", ":scope > .card", ":scope > *"];
			for(const q of tries){
				const arr = Array.from(root.querySelectorAll(q)).filter(visible);
				if(arr.length >= 2) return arr;
			}
			return Array.from(root.children || []).filter(visible);
		}
		const scopes = [document.querySelector("main"), document.body].filter(Boolean);
		const sels = ["article", "li", "[role='listitem']", ".list-item", ".item", ".card"];
		for(const scope of scopes){
			let best = [];
			for(const s of sels){
				const arr = Array.from(scope.querySelectorAll(s)).filter(visible);
				if(arr.length > best.length) best = arr;
			}
			if(best.length >= 2) return best;
		}
		return [];
	}
	function findLoadMoreControl(){
		const kws = [
			"加载更多","更多","下一页","下页","下一","后页","翻页",
			"next","more","show more","load more","older","older posts","continue",
			"›","»","→","⟩","＞"
		];
		const cands = Array.from(document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']"));
		let best = null;
		for(const el of cands){
			if(!visible(el)) continue;
			const st = window.getComputedStyle(el);
			if(st.pointerEvents === "none") continue;
			const t = ((
				el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || el.value || ""
			) + "").toLowerCase();
			const idc = ((el.id || "") + " " + (el.className || "")).toLowerCase();
			if(!t) continue;
			if(
				kws.some((k)=>t.includes(k.toLowerCase())) ||
				/(^|[^a-z])(next|more|pager?|pagination|load)([^a-z]|$)/.test(idc)
			){
				best = el;
				break;
			}
		}
		if(best) return best;
		const relNext = document.querySelector("a[rel='next'], link[rel='next']");
		if(relNext && visible(relNext)) return relNext;
		return null;
	}
	function scrollOneStep(selector){
		const root = selector ? document.querySelector(selector) : null;
		if(root){
			const canScroll = root.scrollHeight > root.clientHeight + 4;
			if(canScroll){
				// Go near-bottom directly to reliably trigger infinite-load hooks.
				root.scrollTop = Math.max(0, root.scrollHeight - root.clientHeight - 2);
				return true;
			}
		}
		const y = window.scrollY || window.pageYOffset || 0;
		const step = Math.max(260, Math.floor((window.innerHeight || 800) * 0.9));
		window.scrollTo(0, y + step);
		return true;
	}

	const s = state && typeof state === "object" ? state : {};
	const tries = Number(s.tries || 0) + 1;
	const maxTries = Math.max(1, Number(s.maxTries || 3));
	const minNewItems = Math.max(1, Number(s.minNewItems || 1));
	const selector = text(s.selector || "");
	const aiTried = !!s.aiTried;
	const aiSelector = text(s.aiSelector || "");
	const preferredAction = text(s.preferredAction || "").toLowerCase();
	const beforeItems = pickItems(selector);
	const beforeCount = Number.isFinite(Number(s.count)) ? Number(s.count) : beforeItems.length;
	const beforeUrl = String(location.href || "");
	let action = "none";
	let acted = false;
	if (preferredAction === "done") {
		return {
			...s,
			tries,
			done: true,
			hasMore: false,
			lastAction: "done_ai",
			reason: text(s.decisionReason || "ai judged no more"),
			url: beforeUrl,
		};
	}

	let ctl = null;
	if (aiSelector) {
		const aiEl = document.querySelector(aiSelector);
		if (aiEl && visible(aiEl)) {
			ctl = aiEl;
		}
	}
	const autoControl = !ctl && (preferredAction === "" || preferredAction === "click");
	if(autoControl) ctl = findLoadMoreControl();
	if(preferredAction === "click" || (preferredAction === "" && ctl)){
		if(ctl){
			try {
				ctl.scrollIntoView({ block: "center", inline: "nearest" });
			} catch(_) {}
			try {
				ctl.click();
				acted = true;
				action = aiSelector ? "click_ai" : (preferredAction === "click" ? "click_pref" : "click");
			} catch(_) {}
		}
	}
	if(!acted && (preferredAction === "scroll" || preferredAction === "")){
		scrollOneStep(selector);
		acted = true;
		action = preferredAction === "scroll" ? "scroll_ai" : "scroll";
	}

	await sleep((action.indexOf("click") >= 0) ? 1400 : 900);
	const afterItems = pickItems(selector);
	const afterCount = afterItems.length;
	const afterUrl = String(location.href || "");
	const urlChanged = afterUrl !== beforeUrl;
	let newItems = Math.max(0, afterCount - beforeCount);
	if(urlChanged && afterCount > 0 && newItems === 0){
		newItems = afterCount;
	}

	const totalNew = Math.max(0, Number(s.totalNew || 0)) + newItems;
	const hitGoal = newItems >= minNewItems || totalNew >= minNewItems;
	const exhausted = tries >= maxTries;
	const done = hitGoal || exhausted || (!acted && preferredAction === "done");
	const hasMore = !done;

	return {
		tries,
		maxTries,
		minNewItems,
		selector,
		aiTried,
		aiSelector,
		preferredAction,
		decisionReason: text(s.decisionReason || ""),
		count: afterCount,
		newItems,
		totalNew,
		done,
		hasMore,
		lastAction: action,
		reason: hitGoal ? "minNewItems reached" : (exhausted ? "maxTries reached" : (!acted ? "no actionable control" : "retry")),
		url: afterUrl,
		urlChanged
	};
}`;

const flow = {
	id: "load_more_generic",
	start: "init",
	args: {
		loadMore: { type: "object", required: false, desc: "loadMore 参数（target/minNewItems/maxTries）" },
		read: { type: "object", required: false, desc: "兼容 read.target 透传" },
	},
	steps: [
		{
			id: "init",
			action: {
				type: "run_js",
				scope: "page",
				code: initCode,
				args: ["${{ ({ loadMore: args.loadMore || {}, read: args.read || {} }) }}"],
			},
			saveAs: "lmState",
			next: "decide_strategy_ai",
		},
		{
			id: "decide_strategy_ai",
			action: {
				type: "run_ai",
				model: "advanced",
				cache: { enabled: true, key: "load_more_strategy" },
				prompt: "你是网页自动化策略器。你只能输出一个 JSON result：{ action:'click'|'scroll'|'done', selector:'', reason:'' }。规则：1) 如果页面存在明显“加载更多/下一页/更多结果”按钮或链接，action=click，selector给稳定CSS（找不到可留空）；2) 如果更像无限滚动，action=scroll；3) 如果看不到可继续加载的线索，action=done。禁止选择站点导航、登录、设置、帮助、页脚。优先主内容区域。",
				input: "${{ ({ state: vars.lmState || {}, loadMore: args.loadMore || {}, read: args.read || {} }) }}",
				page: { url: true, title: true, html: true },
			},
			saveAs: "aiPlan",
			next: { done: "merge_ai_plan", failed: "attempt" },
		},
		{
			id: "merge_ai_plan",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(state, plan){ const s = (state && typeof state==='object') ? state : {}; const p = (plan && typeof plan==='object') ? plan : {}; const a = String(p.action || '').toLowerCase(); const act = (a==='click'||a==='scroll'||a==='done') ? a : ''; const sel = String(p.selector || '').trim(); const aiSelector = sel || String(s.aiSelector || ''); return { ...s, preferredAction: act, decisionReason: String(p.reason || ''), aiSelector, aiTried: !!(s.aiTried || sel) }; }",
				args: ["${{ vars.lmState || {} }}", "${{ vars.aiPlan || {} }}"],
			},
			saveAs: "lmState",
			next: "route_ai",
		},
		{
			id: "attempt",
			action: {
				type: "run_js",
				scope: "page",
				code: attemptCode,
				args: ["${{ vars.lmState || {} }}"],
			},
			saveAs: "lmState",
			next: "route_done",
		},
		{
			id: "route_done",
			action: {
				type: "branch",
				cases: [{ when: { op: "truthy", source: "vars", path: "lmState.done" }, to: "done" }],
				default: "decide_strategy_ai",
			},
			next: {},
		},
		{
			id: "route_ai",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "lmState.preferredAction", value: "done" }, to: "attempt" },
					{ when: { op: "eq", source: "vars", path: "lmState.preferredAction", value: "scroll" }, to: "attempt" },
					{ when: { op: "truthy", source: "vars", path: "lmState.aiSelector" }, to: "attempt" },
					{ when: { op: "truthy", source: "vars", path: "lmState.aiTried" }, to: "attempt" },
					{ when: { op: "neq", source: "vars", path: "lmState.preferredAction", value: "click" }, to: "attempt" }
				],
				default: "resolve_control_ai",
			},
			next: {},
		},
		{
			id: "resolve_control_ai",
			action: {
				type: "selector",
				query: {
					kind: "selector",
					mode: "instance",
					policy: "pool",
					text: "用于加载更多内容或下一页的可点击按钮/链接。必须是主内容区域，不要导航栏、登录、帮助、设置、页脚。"
				}
			},
			saveAs: "aiCtl",
			next: { done: "apply_ai_selector", failed: "mark_ai_tried" },
		},
		{
			id: "apply_ai_selector",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(state, ai){ const s = (state && typeof state==='object') ? state : {}; const a = (ai && typeof ai==='object') ? ai : {}; return { ...s, aiTried:true, aiSelector:String(a.by || a.selector || '') }; }",
				args: ["${{ vars.lmState || {} }}", "${{ vars.aiCtl || {} }}"],
			},
			saveAs: "lmState",
			next: "attempt",
		},
		{
			id: "mark_ai_tried",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(state){ const s = (state && typeof state==='object') ? state : {}; return { ...s, aiTried:true }; }",
				args: ["${{ vars.lmState || {} }}"],
			},
			saveAs: "lmState",
			next: "attempt",
		},
		{
			id: "done",
			action: {
				type: "done",
				reason: "loadMore done",
				conclusion: "${{ ({ newItems: Number(vars.lmState?.totalNew||0), hasMore: !!vars.lmState?.hasMore, tries: Number(vars.lmState?.tries||0), lastAction: vars.lmState?.lastAction||'', reason: vars.lmState?.reason||'', url: vars.lmState?.url||'' }) }}",
			},
			next: {},
		},
	],
};

const loadMoreGenericObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default loadMoreGenericObject;
export { capabilities, filters, ranks, flow, loadMoreGenericObject };
