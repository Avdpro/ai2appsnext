const capabilities = {
	must: ["read.detail", "read.action"],
	prefer: ["read.target", "read.fields", "read.requireFields", "read.output"],
};

const filters = [
	{ key: "domain", value: "*" },
	{ key: "locale", value: "zh-CN" },
];

const ranks = {
	cost: 2,
	quality: 2,
	speed: 2,
};

const flow = {
	id: "read_detail_generic",
	start: "route_action",
	args: {
		read: { type: "object", required: false, desc: "read.* 参数对象" },
		query: { type: "string", required: false, desc: "可选查询词" },
	},
	steps: [
		{
			id: "route_action",
			desc: "仅支持 read.action=detail",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "args", path: "read.action", value: "detail" }, to: "init_target" },
				],
				default: "abort_not_detail",
			},
			next: {},
		},
		{
			id: "init_target",
			desc: "规范化 read.target/pick",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(target){ const t=(target&&typeof target==='object')?target:{}; const by=String(t.by||'auto').toLowerCase(); const selector=String(t.selector||'').trim(); const query=String(t.query||'').trim(); const pick = (t && Object.prototype.hasOwnProperty.call(t,'pick')) ? t.pick : 1; return { by, selector, query, pick }; }",
				args: ["${{ args?.read?.target || {} }}"],
			},
			saveAs: "targetNorm",
			next: { done: "route_target", failed: "abort_failed" },
		},
		{
			id: "route_target",
			desc: "按 target.by 路由",
			action: {
				type: "branch",
				cases: [
					{
						when: {
							op: "and",
							items: [
								{ op: "eq", source: "vars", path: "targetNorm.by", value: "query" },
								{ op: "truthy", source: "vars", path: "targetNorm.query" }
							]
						},
						to: "resolve_selector_query"
					},
					{ when: { op: "truthy", source: "vars", path: "targetNorm.selector" }, to: "extract_from_selector" }
				],
				default: "extract_page_level",
			},
			next: {},
		},
		{
			id: "resolve_selector_query",
			desc: "通过 query 解析目标 selector",
			action: {
				type: "selector",
				query: "${{ vars.targetNorm.query }}",
				multi: true
			},
			saveAs: "targetSel",
			next: { done: "extract_from_query_selector", failed: "extract_page_level" },
		},
		{
			id: "extract_from_query_selector",
			desc: "使用 query 解析得到的 selector 提取 detail",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(selObj, pick, fields, requireFields, output){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } function absUrl(href){ try{return new URL(String(href||''), location.href).href;}catch(_){ return String(href||''); } } function selectAllBy(by){ const s=String(by||'').trim(); if(!s) return []; if(s.startsWith('xpath:')){ const xp=s.slice(6).trim(); if(!xp) return []; const out=[]; const it=document.evaluate(xp,document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null); for(let i=0;i<it.snapshotLength;i++){ const n=it.snapshotItem(i); if(n&&n.nodeType===1) out.push(n);} return out; } let css=s; if(s.startsWith('css:')) css=s.slice(4).trim(); if(!css) return []; try{ return Array.from(document.querySelectorAll(css)); }catch(_){ return []; } } function choose(nodes,pv){ if(!Array.isArray(nodes)||!nodes.length) return null; if(typeof pv==='number' && Number.isFinite(pv)){ const n=Math.trunc(pv); if(n===-1) return nodes[nodes.length-1]; const idx=Math.max(1,n)-1; return nodes[idx]||null; } const ps=asText(pv); if(ps){ const low=ps.toLowerCase(); for(const n of nodes){ const t=asText(n.innerText||n.textContent).toLowerCase(); if(t.includes(low)) return n; } } return nodes[0]||null; } function buildData(node, outMode){ const txt=asText(node? (node.innerText||node.textContent):''); const a=node?node.querySelector('a[href]'):null; const h=node?node.querySelector('h1,h2,h3,h4,[role=\"heading\"]'):null; const tm=node?node.querySelector('time,[data-time],[datetime]'):null; const author=node?node.querySelector('[rel=\"author\"],[itemprop=\"author\"],.author,.byline,[data-author]'):null; const id=node? (node.getAttribute('data-id')||node.id||'') : ''; const url = a ? absUrl(a.getAttribute('href')||'') : location.href; const title = asText((h && (h.innerText||h.textContent)) || (a && (a.innerText||a.textContent)) || document.title || ''); const summary = txt.slice(0, 280); const content = outMode==='markdown' ? txt : txt; const html = node ? String(node.outerHTML||'') : ''; return { id: asText(id), url, title, summary, content, author: asText(author && (author.innerText||author.textContent)), time: asText((tm && (tm.getAttribute('datetime')||tm.innerText||tm.textContent)) || ''), html }; } const by = String((selObj&&selObj.by)||'').trim(); const pickVal = pick; const outMode = asText(output||'').toLowerCase()||'json'; const nodes = selectAllBy(by); const one = choose(nodes, pickVal); if(!one){ throw new Error('detail target not found'); } const raw = buildData(one, outMode); const wanted=Array.isArray(fields)&&fields.length?fields:['url','title','summary','content']; const data={}; for(const f0 of wanted){ const f=String(f0||'').trim(); if(!f) continue; if(Object.prototype.hasOwnProperty.call(raw,f)) data[f]=raw[f]; else if(f==='text' || f==='body' || f==='article') data[f]=raw.content; else data[f]=''; } const req=Array.isArray(requireFields)?requireFields:[]; const missingFields=req.filter((k)=>{ const v=data[k]; return v==null || String(v).trim()===''; }); return { action:'detail', data, missingFields, meta:{ matchedCount:nodes.length, by } }; }",
				args: [
					"${{ vars.targetSel || {} }}",
					"${{ vars.targetNorm?.pick }}",
					"${read.fields}",
					"${read.requireFields}",
					"${read.output}"
				]
			},
			saveAs: "detailOut",
			next: { done: "done", failed: "extract_page_level" },
		},
		{
			id: "extract_from_selector",
			desc: "使用 read.target.selector 提取 detail",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(selector, pick, fields, requireFields, output){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } function absUrl(href){ try{return new URL(String(href||''), location.href).href;}catch(_){ return String(href||''); } } function selectAllBy(by){ const s=String(by||'').trim(); if(!s) return []; if(s.startsWith('xpath:')){ const xp=s.slice(6).trim(); if(!xp) return []; const out=[]; const it=document.evaluate(xp,document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null); for(let i=0;i<it.snapshotLength;i++){ const n=it.snapshotItem(i); if(n&&n.nodeType===1) out.push(n);} return out; } let css=s; if(s.startsWith('css:')) css=s.slice(4).trim(); if(!css) return []; try{ return Array.from(document.querySelectorAll(css)); }catch(_){ return []; } } function choose(nodes,pv){ if(!Array.isArray(nodes)||!nodes.length) return null; if(typeof pv==='number' && Number.isFinite(pv)){ const n=Math.trunc(pv); if(n===-1) return nodes[nodes.length-1]; const idx=Math.max(1,n)-1; return nodes[idx]||null; } const ps=asText(pv); if(ps){ const low=ps.toLowerCase(); for(const n of nodes){ const t=asText(n.innerText||n.textContent).toLowerCase(); if(t.includes(low)) return n; } } return nodes[0]||null; } function buildData(node, outMode){ const txt=asText(node? (node.innerText||node.textContent):''); const a=node?node.querySelector('a[href]'):null; const h=node?node.querySelector('h1,h2,h3,h4,[role=\"heading\"]'):null; const tm=node?node.querySelector('time,[data-time],[datetime]'):null; const author=node?node.querySelector('[rel=\"author\"],[itemprop=\"author\"],.author,.byline,[data-author]'):null; const id=node? (node.getAttribute('data-id')||node.id||'') : ''; const url = a ? absUrl(a.getAttribute('href')||'') : location.href; const title = asText((h && (h.innerText||h.textContent)) || (a && (a.innerText||a.textContent)) || document.title || ''); const summary = txt.slice(0, 280); const content = outMode==='markdown' ? txt : txt; const html = node ? String(node.outerHTML||'') : ''; return { id: asText(id), url, title, summary, content, author: asText(author && (author.innerText||author.textContent)), time: asText((tm && (tm.getAttribute('datetime')||tm.innerText||tm.textContent)) || ''), html }; } const outMode = asText(output||'').toLowerCase()||'json'; const nodes = selectAllBy(selector); const one = choose(nodes, pick); if(!one){ throw new Error('detail target not found'); } const raw = buildData(one, outMode); const wanted=Array.isArray(fields)&&fields.length?fields:['url','title','summary','content']; const data={}; for(const f0 of wanted){ const f=String(f0||'').trim(); if(!f) continue; if(Object.prototype.hasOwnProperty.call(raw,f)) data[f]=raw[f]; else if(f==='text' || f==='body' || f==='article') data[f]=raw.content; else data[f]=''; } const req=Array.isArray(requireFields)?requireFields:[]; const missingFields=req.filter((k)=>{ const v=data[k]; return v==null || String(v).trim()===''; }); return { action:'detail', data, missingFields, meta:{ matchedCount:nodes.length, by:String(selector||'') } }; }",
				args: [
					"${{ vars.targetNorm?.selector || '' }}",
					"${{ vars.targetNorm?.pick }}",
					"${read.fields}",
					"${read.requireFields}",
					"${read.output}"
				]
			},
			saveAs: "detailOut",
			next: { done: "done", failed: "extract_page_level" },
		},
		{
			id: "extract_page_level",
			desc: "无明确 target 时，按页面级 detail 提取（readPage + 归一化）",
			action: {
				type: "readPage",
				field: { url: true, title: true, article: true }
			},
			saveAs: "pageData",
			next: { done: "normalize_page_level", failed: "ai_fallback_detail" },
		},
		{
			id: "normalize_page_level",
			desc: "页面级材料归一化为 detail",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(pageData, fields, requireFields, output){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } const p=(pageData&&typeof pageData==='object')?pageData:{}; const url=asText(p.url||''); const title=asText(p.title||''); const contentRaw=String(p.article==null?'':p.article); const content=asText(contentRaw); const outMode=asText(output||'').toLowerCase()||'json'; const raw={ url, title, summary: content.slice(0,280), content: outMode==='markdown'?contentRaw:content, html:'', author:'', time:'', id:'' }; const wanted=Array.isArray(fields)&&fields.length?fields:['url','title','summary','content']; const data={}; for(const f0 of wanted){ const f=String(f0||'').trim(); if(!f) continue; if(Object.prototype.hasOwnProperty.call(raw,f)) data[f]=raw[f]; else if(f==='text' || f==='body' || f==='article') data[f]=raw.content; else data[f]=''; } const req=Array.isArray(requireFields)?requireFields:[]; const missingFields=req.filter((k)=>{ const v=data[k]; return v==null || String(v).trim()===''; }); return { action:'detail', data, missingFields, meta:{ from:'page' } }; }",
				args: [
					"${{ vars.pageData || {} }}",
					"${read.fields}",
					"${read.requireFields}",
					"${read.output}"
				]
			},
			saveAs: "detailOut",
			next: { done: "done", failed: "ai_fallback_detail" },
		},
		{
			id: "ai_fallback_detail",
			desc: "页面/target 提取失败时，用 run_ai 兜底抽取 detail",
			action: {
				type: "run_ai",
				model: "balanced",
				prompt: "你是网页详情提取器。请基于输入 page 上下文与 target 信息提取单条 detail，严格返回 JSON envelope。status='ok' 时 result 必须是对象：{url:string,title:string,summary:string,content:string,author:string,time:string,id:string}。无法判断的字段用空字符串。",
				input: {
					target: "${read.target}",
					query: "${query}",
					fields: "${read.fields}",
					requireFields: "${read.requireFields}"
				},
				page: { url: true, title: true, html: true, article: true },
				schema: {
					type: "object",
					properties: {
						url: { type: "string" },
						title: { type: "string" },
						summary: { type: "string" },
						content: { type: "string" },
						author: { type: "string" },
						time: { type: "string" },
						id: { type: "string" }
					},
					required: ["url", "title", "summary", "content", "author", "time", "id"]
				},
				cache: { enabled: false }
			},
			saveAs: "aiOut",
			next: { done: "normalize_ai_fallback", failed: "abort_failed" },
		},
		{
			id: "normalize_ai_fallback",
			desc: "AI 兜底结果归一化为 detail",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(aiOut, fields, requireFields, output){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } const a=(aiOut&&typeof aiOut==='object')?aiOut:{}; const outMode=asText(output||'').toLowerCase()||'json'; const raw={ id:asText(a.id||''), url:asText(a.url||''), title:asText(a.title||''), summary:asText(a.summary||''), content: outMode==='markdown' ? String(a.content==null?'':a.content) : asText(a.content||''), author:asText(a.author||''), time:asText(a.time||''), html:'' }; const wanted=Array.isArray(fields)&&fields.length?fields:['url','title','summary','content']; const data={}; for(const f0 of wanted){ const f=String(f0||'').trim(); if(!f) continue; if(Object.prototype.hasOwnProperty.call(raw,f)) data[f]=raw[f]; else if(f==='text' || f==='body' || f==='article') data[f]=raw.content; else data[f]=''; } const req=Array.isArray(requireFields)?requireFields:[]; const missingFields=req.filter((k)=>{ const v=data[k]; return v==null || String(v).trim()===''; }); return { action:'detail', data, missingFields, meta:{ from:'ai_fallback' } }; }",
				args: [
					"${{ vars.aiOut || {} }}",
					"${read.fields}",
					"${read.requireFields}",
					"${read.output}"
				]
			},
			saveAs: "detailOut",
			next: { done: "done", failed: "abort_failed" }
		},
		{
			id: "done",
			desc: "返回 read.detail 结果",
			action: {
				type: "done",
				reason: "read.detail ok",
				conclusion: "${vars.detailOut}",
			},
			next: {},
		},
		{
			id: "abort_not_detail",
			desc: "不支持的 read.action",
			action: {
				type: "abort",
				reason: "read_detail_generic only supports read.action=detail",
			},
			next: {},
		},
		{
			id: "abort_failed",
			desc: "读取失败",
			action: {
				type: "abort",
				reason: "read.detail extraction failed",
			},
			next: {},
		},
	],
	vars: {
		targetNorm: { type: "object", desc: "规范化后的 target 信息", from: "init_target.saveAs" },
		targetSel: { type: "object", desc: "query 解析得到的 selector", from: "resolve_selector_query.saveAs" },
		pageData: { type: "object", desc: "页面级材料", from: "extract_page_level.saveAs" },
		aiOut: { type: "object", desc: "AI 兜底结果", from: "ai_fallback_detail.saveAs" },
		detailOut: { type: "object", desc: "归一化 detail 输出", from: "*.saveAs" },
	},
};

const readDetailGenericObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default readDetailGenericObject;
export { capabilities, filters, ranks, flow, readDetailGenericObject };
