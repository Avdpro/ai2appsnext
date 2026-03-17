const capabilities = {
	must: ["download"],
	prefer: ["download.action", "download.url", "download.target", "download.saveAs", "download.multi"],
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
	id: "download_file",
	start: "init_ctx",
	args: {
		download: { type: "object", required: false, desc: "download args, supports action/url/target/saveAs/multi" },
	},
	steps: [
		{
			id: "init_ctx",
			action: {
				type: "run_js",
				scope: "agent",
				code: `function(input){
					function t(v){ return String(v == null ? "" : v).trim(); }
					const download = (input && input.download) || {};
					const action = t((input && input["download.action"]) || download.action || "file").toLowerCase() || "file";
					const url = t((input && input["download.url"]) || download.url || "");
					const target = download.target && typeof download.target === "object" ? download.target : {};
					const by = t(target.selector || target.bySelector || "");
					const query = t(target.query || "");
					const targetMode = by ? "selector" : (query ? "query" : "none");
					const beginTimeoutMs = Math.max(500, Number(download.beginTimeoutMs || 15000) || 15000);
					const endTimeoutMs = Math.max(500, Number(download.endTimeoutMs || 60000) || 60000);
					return {
						action,
						url,
						targetMode,
						by,
						query,
						beginTimeoutMs,
						endTimeoutMs,
					};
				}`,
				args: ["${{ ({ download: args.download || {}, 'download.action': args['download.action'] || '', 'download.url': args['download.url'] || '' }) }}"],
			},
			saveAs: "dlCtx",
			next: { done: "check_action", failed: "abort" },
		},
		{
			id: "check_action",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "dlCtx.action", value: "file" }, to: "route_source" },
				],
				default: "abort_unsupported_action",
			},
			next: {},
		},
		{
			id: "route_source",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "truthy", source: "vars", path: "dlCtx.url" }, to: "download_by_url" },
					{ when: { op: "eq", source: "vars", path: "dlCtx.targetMode", value: "selector" }, to: "download_by_selector" },
					{ when: { op: "eq", source: "vars", path: "dlCtx.targetMode", value: "query" }, to: "download_by_query" },
				],
				default: "abort_missing_target",
			},
			next: {},
		},
		{
			id: "download_by_url",
			action: {
				type: "download",
				url: "${vars.dlCtx.url}",
				beginTimeoutMs: "${vars.dlCtx.beginTimeoutMs}",
				endTimeoutMs: "${vars.dlCtx.endTimeoutMs}",
				waitForEnd: true,
			},
			saveAs: "dlOut",
			next: { done: "done", failed: "abort" },
		},
		{
			id: "download_by_selector",
			action: {
				type: "download",
				by: "${vars.dlCtx.by}",
				beginTimeoutMs: "${vars.dlCtx.beginTimeoutMs}",
				endTimeoutMs: "${vars.dlCtx.endTimeoutMs}",
				waitForEnd: true,
			},
			saveAs: "dlOut",
			next: { done: "done", failed: "abort" },
		},
		{
			id: "download_by_query",
			action: {
				type: "download",
				query: "${vars.dlCtx.query}",
				beginTimeoutMs: "${vars.dlCtx.beginTimeoutMs}",
				endTimeoutMs: "${vars.dlCtx.endTimeoutMs}",
				waitForEnd: true,
			},
			saveAs: "dlOut",
			next: { done: "done", failed: "abort" },
		},
		{
			id: "done",
			action: {
				type: "done",
				reason: "download.file ok",
				conclusion: "${{ ({ action:'file', ok: !!vars.dlOut?.ok, started: !!vars.dlOut?.started, finished: !!vars.dlOut?.finished, filepath: vars.dlOut?.end?.filepath || vars.dlOut?.begin?.file || '', url: vars.dlOut?.end?.url || vars.dlOut?.begin?.url || '' }) }}",
			},
			next: {},
		},
		{
			id: "abort_missing_target",
			action: { type: "abort", reason: "download.file requires download.url or download.target.selector/query" },
			next: {},
		},
		{
			id: "abort_unsupported_action",
			action: { type: "abort", reason: "download_file only supports download.action=file" },
			next: {},
		},
		{
			id: "abort",
			action: { type: "abort", reason: "download.file failed" },
			next: {},
		},
	],
	vars: {
		dlCtx: { type: "object", desc: "normalized download args", from: "init_ctx.saveAs" },
		dlOut: { type: "object", desc: "download output", from: "download_by_url.saveAs/download_by_selector.saveAs/download_by_query.saveAs" },
	},
};

const downloadFileObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default downloadFileObject;
export { capabilities, filters, ranks, flow, downloadFileObject };

