const capabilities = {
	must: ["compose", "compose.start"],
	prefer: ["compose.action", "compose.type", "compose.visibility", "compose.result"],
};

const filters = [
	{ key: "domain", value: "*" },
	{ key: "locale", value: "zh-CN" },
];

const ranks = {
	cost: 2,
	quality: 3,
	speed: 2,
};

const detectEditorCode = `function(input){
	function isVisible(el){
		if(!el) return false;
		const st = window.getComputedStyle(el);
		if(!st) return false;
		if(st.display === "none" || st.visibility === "hidden" || Number(st.opacity || "1") <= 0.02) return false;
		const r = el.getBoundingClientRect();
		return r.width > 2 && r.height > 2;
	}
	const checks = [
		"textarea",
		"[contenteditable='true']",
		"[role='textbox']",
		"div[aria-label*='写' i]",
		"div[aria-label*='post' i]",
		"div[aria-label*='tweet' i]",
		"div[aria-label*='editor' i]"
	];
	const hits = [];
	for(const sel of checks){
		let arr = [];
		try { arr = Array.from(document.querySelectorAll(sel)); } catch(_) {}
		for(const el of arr){
			if(!isVisible(el)) continue;
			const txt = String(el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim();
			hits.push({ selector: sel, hint: txt.slice(0, 80) });
			if(hits.length >= 8) break;
		}
		if(hits.length >= 8) break;
	}
	return {
		ready: hits.length > 0,
		count: hits.length,
		hints: hits,
		url: String(location.href || ""),
		title: String(document.title || "")
	};
}`;

