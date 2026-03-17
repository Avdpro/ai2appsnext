const capabilities = {
	must: ["compose", "compose.publish"],
	prefer: ["compose.action", "compose.visibility", "compose.publish.result"],
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

const flow = {
	id: "compose_publish",
	start: "init_ctx",
	args: {
		compose: { type: "object", required: false, desc: "compose 参数，支持 action/visibility/strictVisibility" },
	},
	steps: [
		{
			id: "init_ctx",
			action: {
				type: "run_js",
				scope: "agent",
				code: `function(input){
					function t(v){ return String(v == null ? "" : v).trim(); }
					const compose = (input && input.compose) || {};
					const action = t(compose.action || "publish").toLowerCase() || "publish";
					const visibility = t(compose.visibility || "").toLowerCase();
					const strictVisibility = !!compose.strictVisibility;
					const map = {
						public: "公开",
						private: "私密",
						draft: "草稿",
						fansonly: "粉丝可见",
						friendsonly: "好友可见"
					};
					const visibilityLabel = map[visibility] || t(compose.visibility || "");
					return {
						action,
						actionOk: action === "publish",
						visibility,
						visibilityLabel,
						needSetVisibility: !!visibility,
						strictVisibility,
						visibilityTargetQuery: "发布面板中的可见性/权限设置入口（公开/私密/粉丝可见/好友可见/草稿）",
						publishQuery: "发布面板中的发布/发送/提交按钮（不要选择保存草稿）"
					};
				}`,
				args: ["${{ ({ compose: args.compose || {} }) }}"],
			},
			saveAs: "composeCtx",
			next: { done: "route_action", failed: "abort" },
		},
		{
			id: "route_action",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "composeCtx.actionOk", value: true }, to: "route_visibility" },
				],
				default: "abort_unsupported_action",
			},
			next: {},
		},
		{
			id: "route_visibility",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "composeCtx.needSetVisibility", value: true }, to: "set_visibility" },
				],
				default: "click_publish",
			},
			next: {},
		},
		{
			id: "set_visibility",
			action: {
				type: "invoke",
				target: "fill",
				args: {
					"fill.action": "select",
					"fill.target.query": "${vars.composeCtx.visibilityTargetQuery}",
					"fill.value": "${vars.composeCtx.visibilityLabel}",
					"fill.optionQuery": "${{ '在当前展开的可见性选项列表里，选择文本为「' + (vars.composeCtx.visibilityLabel || '') + '」的选项' }}",
				},
				onError: "return",
				returnTo: "caller",
			},
			saveAs: "visibilitySetOut",
			next: { done: "route_visibility_result", failed: "route_visibility_result" },
		},
		{
			id: "route_visibility_result",
			action: {
				type: "branch",
				cases: [
					{
						when: {
							op: "eq",
							source: "vars",
							path: "composeCtx.strictVisibility",
							value: true
						},
						to: "route_visibility_strict_check"
					}
				],
				default: "click_publish",
			},
			next: {},
		},
		{
			id: "route_visibility_strict_check",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "visibilitySetOut.ok", value: true }, to: "click_publish" },
				],
				default: "abort_visibility_failed",
			},
			next: {},
		},
		{
			id: "click_publish",
			action: { type: "click", query: "${vars.composeCtx.publishQuery}" },
			saveAs: "publishClickOut",
			next: { done: "capture_url", failed: "ask_assist_publish" },
		},
		{
			id: "capture_url",
			action: { type: "readPage", field: "url" },
			saveAs: "publishedUrl",
			next: { done: "done", failed: "done" },
		},
		{
			id: "ask_assist_publish",
			action: {
				type: "ask_assist",
				reason: "请手动点击发布/发送按钮，完成后点击“已处理，继续”。",
				waitUserAction: true,
				modal: false,
				mask: false,
			},
			next: { done: "done_after_assist", failed: "abort" },
		},
		{
			id: "done",
			action: {
				type: "done",
				conclusion: "${{ ({ action:'publish', id:'', url: vars.publishedUrl || '', visibilityRequested: vars.composeCtx?.visibility || '', visibilityApplied: vars.composeCtx?.needSetVisibility ? !!vars.visibilitySetOut?.ok : true, strictVisibility: !!vars.composeCtx?.strictVisibility, by: vars.publishClickOut?.by || null }) }}",
			},
			next: {},
		},
		{
			id: "done_after_assist",
			action: {
				type: "done",
				conclusion: "${{ ({ action:'publish', id:'', url: '', assisted: true, visibilityRequested: vars.composeCtx?.visibility || '', visibilityApplied: vars.composeCtx?.needSetVisibility ? !!vars.visibilitySetOut?.ok : true, strictVisibility: !!vars.composeCtx?.strictVisibility }) }}",
			},
			next: {},
		},
		{
			id: "abort_visibility_failed",
			action: { type: "abort", reason: "strict visibility mode: set visibility failed" },
			next: {},
		},
		{
			id: "abort_unsupported_action",
			action: { type: "abort", reason: "compose_publish only supports compose.action=publish" },
			next: {},
		},
		{
			id: "abort",
			action: { type: "abort", reason: "compose.publish failed" },
			next: {},
		},
	],
	vars: {
		composeCtx: { type: "object", desc: "标准化 compose.publish 参数", from: "init_ctx.saveAs" },
		visibilitySetOut: { type: "object", desc: "可见性设置结果（invoke fill）", from: "set_visibility.saveAs" },
		publishClickOut: { type: "object", desc: "发布点击结果", from: "click_publish.saveAs" },
		publishedUrl: { type: "string", desc: "发布后页面 URL（best-effort）", from: "capture_url.saveAs" },
	},
};

const composePublishObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default composePublishObject;
export { capabilities, filters, ranks, flow, composePublishObject };
