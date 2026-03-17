const capabilities = {
	must: ["read.batch", "read.action"],
	prefer: ["read.target", "read.minItems", "read.fields", "read.requireFields", "read.output"],
};

const filters = [
	{ key: "domain", value: "*" },
	{ key: "locale", value: "zh-CN" },
];

const ranks = {
	cost: 2,
	quality: 2,
	speed: 3,
};

const flow = {
	id: "read_batch_generic",
	start: "route_action",
	args: {
		read: { type: "object", required: false, desc: "read.* 参数对象" },
		urls: { type: "array<string>", required: false, desc: "可选直接 URL 列表；有值时跳过 read.list" },
		query: { type: "string", required: false, desc: "可选查询词" },
		concurrency: { type: "number", required: false, desc: "可选并发度，默认 2（上限 8）" },
	},
	steps: [
		{
			id: "route_action",
			desc: "仅支持 read.action=batch",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "args", path: "read.action", value: "batch" }, to: "prepare_direct_urls" }
				],
				default: "abort_not_batch"
			},
			next: {}
		},
		{
			id: "prepare_direct_urls",
			desc: "从 args.urls/read.target.urls/read.target.url 归一化直传 URL",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(directUrls, target){ function asText(v){ return String(v==null?'':v).trim(); } const out=[]; const seen=new Set(); function pushOne(v){ const s=asText(v); if(!s) return; if(seen.has(s)) return; seen.add(s); out.push(s); } function pushMany(v){ if(Array.isArray(v)){ for(const x of v) pushOne(x); return; } if(v!=null) pushOne(v); } pushMany(directUrls); const t=(target&&typeof target==='object')?target:{}; pushMany(t.urls); pushMany(t.url); return out; }",
				args: [
					"${urls}",
					"${read.target}"
				]
			},
			saveAs: "directUrls",
			next: { done: "route_source", failed: "abort_failed" }
		},
		{
			id: "route_source",
			desc: "有直传 URL 则直接批量 detail；否则先 invoke read.list",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "truthy", source: "vars", path: "directUrls[0]" }, to: "run_batch_detail" }
				],
				default: "invoke_read_list"
			},
			next: {}
		},
		{
			id: "invoke_read_list",
			desc: "先读取列表，得到候选 URL",
			action: {
				type: "invoke",
				target: "read_list_generic_ai",
				args: {
					read: {
						action: "list",
						target: "${read.target}",
						minItems: "${read.minItems}",
						fields: "${read.fields}",
						requireFields: "${read.requireFields}",
						filter: "${read.filter}",
						sort: "${read.sort}",
						output: "${read.output}"
					},
					query: "${query}",
					search: { query: "${search.query}" }
				}
			},
			saveAs: "listOut",
			next: { done: "collect_urls_from_list", failed: "abort_failed" }
		},
		{
			id: "collect_urls_from_list",
			desc: "从 read.list 结果提取 URL 列表",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(listOut){ function asText(v){ return String(v==null?'':v).trim(); } const out=[]; const seen=new Set(); const items=Array.isArray(listOut&&listOut.items)?listOut.items:[]; for(const it of items){ const o=(it&&typeof it==='object')?it:{}; const u=asText(o.url||o.href||''); if(!u) continue; if(seen.has(u)) continue; seen.add(u); out.push(u); } return out; }",
				args: [
					"${vars.listOut}"
				]
			},
			saveAs: "batchUrls",
			next: { done: "run_batch_detail", failed: "abort_failed" }
		},
		{
			id: "run_batch_detail",
			desc: "并发 invokeMany 批量执行 read.detail（每项 fork=url），失败项不中断",
			action: {
				type: "invokeMany",
				target: "read_detail_generic",
				items: "${{ (Array.isArray(vars.batchUrls) && vars.batchUrls.length ? vars.batchUrls : vars.directUrls) || [] }}",
				itemVar: "batchUrl",
				concurrency: "${{ Number(args?.read?.concurrency || args?.concurrency || 2) }}",
				itemTimeoutMs: "${{ Number(args?.read?.timeoutMs || 45000) }}",
				continueOnError: true,
				fork: "${vars.batchUrl}",
				forkWait: "interactive",
				args: {
					read: {
						action: "detail",
						fields: "${read.fields}",
						requireFields: "${read.requireFields}",
						output: "${read.output}"
					},
					query: "${query}"
				}
			},
			saveAs: "batchRawOut",
			next: { done: "normalize_out", failed: "abort_failed" }
		},
		{
			id: "normalize_out",
			desc: "归一化到 read.batch.result",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(raw){ const r=(raw&&typeof raw==='object')?raw:{}; const src=Array.isArray(r.items)?r.items:[]; const items=src.map((it)=>{ const o=(it&&typeof it==='object')?it:{}; const status=String(o.status||'').toLowerCase()==='done'?'done':'failed'; const ok=!!o.ok && status==='done'; const v=(o.value&&typeof o.value==='object')?o.value:{}; const data=(v.data&&typeof v.data==='object')?v.data:(v||{}); const missing=Array.isArray(v.missingFields)?v.missingFields:[]; const reason=String(o.reason||o.error||o.invoke?.reason||''); return { index:Number(o.index||0), url:String(o.item||''), status, reason, invoke:(o.invoke&&typeof o.invoke==='object')?o.invoke:{}, data:ok?data:undefined, error:ok?undefined:reason, ok, missingFields:missing }; }); const missing = new Set(); for(const it of items){ for(const f of (Array.isArray(it.missingFields)?it.missingFields:[])){ missing.add(String(f||'')); } } return { action:'batch', items, missingFields:Array.from(missing).filter(Boolean), meta:(r.meta&&typeof r.meta==='object')?r.meta:{} }; }",
				args: [
					"${vars.batchRawOut}"
				]
			},
			saveAs: "batchOut",
			next: { done: "done", failed: "abort_failed" }
		},
		{
			id: "done",
			desc: "返回 read.batch 结果",
			action: {
				type: "done",
				reason: "read.batch ok",
				conclusion: "${vars.batchOut}"
			},
			next: {}
		},
		{
			id: "abort_not_batch",
			desc: "不支持的 read.action",
			action: {
				type: "abort",
				reason: "read_batch_generic only supports read.action=batch"
			},
			next: {}
		},
		{
			id: "abort_failed",
			desc: "批量读取失败",
			action: {
				type: "abort",
				reason: "read.batch failed"
			},
			next: {}
		}
	],
	vars: {
		directUrls: { type: "array<string>", desc: "输入侧直传 URL", from: "prepare_direct_urls.saveAs" },
		listOut: { type: "object", desc: "invoke read.list 结果", from: "invoke_read_list.saveAs" },
		batchUrls: { type: "array<string>", desc: "列表侧提取 URL", from: "collect_urls_from_list.saveAs" },
		batchRawOut: { type: "object", desc: "invokeMany 原始结果", from: "run_batch_detail.saveAs" },
		batchOut: { type: "object", desc: "read.batch 规范输出", from: "normalize_out.saveAs" }
	}
};

const readBatchGenericObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default readBatchGenericObject;
export { capabilities, filters, ranks, flow, readBatchGenericObject };
