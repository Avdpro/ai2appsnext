const loginDetectCode = `function(){
	function isVisible(el){
		if(!el) return false;
		const st = window.getComputedStyle(el);
		if(!st) return false;
		if(st.display==='none' || st.visibility==='hidden' || Number(st.opacity||'1')<=0.02) return false;
		const r = el.getBoundingClientRect();
		return r.width>2 && r.height>2;
	}
	function q(s){
		try{ return document.querySelector(s); }catch(_){ return null; }
	}
	function normalize(s){
		return String(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
	}
	function textOf(el){
		if(!el) return '';
		const txt = el.innerText || el.textContent || '';
		return String(txt || '').replace(/\\s+/g,' ').trim();
	}
	function isLikelyInteractive(el){
		if(!el) return false;
		const tag = String(el.tagName || '').toLowerCase();
		if(tag==='a' || tag==='button' || tag==='input' || tag==='select' || tag==='textarea') return true;
		const role = normalize(el.getAttribute && el.getAttribute('role'));
		if(role && /(button|link|menuitem|tab|option)/i.test(role)) return true;
		const tabindex = el.getAttribute && el.getAttribute('tabindex');
		if(tabindex !== null && Number(tabindex) >= 0) return true;
		if((el.getAttribute && el.getAttribute('onclick')) || (el.getAttribute && el.getAttribute('data-action'))) return true;
		const st = window.getComputedStyle(el);
		if(st && st.cursor === 'pointer') return true;
		return false;
	}
	function hasVisibleLoginCTA(){
		let nodes = [];
		try{
			nodes = Array.from(document.querySelectorAll('a,button,input[type=\"button\"],input[type=\"submit\"],[role],[tabindex],[id*=\"login\" i],[class*=\"login\" i],[data-testid*=\"login\" i],[data-action*=\"login\" i],[aria-label*=\"login\" i],[title*=\"login\" i]'));
		}catch(_){ nodes = []; }
		const include = /(登录|登錄|sign\\s*in|log\\s*in|signin|login|立即登录|去登录)/i;
		const exclude = /(退出|注销|登出|logout|sign\\s*out|log\\s*out)/i;
		for(const el of nodes){
			if(!isVisible(el)) continue;
			if(!isLikelyInteractive(el)) continue;
			const label = [
				textOf(el),
				el.getAttribute && el.getAttribute('aria-label'),
				el.getAttribute && el.getAttribute('title'),
				el.getAttribute && el.getAttribute('id'),
				el.getAttribute && el.getAttribute('class'),
				el.getAttribute && el.getAttribute('data-testid'),
				el.getAttribute && el.getAttribute('data-action')
			].filter(Boolean).join(' ');
			if(!label) continue;
			if(exclude.test(label)) continue;
			if(include.test(label)) return true;
		}
		return false;
	}
	function hasVisibleLoginHref(){
		let nodes = [];
		try{
			nodes = Array.from(document.querySelectorAll('a[href],button[onclick],[role],[tabindex],[id],[class],[data-action],[data-testid]'));
		}catch(_){ nodes = []; }
		const re = /(login|signin|sign-in|passport|auth|account\\/login|\\/user\\/login|openlogin|newlogin)/i;
		for(const el of nodes){
			if(!isVisible(el)) continue;
			const signals = [
				el.getAttribute && (el.getAttribute('href') || el.getAttribute('data-href')),
				el.getAttribute && el.getAttribute('onclick'),
				el.getAttribute && el.getAttribute('id'),
				el.getAttribute && el.getAttribute('class'),
				el.getAttribute && el.getAttribute('data-action'),
				el.getAttribute && el.getAttribute('data-testid'),
				el.getAttribute && el.getAttribute('aria-label'),
				el.getAttribute && el.getAttribute('title'),
			].filter(Boolean).map((v)=>String(v));
			if(signals.some((v)=>re.test(v)) && (isLikelyInteractive(el) || signals.some((v)=>/href|click|action|login|signin|passport|auth/i.test(v)))) return true;
		}
		return false;
	}
	const curUrl = String(location.href || '');
	const curUrlLower = curUrl.toLowerCase();

	// Explicit not-logged-in evidence (avoid "unknown => logged-in" false positive on Weibo login routes)
	const explicitLoggedOutUrl = (
		/location\\.weibo\\.com|passport\\.weibo\\.com/.test(curUrlLower) ||
		/weibo\\.com\\/newlogin/.test(curUrlLower)
	);
	if (explicitLoggedOutUrl) {
		return {
			loggedIn: false,
			reason: 'explicit logged-out route',
			state: 'logged_out',
			url: curUrl
		};
	}

	let loggedIn = false;
	let reason = '';

	// Strong logged-in markers
	const stateAttr = document.body.getAttribute('data-login-state') || '';
	if(normalize(stateAttr)==='logged-in') loggedIn = true;
	if(!loggedIn){
		const stateEl = q('[data-login-state="logged-in"], #login-state[data-login-state="logged-in"]');
		if(stateEl) loggedIn = true;
	}
	if(!loggedIn){
		const logoutBtn = q('#logout-btn, [data-action="logout"], button.logout, a.logout, [href*="logout" i], [href*="signout" i]');
		if(logoutBtn && isVisible(logoutBtn)) loggedIn = true;
	}

	// Explicit login-required evidence
	const loginOverlay = q('#login-overlay, [role="dialog"][aria-modal="true"], .login.modal, .login-dialog, .auth-modal');
	const emailInput = q('input[type="email"], input[name*="email" i], #login-email');
	const passInput = q('input[type="password"], input[name*="pass" i], #login-password');
	const loginBtn = q('#login-submit, button[type="submit"], button[name*="login" i], button[id*="login" i], a[href*="login" i], a[href*="signin" i]');
	const loginBtnVisible = !!(loginBtn && isVisible(loginBtn));
	const loginCtaVisible = hasVisibleLoginCTA();
	const loginHrefVisible = hasVisibleLoginHref();
	const loginVisible = !!(loginOverlay && isVisible(loginOverlay)) || (!!emailInput && isVisible(emailInput) && !!passInput && isVisible(passInput)) || loginBtnVisible || loginCtaVisible || loginHrefVisible;

	if (loggedIn) {
		reason = 'login markers detected';
		return { loggedIn: true, reason, state: 'logged_in', url: curUrl };
	}
	if (loginVisible) {
		reason = 'login form/modal visible';
		return { loggedIn: false, reason, state: 'logged_out', url: curUrl };
	}

	// Default-allow fallback: if no explicit logged-out evidence, treat as logged-in
	reason = 'no logged-out evidence; assume logged-in';
	return {
		loggedIn: true,
		reason,
		state: 'assumed_logged_in',
		url: curUrl
	};
}`;

