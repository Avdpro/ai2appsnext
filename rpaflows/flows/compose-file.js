const capabilities = {
	must: ["compose", "compose.file"],
	prefer: ["compose.action", "compose.files", "compose.field", "compose.result"],
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
	id: "compose_file",
	start: "init_ctx",
	args: {
		compose: { type: "object", required: false, desc: "compose 参数，支持 action/files/field/type/visibility" },
	},
	steps: [
		{
			id: "init_ctx",
			desc: "标准化 compose.file 参数",
			action: {
				type: "run_js",
				scope: "agent",
				code: `function(input){
					function t(v){ return String(v == null ? "" : v).trim(); }
					function normFiles(v){
						if(Array.isArray(v)) return v.map(t).filter(Boolean);
						const s = t(v);
						if(!s) return [];
						return s.split(/[\\n;,]/).map(t).filter(Boolean);
					}
					function uploadQuery(field){
						const f = t(field).toLowerCase();
						if(f === "image"){
							return "可点击的图片上传入口（发布面板中的添加图片/上传图片按钮，或 input[type=file][accept*=image]）";
						}
						if(f === "video"){
							return "可点击的视频上传入口（发布面板中的添加视频/上传视频按钮，或 input[type=file][accept*=video]）";
						}
						return "可点击的附件上传入口（发布面板中的添加附件/上传文件按钮，或 input[type=file]），避免匹配页面无关上传控件";
					}
					function basename(p){
						const s = t(p);
						if(!s) return "";
						const m = s.split(/[\\\\/]/);
						return t(m[m.length - 1] || s);
					}
					const compose = (input && input.compose) || {};
					const action = t(compose.action || "file").toLowerCase() || "file";
					const type = t(compose.type || "post").toLowerCase() || "post";
					const visibility = t(compose.visibility || "");
					const field = t(compose.field || "").toLowerCase() || "file";
					const targetQueryOverride = t(compose.targetQuery || "");
					const files = normFiles(compose.files);
					const uploadMode = t(compose.uploadMode || "chooser").toLowerCase() || "chooser";
					const confirmAfterUpload = !!compose.confirmAfterUpload;
					return {
						action,
						actionOk: action === "file",
						type,
						visibility,
						field,
						files,
						fileNames: files.map(basename).filter(Boolean),
						hasFiles: files.length > 0,
						targetQuery: targetQueryOverride || uploadQuery(field),
						uploadMode,
						confirmAfterUpload
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
					{ when: { op: "eq", source: "vars", path: "composeCtx.actionOk", value: true }, to: "route_has_files" },
				],
				default: "abort_unsupported_action",
			},
			next: {},
		},
		{
			id: "route_has_files",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "composeCtx.hasFiles", value: true }, to: "check_upload_target_ready" },
				],
				default: "abort_empty_files",
			},
			next: {},
		},
		{
			id: "check_upload_target_ready",
			desc: "检查上传入口是否可用",
			action: {
				type: "selector",
				query: "${vars.composeCtx.targetQuery}",
			},
			saveAs: "uploadTargetSel",
			next: { done: "upload_files", failed: "ensure_compose_started" },
		},
		{
			id: "ensure_compose_started",
			desc: "若未处于撰写态，先启动 compose.start",
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
			next: { done: "wait_upload_target_ready", failed: "ask_assist_upload" },
		},
		{
			id: "wait_upload_target_ready",
			desc: "等待上传入口出现",
			action: {
				type: "wait",
				query: "${vars.composeCtx.targetQuery}",
				timeoutMs: 12000,
			},
			saveAs: "uploadTargetSelWait",
			next: { done: "upload_files", failed: "ask_assist_upload", timeout: "ask_assist_upload" },
		},
		{
			id: "upload_files",
			desc: "通过 chooser 优先模式添加附件",
			action: {
				type: "uploadFile",
				query: "${vars.composeCtx.targetQuery}",
				files: "${vars.composeCtx.files}",
				uploadMode: "${vars.composeCtx.uploadMode}",
				timeoutMs: 20000,
			},
			saveAs: "uploadOut",
			next: { done: "wait_upload_settled", failed: "ask_assist_upload" },
		},
		{
			id: "wait_upload_settled",
			desc: "等待上传稳定：10 秒内若出现强失败信号则失败，否则默认成功",
			action: {
				type: "run_js",
				scope: "page",
				code: `async function(input){
					function t(v){ return String(v == null ? "" : v).trim(); }
					function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
					const timeoutMs = Number((input && input.timeoutMs) || 10000) || 10000;
					const pollMs = Number((input && input.pollMs) || 400) || 400;
					const start = Date.now();
					const deadline = start + timeoutMs;
					const failRe = /(上传失败|上传出错|重试|失败|网络错误|格式不支持|超出限制|too large|upload failed|retry|error)/i;

					function scan(){
						const bodyText = t(document && document.body ? (document.body.innerText || "") : "");
						const strongFail = failRe.test(bodyText);
						const fileInputs = Array.from(document.querySelectorAll("input[type='file']"));
						const fileInputCount = fileInputs.reduce(function(n, el){
							try { return n + ((el && el.files && el.files.length) ? 1 : 0); } catch (_) { return n; }
						}, 0);
						const previewCount = document.querySelectorAll(
							"#homeWrap ._publishCard_gykin_19 img, #homeWrap ._publishCard_gykin_19 [class*='preview'], #homeWrap ._publishCard_gykin_19 [class*='thumb']"
						).length;
						const progressCount = document.querySelectorAll(
							"#homeWrap ._publishCard_gykin_19 [role='progressbar'], #homeWrap ._publishCard_gykin_19 progress, #homeWrap ._publishCard_gykin_19 [class*='progress'], #homeWrap ._publishCard_gykin_19 [class*='loading']"
						).length;
						const strongSuccess = fileInputCount > 0 || previewCount > 0;
						return { strongFail, strongSuccess, fileInputCount, previewCount, progressCount };
					}

					let last = { strongFail: false, strongSuccess: false, fileInputCount: 0, previewCount: 0, progressCount: 0 };
					while(Date.now() < deadline){
						last = scan();
						if(last.strongFail){
							return {
								ok: false,
								status: "failed",
								reason: "strong failure signal detected",
								elapsedMs: Date.now() - start,
								signals: last
							};
						}
						if(last.strongSuccess && last.progressCount === 0){
							return {
								ok: true,
								status: "success",
								reason: "strong success signal detected",
								elapsedMs: Date.now() - start,
								signals: last
							};
						}
						await sleep(pollMs);
					}

					return {
						ok: true,
						status: "timeout_default_success",
						reason: "no strong failure within timeout; default success",
						elapsedMs: Date.now() - start,
						signals: last
					};
				}`,
				args: ["${{ ({ timeoutMs: 10000, pollMs: 400 }) }}"],
			},
			saveAs: "uploadSettled",
			next: { done: "verify_upload_best_effort", failed: "ask_assist_upload" },
		},
		{
			id: "verify_upload_best_effort",
			desc: "best-effort 检查页面是否出现文件名/附件提示",
			action: {
				type: "run_js",
				scope: "page",
				code: `function(input){
					function t(v){ return String(v == null ? "" : v).trim(); }
					const names = Array.isArray(input && input.fileNames) ? input.fileNames.map(t).filter(Boolean) : [];
					const bodyText = t(document && document.body ? (document.body.innerText || "") : "").toLowerCase();
					let matched = 0;
					const hit = [];
					for(const n of names){
						const low = n.toLowerCase();
						if(!low) continue;
						if(bodyText.includes(low)){
							matched++;
							hit.push(n);
						}
					}
					return { ok: true, names, matched, hit, total: names.length };
				}`,
				args: ["${{ ({ fileNames: vars.composeCtx.fileNames || [] }) }}"],
			},
			saveAs: "verifyOut",
			next: { done: "route_confirm_after_upload", failed: "route_confirm_after_upload" },
		},
		{
			id: "route_confirm_after_upload",
			action: {
				type: "branch",
				cases: [
					{ when: { op: "eq", source: "vars", path: "composeCtx.confirmAfterUpload", value: true }, to: "confirm_after_upload" },
				],
				default: "done",
			},
			next: {},
		},
		{
			id: "confirm_after_upload",
			desc: "上传后等待人工确认",
			action: {
				type: "ask_assist",
				reason: "请确认附件已出现在发布面板中；确认无误后点击“已处理，继续”。",
				waitUserAction: true,
				modal: false,
				mask: false,
			},
			next: { done: "done", failed: "abort" },
		},
		{
			id: "ask_assist_upload",
			desc: "自动上传失败时请用户手动添加附件",
			action: {
				type: "ask_assist",
				reason: "请在当前撰写界面手动添加附件（文件/图片/视频），完成后点击“已处理，继续”。",
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
				reason: "compose.file done",
				conclusion: "${{ ({ action:'file', id:'', field: vars.composeCtx?.field || 'file', files: vars.composeCtx?.files || [], uploadedCount: Number(vars.uploadOut?.uploadedCount || 0), modeUsed: vars.uploadOut?.modeUsed || vars.composeCtx?.uploadMode || 'chooser', by: vars.uploadOut?.by || vars.uploadTargetSel?.by || vars.uploadTargetSelWait?.by || null, settledStatus: vars.uploadSettled?.status || 'unknown', settledReason: vars.uploadSettled?.reason || '', verifyMatched: Number(vars.verifyOut?.matched || 0), verifyTotal: Number(vars.verifyOut?.total || 0) }) }}",
			},
			next: {},
		},
		{
			id: "done_after_assist",
			action: {
				type: "done",
				reason: "compose.file done by assist",
				conclusion: "${{ ({ action:'file', id:'', field: vars.composeCtx?.field || 'file', files: vars.composeCtx?.files || [], uploadedCount: 0, assisted: true }) }}",
			},
			next: {},
		},
		{
			id: "abort_unsupported_action",
			action: {
				type: "abort",
				reason: "compose_file only supports compose.action=file",
			},
			next: {},
		},
		{
			id: "abort_empty_files",
			action: {
				type: "abort",
				reason: "compose.file requires compose.files",
			},
			next: {},
		},
		{
			id: "abort",
			action: {
				type: "abort",
				reason: "compose.file failed",
			},
			next: {},
		},
	],
	vars: {
		composeCtx: { type: "object", desc: "标准化 compose.file 参数", from: "init_ctx.saveAs" },
		uploadTargetSel: { type: "object", desc: "上传入口 selector 结果", from: "check_upload_target_ready.saveAs" },
		uploadTargetSelWait: { type: "object", desc: "等待后的上传入口 selector 结果", from: "wait_upload_target_ready.saveAs" },
		composeStartOut: { type: "object", desc: "compose.start 返回结果", from: "ensure_compose_started.saveAs" },
		uploadOut: { type: "object", desc: "uploadFile 上传结果", from: "upload_files.saveAs" },
		uploadSettled: { type: "object", desc: "上传稳定性检测结果", from: "wait_upload_settled.saveAs" },
		verifyOut: { type: "object", desc: "上传后 best-effort 验证结果", from: "verify_upload_best_effort.saveAs" },
	},
};

const composeFileObject = {
	capabilities,
	filters,
	ranks,
	flow,
};

export default composeFileObject;
export { capabilities, filters, ranks, flow, composeFileObject };