const flow = {
	id: "compose_start",
	start: "init_ctx",
	args: {
		compose: { type: "object", required: false, desc: "compose 参数，支持 compose.action/type/visibility/resetDraftOnStart" },
	},
	steps: [
		{
			id: "init_ctx",
			desc: "标准化 compose.start 参数",
			action: {
				type: "run_js",
				scope: "agent",
				code: `function(input){
					function t(v){ return String(v == null ? "" : v).trim(); }
					const compose = (input && input.compose) || {};
					const action = t(compose.action || "start").toLowerCase() || "start";
					const type = t(compose.type || "post").toLowerCase() || "post";
					const visibility = t(compose.visibility || "");
					const resetDraftOnStart = compose.resetDraftOnStart === false ? false : true;
					const actionOk = action === "start";
					let entryQuery = "打开页面中的发帖/发布/写文章/创建内容入口";
					if(type === "comment" || type === "reply"){
						entryQuery = "打开当前页面的评论或回复输入入口";
					} else if(type === "thread"){
						entryQuery = "打开页面中的发串/发帖线程入口";
					} else if(type === "article"){
						entryQuery = "打开写文章/发布文章入口";
					}
					return { action, type, visibility, resetDraftOnStart, actionOk, entryQuery };
				}`,
				args: [
					"${{ ({ compose: args.compose || {} }) }}",
				],
			},
			saveAs: "composeCtx",
			next: { done: "route_action", failed: "abort" },
		},
		{
			id: "route_action",
			desc: "当前 flow 仅支持 compose.action=start",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "composeCtx.actionOk", value: true }, to: "clear_blockers" },
				],
				default: "abort_unsupported_action",
			},
			next: {},
		},
		{
			id: "clear_blockers",
			desc: "启动撰写前先尝试清理阻挡交互的弹窗",
			action: {
				type: "invoke",
				target: "blockers_check_clear",
				args: { "blockers.clear": true },
				onError: "return",
				returnTo: "caller",
			},
			saveAs: "blockersOut",
			next: { done: "ensure_login", failed: "ensure_login" },
		},
		{
			id: "ensure_login",
			desc: "进入撰写前确保已登录（失败时转人工）",
			action: {
				type: "invoke",
				target: "login_check_ensure",
				args: { "login.ensure": true },
				timeoutMs: 60000,
				onError: "fail",
				returnTo: "caller",
			},
			saveAs: "loginOut",
			next: { done: "check_compose_ready", failed: "assist_login", timeout: "assist_login" },
		},
		{
			id: "assist_login",
			desc: "登录需要人工介入",
			action: {
				type: "ask_assist",
				reason: "请先手动完成登录（如账号密码/扫码/验证码），完成后点击“已处理，继续”。",
				waitUserAction: true,
				modal: false,
				mask: false,
			},
			next: { done: "check_compose_ready", failed: "abort" },
		},
		{
			id: "check_compose_ready",
			desc: "探测是否已经在撰写编辑器界面",
			action: {
				type: "selector",
				query: "可见的撰写编辑器/输入区（用于发布内容），通常是 textarea 或 contenteditable 区域，并且附近出现发布/发送/下一步按钮；避免匹配搜索框",
			},
			saveAs: "composeEditorSel",
			next: { done: "detect_editor", failed: "open_compose_entry" },
		},
		{
			id: "open_compose_entry",
			desc: "点击撰写入口",
			action: {
				type: "click",
				query: "${vars.composeCtx.entryQuery}",
			},
			saveAs: "composeEntry",
			next: { done: "wait_compose_editor", failed: "ask_assist_open", timeout: "ask_assist_open" },
		},
		{
			id: "wait_compose_editor",
			desc: "点击入口后等待编辑器出现",
			action: {
				type: "wait",
				timeoutMs: 7000,
				query: "可见的撰写编辑器/输入区（textarea 或 contenteditable），用于输入正文；通常和发布/发送按钮在同一面板",
			},
			next: { done: "detect_editor", failed: "ask_assist_open", timeout: "ask_assist_open" },
		},
		{
			id: "detect_editor",
			desc: "检查编辑器是否已出现",
			action: {
				type: "run_js",
				scope: "page",
				code: detectEditorCode,
			},
			saveAs: "editorCheck",
			next: { done: "route_editor_ready", failed: "ask_assist_open" },
		},
		{
			id: "route_editor_ready",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "editorCheck.ready", value: true }, to: "route_reset_draft" },
				],
				default: "ask_assist_open",
			},
			next: {},
		},
		{
			id: "route_reset_draft",
			desc: "按策略决定是否在 compose.start 清空旧草稿",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "composeCtx.resetDraftOnStart", value: true }, to: "clear_editor_content" },
				],
				default: "done",
			},
			next: {},
		},
		{
			id: "clear_editor_content",
			desc: "清空编辑器已有内容，避免残留草稿影响后续 compose.input",
			action: {
				type: "input",
				query: "撰写区域的正文输入区（textarea 或 contenteditable），用于输入正文内容，避免匹配搜索框",
				text: "",
				mode: "paste",
				clear: true,
			},
			next: { done: "done", failed: "done" },
		},
		{
			id: "ask_assist_open",
			desc: "请用户手动打开撰写入口",
			action: {
				type: "ask_assist",
				reason: "请手动打开页面的发帖/写作输入框（compose.start）。打开后点击“已处理，继续”；如果当前页面不支持请点“无法处理”。",
				waitUserAction: true,
				modal: false,
				mask: false,
			},
			next: { done: "detect_editor_after_assist", failed: "abort" },
		},
		{
			id: "detect_editor_after_assist",
			action: {
				type: "run_js",
				scope: "page",
				code: detectEditorCode,
			},
			saveAs: "editorCheckAfter",
			next: { done: "route_editor_ready_after_assist", failed: "abort" },
		},
		{
			id: "route_editor_ready_after_assist",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "editorCheckAfter.ready", value: true }, to: "route_reset_draft_after_assist" },
				],
				default: "abort",
			},
			next: {},
		},
		{
			id: "route_reset_draft_after_assist",
			desc: "人工介入后按策略决定是否清空旧草稿",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "composeCtx.resetDraftOnStart", value: true }, to: "clear_editor_content_after_assist" },
				],
				default: "done_after_assist",
			},
			next: {},
		},
		{
			id: "clear_editor_content_after_assist",
			desc: "人工介入后清空编辑器已有内容",
			action: {
				type: "input",
				query: "撰写区域的正文输入区（textarea 或 contenteditable），用于输入正文内容，避免匹配搜索框",
				text: "",
				mode: "paste",
				clear: true,
			},
			next: { done: "done_after_assist", failed: "done_after_assist" },
		},
		{
			id: "done",
			action: {
				type: "done",
				reason: "compose.start done",
				conclusion: "${{ ({ action:'start', id:'', url: vars.editorCheck?.url || '', type: vars.composeCtx?.type || 'post', visibility: vars.composeCtx?.visibility || '', entryBy: vars.composeEntry?.by || null, editorReady: true, editorHints: vars.editorCheck?.hints || [] }) }}",
			},
			next: {},
		},
		{
			id: "done_after_assist",
			action: {
				type: "done",
				reason: "compose.start done by assist",
				conclusion: "${{ ({ action:'start', id:'', url: vars.editorCheckAfter?.url || '', type: vars.composeCtx?.type || 'post', visibility: vars.composeCtx?.visibility || '', entryBy: vars.composeEntry?.by || null, editorReady: true, editorHints: vars.editorCheckAfter?.hints || [] }) }}",
			},
			next: {},
		},
		{
			id: "abort_unsupported_action",
			action: {
				type: "abort",
				reason: "compose_start only supports compose.action=start",
			},
			next: {},
		},
		{
			id: "abort",
			action: {
				type: "abort",
				reason: "compose.start failed: cannot open composer/editor",
			},
			next: {},
		},
	],
	vars: {
		composeCtx: { type: "object", desc: "标准化 compose 参数", from: "init_ctx.saveAs" },
		blockersOut: { type: "object", desc: "blockers 清理结果", from: "clear_blockers.saveAs" },
		loginOut: { type: "object", desc: "login.ensure 返回结果", from: "ensure_login.saveAs" },
		composeEditorSel: { type: "object", desc: "compose 编辑器 selector 解析结果", from: "check_compose_ready.saveAs" },
		composeEntry: { type: "object", desc: "compose 入口点击结果", from: "open_compose_entry.saveAs" },
		editorCheck: { type: "object", desc: "编辑器检测结果", from: "detect_editor.saveAs" },
		editorCheckAfter: { type: "object", desc: "人工介入后编辑器检测结果", from: "detect_editor_after_assist.saveAs" },
	},
};

const composeStartObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default composeStartObject;
export { capabilities, filters, ranks, flow, composeStartObject };