const capabilities = {
	must: ["login.check"],
	prefer: ["login.ensure", "login.interactive", "login.check.result", "login.ensure.result"],
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
	id: "login_check_ensure",
	start: "check_before",
	args: {
		login: { type: "object", required: false, desc: "login 参数，支持 ensure/email/password" },
	},
	steps: [
		{
			id: "check_before",
			action: { type: "run_js", scope: "page", code: loginDetectCode },
			saveAs: "check0",
			next: "route_logged_in_before",
		},
		{
			id: "route_logged_in_before",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "check0.loggedIn", value: true }, to: "done_check_logged_in" },
				],
				default: "route_ensure_flag",
			},
			next: {},
		},
		{
			id: "route_ensure_flag",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "args", path: "login.ensure", value: true }, to: "ask_assist_login" },
				],
				default: "done_check_not_logged_in",
			},
			next: {},
		},
		{
			id: "ask_assist_login",
			action: {
				type: "ask_assist",
				reason: "请在页面手动完成登录（包含账号输入、验证码、二次确认等），完成后点击“已处理，继续”。若放弃请点“无法处理”。",
				waitUserAction: true,
				maxRetry: 1,
				modal: false,
				mask: false,
			},
			next: { done: "check_after_assist", failed: "abort_ensure_failed" },
		},
		{
			id: "check_after_assist",
			action: { type: "run_js", scope: "page", code: loginDetectCode },
			saveAs: "check2",
			next: "route_after_assist",
		},
		{
			id: "route_after_assist",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "check2.loggedIn", value: true }, to: "done_ensure_logged_in" },
				],
				default: "abort_ensure_failed",
			},
			next: {},
		},
		{
			id: "done_check_logged_in",
			action: {
				type: "done",
				reason: "login.check done (already logged-in)",
				conclusion: "${{ ({ loggedIn:true, reason: vars.check0?.reason || 'already logged-in' }) }}",
			},
			next: {},
		},
		{
			id: "done_check_not_logged_in",
			action: {
				type: "done",
				reason: "login.check done (not logged-in)",
				conclusion: "${{ ({ loggedIn:false, reason: vars.check0?.reason || 'not logged-in' }) }}",
			},
			next: {},
		},
		{
			id: "done_ensure_logged_in",
			action: {
				type: "done",
				reason: "login.ensure done",
				conclusion: "${{ ({ loggedIn:true, reason: vars.check2?.reason || 'login ensured by user action' }) }}",
			},
			next: {},
		},
		{
			id: "abort_ensure_failed",
			action: {
				type: "abort",
				reason: "login.ensure failed: still not logged-in after auto/manual attempts",
			},
			next: {},
		},
	],
};

const loginCheckEnsureObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default loginCheckEnsureObject;
export { capabilities, filters, ranks, flow, loginCheckEnsureObject };
