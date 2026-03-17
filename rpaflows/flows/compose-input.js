const capabilities = {
	must: ["compose", "compose.input"],
	prefer: ["compose.action", "compose.field", "compose.text", "compose.blocks", "compose.to", "compose.cc", "compose.bcc", "compose.subject", "compose.fieldPolicy", "compose.result"],
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
	id: "compose_input",
	start: "init_ctx",
	args: {
		compose: { type: "object", required: false, desc: "compose 参数，支持 action/field/text/blocks/to/cc/bcc/subject/fieldPolicy/type/visibility" },
	},
	steps: [
		{
			id: "init_ctx",
			desc: "标准化 compose.input 参数并生成输入目标 query",
			action: {
				type: "run_js",
				scope: "agent",
				code: `function(input){
					function t(v){ return String(v == null ? "" : v).trim(); }
					function hostFromUrl(u){
						const s = t(u);
						if(!s) return "";
						try { return String(new URL(s).hostname || "").toLowerCase(); } catch(_) { return ""; }
					}
					function hostMatches(host, base){
						const h = t(host).toLowerCase();
						const b = t(base).toLowerCase();
						if(!h || !b) return false;
						if(h === b) return true;
						return h.endsWith("." + b);
					}
					function normalizePolicy(v){
						const s = t(v).toLowerCase();
						if(s === "fallback" || s === "assist" || s === "strict") return s;
						return "strict";
					}
					function normalizeList(v){
						if(Array.isArray(v)) return v.map(t).filter(Boolean);
						const s = t(v);
						if(!s) return [];
						return s.split(/[;,\\n]/).map(t).filter(Boolean);
					}
					function normalizeBlocks(blocks){
						if(!Array.isArray(blocks)) return "";
						const lines = [];
						for(const b of blocks){
							if(b == null) continue;
							if(typeof b === "string"){ if(t(b)) lines.push(t(b)); continue; }
							if(typeof b === "object"){
								const cands = [b.text, b.content, b.value, b.title, b.body];
								for(const c of cands){
									const s = t(c);
									if(s){ lines.push(s); break; }
								}
							}
						}
						return lines.join("\\n");
					}
					function queryByField(field){
						switch(field){
							case "to":
								return "收件人输入框（To/收件人），用于填写邮箱地址列表";
							case "cc":
								return "抄送输入框（Cc/抄送），用于填写邮箱地址列表";
							case "bcc":
								return "密送输入框（Bcc/密送），用于填写邮箱地址列表";
							case "subject":
								return "主题输入框（Subject/主题），用于输入邮件主题";
							case "title":
								return "撰写区域的标题输入框（title/headline），用于输入标题文本";
							case "subtitle":
								return "撰写区域的副标题输入框（subtitle/description），用于输入副标题文本";
							case "tag":
								return "撰写区域的标签输入框（tag/topic/hashtag），用于输入标签";
							case "content":
							default:
								return "撰写区域的正文输入区（textarea 或 contenteditable），用于输入正文内容，避免匹配搜索框";
						}
					}
					function withFallbackLabel(field, content){
						const s = t(content);
						if(!s) return "";
						if(field === "title") return "【标题】" + s + "\\n\\n---\\n";
						if(field === "subtitle") return "【副标题】" + s + "\\n\\n---\\n";
						return s;
					}
					const compose = (input && input.compose) || {};
					const host = hostFromUrl(input && input.url);
					const action = t(compose.action || "input").toLowerCase() || "input";
					const type = t(compose.type || "post").toLowerCase() || "post";
					const requestedField = t(compose.field || "content").toLowerCase() || "content";
					const fieldPolicy = normalizePolicy(compose.fieldPolicy || "strict");
					const text = t(compose.text);
					const textFromBlocks = normalizeBlocks(compose.blocks);
					const toList = normalizeList(compose.to);
					const ccList = normalizeList(compose.cc);
					const bccList = normalizeList(compose.bcc);
					const subject = t(compose.subject);
					const fallbackEligible = requestedField === "title" || requestedField === "subtitle";
					const autoFallbackHostHit = fallbackEligible && (
						hostMatches(host, "weibo.com") ||
						hostMatches(host, "x.com") ||
						hostMatches(host, "twitter.com")
					);
					const streamComposeHost = (
						hostMatches(host, "weibo.com") ||
						hostMatches(host, "x.com") ||
						hostMatches(host, "twitter.com")
					);
					let effectiveField = requestedField;
					let fallbackApplied = false;
					let fallbackReason = "";
					let fallbackAuto = false;
					if(autoFallbackHostHit){
						effectiveField = "content";
						fallbackApplied = true;
						fallbackAuto = true;
						fallbackReason = "auto-fallback-by-host";
					}
					const rawText = text || textFromBlocks;
					let finalText = rawText;
					if(!finalText){
						if(requestedField === "to") finalText = toList.join(", ");
						else if(requestedField === "cc") finalText = ccList.join(", ");
						else if(requestedField === "bcc") finalText = bccList.join(", ");
						else if(requestedField === "subject") finalText = subject;
					}
					if(fallbackApplied) finalText = withFallbackLabel(requestedField, finalText);
					const contentLikeRequested = requestedField === "content" || requestedField === "title" || requestedField === "subtitle";
					// In stream-style editors (weibo/x/twitter), compose.start already clears draft.
					// Subsequent content-like writes should append to avoid wiping previous fallback sections.
					const inputClear = !(streamComposeHost && contentLikeRequested);
					const inputMode = (streamComposeHost && contentLikeRequested) ? "type" : "paste";
					const deferWrite = !!(streamComposeHost && autoFallbackHostHit);
					const hasText = !!finalText;
					return {
						action,
						actionOk: action === "input",
						type,
						host,
						requestedField,
						effectiveField,
						field: effectiveField,
						fieldPolicy,
						fallbackEligible,
						fallbackApplied,
						fallbackAuto,
						fallbackReason,
						streamComposeHost,
						inputClear,
						inputMode,
						deferWrite,
						rawText,
						text: finalText,
						hasText,
						to: toList,
						cc: ccList,
						bcc: bccList,
						subject,
						targetQuery: queryByField(effectiveField),
						visibility: t(compose.visibility || ""),
					};
				}`,
				args: ["${{ ({ compose: args.compose || {}, url: opts.url || '' }) }}"],
			},
			saveAs: "composeCtx",
			next: { done: "route_action", failed: "abort" },
		},
		{
			id: "route_action",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "composeCtx.actionOk", value: true }, to: "route_has_text" },
				],
				default: "abort_unsupported_action",
			},
			next: {},
		},
		{
			id: "route_has_text",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "composeCtx.hasText", value: true }, to: "route_defer_write" },
				],
				default: "abort_empty_text",
			},
			next: {},
		},
		{
			id: "route_defer_write",
			desc: "流式站点 title/subtitle fallback：先暂存，等 content 步一次性写入",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "composeCtx.deferWrite", value: true }, to: "store_pending_section" },
				],
				default: "check_target_ready",
			},
			next: {},
		},
		{
			id: "store_pending_section",
			action: {
				type: "run_js",
				scope: "page",
				code: `function(input){
					const field = String(input && input.field || "").toLowerCase();
					const text = String(input && input.text || "");
					const cur = (globalThis.__rpaComposePending && typeof globalThis.__rpaComposePending === "object")
						? globalThis.__rpaComposePending
						: {};
					if (field === "title") cur.title = text;
					if (field === "subtitle") cur.subtitle = text;
					globalThis.__rpaComposePending = cur;
					return { deferred: true, pending: { title: String(cur.title || ""), subtitle: String(cur.subtitle || "") } };
				}`,
				args: ["${{ ({ field: vars.composeCtx.requestedField, text: vars.composeCtx.rawText || vars.composeCtx.text }) }}"],
			},
			saveAs: "pendingWrite",
			next: { done: "done_deferred", failed: "abort" },
		},
		{
			id: "done_deferred",
			action: {
				type: "done",
				reason: "compose.input deferred for stream fallback",
				conclusion: "${{ ({ action:'input', id:'', field: vars.composeCtx?.field || 'content', requestedField: vars.composeCtx?.requestedField || vars.composeCtx?.field || 'content', deferred:true, fallbackApplied:true, fallbackReason: vars.composeCtx?.fallbackReason || 'auto-fallback-deferred' }) }}",
			},
			next: {},
		},
		{
			id: "check_target_ready",
			desc: "检查当前页面是否已经有可输入目标",
			action: {
				type: "selector",
				query: "${vars.composeCtx.targetQuery}",
			},
			saveAs: "targetSel",
			next: { done: "prepare_input_text", failed: "ensure_compose_started" },
		},
		{
			id: "ensure_compose_started",
			desc: "若当前无可输入目标，则先启动 compose.start",
			action: {
				type: "invoke",
				target: "compose_start",
				args: {
					"compose.action": "start",
					"compose.type": "${vars.composeCtx.type}",
					"compose.visibility": "${vars.composeCtx.visibility}",
				},
				onError: "fail",
				returnTo: "caller",
			},
			saveAs: "composeStartOut",
			next: { done: "wait_target_ready", failed: "ask_assist_input" },
		},
		{
			id: "wait_target_ready",
			desc: "等待输入目标出现",
			action: {
				type: "wait",
				query: "${vars.composeCtx.targetQuery}",
				timeoutMs: 10000,
			},
			saveAs: "targetSelWait",
			next: { done: "prepare_input_text", failed: "route_missing_field", timeout: "route_missing_field" },
		},
		{
			id: "prepare_input_text",
			desc: "在流式站点 content 步合并暂存的 title/subtitle",
			action: {
				type: "run_js",
				scope: "page",
				code: `function(input){
					function t(v){ return String(v == null ? "" : v); }
					const req = String(input && input.requestedField || "").toLowerCase();
					const isStream = !!(input && input.streamComposeHost);
					const baseText = t(input && input.text);
					let outText = baseText;
					let clear = !!(input && input.inputClear);
					let merged = false;
					if (isStream && req === "content") {
						const p = (globalThis.__rpaComposePending && typeof globalThis.__rpaComposePending === "object")
							? globalThis.__rpaComposePending
							: {};
						const parts = [];
						if (p.title) parts.push("【标题】" + t(p.title) + "\\n\\n---\\n");
						if (p.subtitle) parts.push("【副标题】" + t(p.subtitle) + "\\n\\n---\\n");
						parts.push(baseText);
						outText = parts.join("");
						merged = !!(p.title || p.subtitle);
						clear = merged ? true : clear;
						globalThis.__rpaComposePending = null;
					}
					return { text: outText, clear, merged };
				}`,
				args: ["${{ ({ requestedField: vars.composeCtx.requestedField, streamComposeHost: vars.composeCtx.streamComposeHost, text: vars.composeCtx.text, inputClear: vars.composeCtx.inputClear }) }}"],
			},
			saveAs: "preparedInput",
			next: { done: "input_text", failed: "ask_assist_input" },
		},
		{
			id: "route_missing_field",
			desc: "目标字段不存在时，按 fieldPolicy 处理",
			action: {
				type: "branch",
				cases: [
					{
						when: {
							op: "and",
							items: [
								{ op: "eq", source: "vars", path: "composeCtx.fieldPolicy", value: "fallback" },
								{ op: "eq", source: "vars", path: "composeCtx.fallbackEligible", value: true },
								{ op: "neq", source: "vars", path: "composeCtx.effectiveField", value: "content" },
							],
						},
						to: "build_fallback_ctx",
					},
					{ when: { op: "eq", source: "vars", path: "composeCtx.fieldPolicy", value: "assist" }, to: "ask_assist_input" },
				],
				default: "abort_missing_field",
			},
			next: {},
		},
		{
			id: "build_fallback_ctx",
			desc: "构造字段降级（title/subtitle -> content）上下文",
			action: {
				type: "run_js",
				scope: "agent",
				code: `function(ctx){
					function t(v){ return String(v == null ? "" : v).trim(); }
					function queryByField(field){
						if(field === "content"){
							return "撰写区域的正文输入区（textarea 或 contenteditable），用于输入正文内容，避免匹配搜索框";
						}
						return t(ctx && ctx.targetQuery);
					}
					function withFallbackLabel(field, content){
						const s = t(content);
						if(!s) return "";
						if(field === "title") return "【标题】" + s + "\\n\\n---\\n";
						if(field === "subtitle") return "【副标题】" + s + "\\n\\n---\\n";
						return s;
					}
					const c = (ctx && typeof ctx === "object") ? ctx : {};
					const req = t(c.requestedField || c.field || "content").toLowerCase();
					return {
						...c,
						effectiveField: "content",
						field: "content",
						fallbackApplied: true,
						fallbackReason: "policy-fallback-to-content",
						targetQuery: queryByField("content"),
						text: withFallbackLabel(req, c.text),
						hasText: !!withFallbackLabel(req, c.text),
					};
				}`,
				args: ["${vars.composeCtx}"],
			},
			saveAs: "composeCtxFallback",
			next: { done: "wait_fallback_target", failed: "abort_missing_field" },
		},
		{
			id: "wait_fallback_target",
			desc: "等待 fallback 后的 content 输入目标出现",
			action: {
				type: "wait",
				query: "${vars.composeCtxFallback.targetQuery}",
				timeoutMs: 10000,
			},
			saveAs: "targetSelFallback",
			next: { done: "input_text_fallback", failed: "ask_assist_input", timeout: "ask_assist_input" },
		},
		{
			id: "input_text",
			desc: "写入 compose 文本",
			action: {
				type: "input",
				query: "${vars.composeCtx.targetQuery}",
				text: "${vars.preparedInput.text}",
				mode: "${vars.composeCtx.inputMode}",
				clear: "${vars.preparedInput.clear}",
			},
			next: { done: "done", failed: "ask_assist_input" },
		},
		{
			id: "input_text_fallback",
			desc: "按 fallback 策略写入 compose 文本",
			action: {
				type: "input",
				query: "${vars.composeCtxFallback.targetQuery}",
				text: "${vars.composeCtxFallback.text}",
				mode: "${vars.composeCtxFallback.inputMode}",
				clear: "${vars.composeCtxFallback.inputClear}",
			},
			next: { done: "done", failed: "ask_assist_input" },
		},
		{
			id: "ask_assist_input",
			desc: "自动输入失败时请求用户手动输入",
			action: {
				type: "ask_assist",
				reason: "请在当前撰写编辑器中手动输入内容，完成后点击“已处理，继续”。",
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
				reason: "compose.input done",
				conclusion: "${{ ({ action:'input', id:'', field: (vars.composeCtxFallback?.field || vars.composeCtx?.field || 'content'), requestedField: vars.composeCtx?.requestedField || vars.composeCtx?.field || 'content', fieldPolicy: vars.composeCtx?.fieldPolicy || 'strict', fallbackApplied: !!(vars.composeCtxFallback || vars.composeCtx?.fallbackApplied), fallbackReason: vars.composeCtxFallback?.fallbackReason || vars.composeCtx?.fallbackReason || '', chars: String((vars.composeCtxFallback?.text || vars.preparedInput?.text || vars.composeCtx?.text || '')).length, by: vars.targetSel?.by || vars.targetSelWait?.by || vars.targetSelFallback?.by || null }) }}",
			},
			next: {},
		},
		{
			id: "done_after_assist",
			action: {
				type: "done",
				reason: "compose.input done by assist",
				conclusion: "${{ ({ action:'input', id:'', field: (vars.composeCtxFallback?.field || vars.composeCtx?.field || 'content'), requestedField: vars.composeCtx?.requestedField || vars.composeCtx?.field || 'content', fieldPolicy: vars.composeCtx?.fieldPolicy || 'strict', fallbackApplied: !!(vars.composeCtxFallback || vars.composeCtx?.fallbackApplied), fallbackReason: vars.composeCtxFallback?.fallbackReason || vars.composeCtx?.fallbackReason || '', chars: String((vars.composeCtxFallback?.text || vars.preparedInput?.text || vars.composeCtx?.text || '')).length, by: vars.targetSel?.by || vars.targetSelWait?.by || vars.targetSelFallback?.by || null, assisted: true }) }}",
			},
			next: {},
		},
		{
			id: "abort_unsupported_action",
			action: { type: "abort", reason: "compose_input only supports compose.action=input" },
			next: {},
		},
		{
			id: "abort_empty_text",
			action: { type: "abort", reason: "compose.input requires compose.text or compose.blocks" },
			next: {},
		},
		{
			id: "abort_missing_field",
			action: { type: "abort", reason: "compose.input target field not available on current site (requested=${vars.composeCtx.requestedField}, policy=${vars.composeCtx.fieldPolicy})" },
			next: {},
		},
		{
			id: "abort",
			action: { type: "abort", reason: "compose.input failed" },
			next: {},
		},
	],
	vars: {
		composeCtx: { type: "object", desc: "标准化 compose.input 参数", from: "init_ctx.saveAs" },
		composeCtxFallback: { type: "object", desc: "fallback 后的 compose 输入上下文", from: "build_fallback_ctx.saveAs" },
		pendingWrite: { type: "object", desc: "title/subtitle fallback 暂存结果", from: "store_pending_section.saveAs" },
		preparedInput: { type: "object", desc: "实际用于本次输入的文本/clear 参数", from: "prepare_input_text.saveAs" },
		targetSel: { type: "object", desc: "输入目标 selector", from: "check_target_ready.saveAs" },
		targetSelWait: { type: "object", desc: "wait_target_ready 命中的输入目标", from: "wait_target_ready.saveAs" },
		targetSelFallback: { type: "object", desc: "wait_fallback_target 命中的输入目标", from: "wait_fallback_target.saveAs" },
		composeStartOut: { type: "object", desc: "compose.start 结果", from: "ensure_compose_started.saveAs" },
	},
};

const composeInputObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default composeInputObject;
export { capabilities, filters, ranks, flow, composeInputObject };
