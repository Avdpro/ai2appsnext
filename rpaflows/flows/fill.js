const capabilities = {
	must: ["fill"],
	prefer: ["fill.action", "fill.target", "fill.value", "fill.result"],
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
	id: "fill",
	start: "init_ctx",
	args: {
		fill: { type: "object", required: false, desc: "fill 参数，支持 action/target/value/files 等" },
	},
	steps: [
		{
			id: "init_ctx",
			action: {
				type: "run_js",
				scope: "agent",
				code: `function(input){
					function t(v){ return String(v == null ? "" : v).trim(); }
					const fill = (input && input.fill) || {};
					const action = t(fill.action).toLowerCase();
					const target = fill.target && typeof fill.target === "object" ? fill.target : {};
					const by = t(target.selector || target.bySelector || "");
					const query = t(target.query || "");
					const targetMode = by ? "selector" : (query ? "query" : "none");
					const value = fill.value;
					const files = Array.isArray(fill.files) ? fill.files.map(t).filter(Boolean) : [];
					const textMode = t(fill.textMode || "set").toLowerCase();
					const clear = fill.clear !== false;
					const selectMode = t(fill.selectMode || "set").toLowerCase();
					const optionQuery = t(fill.optionQuery || "");
					const optionText = t(fill.value || "");
					const builtOptionQuery = optionQuery || (optionText ? ("在当前展开的选项列表里，选择文本为「" + optionText + "」的选项") : "");
					return {
						action,
						targetMode,
						by,
						query,
						value,
						files,
						text: t(fill.value || ""),
						textMode,
						clear,
						selectMode,
						optionText,
						optionQuery: builtOptionQuery
					};
				}`,
				args: ["${{ ({ fill: args.fill || {} }) }}"],
			},
			saveAs: "fillCtx",
			next: { done: "route_action", failed: "abort" },
		},
		{
			id: "route_action",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "fillCtx.action", value: "text" }, to: "target_ready" },
					{ when: { op: "eq", source: "vars", path: "fillCtx.action", value: "clear" }, to: "target_ready" },
					{ when: { op: "eq", source: "vars", path: "fillCtx.action", value: "submit" }, to: "target_ready" },
					{ when: { op: "eq", source: "vars", path: "fillCtx.action", value: "check" }, to: "target_ready" },
					{ when: { op: "eq", source: "vars", path: "fillCtx.action", value: "select" }, to: "target_ready" },
					{ when: { op: "eq", source: "vars", path: "fillCtx.action", value: "upload" }, to: "target_ready" },
				],
				default: "abort_unsupported_action",
			},
			next: {},
		},
		{
			id: "target_ready",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "fillCtx.targetMode", value: "selector" }, to: "resolve_target_by" },
					{ when: { op: "eq", source: "vars", path: "fillCtx.targetMode", value: "query" }, to: "resolve_target_query" },
				],
				default: "abort_missing_target",
			},
			next: {},
		},
		{
			id: "resolve_target_by",
			action: { type: "selector", by: "${vars.fillCtx.by}" },
			saveAs: "targetSel",
			next: { done: "route_exec", failed: "abort" },
		},
		{
			id: "resolve_target_query",
			action: { type: "selector", query: "${vars.fillCtx.query}" },
			saveAs: "targetSel",
			next: { done: "route_exec", failed: "abort" },
		},
		{
			id: "route_exec",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "fillCtx.action", value: "text" }, to: "exec_text" },
					{ when: { op: "eq", source: "vars", path: "fillCtx.action", value: "clear" }, to: "exec_clear" },
					{ when: { op: "eq", source: "vars", path: "fillCtx.action", value: "submit" }, to: "exec_submit" },
					{ when: { op: "eq", source: "vars", path: "fillCtx.action", value: "check" }, to: "exec_check" },
					{ when: { op: "eq", source: "vars", path: "fillCtx.action", value: "select" }, to: "exec_select_open" },
					{ when: { op: "eq", source: "vars", path: "fillCtx.action", value: "upload" }, to: "exec_upload" },
				],
				default: "abort_unsupported_action",
			},
			next: {},
		},
		{
			id: "exec_text",
			action: {
				type: "input",
				by: "${vars.targetSel.by}",
				text: "${vars.fillCtx.text}",
				clear: "${{ vars.fillCtx.textMode === 'set' && !!vars.fillCtx.clear }}",
			},
			next: { done: "done", failed: "abort" },
		},
		{
			id: "exec_clear",
			action: {
				type: "input",
				by: "${vars.targetSel.by}",
				text: "",
				clear: true,
			},
			next: { done: "done", failed: "abort" },
		},
		{
			id: "exec_submit",
			action: { type: "click", by: "${vars.targetSel.by}" },
			next: { done: "done", failed: "abort" },
		},
		{
			id: "exec_upload",
			action: {
				type: "uploadFile",
				by: "${vars.targetSel.by}",
				files: "${vars.fillCtx.files}",
				uploadMode: "auto",
			},
			saveAs: "uploadOut",
			next: { done: "done", failed: "abort" },
		},
		{
			id: "exec_check",
			action: {
				type: "run_js",
				scope: "page",
				code: `function(input){
					const by = String((input && input.by) || "").trim();
					const desired = !!(input && input.desired);
					if(!by) return { ok:false, reason:"missing selector" };
					let el = null;
					try { el = document.querySelector(by); } catch (_) {}
					if(!el) return { ok:false, reason:"target not found" };
					const tag = String(el.tagName || "").toLowerCase();
					const type = String(el.getAttribute("type") || "").toLowerCase();
					if(tag !== "input" || (type !== "checkbox" && type !== "radio")) return { ok:false, reason:"target not checkable" };
					if(el.checked !== desired){
						el.click();
						if(el.checked !== desired){
							el.checked = desired;
							el.dispatchEvent(new Event("input", { bubbles:true }));
							el.dispatchEvent(new Event("change", { bubbles:true }));
						}
					}
					return { ok:true, checked: !!el.checked };
				}`,
				args: ["${{ ({ by: vars.targetSel.by, desired: !!vars.fillCtx.value }) }}"],
			},
			saveAs: "checkOut",
			next: { done: "done", failed: "abort" },
		},
		{
			id: "exec_select_open",
			action: { type: "click", by: "${vars.targetSel.by}", postWaitMs: 500 },
			next: { done: "exec_select_pick", failed: "abort" },
		},
		{
			id: "exec_select_pick",
			action: {
				type: "click",
				query: "${vars.fillCtx.optionQuery}",
				cacheKeySuffix: "${vars.fillCtx.optionText}",
			},
			saveAs: "selectOut",
			next: { done: "done", failed: "abort" },
		},
		{
			id: "done",
			action: {
				type: "done",
				conclusion: "${{ ({ action: vars.fillCtx?.action || '', by: vars.targetSel?.by || null, value: vars.fillCtx?.value, ok: true, applied: true, upload: vars.uploadOut || null }) }}",
			},
			next: {},
		},
		{
			id: "abort_missing_target",
			action: { type: "abort", reason: "fill requires fill.target.query or fill.target.selector" },
			next: {},
		},
		{
			id: "abort_unsupported_action",
			action: { type: "abort", reason: "unsupported fill.action" },
			next: {},
		},
		{
			id: "abort",
			action: { type: "abort", reason: "fill failed" },
			next: {},
		},
	],
	vars: {
		fillCtx: { type: "object", desc: "标准化 fill 参数", from: "init_ctx.saveAs" },
		targetSel: { type: "object", desc: "目标控件选择器", from: "resolve_target_query.saveAs/resolve_target_by.saveAs" },
		uploadOut: { type: "object", desc: "上传结果", from: "exec_upload.saveAs" },
		checkOut: { type: "object", desc: "勾选结果", from: "exec_check.saveAs" },
		selectOut: { type: "object", desc: "选择结果", from: "exec_select_pick.saveAs" },
	},
};

const fillObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default fillObject;
export { capabilities, filters, ranks, flow, fillObject };
