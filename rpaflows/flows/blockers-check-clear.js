const detectBlockerCode = "function(config){ const maxScan = Math.max(20, Math.min(400, Number(config && config.maxScan || 180))); const minCoverRatio = Math.max(0.05, Math.min(0.9, Number(config && config.minCoverRatio || 0.12))); function isVisible(el){ if(!el) return false; const st = window.getComputedStyle(el); if(!st) return false; if(st.display==='none' || st.visibility==='hidden' || Number(st.opacity||'1')<=0.02) return false; const r = el.getBoundingClientRect(); return r.width>2 && r.height>2; } function zIndex(el){ const st = window.getComputedStyle(el); const z = Number.parseInt(st && st.zIndex || '',10); return Number.isFinite(z)?z:0; } function coverRatio(el){ const r = el.getBoundingClientRect(); const vw = Math.max(document.documentElement.clientWidth, window.innerWidth||0); const vh = Math.max(document.documentElement.clientHeight, window.innerHeight||0); const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)); const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)); const area = w*h; const viewport = Math.max(1, vw*vh); return area/viewport; } function isSemanticBlocker(el){ const role = String(el.getAttribute('role')||'').toLowerCase(); const ariaModal = String(el.getAttribute('aria-modal')||'').toLowerCase(); if(role==='dialog' || role==='alertdialog' || ariaModal==='true') return true; const hay = [el.id||'', el.className||'', el.getAttribute('data-testid')||'', el.getAttribute('data-test')||''].join(' ').toLowerCase(); const kws = ['cookie','consent','gdpr','ccpa','subscribe','newsletter','signup','register','paywall','meter','wall','modal','dialog','popup','overlay','backdrop','lightbox','interstitial','gate','captcha','verify','robot','login','sign-in']; return kws.some(k=>hay.includes(k)); } function topIntercepts(el){ const r = el.getBoundingClientRect(); const vw = Math.max(document.documentElement.clientWidth, window.innerWidth||0); const vh = Math.max(document.documentElement.clientHeight, window.innerHeight||0); const pts = [[0.5,0.5],[0.2,0.2],[0.8,0.2],[0.2,0.8],[0.8,0.8]]; for(const p of pts){ const x = Math.min(vw-1, Math.max(0, Math.floor(r.left + r.width*p[0]))); const y = Math.min(vh-1, Math.max(0, Math.floor(r.top + r.height*p[1]))); const t = document.elementFromPoint(x,y); if(!t) continue; if(t===el || el.contains(t)) return true; } return false; } function classify(el, text){ const low = (String(text||'')+' '+String(el.id||'')+' '+String(el.className||'')).toLowerCase(); if(/captcha|robot|verify you are human/.test(low)) return 'captcha'; if(/paywall|subscribe to continue|member only|premium/.test(low)) return 'paywall'; if(/login|sign in|log in|登录|登入/.test(low)) return 'login'; if(/cookie|consent|gdpr|ccpa|隐私|同意/.test(low)) return 'consent'; return 'modal'; } const selectors = ['[role=\"dialog\"]','[role=\"alertdialog\"]','[aria-modal=\"true\"]','.modal,.dialog,.popup,.overlay,.backdrop,.lightbox','[id*=\"cookie\" i],[class*=\"cookie\" i],[id*=\"consent\" i],[class*=\"consent\" i]','[id*=\"paywall\" i],[class*=\"paywall\" i],[id*=\"interstitial\" i],[class*=\"interstitial\" i]','[id*=\"captcha\" i],[class*=\"captcha\" i],iframe[title*=\"captcha\" i]'].join(','); const nodes = Array.from(document.querySelectorAll(selectors)).slice(0,maxScan); const cands=[]; for(const el of nodes){ if(!isVisible(el)) continue; const cr = coverRatio(el); const sem = isSemanticBlocker(el); const zi = zIndex(el); if(cr < minCoverRatio && !sem) continue; if(!(topIntercepts(el) || (sem && zi>=10))) continue; const text = String(el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,160); cands.push({coverRatio:cr, zIndex:zi, semantic:sem, text, kind: classify(el,text)}); } cands.sort((a,b)=>(b.coverRatio-a.coverRatio)||(b.zIndex-a.zIndex)); if(!cands.length){ return { blocked:false, simpleClosePossible:false, kind:null, reason:'No visible interaction-blocking overlay detected', blockers:[] }; } const top = cands[0]; const hardKinds = new Set(['captcha','login','paywall']); const simpleClosePossible = !hardKinds.has(top.kind); return { blocked:true, simpleClosePossible, kind: top.kind, reason: 'Top blocker: kind='+top.kind+' cover='+(top.coverRatio*100).toFixed(1)+'% z='+top.zIndex, blockers:cands.slice(0,8) }; }";

