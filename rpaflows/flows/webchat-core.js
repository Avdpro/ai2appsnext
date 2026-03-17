import WEBCHAT_SITE_PROFILES from "../site-profiles/webchat-profiles.mjs";

const capabilities = {
	must: ["webChat", "webChat.action"],
	prefer: ["webChat.session", "webChat.text", "webChat.sendMode", "webChat.limit", "webChat.timeoutMs", "webChat.pollMs", "webChat.idleMs", "webChat.result"],
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
	id: "webchat_core",
	start: "init_ctx",
	args: {
		webChat: { type: "object", required: false, desc: "webChat.* 参数对象" },
		"webChat.action": { type: "string", required: false, desc: "兼容参数：webChat.action" },
		"webChat.session": { type: "object|string", required: false, desc: "兼容参数：webChat.session" },
		"webChat.text": { type: "string", required: false, desc: "兼容参数：webChat.text" },
		"webChat.assets": { type: "array<string>", required: false, desc: "兼容参数：webChat.assets" },
		"webChat.sendMode": { type: "string", required: false, desc: "兼容参数：webChat.sendMode" },
		"webChat.limit": { type: "number", required: false, desc: "兼容参数：webChat.limit" },
		"webChat.timeoutMs": { type: "number", required: false, desc: "兼容参数：webChat.timeoutMs" },
		"webChat.pollMs": { type: "number", required: false, desc: "兼容参数：webChat.pollMs" },
		"webChat.idleMs": { type: "number", required: false, desc: "兼容参数：webChat.idleMs" },
		"webChat.minNew": { type: "number", required: false, desc: "兼容参数：webChat.minNew" },
		"webChat.requireDoneSignal": { type: "boolean", required: false, desc: "兼容参数：webChat.requireDoneSignal" },
		"webChat.menuMode": { type: "string", required: false, desc: "兼容参数：webChat.menuMode(auto|hover|more|assist)" },
		"webChat.confirm": { type: "boolean", required: false, desc: "兼容参数：webChat.confirm（删除确认）" },
	},
	steps: [
		{
			id: "init_ctx",
			desc: "规范化 webChat action/session/text（兼容 args.webChat 与 dot-key）",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(input){ function asText(v){ return String(v==null?'':v).trim(); } function asObj(v){ return (v && typeof v==='object' && !Array.isArray(v)) ? v : {}; } function asArr(v){ if(!Array.isArray(v)) return []; return v.map((x)=>asText(x)).filter(Boolean); } function asInt(v,dv){ const n=Number(v); if(!Number.isFinite(n)) return dv; const k=Math.floor(n); if(k<1) return dv; return k; } const root=asObj(input); const wc=asObj(root.webChat); const action=asText(root['webChat.action'] || wc.action).toLowerCase(); const rawSession = (root['webChat.session']!==undefined) ? root['webChat.session'] : wc.session; let session={kind:'ai', title:'', id:'', path:[], pick:null}; if(typeof rawSession==='string'){ session.title=asText(rawSession); } else if(rawSession && typeof rawSession==='object'){ session.kind=asText(rawSession.kind || 'ai') || 'ai'; session.title=asText(rawSession.title); session.id=asText(rawSession.id); session.path=Array.isArray(rawSession.path)?rawSession.path:[]; session.pick=(rawSession.pick===undefined?null:rawSession.pick); } const text=asText(root['webChat.text']!==undefined ? root['webChat.text'] : wc.text); const assets=asArr(root['webChat.assets']!==undefined ? root['webChat.assets'] : wc.assets); const sendMode=asText(root['webChat.sendMode']!==undefined ? root['webChat.sendMode'] : wc.sendMode).toLowerCase() || 'auto'; const mode = (sendMode==='enter' || sendMode==='button' || sendMode==='auto') ? sendMode : 'auto'; const limit=asInt((root['webChat.limit']!==undefined ? root['webChat.limit'] : wc.limit), 50); const timeoutMs=asInt((root['webChat.timeoutMs']!==undefined ? root['webChat.timeoutMs'] : wc.timeoutMs), 30000); const pollMs=asInt((root['webChat.pollMs']!==undefined ? root['webChat.pollMs'] : wc.pollMs), 1000); const idleMs=asInt((root['webChat.idleMs']!==undefined ? root['webChat.idleMs'] : wc.idleMs), 1800); const minNew=asInt((root['webChat.minNew']!==undefined ? root['webChat.minNew'] : wc.minNew), 1); const requireDoneSignal=!!((root['webChat.requireDoneSignal']!==undefined ? root['webChat.requireDoneSignal'] : wc.requireDoneSignal)); const menuMode=asText(root['webChat.menuMode']!==undefined ? root['webChat.menuMode'] : wc.menuMode).toLowerCase() || ''; const confirm=!!((root['webChat.confirm']!==undefined ? root['webChat.confirm'] : wc.confirm)); return { action, session, text, assets, sendMode: mode, limit, timeoutMs, pollMs, idleMs, minNew, requireDoneSignal, menuMode, confirm, selectors:{} }; }",
				args: [
					"${{ ({ webChat: args.webChat || {}, 'webChat.action': args['webChat.action'], 'webChat.session': args['webChat.session'], 'webChat.text': args['webChat.text'], 'webChat.assets': args['webChat.assets'], 'webChat.sendMode': args['webChat.sendMode'], 'webChat.limit': args['webChat.limit'], 'webChat.timeoutMs': args['webChat.timeoutMs'], 'webChat.pollMs': args['webChat.pollMs'], 'webChat.idleMs': args['webChat.idleMs'], 'webChat.minNew': args['webChat.minNew'], 'webChat.requireDoneSignal': args['webChat.requireDoneSignal'], 'webChat.menuMode': args['webChat.menuMode'], 'webChat.confirm': args['webChat.confirm'] }) }}",
				],
			},
			saveAs: "wcCtx",
			next: { done: "read_site_origin", failed: "abort_bad_args" },
		},
		{
			id: "read_site_origin",
			desc: "读取当前页面 origin 以匹配站点 profile",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(){ try{ return { origin: String(location.origin||''), host: String(location.hostname||'') }; }catch(_){ return { origin:'', host:'' }; } }",
			},
			saveAs: "siteOrigin",
			next: { done: "merge_site_profile", failed: "merge_site_profile" },
		},
		{
			id: "merge_site_profile",
			desc: "合并站点 profile 到 webChat 上下文",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(ctx, site, profiles){ function asObj(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; } function asText(v){ return String(v==null?'':v).trim(); } const c=asObj(ctx); const s=asObj(site); const p=asObj(profiles); const host=asText(s.host).toLowerCase(); const base=asObj(p.default); let matched={}; for(const k of Object.keys(p)){ if(k==='default') continue; const one=asObj(p[k]); const hs=Array.isArray(one.matchHosts)?one.matchHosts.map((x)=>asText(x).toLowerCase()).filter(Boolean):[]; if(!hs.length) continue; if(hs.some((h)=>host===h || host.endsWith('.'+h))){ matched=one; break; } } const out={ ...c }; out.selectors={ ...asObj(base.selectors), ...asObj(matched.selectors), ...asObj(c.selectors) }; if(!asText(out.menuMode)){ out.menuMode=asText(matched.menuMode||base.menuMode||'auto').toLowerCase(); } out.siteProfile={ host, matched: Object.keys(matched).length>0 }; return out; }",
				args: ["${{ vars.wcCtx || {} }}", "${{ vars.siteOrigin || {} }}", WEBCHAT_SITE_PROFILES],
			},
			saveAs: "wcCtx",
			next: { done: "route_action", failed: "route_action" },
		},
		{
			id: "route_action",
			desc: "按 webChat.action 路由（当前实现 newSession/send/getMessages/waitReply/getSessions/enterSession/renameSession/deleteSession）",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "wcCtx.action", value: "newsession" }, to: "new_session_click" },
					{ when: { op: "eq", source: "vars", path: "wcCtx.action", value: "send" }, to: "send_validate" },
					{ when: { op: "eq", source: "vars", path: "wcCtx.action", value: "getmessages" }, to: "get_messages_extract" },
					{ when: { op: "eq", source: "vars", path: "wcCtx.action", value: "waitreply" }, to: "wait_reply_init" },
					{ when: { op: "eq", source: "vars", path: "wcCtx.action", value: "getsessions" }, to: "get_sessions_extract" },
					{ when: { op: "eq", source: "vars", path: "wcCtx.action", value: "entersession" }, to: "enter_session_resolve" },
					{ when: { op: "eq", source: "vars", path: "wcCtx.action", value: "renamesession" }, to: "rename_session_validate" },
					{ when: { op: "eq", source: "vars", path: "wcCtx.action", value: "deletesession" }, to: "delete_session_prepare" },
				],
				default: "abort_unsupported",
			},
			next: {},
		},

		{
			id: "new_session_click",
			desc: "点击新建会话按钮",
			action: {
				type: "click",
				by: "css: ${vars.wcCtx.selectors.newSessionBtn}",
				postWaitMs: 400,
			},
			next: { done: "read_active_title", failed: "abort_failed" },
		},
		{
			id: "read_active_title",
			desc: "读取当前会话标题（best-effort）",
			action: {
				type: "readElement",
				by: "css: ${vars.wcCtx.selectors.sessionTitle}",
				pick: "text",
			},
			saveAs: "activeTitle",
			next: { done: "build_out_newsession", failed: "build_out_newsession" },
		},
		{
			id: "build_out_newsession",
			desc: "构造 webChat.result（newSession）",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(ctx, activeTitle){ function asText(v){ return String(v==null?'':v).trim(); } const c=(ctx&&typeof ctx==='object')?ctx:{}; const s=(c.session&&typeof c.session==='object')?c.session:{}; const t=asText(activeTitle); const title = t || asText(s.title) || 'New chat'; return { action:'newSession', created:true, session:{ kind: asText(s.kind || 'ai') || 'ai', title }, items:[], cursor:'' }; }",
				args: ["${{ vars.wcCtx || {} }}", "${{ vars.activeTitle || '' }}"],
			},
			saveAs: "wcOut",
			next: { done: "done", failed: "abort_failed" },
		},

		{
			id: "send_validate",
			desc: "校验 send 输入",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(ctx){ const c=(ctx&&typeof ctx==='object')?ctx:{}; const text=String(c.text||'').trim(); if(!text){ throw new Error('webChat.send requires non-empty webChat.text'); } return { ok:true, textLen:text.length, assetsCount:Array.isArray(c.assets)?c.assets.length:0, sendMode:String(c.sendMode||'auto') }; }",
				args: ["${{ vars.wcCtx || {} }}"],
			},
			saveAs: "sendCheck",
			next: { done: "send_type_input", failed: "abort_failed" },
		},
		{
			id: "send_type_input",
			desc: "输入发送文本到聊天输入框",
			action: {
				type: "input",
				by: "css: ${vars.wcCtx.selectors.chatInput}",
				text: "${vars.wcCtx.text}",
				mode: "fill",
				clear: true,
				postWaitMs: 120,
			},
			next: { done: "route_send_mode", failed: "abort_failed" },
		},
		{
			id: "route_send_mode",
			desc: "按 sendMode 选择发送方式",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "wcCtx.sendMode", value: "enter" }, to: "send_press_enter" },
				],
				default: "send_click_button",
			},
			next: {},
		},
		{
			id: "send_press_enter",
			desc: "回车发送",
			action: {
				type: "press_key",
				key: "Enter",
				postWaitMs: 160,
			},
			next: { done: "send_verify_user", failed: "abort_failed" },
		},
		{
			id: "send_click_button",
			desc: "点击发送按钮",
			action: {
				type: "click",
				by: "css: ${vars.wcCtx.selectors.sendBtn}",
				postWaitMs: 160,
			},
			next: { done: "send_verify_user", failed: "abort_failed" },
		},
		{
			id: "send_verify_user",
			desc: "确认最后一条用户消息已发送",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(expected, selectors){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } function asObj(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; } const exp=asText(expected); const sel=asObj(selectors); const userSel=asText(sel.messageUser) || \"[data-role='message'][data-message-role='user'], [data-message-author-role='user']\"; const textSel=asText(sel.messageText) || \".text,[data-role='message-text'],.message-text,[data-role='text'],.markdown,[dir='auto']\"; const nodes=Array.from(document.querySelectorAll(userSel)); const last=nodes.length?nodes[nodes.length-1]:null; const txt=asText(last ? ((last.querySelector(textSel) && (last.querySelector(textSel).innerText || last.querySelector(textSel).textContent)) || last.innerText || last.textContent || '') : ''); const expHit=!!exp && !!txt && (txt.indexOf(exp)>=0 || exp.indexOf(txt)>=0); const fallbackHit=!!exp && asText(document.body && document.body.innerText).indexOf(exp)>=0; const ok=(!!txt && (!!exp ? expHit : true)) || fallbackHit; return { ok, userText: txt, userCount: nodes.length, expHit, fallbackHit }; }",
				args: ["${vars.wcCtx.text}", "${{ vars.wcCtx?.selectors || {} }}"],
			},
			saveAs: "sendVerify",
			next: { done: "route_send_verify", failed: "abort_failed" },
		},
		{
			id: "route_send_verify",
			desc: "若发送确认失败则中止",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "sendVerify.ok", value: true }, to: "build_out_send" },
				],
				default: "abort_failed",
			},
			next: {},
		},
		{
			id: "build_out_send",
			desc: "构造 webChat.result（send）",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(ctx, verify){ function asText(v){ return String(v==null?'':v).trim(); } const c=(ctx&&typeof ctx==='object')?ctx:{}; const s=(c.session&&typeof c.session==='object')?c.session:{}; const v=(verify&&typeof verify==='object')?verify:{}; const text=asText(v.userText || c.text); const title=asText(s.title || ''); return { action:'send', sent: !!v.ok, session:{ kind: asText(s.kind || 'ai') || 'ai', title }, items:[{ role:'user', text }], cursor:'' }; }",
				args: ["${{ vars.wcCtx || {} }}", "${{ vars.sendVerify || {} }}"],
			},
			saveAs: "wcOut",
			next: { done: "done", failed: "abort_failed" },
		},

		{
			id: "get_messages_extract",
			desc: "使用 run_js(query)+cache 从当前聊天页面提取消息",
			action: {
				type: "run_js",
				scope: "page",
				cache: true,
				query: "编写一个只读函数，签名必须是 function(config)。任务：从当前聊天页面提取消息列表，返回 {action:'getMessages',items:Array,cursor:string}. 绝对禁止：导航跳转、网络请求、DOM写入、事件触发。优先使用语义标记：data-role='message'、data-message-role、[role='listitem'] 等；每条消息输出对象字段 {id,role,text,time,status,index}，全部是字符串或数字（id/role/text/time/status 为字符串，index 为数字）。role 仅可为 user|assistant|system|tool|unknown。如果拿不到稳定 id，使用 role+index+text 前缀组合生成。去掉纯空白消息。按页面展示顺序输出（旧->新）。根据 config.limit 截断末尾 N 条（默认 50）。cursor 可用最后一条消息 id；没有则空字符串。config 包含 {limit,session}.",
				args: [
					"${{ ({ limit: vars.wcCtx?.limit || 50, session: vars.wcCtx?.session || {} }) }}",
				],
			},
			saveAs: "rawMessagesOut",
			next: { done: "get_messages_normalize", failed: "get_messages_fallback" },
		},
		{
			id: "get_messages_fallback",
			desc: "规则兜底提取消息（不依赖 AI）",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(config){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } function normRole(v){ const s=asText(v).toLowerCase(); if(s==='user'||s==='assistant'||s==='system'||s==='tool') return s; if(s.includes('assistant')||s==='ai'||s.includes('bot')) return 'assistant'; if(s.includes('user')||s.includes('human')) return 'user'; if(s.includes('system')) return 'system'; return 'unknown'; } function asLimit(v){ const n=Number(v); if(!Number.isFinite(n) || n<1) return 50; return Math.floor(n); } const limit=asLimit(config&&config.limit); const nodes=Array.from(document.querySelectorAll(\"[data-role='message'], .msg, [role='listitem']\")); const out=[]; for(let i=0;i<nodes.length;i+=1){ const n=nodes[i]; const role=normRole(n.getAttribute('data-message-role') || n.getAttribute('data-role') || n.className || ''); const txtNode=n.querySelector('.text,[data-role=\"message-text\"],.message-text,[data-role=\"text\"]'); const text=asText(txtNode ? (txtNode.innerText || txtNode.textContent || '') : (n.innerText || n.textContent || '')); if(!text) continue; const metaNode=n.querySelector('.meta,[data-role=\"message-meta\"]'); let time=''; let status=''; if(metaNode){ const spans=Array.from(metaNode.querySelectorAll('span')); if(spans[1]) time=asText(spans[1].innerText||spans[1].textContent||''); if(spans[2]) status=asText(spans[2].innerText||spans[2].textContent||''); } const idx=i+1; const id=asText(n.getAttribute('data-message-id')||n.id||'') || (role+'_'+idx+'_'+text.slice(0,24)); out.push({ id, role, text, time, status, index: idx }); } const sliced=out.slice(Math.max(0,out.length-limit)); return { action:'getMessages', items:sliced, cursor: sliced.length?String(sliced[sliced.length-1].id||''):'' }; }",
				args: [
					"${{ ({ limit: vars.wcCtx?.limit || 50 }) }}",
				],
			},
			saveAs: "rawMessagesOut",
			next: { done: "get_messages_normalize", failed: "abort_failed" },
		},
		{
			id: "get_messages_normalize",
			desc: "规范化 getMessages 输出为统一结构",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(raw, ctx){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } function asObj(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; } function normRole(v){ const s=asText(v).toLowerCase(); if(s==='user'||s==='assistant'||s==='system'||s==='tool'||s==='unknown') return s; if(s.includes('assistant')||s==='ai'||s.includes('bot')) return 'assistant'; if(s.includes('user')||s.includes('human')) return 'user'; if(s.includes('system')) return 'system'; if(s.includes('tool')) return 'tool'; return 'unknown'; } function asLimit(v){ const n=Number(v); if(!Number.isFinite(n)||n<1) return 50; return Math.floor(n); } function parseRaw(x){ if(x==null) return {}; if(typeof x==='string'){ try{return JSON.parse(x);}catch(_){ return {}; } } return asObj(x); } const c=asObj(ctx); const session=asObj(c.session); const limit=asLimit(c.limit); const obj=parseRaw(raw); const src=Array.isArray(obj.items)?obj.items:(Array.isArray(obj.messages)?obj.messages:(Array.isArray(obj.list)?obj.list:[])); const out=[]; for(let i=0;i<src.length;i+=1){ const it=asObj(src[i]); const role=normRole(it.role||it.author||it.type||it.sender); const text=asText(it.text||it.content||it.body||it.message); if(!text) continue; const idx=Number.isFinite(Number(it.index))?Math.floor(Number(it.index)):(i+1); const id=asText(it.id||it.messageId||it.mid) || (role+'_'+idx+'_'+text.slice(0,24)); out.push({ id, role, text, time: asText(it.time||it.ts||it.date), status: asText(it.status), index: idx }); } const sliced=out.slice(Math.max(0,out.length-limit)); const cursor=asText(obj.cursor || obj.nextCursor || (sliced.length ? sliced[sliced.length-1].id : '')); return { action:'getMessages', session:{ kind: asText(session.kind||'ai') || 'ai', title: asText(session.title) }, items:sliced, cursor }; }",
				args: ["${{ vars.rawMessagesOut || {} }}", "${{ vars.wcCtx || {} }}"],
			},
			saveAs: "wcOut",
			next: { done: "done", failed: "abort_failed" },
		},
		{
			id: "get_sessions_extract",
			desc: "提取当前页面会话列表（规则提取，跨站可扩展）",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(config){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } function asLimit(v){ const n=Number(v); if(!Number.isFinite(n)||n<1) return 50; return Math.floor(n); } function asObj(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; } const cfg=asObj(config); const selectors=asObj(cfg.selectors); const listSel=asText(selectors.sessionList) || \"[data-role='session-list']\"; const itemSel=asText(selectors.sessionItem) || \"[data-role='session-item']\"; const titleSel=asText(selectors.sessionTitle) || \"[data-role='session-title'], .session-title\"; const limit=asLimit(cfg.limit); const root=document.querySelector(listSel) || document; let nodes=Array.from(root.querySelectorAll(itemSel)); if(!nodes.length){ nodes=Array.from(root.querySelectorAll(\"aside button, nav button, [role='listitem'] button, [role='listitem'], aside a, nav a\")); } const out=[]; for(let i=0;i<nodes.length;i+=1){ const n=nodes[i]; const id=asText(n.getAttribute('data-session-id')||n.id||'') || ('session_'+(i+1)); const titleNode=n.querySelector(titleSel); const title=asText(titleNode ? (titleNode.innerText||titleNode.textContent||'') : (n.innerText||n.textContent||'')); if(!title) continue; const metaNode=n.querySelector(\"[data-role='session-meta'], .session-meta\"); const metaText=asText(metaNode ? (metaNode.innerText||metaNode.textContent||'') : ''); const active=!!n.classList.contains('active') || n.getAttribute('aria-selected')==='true' || n.getAttribute('aria-current')==='page'; const msgCnt=(metaText.match(/(\\d+)\\s*(msgs|messages|条)/i)||[])[1] || ''; out.push({ id, title, kind:'ai', status: active?'active':'idle', messageCount: asText(msgCnt), lastTime:'', lastMessage:'' }); if(out.length>=limit) break; } return { action:'getSessions', items: out, cursor: out.length?String(out[out.length-1].id||''):'' }; }",
				args: ["${{ ({ limit: vars.wcCtx?.limit || 50, selectors: vars.wcCtx?.selectors || {} }) }}"],
			},
			saveAs: "rawSessionsOut",
			next: { done: "get_sessions_normalize", failed: "abort_failed" },
		},
		{
			id: "get_sessions_normalize",
			desc: "规范化 getSessions 输出",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(raw, ctx){ function asObj(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; } function asText(v){ return String(v==null?'':v).trim(); } function parseRaw(x){ if(x==null) return {}; if(typeof x==='string'){ try{return JSON.parse(x);}catch(_){ return {}; } } return asObj(x); } const c=asObj(ctx); const limit=Math.max(1, Math.floor(Number(c.limit||50))); const obj=parseRaw(raw); const src=Array.isArray(obj.items)?obj.items:(Array.isArray(obj.sessions)?obj.sessions:(Array.isArray(obj.list)?obj.list:[])); const out=[]; const seen=new Set(); for(let i=0;i<src.length;i+=1){ const it=asObj(src[i]); const id=asText(it.id||it.sessionId||it.sid) || ('session_'+(i+1)); if(seen.has(id)) continue; seen.add(id); const title=asText(it.title||it.name||it.sessionTitle); if(!title) continue; out.push({ id, kind: asText(it.kind||'ai')||'ai', title, status: asText(it.status||'idle')||'idle', messageCount: asText(it.messageCount||it.count||''), lastMessage: asText(it.lastMessage||it.preview||''), lastTime: asText(it.lastTime||it.time||'') }); if(out.length>=limit) break; } const cursor=asText(obj.cursor || obj.nextCursor || (out.length?out[out.length-1].id:'')); return { action:'getSessions', session:{ kind:'ai', title: asText(c?.session?.title||'') }, items: out, cursor }; }",
				args: ["${{ vars.rawSessionsOut || {} }}", "${{ vars.wcCtx || {} }}"],
			},
			saveAs: "wcOut",
			next: { done: "done", failed: "abort_failed" },
		},

		{
			id: "enter_session_resolve",
			desc: "解析要进入的会话（按 id/title/pick/path）",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(session, selectors){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } function asObj(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; } function normPick(v){ if(v==null || v==='') return null; if(typeof v==='number' && Number.isFinite(v)) return Math.trunc(v); var s=String(v).trim(); if(!s) return null; if(/^[+-]?\\d+$/.test(s)) return Number.parseInt(s,10); var low=s.toLowerCase(); if(low==='first') return 1; if(low==='last') return -1; return s; } function chooseByPick(list,pick){ if(!Array.isArray(list)||!list.length) return null; if(pick==null) return null; if(typeof pick==='number' && Number.isFinite(pick)){ var n=Math.trunc(pick); var idx=0; if(n===-1) idx=list.length-1; else if(n>=1) idx=n-1; else if(n<=-2) idx=list.length+n; if(idx<0||idx>=list.length) return null; return list[idx]; } var q=String(pick).toLowerCase(); for(var i=0;i<list.length;i++){ var t=(list[i].title||'').toLowerCase(); if(t.indexOf(q)>=0) return list[i]; } return null; } function tpl(s,vars){ var out=String(s||''); for(var k in vars){ out=out.split('{{'+k+'}}').join(String(vars[k]||'')); } return out; } var s=asObj(session); var sel=asObj(selectors); var listRoot=document.querySelector(asText(sel.sessionList)||\"[data-role='session-list']\")||document; var itemSel=asText(sel.sessionItem)||\"[data-role='session-item']\"; var itemByIdTpl=asText(sel.sessionItemByIdTemplate)||asText(sel.sessionItemTemplate)||''; var titleSel=asText(sel.sessionTitle)||\"[data-role='session-title'], .session-title\"; var nodes=Array.from(listRoot.querySelectorAll(itemSel)); if(!nodes.length){ nodes=Array.from(listRoot.querySelectorAll(\"[data-role='session-item'], aside a, nav a, aside button, nav button\")); } var list=[]; for(var i=0;i<nodes.length;i++){ var n=nodes[i]; var id=asText(n.getAttribute('data-session-id')||n.id||'') || ('session_'+(i+1)); var tNode=n.querySelector(titleSel); var title=asText(tNode ? (tNode.innerText||tNode.textContent||'') : (n.innerText||n.textContent||'')); if(!title) continue; var rowSelector=(itemByIdTpl && itemByIdTpl.indexOf('{{id}}')>=0) ? tpl(itemByIdTpl,{id:id}) : (itemSel+':nth-of-type('+(i+1)+')'); list.push({ id:id, title, idx:i, active:!!n.classList.contains('active'), rowSelector: rowSelector }); } var byId=asText(s.id); var byTitle=asText(s.title); var byPath=(Array.isArray(s.path)&&s.path.length)?asText(s.path[0]):''; var pick=normPick(s.pick); var chosen=null; if(byId){ chosen=list.find(function(it){ return it.id===byId; })||null; } if(!chosen && byTitle){ var q1=byTitle.toLowerCase(); chosen=list.find(function(it){ return String(it.title||'').toLowerCase().indexOf(q1)>=0; })||null; } if(!chosen && byPath){ var q2=byPath.toLowerCase(); chosen=list.find(function(it){ return String(it.title||'').toLowerCase().indexOf(q2)>=0; })||null; } if(!chosen){ chosen=chooseByPick(list,pick); } if(!chosen && list.length===1){ chosen=list[0]; } if(!chosen){ return { ok:false, reason:'session target not found', target:null, count:list.length }; } return { ok:true, reason:'', target:chosen, count:list.length }; }",
				args: ["${{ vars.wcCtx?.session || {} }}", "${{ vars.wcCtx?.selectors || {} }}"],
			},
			saveAs: "enterResolve",
			next: { done: "enter_session_route_resolve", failed: "abort_failed" },
		},
		{
			id: "enter_session_route_resolve",
			desc: "会话目标存在才继续",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "enterResolve.ok", value: true }, to: "enter_session_post_resolve" },
				],
				default: "abort_failed",
			},
			next: {},
		},
		{
			id: "enter_session_click",
			desc: "点击目标会话条目",
			action: {
				type: "click",
				by: "css: ${vars.enterResolve.target.rowSelector}",
				postWaitMs: 200,
			},
			next: { done: "enter_session_verify", failed: "abort_failed" },
		},
		{
			id: "enter_session_verify",
			desc: "验证已切换到目标会话",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(expect, selectors){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } var ex=(expect&&typeof expect==='object')?expect:{}; var sel=(selectors&&typeof selectors==='object')?selectors:{}; var exId=asText(ex.id); var exTitle=asText(ex.title); var activeSel=asText(sel.activeSessionItem)||\"[data-role='session-item'].active\"; var titleSel=asText(sel.sessionTitle)||\"[data-role='session-title'], .session-title\"; var active=document.querySelector(activeSel); var activeId=asText(active ? (active.getAttribute('data-session-id')||active.id||'') : ''); var tNode=document.querySelector(titleSel); var activeTitle=asText(tNode ? (tNode.innerText||tNode.textContent||'') : (active ? active.innerText : '')); var ok=!!active && ((!exId || activeId===exId) || (!!exTitle && activeTitle.toLowerCase().indexOf(exTitle.toLowerCase())>=0)); return { ok, activeId, activeTitle }; }",
				args: ["${{ vars.enterResolve?.target || {} }}", "${{ vars.wcCtx?.selectors || {} }}"],
			},
			saveAs: "enterVerify",
			next: { done: "enter_session_route_verify", failed: "abort_failed" },
		},
		{
			id: "enter_session_route_verify",
			desc: "切换成功则输出结果",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "enterVerify.ok", value: true }, to: "build_out_entersession" },
				],
				default: "abort_failed",
			},
			next: {},
		},
		{
			id: "build_out_entersession",
			desc: "构造 webChat.result（enterSession）",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(ctx, resolve, verify){ function asText(v){ return String(v==null?'':v).trim(); } var c=(ctx&&typeof ctx==='object')?ctx:{}; var r=(resolve&&typeof resolve==='object')?resolve:{}; var v=(verify&&typeof verify==='object')?verify:{}; var s=(c.session&&typeof c.session==='object')?c.session:{}; var t=(r.target&&typeof r.target==='object')?r.target:{}; return { action:'enterSession', entered:!!v.ok, session:{ kind: asText(s.kind||'ai')||'ai', id: asText(v.activeId||t.id||s.id||''), title: asText(v.activeTitle||t.title||s.title||'') }, items:[], cursor:'' }; }",
				args: ["${{ vars.wcCtx || {} }}", "${{ vars.enterResolve || {} }}", "${{ vars.enterVerify || {} }}"],
			},
			saveAs: "wcOut",
			next: { done: "done", failed: "abort_failed" },
		},
		{
			id: "rename_session_validate",
			desc: "renameSession 需要新标题文本",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(ctx){ var c=(ctx&&typeof ctx==='object')?ctx:{}; var t=String(c.text||'').trim(); if(!t){ throw new Error('renameSession requires webChat.text as new title'); } return { ok:true, text:t }; }",
				args: ["${{ vars.wcCtx || {} }}"],
			},
			saveAs: "renameCheck",
			next: { done: "enter_session_resolve", failed: "abort_failed" },
		},
		{
			id: "delete_session_prepare",
			desc: "deleteSession 目标解析前置",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(){ return { ok:true }; }",
			},
			next: { done: "enter_session_resolve", failed: "abort_failed" },
		},
		{
			id: "enter_session_post_resolve",
			desc: "目标解析后按 action 分流",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "wcCtx.action", value: "entersession" }, to: "enter_session_click" },
					{ when: { op: "eq", source: "vars", path: "wcCtx.action", value: "renamesession" }, to: "rename_session_route_mode" },
					{ when: { op: "eq", source: "vars", path: "wcCtx.action", value: "deletesession" }, to: "delete_session_route_mode" },
				],
				default: "abort_failed",
			},
			next: {},
		},
		{
			id: "rename_session_route_mode",
			desc: "renameSession 模式路由",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "wcCtx.menuMode", value: "assist" }, to: "rename_ask_assist" },
				],
				default: "rename_session_hover",
			},
			next: {},
		},
		{
			id: "rename_session_hover",
			desc: "尝试 hover 显示会话操作入口",
			action: {
				type: "hover",
				by: "css: ${vars.enterResolve.target.rowSelector}",
			},
			next: { done: "rename_click_inline_btn", failed: "rename_click_more_btn" },
		},
		{
			id: "rename_click_inline_btn",
			desc: "尝试点击行内 rename 按钮",
			action: {
				type: "click",
				by: "css: ${vars.enterResolve.target.rowSelector} ${vars.wcCtx.selectors.renameInline}",
				postWaitMs: 120,
			},
			next: { done: "rename_try_inline_input", failed: "rename_click_more_btn" },
		},
		{
			id: "rename_click_more_btn",
			desc: "尝试点击全局 rename 按钮（更多菜单/顶部工具栏）",
			action: {
				type: "click",
				by: "css: ${vars.wcCtx.selectors.renameGlobal}",
				postWaitMs: 120,
			},
			next: { done: "rename_try_inline_input", failed: "rename_ask_assist" },
		},
		{
			id: "rename_try_inline_input",
			desc: "若出现可编辑输入框则自动填入新标题",
			action: {
				type: "input",
				by: "css: ${vars.wcCtx.selectors.renameInput}",
				text: "${vars.wcCtx.text}",
				mode: "fill",
				clear: true,
			},
			next: { done: "rename_submit_inline", failed: "rename_ask_assist" },
		},
		{
			id: "rename_submit_inline",
			desc: "提交 inline rename",
			action: {
				type: "press_key",
				key: "Enter",
				postWaitMs: 150,
			},
			next: { done: "rename_verify", failed: "rename_verify" },
		},
		{
			id: "rename_ask_assist",
			desc: "自动重命名失败时请求人工介入",
			action: {
				type: "ask_assist",
				reason: "请将目标会话重命名为：${vars.wcCtx.text}，完成后点击继续。",
				waitUserAction: true,
				modal: false,
			},
			next: { done: "rename_verify", failed: "abort_failed" },
		},
		{
			id: "rename_verify",
			desc: "验证会话标题已更新",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(target,newTitle,selectors){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } var t=(target&&typeof target==='object')?target:{}; var sel=(selectors&&typeof selectors==='object')?selectors:{}; var want=asText(newTitle).toLowerCase(); var rowSel=asText(t.rowSelector); var activeSel=asText(sel.activeSessionItem)||\"[data-role='session-item'].active\"; var titleSel=asText(sel.sessionTitle)||\"[data-role='session-title'], .session-title\"; var row=rowSel?document.querySelector(rowSel):null; if(!row){ row=document.querySelector(activeSel); } var txt=''; if(row){ var n=row.querySelector(titleSel); txt=asText(n?(n.innerText||n.textContent||''):(row.innerText||row.textContent||'')); } var ok=!!txt && (!!want ? txt.toLowerCase().indexOf(want)>=0 : false); return { ok, title: txt }; }",
				args: ["${{ vars.enterResolve?.target || {} }}", "${vars.wcCtx.text}", "${{ vars.wcCtx?.selectors || {} }}"],
			},
			saveAs: "renameVerify",
			next: { done: "rename_route_verify", failed: "abort_failed" },
		},
		{
			id: "rename_route_verify",
			desc: "重命名成功路由",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "renameVerify.ok", value: true }, to: "build_out_renamesession" },
				],
				default: "abort_failed",
			},
			next: {},
		},
		{
			id: "build_out_renamesession",
			desc: "构造 webChat.result（renameSession）",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(ctx, target, verify){ function asText(v){ return String(v==null?'':v).trim(); } var c=(ctx&&typeof ctx==='object')?ctx:{}; var t=(target&&typeof target==='object')?target:{}; var v=(verify&&typeof verify==='object')?verify:{}; return { action:'renameSession', renamed:!!v.ok, session:{ kind: asText(c?.session?.kind||'ai')||'ai', id: asText(t.id||''), title: asText(v.title||c.text||'') }, items:[], cursor:'' }; }",
				args: ["${{ vars.wcCtx || {} }}", "${{ vars.enterResolve?.target || {} }}", "${{ vars.renameVerify || {} }}"],
			},
			saveAs: "wcOut",
			next: { done: "done", failed: "abort_failed" },
		},
		{
			id: "delete_session_hover",
			desc: "尝试 hover 显示删除入口",
			action: {
				type: "hover",
				by: "css: ${vars.enterResolve.target.rowSelector}",
			},
			next: { done: "delete_click_inline_btn", failed: "delete_click_more_btn" },
		},
		{
			id: "delete_session_route_mode",
			desc: "deleteSession 模式路由",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "wcCtx.menuMode", value: "assist" }, to: "delete_ask_assist" },
				],
				default: "delete_session_hover",
			},
			next: {},
		},
		{
			id: "delete_click_inline_btn",
			desc: "尝试点击行内 delete 按钮",
			action: {
				type: "click",
				by: "css: ${vars.enterResolve.target.rowSelector} ${vars.wcCtx.selectors.deleteInline}",
				postWaitMs: 120,
			},
			next: { done: "delete_verify", failed: "delete_click_more_btn" },
		},
		{
			id: "delete_click_more_btn",
			desc: "尝试点击全局 delete 按钮（更多菜单/顶部工具栏）",
			action: {
				type: "click",
				by: "css: ${vars.wcCtx.selectors.deleteGlobal}",
				postWaitMs: 120,
			},
			next: { done: "delete_verify", failed: "delete_ask_assist" },
		},
		{
			id: "delete_ask_assist",
			desc: "自动删除失败时请求人工介入",
			action: {
				type: "ask_assist",
				reason: "请删除目标会话（${vars.enterResolve.target.title}），完成后点击继续。",
				waitUserAction: true,
				modal: false,
			},
			next: { done: "delete_verify", failed: "abort_failed" },
		},
		{
			id: "delete_verify",
			desc: "验证会话已删除（目标 id 不再存在）",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(target){ var t=(target&&typeof target==='object')?target:{}; var rowSel=String(t.rowSelector||'').trim(); if(!rowSel){ return { ok:false, remaining:true }; } var row=document.querySelector(rowSel); return { ok: !row, remaining: !!row }; }",
				args: ["${{ vars.enterResolve?.target || {} }}"],
			},
			saveAs: "deleteVerify",
			next: { done: "delete_route_verify", failed: "abort_failed" },
		},
		{
			id: "delete_route_verify",
			desc: "删除成功路由",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "deleteVerify.ok", value: true }, to: "build_out_deletesession" },
				],
				default: "abort_failed",
			},
			next: {},
		},
		{
			id: "build_out_deletesession",
			desc: "构造 webChat.result（deleteSession）",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(ctx, target, verify){ function asText(v){ return String(v==null?'':v).trim(); } var c=(ctx&&typeof ctx==='object')?ctx:{}; var t=(target&&typeof target==='object')?target:{}; var v=(verify&&typeof verify==='object')?verify:{}; return { action:'deleteSession', deleted:!!v.ok, session:{ kind: asText(c?.session?.kind||'ai')||'ai', id: asText(t.id||''), title: asText(t.title||'') }, items:[], cursor:'' }; }",
				args: ["${{ vars.wcCtx || {} }}", "${{ vars.enterResolve?.target || {} }}", "${{ vars.deleteVerify || {} }}"],
			},
			saveAs: "wcOut",
			next: { done: "done", failed: "abort_failed" },
		},

		{
			id: "wait_reply_init",
			desc: "初始化 waitReply 轮询状态",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(ctx){ function clamp(v,a,b,d){ const n=Number(v); if(!Number.isFinite(n)) return d; return Math.max(a, Math.min(b, Math.floor(n))); } const c=(ctx&&typeof ctx==='object')?ctx:{}; const timeoutMs=clamp(c.timeoutMs, 1000, 180000, 30000); const pollMs=clamp(c.pollMs, 200, 5000, 1000); const idleMs=clamp(c.idleMs, 500, 15000, 1800); const minNew=clamp(c.minNew, 1, 20, 1); const now=Date.now(); return { startMs: now, deadlineMs: now + timeoutMs, timeoutMs, pollMs, idleMs, minNew, requireDoneSignal: !!c.requireDoneSignal, rounds: 0, stableMs: 0, lastAssistantSig: '', baselineAssistantIds: [], done: false, timeout: false, reason: '' }; }",
				args: ["${{ vars.wcCtx || {} }}"],
			},
			saveAs: "waitState",
			next: { done: "wait_reply_baseline_probe", failed: "abort_failed" },
		},
		{
			id: "wait_reply_baseline_probe",
			desc: "读取 waitReply 基线消息（规则提取，避免首次 AI 抖动）",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(config){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } function asObj(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; } function normRole(v){ const s=asText(v).toLowerCase(); if(s==='user'||s==='assistant'||s==='system'||s==='tool') return s; if(s.includes('assistant')||s==='ai'||s.includes('bot')) return 'assistant'; if(s.includes('user')||s.includes('human')) return 'user'; if(s.includes('system')) return 'system'; return 'unknown'; } function asLimit(v){ const n=Number(v); if(!Number.isFinite(n) || n<1) return 80; return Math.floor(n); } const cfg=asObj(config); const selectors=asObj(cfg.selectors); const limit=asLimit(cfg.limit); const userSel=asText(selectors.messageUser) || \"[data-role='message'][data-message-role='user'], [data-message-author-role='user'], [data-message-author-role='human']\"; const assistantSel=asText(selectors.messageAssistant) || \"[data-role='message'][data-message-role='assistant'], [data-message-author-role='assistant']\"; const textSel=asText(selectors.messageText) || \".text,[data-role='message-text'],.message-text,[data-role='text'],.markdown,[dir='auto']\"; const map=new Map(); const take=(sel)=>{ for(const n of Array.from(document.querySelectorAll(sel))){ if(!map.has(n)) map.set(n,true); } }; take(userSel); take(assistantSel); let nodes=Array.from(map.keys()); if(!nodes.length){ nodes=Array.from(document.querySelectorAll(\"[data-role='message'], .msg, [role='listitem']\")); } const out=[]; for(let i=0;i<nodes.length;i+=1){ const n=nodes[i]; let role='unknown'; if(n.matches && n.matches(assistantSel)) role='assistant'; else if(n.matches && n.matches(userSel)) role='user'; else role=normRole(n.getAttribute('data-message-author-role') || n.getAttribute('data-message-role') || n.getAttribute('data-role') || n.className || ''); const txtNode=n.querySelector(textSel); const text=asText(txtNode ? (txtNode.innerText || txtNode.textContent || '') : (n.innerText || n.textContent || '')); if(!text) continue; const metaNode=n.querySelector('.meta,[data-role=\"message-meta\"]'); let time=''; let status=''; if(metaNode){ const spans=Array.from(metaNode.querySelectorAll('span')); if(spans[1]) time=asText(spans[1].innerText||spans[1].textContent||''); if(spans[2]) status=asText(spans[2].innerText||spans[2].textContent||''); } const idx=i; const id=asText(n.getAttribute('data-message-id')||n.getAttribute('data-testid')||n.id||'') || (role+':'+idx+':'+text.slice(0,32)); out.push({ id, role, text, time, status, index: idx }); } const sliced=out.slice(Math.max(0,out.length-limit)); return { action:'getMessages', items:sliced, cursor: sliced.length?String(sliced[sliced.length-1].id||''):'' }; }",
				args: ["${{ ({ limit: vars.wcCtx?.limit || 80, selectors: vars.wcCtx?.selectors || {} }) }}"],
			},
			saveAs: "waitBaseline",
			next: { done: "wait_reply_seed", failed: "wait_reply_seed" },
		},
		{
			id: "wait_reply_seed",
			desc: "由基线构建 waitReply 状态",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(state, baseline){ function asObj(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; } function asText(v){ return String(v==null?'':v).trim(); } const s=asObj(state); const b=asObj(baseline); const items=Array.isArray(b.items)?b.items:[]; const assist=items.filter((it)=>asText(it&&it.role).toLowerCase()==='assistant'); const ids=[]; for(const a of assist){ const id=asText(a&&a.id); if(id) ids.push(id); } const last=assist.length?assist[assist.length-1]:null; const lastSig=last ? (asText(last.id)+'|'+asText(last.text).length+'|'+asText(last.text).slice(-24)) : ''; return { ...s, baselineAssistantIds: ids, lastAssistantSig: lastSig, baselineCount: assist.length }; }",
				args: ["${{ vars.waitState || {} }}", "${{ vars.waitBaseline || {} }}"],
			},
			saveAs: "waitState",
			next: { done: "wait_reply_probe", failed: "abort_failed" },
		},
		{
			id: "wait_reply_probe",
			desc: "轮询当前消息快照",
			action: {
				type: "run_js",
				scope: "page",
				code: "function(config){ function asText(v){ return String(v==null?'':v).replace(/\\s+/g,' ').trim(); } function asObj(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; } function normRole(v){ const s=asText(v).toLowerCase(); if(s==='user'||s==='assistant'||s==='system'||s==='tool') return s; if(s.includes('assistant')||s==='ai'||s.includes('bot')) return 'assistant'; if(s.includes('user')||s.includes('human')) return 'user'; if(s.includes('system')) return 'system'; return 'unknown'; } function asLimit(v){ const n=Number(v); if(!Number.isFinite(n) || n<1) return 80; return Math.floor(n); } const cfg=asObj(config); const selectors=asObj(cfg.selectors); const limit=asLimit(cfg.limit); const userSel=asText(selectors.messageUser) || \"[data-role='message'][data-message-role='user'], [data-message-author-role='user'], [data-message-author-role='human']\"; const assistantSel=asText(selectors.messageAssistant) || \"[data-role='message'][data-message-role='assistant'], [data-message-author-role='assistant']\"; const textSel=asText(selectors.messageText) || \".text,[data-role='message-text'],.message-text,[data-role='text'],.markdown,[dir='auto']\"; const map=new Map(); const take=(sel)=>{ for(const n of Array.from(document.querySelectorAll(sel))){ if(!map.has(n)) map.set(n,true); } }; take(userSel); take(assistantSel); let nodes=Array.from(map.keys()); if(!nodes.length){ nodes=Array.from(document.querySelectorAll(\"[data-role='message'], .msg, [role='listitem']\")); } const out=[]; for(let i=0;i<nodes.length;i+=1){ const n=nodes[i]; let role='unknown'; if(n.matches && n.matches(assistantSel)) role='assistant'; else if(n.matches && n.matches(userSel)) role='user'; else role=normRole(n.getAttribute('data-message-author-role') || n.getAttribute('data-message-role') || n.getAttribute('data-role') || n.className || ''); const txtNode=n.querySelector(textSel); const text=asText(txtNode ? (txtNode.innerText || txtNode.textContent || '') : (n.innerText || n.textContent || '')); if(!text) continue; const metaNode=n.querySelector('.meta,[data-role=\"message-meta\"]'); let time=''; let status=''; if(metaNode){ const spans=Array.from(metaNode.querySelectorAll('span')); if(spans[1]) time=asText(spans[1].innerText||spans[1].textContent||''); if(spans[2]) status=asText(spans[2].innerText||spans[2].textContent||''); } const idx=i; const id=asText(n.getAttribute('data-message-id')||n.getAttribute('data-testid')||n.id||'') || (role+':'+idx+':'+text.slice(0,32)); out.push({ id, role, text, time, status, index: idx }); } const sliced=out.slice(Math.max(0,out.length-limit)); return { action:'getMessages', items:sliced, cursor: sliced.length?String(sliced[sliced.length-1].id||''):'' }; }",
				args: ["${{ ({ limit: vars.wcCtx?.limit || 80, selectors: vars.wcCtx?.selectors || {} }) }}"],
			},
			saveAs: "waitProbe",
			next: { done: "wait_reply_eval", failed: "wait_reply_pause" },
		},
		{
			id: "wait_reply_eval",
			desc: "根据轮询快照判断是否完成/超时",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(state, probe){ function asObj(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; } function asText(v){ return String(v==null?'':v).trim(); } const s=asObj(state); const p=asObj(probe); const items=Array.isArray(p.items)?p.items:[]; const assist=items.filter((it)=>asText(it&&it.role).toLowerCase()==='assistant'); const baseIds=new Set(Array.isArray(s.baselineAssistantIds)?s.baselineAssistantIds.map((x)=>asText(x)).filter(Boolean):[]); const newItems=[]; for(const a of assist){ const id=asText(a&&a.id); if(!id || !baseIds.has(id)) newItems.push(a); } const latest=assist.length?assist[assist.length-1]:null; const latestText=asText(latest&&latest.text); const latestSig=latest ? (asText(latest.id)+'|'+latestText.length+'|'+latestText.slice(-24)) : ''; const changed=!!latestSig && latestSig!==asText(s.lastAssistantSig); const stableMs=changed?0:(Number(s.stableMs||0)+Number(s.pollMs||500)); const doneSignal=/(^|\\b)(done|finish|finished|complete|completed|success)(\\b|$)/i.test(asText(latest&&latest.status)); const enoughNew=newItems.length>=Number(s.minNew||1); const hasOutput=latestText.length>0; const requireDone=!!s.requireDoneSignal; const done=enoughNew && ((requireDone && doneSignal) || (!requireDone && (doneSignal || (hasOutput && stableMs>=Number(s.idleMs||1800))))); const now=Date.now(); const timeout=now>=Number(s.deadlineMs||0); let reason='waiting'; if(done) reason=doneSignal?'done_signal':'idle_settled'; else if(timeout) reason='timeout'; return { ...s, rounds: Number(s.rounds||0)+1, stableMs, lastAssistantSig: latestSig || asText(s.lastAssistantSig), latestAssistant: latest||null, newItems, done, timeout, reason, probeCursor: asText(p.cursor||''), probeCount: items.length, doneSignal, hasOutput }; }",
				args: ["${{ vars.waitState || {} }}", "${{ vars.waitProbe || {} }}"],
			},
			saveAs: "waitState",
			next: { done: "wait_reply_route", failed: "abort_failed" },
		},
		{
			id: "wait_reply_route",
			desc: "根据 wait 状态继续轮询或结束",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "waitState.done", value: true }, to: "wait_reply_build_done" },
					{ when: { op: "eq", source: "vars", path: "waitState.timeout", value: true }, to: "wait_reply_build_timeout" },
				],
				default: "wait_reply_pause",
			},
			next: {},
		},
		{
			id: "wait_reply_pause",
			desc: "轮询间隔等待",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(state){ const ms=Math.max(120, Math.min(5000, Number((state&&state.pollMs)||500))); const t=Date.now(); while(Date.now()-t<ms){} return { waitedMs: ms }; }",
				args: ["${{ vars.waitState || {} }}"],
			},
			next: { done: "wait_reply_probe", failed: "wait_reply_probe" },
		},
		{
			id: "wait_reply_build_done",
			desc: "构造 waitReply 成功输出",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(ctx, state){ function asObj(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; } function asText(v){ return String(v==null?'':v).trim(); } const c=asObj(ctx); const s=asObj(state); const session=asObj(c.session); const newItems=Array.isArray(s.newItems)?s.newItems:[]; const latest=s.latestAssistant&&typeof s.latestAssistant==='object'?s.latestAssistant:null; const items=newItems.length?newItems:(latest?[latest]:[]); const cursor=asText((latest&&latest.id)||s.probeCursor||''); return { action:'waitReply', received:true, timedOut:false, reason:asText(s.reason||'done'), session:{ kind: asText(session.kind||'ai')||'ai', title: asText(session.title) }, items, cursor, meta:{ rounds:Number(s.rounds||0), stableMs:Number(s.stableMs||0), doneSignal:!!s.doneSignal } }; }",
				args: ["${{ vars.wcCtx || {} }}", "${{ vars.waitState || {} }}"],
			},
			saveAs: "wcOut",
			next: { done: "done", failed: "abort_failed" },
		},
		{
			id: "wait_reply_build_timeout",
			desc: "构造 waitReply 超时输出（返回当前可见 assistant 内容）",
			action: {
				type: "run_js",
				scope: "agent",
				code: "function(ctx, state){ function asObj(v){ return (v&&typeof v==='object'&&!Array.isArray(v))?v:{}; } function asText(v){ return String(v==null?'':v).trim(); } const c=asObj(ctx); const s=asObj(state); const session=asObj(c.session); const newItems=Array.isArray(s.newItems)?s.newItems:[]; const latest=s.latestAssistant&&typeof s.latestAssistant==='object'?s.latestAssistant:null; const items=newItems.length?newItems:(latest?[latest]:[]); const cursor=asText((latest&&latest.id)||s.probeCursor||''); return { action:'waitReply', received: items.length>0, timedOut:true, reason:asText(s.reason||'timeout'), session:{ kind: asText(session.kind||'ai')||'ai', title: asText(session.title) }, items, cursor, meta:{ rounds:Number(s.rounds||0), stableMs:Number(s.stableMs||0), doneSignal:!!s.doneSignal, timeoutMs:Number(s.timeoutMs||0) } }; }",
				args: ["${{ vars.wcCtx || {} }}", "${{ vars.waitState || {} }}"],
			},
			saveAs: "wcOut",
			next: { done: "done", failed: "abort_failed" },
		},

		{
			id: "done",
			action: {
				type: "done",
				reason: "webchat action ok",
				conclusion: "${vars.wcOut}",
			},
			next: {},
		},
		{
			id: "abort_unsupported",
			action: {
				type: "abort",
				reason: "webchat_core currently supports only webChat.action=newSession|send|getMessages|waitReply|getSessions|enterSession|renameSession|deleteSession",
			},
			next: {},
		},
		{
			id: "abort_bad_args",
			action: {
				type: "abort",
				reason: "webchat_core invalid args",
			},
			next: {},
		},
		{
			id: "abort_failed",
			action: {
				type: "abort",
				reason: "webchat_core action failed",
			},
			next: {},
		},
	],
	vars: {
		wcCtx: { type: "object", desc: "webChat 规范化上下文", from: "init_ctx.saveAs" },
		activeTitle: { type: "string", desc: "当前会话标题", from: "read_active_title.saveAs" },
		sendCheck: { type: "object", desc: "send 参数校验结果", from: "send_validate.saveAs" },
		sendVerify: { type: "object", desc: "send 页面结果校验", from: "send_verify_user.saveAs" },
		enterResolve: { type: "object", desc: "enterSession 目标解析", from: "enter_session_resolve.saveAs" },
		enterVerify: { type: "object", desc: "enterSession 校验", from: "enter_session_verify.saveAs" },
		renameCheck: { type: "object", desc: "renameSession 参数校验", from: "rename_session_validate.saveAs" },
		renameVerify: { type: "object", desc: "renameSession 校验", from: "rename_verify.saveAs" },
		deleteVerify: { type: "object", desc: "deleteSession 校验", from: "delete_verify.saveAs" },
		rawMessagesOut: { type: "any", desc: "getMessages 原始提取结果", from: "get_messages_*.saveAs" },
		rawSessionsOut: { type: "any", desc: "getSessions 原始提取结果", from: "get_sessions_extract.saveAs" },
		waitBaseline: { type: "object", desc: "waitReply 基线快照", from: "wait_reply_baseline_probe.saveAs" },
		waitProbe: { type: "object", desc: "waitReply 轮询快照", from: "wait_reply_probe.saveAs" },
		waitState: { type: "object", desc: "waitReply 状态", from: "wait_reply_*.saveAs" },
		wcOut: { type: "object", desc: "webChat.result 输出", from: "build_out_* / get_messages_normalize.saveAs / get_sessions_normalize.saveAs / wait_reply_build_*.saveAs" },
	},
};

const webchatCoreObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default webchatCoreObject;
export { capabilities, filters, ranks, flow, webchatCoreObject };
