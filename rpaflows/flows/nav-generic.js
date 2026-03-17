const capabilities = {
	must: ["nav"],
	prefer: ["nav.dest", "nav.result"],
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

const verifyNavCode = `function(before, ctx){
	function t(v){ return String(v == null ? "" : v).trim(); }
	function low(v){ return t(v).toLowerCase(); }
	function hasAny(text, list){
		const hay = low(text);
		for(const x of (Array.isArray(list) ? list : [])){
			const k = low(x);
			if(k && hay.includes(k)) return true;
		}
		return false;
	}
	function isProfileDestination(destKey){
		return low(destKey) === "profile";
	}
	function scoreProfile(url, title, bodyText){
		let score = 0;
		const u = low(url);
		const ttl = low(title);
		const body = low(bodyText);
		if(/\\/(?:u|user|users|me|account|people)(?:\\/|$|[?#])/.test(u) || /\\/profile(?:\\/|$|[?#])/.test(u) || /(?:^|[?#&])tab=profile\\b/.test(u)) score += 2;
		if(/(?:个人主页|我的主页|我的账号|账号中心|profile\\s*page|account\\s*center)/.test(ttl)) score += 1;
		if(/(?:个人简介|简介|about\\s+me|bio|followers?|following|粉丝|关注|获赞)/.test(body)) score += 1;
		const hasAvatar = !!document.querySelector("img[alt*='avatar' i], img[class*='avatar' i], [class*='avatar' i] img");
		const hasNameLike = !!document.querySelector("h1, h2, [class*='name' i], [data-testid*='name' i]");
		if(hasAvatar && hasNameLike) score += 1;
		const hasProfileMeta = !!document.querySelector("meta[property='og:type'][content*='profile' i], [itemtype*='Person']");
		if(hasProfileMeta) score += 1;
		return score;
	}
	const b = before && typeof before === "object" ? before : {};
	const c = ctx && typeof ctx === "object" ? ctx : {};
	const labels = Array.isArray(c.destLabels) ? c.destLabels : [];
	const destKey = t(c.destKey);
	const url = t(location.href);
	const title = t(document.title);
	const bodyText = t((document.body && document.body.innerText) || "").slice(0, 3000);
	const changedUrl = !!t(b.url) && t(b.url) !== url;
	const titleHit = hasAny(title, labels);
	const urlHit = hasAny(url, labels);
	const bodyHit = hasAny(bodyText, labels);
	if(!isProfileDestination(destKey)){
		const ok = !!(changedUrl || titleHit || urlHit || bodyHit);
		return { ok, url, title, changedUrl, titleHit, urlHit, bodyHit, labels, destKey, profileScore: 0 };
	}
	const profileScore = scoreProfile(url, title, bodyText);
	const ok = profileScore >= 1;
	return { ok, url, title, changedUrl, titleHit, urlHit, bodyHit, labels, destKey, profileScore };
}`;

const flow = {
	id: "nav_generic",
	start: "init_ctx",
	args: {
		nav: { type: "object", required: false, desc: "nav args, supports nav.dest/nav.target" },
	},
	steps: [
		{
			id: "init_ctx",
			action: {
				type: "run_js",
				scope: "agent",
				code: `function(input){
					function t(v){ return String(v == null ? "" : v).trim(); }
					function norm(s){ return t(s).toLowerCase().replace(/[\\s_\\-]+/g, ""); }
					function pickDest(raw){
						const x = norm(raw);
						if(!x) return "";
						if(["home","homepage","index","main","feed","timeline","shouye","zhuye","首页","主页"].some(k => x.includes(norm(k)))) return "home";
						if(["inbox","message","messages","chat","dm","xiaoxi","youxiang","消息","私信","收件箱"].some(k => x.includes(norm(k)))) return "inbox";
						if(["setting","settings","config","preference","preferences","shezhi","设置","偏好"].some(k => x.includes(norm(k)))) return "settings";
						if(["profile","account","me","my","wo","zhanghao","个人","账号","我的"].some(k => x.includes(norm(k)))) return "profile";
						return x;
					}
					function labels(key){
						if(key === "home") return ["首页", "主页", "Home", "Home Page", "Main", "Feed"];
						if(key === "inbox") return ["消息", "私信", "收件箱", "Inbox", "Messages", "Chat", "DM"];
						if(key === "settings") return ["设置", "偏好", "Settings", "Preferences", "Config"];
						if(key === "profile") return ["我的", "个人主页", "账号", "Profile", "Account", "Me"];
						return [key];
					}
					const nav = (input && input.nav) || {};
					const destRaw = t((input && input["nav.dest"]) || nav.dest || input.dest || "");
					const destKey = pickDest(destRaw);
					const destLabels = labels(destKey);
					const target = nav && typeof nav.target === "object" ? nav.target : {};
					const by = t(target.selector || target.bySelector || "");
					const query = t(target.query || "");
					const targetMode = by ? "selector" : (query ? "query" : "autoQuery");
					const autoQuery = "导航到「" + (destLabels[0] || destRaw || "") + "」的入口（链接/按钮/菜单项）";
					const profileQueries = [
						"打开“我的/Me/My/Profile/Account”入口（通常在页面顶栏、侧边栏、头像菜单）。不要点击内容卡片里作者/用户主页链接",
						"在当前页面继续定位“我的主页/账号中心/Profile/Account/Me”入口。避免任何帖子卡片、作者名、作者头像区域的链接",
						"若仍未到达“我的主页”，优先在个人菜单、设置菜单、账号菜单中查找并点击“我的主页/Profile/Account center/Me”",
					];
					return {
						destRaw,
						destKey,
						destLabels,
						targetMode,
						by,
						query,
						autoQuery,
						profileQueries,
						cacheKeySuffix: ((destKey || destRaw || "unknown") + "_v2_self"),
						assistReason: "请手动导航到「" + (destLabels[0] || destRaw || "目标页面") + "」，完成后点击“已处理，继续”。",
					};
				}`,
				args: ["${{ ({ nav: args.nav || {}, dest: args.dest || '', 'nav.dest': args['nav.dest'] || '' }) }}"],
			},
			saveAs: "navCtx",
			next: { done: "check_dest", failed: "abort" },
		},
		{
			id: "check_dest",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "truthy", source: "vars", path: "navCtx.destKey" }, to: "snapshot_before" },
				],
				default: "abort_missing_dest",
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
			next: { done: "route_dest_kind", failed: "abort" },
		},
		{
			id: "route_dest_kind",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "navCtx.destKey", value: "profile" }, to: "verify_profile_pre" },
				],
				default: "route_resolve",
			},
			next: {},
		},
		{
			id: "verify_profile_pre",
			action: {
				type: "run_js",
				scope: "page",
				code: verifyNavCode,
				args: ["${vars.before}", "${vars.navCtx}"],
			},
			saveAs: "verifyOut",
			next: { done: "route_verify_profile_pre", failed: "abort" },
		},
			{
				id: "route_verify_profile_pre",
				action: {
					type: "branch",
					cases: [
						{ when: { op: "eq", source: "vars", path: "verifyOut.ok", value: true }, to: "ai_review_profile_pre" },
					],
					default: "resolve_profile_query_1",
				},
				next: {},
			},
			{
				id: "ai_review_profile_pre",
				action: {
					type: "run_ai",
					model: "advanced",
					prompt: "判断当前页面是否已经是“当前登录用户自己的个人主页/Profile页（my profile）”，不是首页/发现页，也不是他人的主页。只返回结构化结果。",
					input: {
						dest: "${{ vars.navCtx?.destKey || '' }}",
						verify: "${{ vars.verifyOut || {} }}",
						stage: "profile_pre",
					},
					page: { url: true, title: true, html: true },
					schema: {
						type: "object",
						properties: {
							isOwnProfile: { type: "boolean" },
							confidence: { type: "number" },
							reason: { type: "string" }
						},
						required: ["isOwnProfile", "confidence", "reason"]
					},
					cache: { enabled: false }
				},
				saveAs: "profileReviewOut",
				next: { done: "route_ai_review_profile_pre", failed: "resolve_profile_query_1" },
			},
			{
				id: "route_ai_review_profile_pre",
				action: {
					type: "branch",
					cases: [
						{ when: { op: "eq", source: "vars", path: "profileReviewOut.isOwnProfile", value: true }, to: "done" },
					],
					default: "resolve_profile_query_1",
				},
				next: {},
			},
		{
			id: "resolve_profile_query_1",
			action: {
				type: "selector",
				query: "${{ vars.navCtx.profileQueries?.[0] || vars.navCtx.autoQuery }}",
				cacheKeySuffix: "${{ (vars.navCtx.cacheKeySuffix || 'nav') + '_profile_s1' }}",
			},
			saveAs: "navSel",
			next: { done: "click_profile_query_1", failed: "assist_nav" },
		},
		{
			id: "click_profile_query_1",
			action: { type: "click", by: "${vars.navSel.by}", postWaitMs: 700 },
			next: { done: "verify_profile_query_1", failed: "assist_nav" },
		},
		{
			id: "verify_profile_query_1",
			action: {
				type: "run_js",
				scope: "page",
				code: verifyNavCode,
				args: ["${vars.before}", "${vars.navCtx}"],
			},
			saveAs: "verifyOut",
			next: { done: "route_verify_profile_query_1", failed: "assist_nav" },
		},
			{
				id: "route_verify_profile_query_1",
				action: {
					type: "branch",
					cases: [
						{ when: { op: "eq", source: "vars", path: "verifyOut.ok", value: true }, to: "ai_review_profile_q1" },
					],
					default: "resolve_profile_query_2",
				},
				next: {},
			},
			{
				id: "ai_review_profile_q1",
				action: {
					type: "run_ai",
					model: "advanced",
					prompt: "判断当前页面是否已经是“当前登录用户自己的个人主页/Profile页（my profile）”，不是首页/发现页，也不是他人的主页。只返回结构化结果。",
					input: {
						dest: "${{ vars.navCtx?.destKey || '' }}",
						verify: "${{ vars.verifyOut || {} }}",
						stage: "profile_q1",
					},
					page: { url: true, title: true, html: true },
					schema: {
						type: "object",
						properties: {
							isOwnProfile: { type: "boolean" },
							confidence: { type: "number" },
							reason: { type: "string" }
						},
						required: ["isOwnProfile", "confidence", "reason"]
					},
					cache: { enabled: false }
				},
				saveAs: "profileReviewOut",
				next: { done: "route_ai_review_profile_q1", failed: "resolve_profile_query_2" },
			},
			{
				id: "route_ai_review_profile_q1",
				action: {
					type: "branch",
					cases: [
						{ when: { op: "eq", source: "vars", path: "profileReviewOut.isOwnProfile", value: true }, to: "done" },
					],
					default: "resolve_profile_query_2",
				},
				next: {},
			},
		{
			id: "resolve_profile_query_2",
			action: {
				type: "selector",
				query: "${{ vars.navCtx.profileQueries?.[1] || vars.navCtx.autoQuery }}",
				cacheKeySuffix: "${{ (vars.navCtx.cacheKeySuffix || 'nav') + '_profile_s2' }}",
			},
			saveAs: "navSel",
			next: { done: "click_profile_query_2", failed: "assist_nav" },
		},
		{
			id: "click_profile_query_2",
			action: { type: "click", by: "${vars.navSel.by}", postWaitMs: 900 },
			next: { done: "verify_profile_query_2", failed: "assist_nav" },
		},
		{
			id: "verify_profile_query_2",
			action: {
				type: "run_js",
				scope: "page",
				code: verifyNavCode,
				args: ["${vars.before}", "${vars.navCtx}"],
			},
			saveAs: "verifyOut",
			next: { done: "route_verify_profile_query_2", failed: "assist_nav" },
		},
			{
				id: "route_verify_profile_query_2",
				action: {
					type: "branch",
					cases: [
						{ when: { op: "eq", source: "vars", path: "verifyOut.ok", value: true }, to: "ai_review_profile_q2" },
					],
					default: "resolve_profile_query_3",
				},
				next: {},
			},
			{
				id: "ai_review_profile_q2",
				action: {
					type: "run_ai",
					model: "advanced",
					prompt: "判断当前页面是否已经是“当前登录用户自己的个人主页/Profile页（my profile）”，不是首页/发现页，也不是他人的主页。只返回结构化结果。",
					input: {
						dest: "${{ vars.navCtx?.destKey || '' }}",
						verify: "${{ vars.verifyOut || {} }}",
						stage: "profile_q2",
					},
					page: { url: true, title: true, html: true },
					schema: {
						type: "object",
						properties: {
							isOwnProfile: { type: "boolean" },
							confidence: { type: "number" },
							reason: { type: "string" }
						},
						required: ["isOwnProfile", "confidence", "reason"]
					},
					cache: { enabled: false }
				},
				saveAs: "profileReviewOut",
				next: { done: "route_ai_review_profile_q2", failed: "resolve_profile_query_3" },
			},
			{
				id: "route_ai_review_profile_q2",
				action: {
					type: "branch",
					cases: [
						{ when: { op: "eq", source: "vars", path: "profileReviewOut.isOwnProfile", value: true }, to: "done" },
					],
					default: "resolve_profile_query_3",
				},
				next: {},
			},
		{
			id: "resolve_profile_query_3",
			action: {
				type: "selector",
				query: "${{ vars.navCtx.profileQueries?.[2] || vars.navCtx.autoQuery }}",
				cacheKeySuffix: "${{ (vars.navCtx.cacheKeySuffix || 'nav') + '_profile_s3' }}",
			},
			saveAs: "navSel",
			next: { done: "click_profile_query_3", failed: "assist_nav" },
		},
		{
			id: "click_profile_query_3",
			action: { type: "click", by: "${vars.navSel.by}", postWaitMs: 1000 },
			next: { done: "verify_profile_query_3", failed: "assist_nav" },
		},
		{
			id: "verify_profile_query_3",
			action: {
				type: "run_js",
				scope: "page",
				code: verifyNavCode,
				args: ["${vars.before}", "${vars.navCtx}"],
			},
			saveAs: "verifyOut",
			next: { done: "route_verify_profile_query_3", failed: "assist_nav" },
		},
			{
				id: "route_verify_profile_query_3",
				action: {
					type: "branch",
					cases: [
						{ when: { op: "eq", source: "vars", path: "verifyOut.ok", value: true }, to: "ai_review_profile_q3" },
					],
					default: "assist_nav",
				},
				next: {},
			},
			{
				id: "ai_review_profile_q3",
				action: {
					type: "run_ai",
					model: "advanced",
					prompt: "判断当前页面是否已经是“当前登录用户自己的个人主页/Profile页（my profile）”，不是首页/发现页，也不是他人的主页。只返回结构化结果。",
					input: {
						dest: "${{ vars.navCtx?.destKey || '' }}",
						verify: "${{ vars.verifyOut || {} }}",
						stage: "profile_q3",
					},
					page: { url: true, title: true, html: true },
					schema: {
						type: "object",
						properties: {
							isOwnProfile: { type: "boolean" },
							confidence: { type: "number" },
							reason: { type: "string" }
						},
						required: ["isOwnProfile", "confidence", "reason"]
					},
					cache: { enabled: false }
				},
				saveAs: "profileReviewOut",
				next: { done: "route_ai_review_profile_q3", failed: "assist_nav" },
			},
			{
				id: "route_ai_review_profile_q3",
				action: {
					type: "branch",
					cases: [
						{ when: { op: "eq", source: "vars", path: "profileReviewOut.isOwnProfile", value: true }, to: "done" },
					],
					default: "assist_nav",
				},
				next: {},
			},
		{
			id: "route_resolve",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "navCtx.targetMode", value: "selector" }, to: "resolve_by" },
					{ when: { op: "eq", source: "vars", path: "navCtx.targetMode", value: "query" }, to: "resolve_query" },
				],
				default: "resolve_auto_query",
			},
			next: {},
		},
		{
			id: "resolve_by",
			action: { type: "selector", by: "${vars.navCtx.by}" },
			saveAs: "navSel",
			next: { done: "click_nav", failed: "assist_nav" },
		},
		{
			id: "resolve_query",
			action: { type: "selector", query: "${vars.navCtx.query}", cacheKeySuffix: "${vars.navCtx.cacheKeySuffix}" },
			saveAs: "navSel",
			next: { done: "click_nav", failed: "assist_nav" },
		},
		{
			id: "resolve_auto_query",
			action: { type: "selector", query: "${vars.navCtx.autoQuery}", cacheKeySuffix: "${vars.navCtx.cacheKeySuffix}" },
			saveAs: "navSel",
			next: { done: "click_nav", failed: "assist_nav" },
		},
		{
			id: "click_nav",
			action: { type: "click", by: "${vars.navSel.by}", postWaitMs: 900 },
			next: { done: "verify_nav", failed: "assist_nav" },
		},
		{
			id: "verify_nav",
			action: {
				type: "run_js",
				scope: "page",
				code: verifyNavCode,
				args: ["${vars.before}", "${vars.navCtx}"],
			},
			saveAs: "verifyOut",
			next: { done: "route_verify", failed: "assist_nav" },
		},
		{
			id: "route_verify",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "verifyOut.ok", value: true }, to: "done" },
				],
				default: "assist_nav",
			},
			next: {},
		},
		{
			id: "assist_nav",
			action: {
				type: "ask_assist",
				reason: "${vars.navCtx.assistReason}",
				waitUserAction: true,
				modal: false,
				mask: false,
			},
			next: { done: "verify_after_assist", failed: "abort" },
		},
		{
			id: "verify_after_assist",
			action: {
				type: "run_js",
				scope: "page",
				code: verifyNavCode,
				args: ["${vars.before}", "${vars.navCtx}"],
			},
			saveAs: "verifyAfterAssistOut",
			next: { done: "route_verify_after_assist", failed: "abort" },
		},
		{
			id: "route_verify_after_assist",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "verifyAfterAssistOut.ok", value: true }, to: "done_assist" },
				],
				default: "abort",
			},
			next: {},
		},
		{
			id: "done",
			action: {
				type: "done",
				reason: "nav ok",
				conclusion: "${{ ({ dest: vars.navCtx?.destKey || '', url: vars.verifyOut?.url || '', title: vars.verifyOut?.title || '', via: vars.navSel?.by || null, assisted: false }) }}",
			},
			next: {},
		},
		{
			id: "done_assist",
			action: {
				type: "done",
				reason: "nav ok by assist",
				conclusion: "${{ ({ dest: vars.navCtx?.destKey || '', url: vars.verifyAfterAssistOut?.url || '', title: vars.verifyAfterAssistOut?.title || '', via: vars.navSel?.by || null, assisted: true }) }}",
			},
			next: {},
		},
		{
			id: "abort_missing_dest",
			action: { type: "abort", reason: "nav requires nav.dest" },
			next: {},
		},
		{
			id: "abort",
			action: { type: "abort", reason: "nav failed" },
			next: {},
		},
	],
	vars: {
		navCtx: { type: "object", desc: "normalized nav args", from: "init_ctx.saveAs" },
		before: { type: "object", desc: "before snapshot", from: "snapshot_before.saveAs" },
		navSel: { type: "object", desc: "resolved nav selector", from: "resolve_by.saveAs/resolve_query.saveAs/resolve_auto_query.saveAs" },
		verifyOut: { type: "object", desc: "post click verify result", from: "verify_nav.saveAs" },
		profileReviewOut: { type: "object", desc: "AI review for profile landing", from: "ai_review_profile_*.saveAs" },
		verifyAfterAssistOut: { type: "object", desc: "post assist verify result", from: "verify_after_assist.saveAs" },
	},
};

const navGenericObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default navGenericObject;
export { capabilities, filters, ranks, flow, navGenericObject };