const capabilities = {
	must: ["blockers.check"],
	prefer: ["blockers.clear", "blockers.check.result"],
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

const flow = {
	id: "blockers_check_clear",
	start: "detect",
	args: {
		blockers: { type: "object", required: false, desc: "blocker 参数，支持 clear:boolean" },
	},
	steps: [
		{
			id: "detect",
			action: {
				type: "run_js",
				scope: "page",
				code: detectBlockerCode,
				args: [{ maxScan: 180, minCoverRatio: 0.12 }],
			},
			saveAs: "blockerCheck",
			next: "route_blocked",
		},
		{
			id: "route_blocked",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "blockerCheck.blocked", value: false }, to: "done_no_blocker" },
				],
				default: "route_clear_flag",
			},
			next: {},
		},
		{
			id: "route_clear_flag",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "args", path: "blockers.clear", value: true }, to: "route_simple_close" },
				],
				default: "done_blocked_only",
			},
			next: {},
		},
		{
			id: "route_simple_close",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "blockerCheck.simpleClosePossible", value: true }, to: "click_close" },
				],
				default: "fail_manual_needed",
			},
			next: {},
		},
		{
			id: "click_close",
			action: {
				type: "click",
				query: "关闭当前页面阻挡交互的弹窗或遮罩。优先点击：关闭/同意/接受/仅本次/我知道了/继续 等按钮；禁止点击会导致跳转或登录提交的按钮。",
			},
			saveAs: "clickedClose",
			next: { done: "detect_after_clear", failed: "fail_click_close" },
		},
		{
			id: "detect_after_clear",
			action: {
				type: "run_js",
				scope: "page",
				code: detectBlockerCode,
				args: [{ maxScan: 180, minCoverRatio: 0.12 }],
			},
			saveAs: "blockerCheckAfter",
			next: "route_after_clear",
		},
		{
			id: "route_after_clear",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "blockerCheckAfter.blocked", value: false }, to: "done_cleared" },
				],
				default: "fail_still_blocked",
			},
			next: {},
		},
		{
			id: "done_no_blocker",
			action: {
				type: "done",
				reason: "no blocker",
				conclusion: "${{ ({ blocked:false, cleared:false, kind: vars.blockerCheck?.kind || null, reason: vars.blockerCheck?.reason || '' }) }}",
			},
			next: {},
		},
		{
			id: "done_blocked_only",
			action: {
				type: "done",
				reason: "blocked checked only",
				conclusion: "${{ ({ blocked:true, cleared:false, kind: vars.blockerCheck?.kind || null, reason: vars.blockerCheck?.reason || 'blocked and clear disabled' }) }}",
			},
			next: {},
		},
		{
			id: "done_cleared",
			action: {
				type: "done",
				reason: "blocker cleared",
				conclusion: "${{ ({ blocked:false, cleared:true, kind: vars.blockerCheck?.kind || null, reason: vars.blockerCheckAfter?.reason || '' }) }}",
			},
			next: {},
		},
		{
			id: "fail_manual_needed",
			action: {
				type: "abort",
				reason: "blocker requires manual handling: ${vars.blockerCheck.kind}; ${vars.blockerCheck.reason}",
			},
			next: {},
		},
		{
			id: "fail_click_close",
			action: {
				type: "abort",
				reason: "failed to click blocker close element (query resolved by AI/cache).",
			},
			next: {},
		},
		{
			id: "fail_still_blocked",
			action: {
				type: "abort",
				reason: "click close done but blocker still present: ${vars.blockerCheckAfter.reason}; clickedBy=${vars.clickedClose.by}",
			},
			next: {},
		},
	],
};

const blockersCheckClearObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default blockersCheckClearObject;
export { capabilities, filters, ranks, flow, blockersCheckClearObject };
