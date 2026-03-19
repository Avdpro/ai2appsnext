import CacheAPI from "./FlowRuleCache.mjs";
import pathLib from "path";
import { promises as fsp } from "fs";
import { createHash } from "crypto";
import {
	getProviderForPurpose,
	getFallbackProviderForPurpose,
	resolveModelByTier,
	callProviderText,
	normalizeSessionMessages,
} from "./AIProviderClient.mjs";

function normalizeUrlForCache(url) {
	const s = String(url || "").trim();
	if (!s) return "";
	try {
		const u = new URL(s);
		const mode = String(process.env.AI_RUN_JS_CACHE_SCOPE || "origin").trim().toLowerCase();
		if (mode === "origin_path" || mode === "origin+path" || mode === "path") {
			return `${u.origin}${u.pathname}`;
		}
		return u.origin;
	} catch (_) {
		return s;
	}
}

function envInt(name, fallback, min = 1, max = 1000000) {
	const raw = process.env[name];
	const n = Number.parseInt(String(raw ?? ""), 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}

function envFloat(name, fallback, min = 0, max = 2) {
	const raw = process.env[name];
	const n = Number.parseFloat(String(raw ?? ""));
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}

function envBool(name, fallback = false) {
	const raw = String(process.env[name] ?? "").trim().toLowerCase();
	if (!raw) return fallback;
	if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
	if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
	return fallback;
}

function normalizeAIOptions(aiOptions = null) {
	return (aiOptions && typeof aiOptions === "object") ? aiOptions : {};
}

function pickAIConfig(aiOptions = null) {
	const useAdvanced = /^(1|true|yes)$/i.test(String(process.env.AI_RUN_JS_USE_ADVANCED || ""));
	const ai = normalizeAIOptions(aiOptions);
	const provider = String(
		ai.runJsProvider
		|| ai.run_js_provider
		|| ai.provider
		|| getProviderForPurpose("run_js")
	).trim();
	const providerFallback = String(
		ai.runJsFallbackProvider
		|| ai.run_js_fallback_provider
		|| ai.fallbackProvider
		|| getFallbackProviderForPurpose("run_js")
	).trim();
	const tier = useAdvanced ? "advanced" : "balanced";
	const model = resolveModelByTier({ provider, purpose: "run_js", tier, fallback: false });
	const fallbackModel = resolveModelByTier({ provider, purpose: "run_js", tier, fallback: true });
	const temperature = envFloat("AI_TEMPERATURE_RUN_JS", 0, 0, 1);
	const htmlMaxLen = envInt("AI_HTML_MAXLEN_RUN_JS", 80000, 2000, 300000);
	const retryMax = envInt("AI_RETRY_RUN_JS", 2, 1, 5);
	const requestTimeoutMs = envInt("AI_TIMEOUT_RUN_JS_MS", 90000, 3000, 300000);
	const codeMaxChars = envInt("AI_RUN_JS_CODE_MAX_CHARS", 12000, 1000, 50000);
	const codeMaxLines = envInt("AI_RUN_JS_CODE_MAX_LINES", 260, 40, 1200);
	const repeatPatternLimit = envInt("AI_RUN_JS_REPEAT_PATTERN_LIMIT", 12, 2, 100);
	const promptVersion = envInt("AI_PROMPT_VERSION_RUN_JS", 4, 1, 999);
	const verifyEnabled = envBool("AI_RUN_JS_VERIFY_ENABLED", true);
	const verifyMaxCycles = envInt("AI_RUN_JS_VERIFY_MAX_CYCLES", 3, 1, 6);
	const verifyHtmlMaxLen = envInt("AI_RUN_JS_VERIFY_HTML_MAXLEN", 50000, 2000, 300000);
	const verifyResultMaxLen = envInt("AI_RUN_JS_VERIFY_RESULT_MAXLEN", 12000, 1000, 120000);
	const verifyModel = process.env.AI_MODEL_RUN_JS_VERIFY
		|| resolveModelByTier({ provider, purpose: "run_js_verify", tier: "quality", fallback: false })
		|| fallbackModel
		|| model;
	const verifyFallbackModel = process.env.AI_MODEL_RUN_JS_VERIFY_FALLBACK
		|| resolveModelByTier({ provider, purpose: "run_js_verify", tier: "quality", fallback: true })
		|| fallbackModel
		|| model;
	const verifyPromptVersion = envInt("AI_RUN_JS_VERIFY_PROMPT_VERSION", 1, 1, 999);
	const verifyCommentsEnabled = envBool("AI_RUN_JS_VERIFY_COMMENTS", false);
	const logCodeEnabled = envBool("AI_RUN_JS_LOG_CODE", true);
	const logCodePreviewMax = envInt("AI_RUN_JS_LOG_CODE_PREVIEW_MAX", 2200, 200, 20000);
	const logCodeSaveFile = envBool("AI_RUN_JS_LOG_CODE_SAVE_FILE", true);
	const logCodeDir = String(process.env.AI_RUN_JS_LOG_CODE_DIR || "").trim();
	return {
		provider,
		providerFallback,
		model,
		fallbackModel,
		temperature,
		htmlMaxLen,
		retryMax,
		requestTimeoutMs,
		codeMaxChars,
		codeMaxLines,
		repeatPatternLimit,
		promptVersion,
		verifyEnabled,
		verifyMaxCycles,
		verifyHtmlMaxLen,
		verifyResultMaxLen,
		verifyModel,
		verifyFallbackModel,
		verifyPromptVersion,
		verifyCommentsEnabled,
		logCodeEnabled,
		logCodePreviewMax,
		logCodeSaveFile,
		logCodeDir,
	};
}

function detectTaskProfile(query) {
	const q = String(query || "").toLowerCase();
	if (/comment|comments|评论|回复/.test(q)) return "comments";
	return "list";
}

function safeCut(text, maxLen = 80000) {
	const s = String(text || "");
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen);
}

function normalizeLLMRaw(result) {
	if (typeof result === "string") return result;
	if (result && typeof result === "object") {
		if (typeof result.output_text === "string") return result.output_text;
		if (typeof result.content === "string") return result.content;
		if (typeof result.text === "string") return result.text;
		try {
			return JSON.stringify(result);
		} catch (_) {
			return "";
		}
	}
	return "";
}

async function callBySessionLLM({ session, model, input, logger = null }) {
	if (!session || typeof session.callSegLLM !== "function") {
		return { ok: false, reason: "session.callSegLLM unavailable", model, provider: "session" };
	}
	try {
		await logger?.debug("run_js.ai.session.request", { model });
		const opts = {
			platform: "OpenAI",
			mode: model,
			maxToken: 4000,
			temperature: 0,
			topP: 1,
			fqcP: 0,
			prcP: 0,
			secret: false,
			responseFormat: "json_object",
		};
		const messages = normalizeSessionMessages(input);
		const out = await session.callSegLLM("rpaflows.runjs.fallback", opts, messages, true);
		const raw = normalizeLLMRaw(out);
		if (!String(raw || "").trim()) {
			return { ok: false, reason: "session llm empty response", model, provider: "session" };
		}
		await logger?.debug("run_js.ai.session.success", { model });
		return { ok: true, raw, model, provider: "session" };
	} catch (e) {
		await logger?.warn("run_js.ai.session.error", { model, reason: e?.message || "request failed" });
		return { ok: false, reason: e?.message || "session llm failed", model, provider: "session" };
	}
}

async function readPageHtmlForAI({ webRpa, page, logger = null, maxLen = 80000 }) {
	try {
		if (webRpa && typeof webRpa.readInnerHTML === "function") {
			const cleaned = await webRpa.readInnerHTML(page, null, { removeHidden: true });
			return safeCut(cleaned, maxLen);
		}
	} catch (e) {
		await logger?.warn("run_js.ai.cleaned_html_failed", { reason: e?.message || "readInnerHTML failed" });
	}
	try {
		return safeCut(await page.content(), maxLen);
	} catch (_) {
		return "";
	}
}

function tryParseJSON(text) {
	const s = String(text || "").trim();
	if (!s) return null;
	try {
		return JSON.parse(s);
	} catch (_) {
	}
	const m = s.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try {
		return JSON.parse(m[0]);
	} catch (_) {
		return null;
	}
}

function checkFunctionCode(code) {
	const src = String(code || "").trim();
	if (!src) return { ok: false, reason: "empty code" };
	if (/\)\s*\(\s*\)\s*;?\s*$/.test(src) || /\}\s*\(\s*\)\s*;?\s*$/.test(src)) {
		return { ok: false, reason: "top-level invocation is not allowed" };
	}
	try {
		const fn = new Function('"use strict"; return (' + src + ');')();
		if (typeof fn !== "function") return { ok: false, reason: "not a function" };
		return { ok: true };
	} catch (e) {
		return { ok: false, reason: e?.message || "cannot compile" };
	}
}

function checkFunctionQuality(code, cfg) {
	const src = String(code || "").trim();
	if (!src) return { ok: false, reason: "empty code" };
	const maxChars = cfg?.codeMaxChars || 12000;
	const maxLines = cfg?.codeMaxLines || 260;
	if (src.length > maxChars) return { ok: false, reason: `code too long: ${src.length} chars` };
	const lines = src.split(/\r?\n/);
	if (lines.length > maxLines) return { ok: false, reason: `code too long: ${lines.length} lines` };

	// Guard against pathological repeated selector/code patterns.
	const lower = src.toLowerCase();
	const repeatedSignals = [
		"gws-plugins-horizon-card__tabpanel",
		"queryselector('.gws-plugins-horizon-card__",
		"queryselector(\".gws-plugins-horizon-card__",
	];
	for (const sig of repeatedSignals) {
		const cnt = lower.split(sig).length - 1;
		if (cnt > (cfg?.repeatPatternLimit || 12)) return { ok: false, reason: `overfit repeated pattern: ${sig}` };
	}

	return { ok: true };
}

function validateCandidateCode(code, cfg) {
	const validFn = checkFunctionCode(code);
	if (!validFn.ok) return validFn;
	const quality = checkFunctionQuality(code, cfg);
	if (!quality.ok) return quality;
	return { ok: true };
}

function shortModelName(model) {
	return String(model || "unknown").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 60) || "unknown";
}

function codeDigest(code) {
	const src = String(code || "");
	return createHash("sha1").update(src).digest("hex").slice(0, 12);
}

async function showAiBusyTip({ webRpa, page, tipId, text, logger = null }) {
	try {
		if (!webRpa || !page || typeof webRpa.inPageTip !== "function") return null;
		await logger?.debug("run_js.ui.tip.show", {
			tipId: String(tipId || "__flow_ai_run_js_busy__"),
			text: String(text || "").slice(0, 120),
		});
		const ret = await webRpa.inPageTip(page, String(text || "AI 正在生成页面读取代码，请稍候…"), {
			id: String(tipId || "__flow_ai_run_js_busy__"),
			position: "top",
			stack: false,
			timeout: 0,
			opacity: 0.96,
			persistAcrossNav: true,
			persistTtlMs: 45000,
			pollMs: 400,
		});
		return (ret && typeof ret.id === "string" && ret.id.trim()) ? ret.id.trim() : String(tipId || "__flow_ai_run_js_busy__");
	} catch (e) {
		await logger?.debug("ui.tip.show_failed", { reason: e?.message || "unknown", tipId: String(tipId || "") });
		return null;
	}
}

async function dismissAiBusyTip({ webRpa, page, tipId, logger = null }) {
	try {
		if (!tipId) return;
		if (!webRpa || !page || typeof webRpa.inPageTipDismiss !== "function") return;
		await logger?.debug("run_js.ui.tip.dismiss", { tipId: String(tipId || "") });
		await webRpa.inPageTipDismiss(page, String(tipId));
	} catch (e) {
		await logger?.debug("ui.tip.dismiss_failed", { reason: e?.message || "unknown", tipId: String(tipId || "") });
	}
}

function buildRunJsTipText(cycle, totalCycles) {
	const idx = Number(cycle || 0) + 1;
	const total = Math.max(1, Number(totalCycles || 1));
	if (idx <= 1) return `AI 正在生成并校验页面读取代码（第${idx}/${total}次尝试），请稍候…`;
	return `AI 正在重新生成并校验页面读取代码（第${idx}/${total}次尝试），请稍候…`;
}

async function logCandidateCode({ cfg, logger, cycle, model, code, phase = "candidate", reason = "" }) {
	if (!cfg?.logCodeEnabled) return null;
	const src = String(code || "");
	const digest = codeDigest(src);
	const lines = src ? src.split(/\r?\n/).length : 0;
	const preview = safeCut(src, cfg.logCodePreviewMax || 2200);
	let filePath = "";
	if (cfg.logCodeSaveFile) {
		const baseDir = cfg.logCodeDir || pathLib.join(process.cwd(), "flow-logs", "run-js-candidates");
		const runSeg = String(logger?.runId || "run").replace(/[^a-zA-Z0-9_.-]+/g, "_");
		const ts = Date.now();
		const fname = `${runSeg}_c${Number(cycle || 0)}_${phase}_${shortModelName(model)}_${digest}.js`;
		filePath = pathLib.join(baseDir, fname);
		try {
			await fsp.mkdir(baseDir, { recursive: true });
			await fsp.writeFile(filePath, src, "utf8");
		} catch (_) {
			filePath = "";
		}
	}
	await logger?.info("run_js.ai.candidate_code", {
		cycle: Number(cycle || 0),
		phase,
		model: model || null,
		digest,
		chars: src.length,
		lines,
		reason: String(reason || ""),
		preview,
		file: filePath || undefined,
	});
	return { digest, filePath };
}

async function callResponses({ session = null, model, input, logger = null, temperature = 0, cfg = null }) {
	const useCfg = cfg || pickAIConfig();
	if (useCfg.provider === "openai" && !String(process.env.OPENAI_API_KEY || "").trim()) {
		return callBySessionLLM({ session, model, input, logger });
	}
	return callProviderText({
		provider: useCfg.provider,
		model,
		input,
		logger,
		temperature,
		forceJson: true,
		timeoutMs: useCfg.requestTimeoutMs,
		purpose: "run_js",
	});
}

function buildSystemPrompt(cfg, profile = "list") {
	const maxLines = cfg?.codeMaxLines || 260;
	const maxChars = cfg?.codeMaxChars || 12000;
	const commentsRules = [
		"For comment extraction task, return object: { action:'comments', items:Array, nextCursor:string|null, pageUrl?:string }.",
		"Each item should include string fields: id, author, text, summary, time, url (empty string allowed).",
		"Prioritize single-comment body text; avoid capturing whole-page text or non-comment widgets.",
		"Treat author/time/url/id as best-effort; text quality is primary.",
	];
	return [
		"You generate JavaScript for Flow action run_js.",
		"Follow Flow run_js spec strictly.",
		"Output strict JSON only: {\"code\":\"<function code>\",\"reason\":\"...\"}",
		"code MUST be exactly one JavaScript function value (function declaration/expression/arrow), NOT invoked.",
		"Do not output any wrapper/runner/eval/new Function logic.",
		"No markdown, no comments outside code string.",
		"Function must be pure read-only: no navigation, no network, no DOM mutation, no event triggering.",
		"Use only standard querySelector/querySelectorAll CSS supported by browsers.",
		"Forbidden selectors/features: :contains, :matches, jQuery-only syntax, non-standard pseudos.",
		"Prefer robust selectors and repeated-structure extraction.",
		"Must avoid global nav/header/footer/sidebar/login/help/policy links and right-rail widgets.",
		"For list extraction, MUST follow pipeline:",
		"1) detect likely main repeated list container in content area;",
		"2) enumerate repeated cards/items;",
		"3) extract url/title/summary per item;",
		"4) detect nextCursor from real pager link if present.",
		"Normalize each item with string fields; use empty string for missing values, never null.",
		"Must return plain object, never JSON string.",
		"When extraction quality is low (e.g. empty items), retry once with next-best container strategy inside function.",
		`Keep code concise: <=${maxLines} lines and <=${maxChars} characters.`,
		"Do not generate giant hardcoded filter lists; prefer compact heuristics.",
		...(profile === "comments" ? commentsRules : []),
	].join("\n");
}

function buildUserPayload({ query, scope, page, feedback = [], profile = "list" }) {
	const isComments = profile === "comments";
	const payload = {
		task: String(query || ""),
		profile,
		scope: scope === "agent" ? "agent" : "page",
		page,
		outputContract: {
			mustReturn: "exactly one function code string for Flow run_js",
			forTask: isComments
				? "{ action:'comments', items:Array, nextCursor:string|null, pageUrl?:string }"
				: "{ action:'list', items:Array, nextCursor:string|null, pageUrl?:string }",
			itemsRules: isComments
				? "prefer id/author/text/summary/time/url strings; text must be single comment body; no null"
				: "prefer url/title/summary strings; no null",
		},
		acceptanceChecklist: isComments ? [
			"result must be an object (not string)",
			"result.action === 'comments'",
			"result.items is array",
			"every item has string text (non-empty) and optional id/author/summary/time/url strings",
			"avoid sidebar/right-rail/recommend/login/help/privacy/ads blocks",
			"do not mix post header or reply-count-only rows into comments",
		] : [
			"result must be an object (not string)",
			"result.action === 'list'",
			"result.items is array",
			"every item has string url/title/summary (may be empty string)",
			"avoid sidebar/right-rail/recommend/login/help/privacy/ads blocks",
			"use absolute url when possible",
			"nextCursor must be null or a real next-page link/cursor",
		],
		forbiddenSelectorFeatures: [":contains", ":matches", "jQuery-only pseudo selectors"],
		constraints: [
			"read-only",
			"no side effects",
			"avoid nav/footer/login/help/ads",
			"use repeated structure in main content",
			"keep concise",
		],
	};
	if (feedback.length) payload.previousFailures = feedback;
	return payload;
}

function safeJson(value, maxLen = 12000) {
	try {
		return safeCut(JSON.stringify(value), maxLen);
	} catch (_) {
		return safeCut(String(value), maxLen);
	}
}

function trimFeedbackEntry(entry) {
	const e = (entry && typeof entry === "object") ? entry : {};
	const out = {};
	if ("error_type" in e) out.error_type = safeCut(String(e.error_type || ""), 60);
	if ("failed_step" in e) out.failed_step = safeCut(String(e.failed_step || ""), 80);
	if ("type" in e) out.type = safeCut(String(e.type || ""), 60);
	if ("message" in e) out.message = safeCut(String(e.message || ""), 700);
	if ("advice" in e) out.advice = safeCut(String(e.advice || ""), 700);
	if ("must_fix" in e) {
		const arr = Array.isArray(e.must_fix) ? e.must_fix : [];
		out.must_fix = arr.map((x) => safeCut(String(x || ""), 240)).filter(Boolean).slice(0, 6);
	}
	if ("issues" in e) {
		const arr = Array.isArray(e.issues) ? e.issues : [];
		out.issues = arr.map((x) => safeCut(String(x || ""), 240)).filter(Boolean).slice(0, 6);
	}
	if ("evidence" in e) {
		const arr = Array.isArray(e.evidence) ? e.evidence : [];
		out.evidence = arr.map((x) => safeCut(String(x || ""), 240)).filter(Boolean).slice(0, 6);
	}
	if ("resultPreview" in e) out.resultPreview = safeCut(String(e.resultPreview || ""), 1200);
	if ("candidate" in e) out.candidate = safeCut(String(e.candidate || ""), 120);
	return out;
}

function pushFeedbackLimited(feedback, entry, maxKeep = 3) {
	const arr = Array.isArray(feedback) ? feedback : [];
	arr.push(trimFeedbackEntry(entry));
	if (arr.length > maxKeep) {
		arr.splice(0, arr.length - maxKeep);
	}
	return arr;
}

function buildVerifySystemPrompt(profile = "list") {
	const isComments = profile === "comments";
	return [
		"You are a strict validator for browser run_js extraction output.",
		"Given task/page/result, decide if result is likely correct and usable.",
		"Output strict JSON only: {\"ok\":boolean,\"issues\":[\"...\"],\"advice\":\"...\"}.",
		"Reject when result is empty/irrelevant/noisy or violates read-only extraction goal.",
		"Validation MUST respect provided config semantics (especially target.pick/minItems/target.selector/target.query).",
		"If target.pick is present, returning a single picked item is acceptable and should not be rejected for low count.",
		...(isComments ? [
			"For comments task, prioritize correctness of comment text items.",
			"Do NOT reject only because id/time/url are missing if text items are clear and relevant.",
			"Reject when items are mostly non-comment UI text, duplicated containers, or whole-page blobs.",
		] : []),
		"Keep issues concise and actionable.",
	].join("\n");
}

function normalizeVerifyDecision(obj) {
	if (!obj || typeof obj !== "object") return { ok: false, reason: "invalid verify json" };
	if (typeof obj.ok !== "boolean") return { ok: false, reason: "verify json missing ok:boolean" };
	const issues = Array.isArray(obj.issues) ? obj.issues.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6) : [];
	const advice = String(obj.advice || "").trim().slice(0, 800);
	return { ok: true, decision: { ok: obj.ok, issues, advice } };
}

function classifyExecutionFailure(reason) {
	const s = String(reason || "").toLowerCase();
	if (!s) return { errorType: "execution_failed", failedStep: "runtime" };
	if (s.includes("not connected to webdriver bidi")) {
		return { errorType: "bidi_disconnected", failedStep: "runtime_connection" };
	}
	if (s.includes("not a valid selector") || s.includes("failed to execute 'queryselector'")) {
		return { errorType: "selector_invalid", failedStep: "selector_compile" };
	}
	if (s.includes("syntaxerror")) return { errorType: "syntax_error", failedStep: "compile" };
	return { errorType: "execution_failed", failedStep: "runtime" };
}

function summarizeExecutionResult(execResult, pageUrl = "", profile = "list") {
	const summary = {
		itemsCount: 0,
		missingFieldCounts: { url: 0, title: 0, summary: 0 },
		missingCommentFieldCounts: { id: 0, author: 0, text: 0, summary: 0, time: 0, url: 0 },
		nextCursorSameAsPage: false,
		resultShape: typeof execResult,
	};
	if (!execResult || typeof execResult !== "object") return summary;
	const items = Array.isArray(execResult.items) ? execResult.items : [];
	summary.itemsCount = items.length;
	for (const it of items.slice(0, 100)) {
		const obj = (it && typeof it === "object") ? it : {};
		if (!String(obj.url || "").trim()) summary.missingFieldCounts.url++;
		if (!String(obj.title || "").trim()) summary.missingFieldCounts.title++;
		if (!String(obj.summary || "").trim()) summary.missingFieldCounts.summary++;
		if (!String(obj.id || "").trim()) summary.missingCommentFieldCounts.id++;
		if (!String(obj.author || "").trim()) summary.missingCommentFieldCounts.author++;
		if (!String(obj.text || "").trim()) summary.missingCommentFieldCounts.text++;
		if (!String(obj.summary || "").trim()) summary.missingCommentFieldCounts.summary++;
		if (!String(obj.time || "").trim()) summary.missingCommentFieldCounts.time++;
		if (!String(obj.url || "").trim()) summary.missingCommentFieldCounts.url++;
	}
	const nextCursor = String(execResult.nextCursor || "").trim();
	const p = String(pageUrl || "").trim();
	summary.nextCursorSameAsPage = !!nextCursor && !!p && nextCursor === p;
	return summary;
}

async function executeRunJsCandidateOnPage({ page, code, taskQuery, verifyInput = null, profile = "list" }) {
	try {
		const baseCfg = (verifyInput && typeof verifyInput === "object") ? { ...verifyInput } : {};
		// Do not inject the generation prompt into config.query; it can falsely filter all items.
		if (!("query" in baseCfg)) baseCfg.query = "";
		if (!("searchQuery" in baseCfg)) baseCfg.searchQuery = "";
		if (!("profile" in baseCfg)) baseCfg.profile = profile;
		const result = await page.callFunction(code, [baseCfg], { awaitPromise: true });
		return { ok: true, result };
	} catch (e) {
		return { ok: false, reason: e?.message || "run_js execution failed", result: null };
	}
}

async function verifyRunJsCandidateByAI({ session = null, cfg, logger, taskQuery, pageInfo, execOut, verifyInput = null, profile = "list" }) {
	const verifyCfg = (verifyInput && typeof verifyInput === "object") ? verifyInput : {};
	const payload = {
		task: String(taskQuery || ""),
		profile,
		config: {
			minItems: verifyCfg.minItems ?? null,
			target: (verifyCfg.target && typeof verifyCfg.target === "object") ? verifyCfg.target : null,
			requireFields: Array.isArray(verifyCfg.requireFields) ? verifyCfg.requireFields : null,
		},
		page: {
			url: pageInfo?.url || "",
			title: pageInfo?.title || "",
			html: safeCut(pageInfo?.html || "", cfg.verifyHtmlMaxLen),
		},
		execution: {
			ok: !!execOut?.ok,
			error: execOut?.ok ? "" : String(execOut?.reason || ""),
			result: execOut?.ok ? safeJson(execOut?.result, cfg.verifyResultMaxLen) : "",
		},
	};
	const input = [
		{ role: "system", content: [{ type: "input_text", text: buildVerifySystemPrompt(profile) }] },
		{ role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] },
	];
	const first = await callResponses({
		session,
		model: cfg.verifyModel,
		input,
		logger,
		temperature: 0,
	});
	if (first.ok) {
		const parsed = tryParseJSON(first.raw);
		const norm = normalizeVerifyDecision(parsed);
		if (norm.ok) return { ok: true, model: cfg.verifyModel, decision: norm.decision };
	}
	if (cfg.verifyFallbackModel && cfg.verifyFallbackModel !== cfg.verifyModel) {
		const fb = await callResponses({
			session,
			model: cfg.verifyFallbackModel,
			input,
			logger,
			temperature: 0,
		});
		if (fb.ok) {
			const parsed = tryParseJSON(fb.raw);
			const norm = normalizeVerifyDecision(parsed);
			if (norm.ok) return { ok: true, model: cfg.verifyFallbackModel, decision: norm.decision };
		}
	}
	return { ok: false, reason: "verify model returned invalid response", model: cfg.verifyModel };
}

async function generateCodeWithModel({ session = null, model, baseInput, logger = null, cfg }) {
	const failures = [];
	const maxAttempts = cfg?.retryMax || 2;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const extra = failures.length
			? `Previous failures (do NOT repeat): ${JSON.stringify(failures).slice(0, 3500)}`
			: "";
		const input = extra
			? [...baseInput, { role: "user", content: [{ type: "input_text", text: extra }] }]
			: baseInput;
		const call = await callResponses({ session, model, input, logger, temperature: cfg?.temperature ?? 0, cfg });
		if (!call.ok) return { ok: false, reason: call.reason, model };

		const parsed = tryParseJSON(call.raw);
		if (!parsed || typeof parsed !== "object") {
			failures.push({ type: "invalid_json", message: "model output is not strict JSON object" });
			continue;
		}
		const code = parsed.code;
		const valid = validateCandidateCode(code, cfg);
		if (valid.ok) {
			return { ok: true, code: String(code), reason: parsed.reason || "", model };
		}
		failures.push({
			type: "invalid_code",
			message: valid.reason || "invalid run_js code",
			codePreview: String(code || "").slice(0, 800),
		});
	}
	const last = failures[failures.length - 1];
	return { ok: false, reason: last?.message || "invalid run_js code", model };
}

async function generateRunJsCodeByAI({ query, verifyInput = null, webRpa = null, page, session = null, scope = "page", logger = null, onProgressTip = null, aiOptions = null }) {
	const cfg = pickAIConfig(aiOptions);
	const { model, fallbackModel, providerFallback } = cfg;
	const profile = detectTaskProfile(query);
	let url = "";
	let title = "";
	try { url = await page.url(); } catch (_) {}
	try { title = await page.title(); } catch (_) {}
	const feedback = [];
	const feedbackKeep = 3;
	await logger?.info("run_js.ai.generate.begin", {
		scope,
		profile,
		verifyMaxCycles: cfg.verifyMaxCycles,
		retryMax: cfg.retryMax,
		model,
		fallbackModel,
		providerFallback,
		queryPreview: String(query || "").slice(0, 180),
	});
	for (let cycle = 0; cycle < cfg.verifyMaxCycles; cycle++) {
		const cycleNo = cycle + 1;
		const cycleStart = Date.now();
		await logger?.info("run_js.ai.cycle.begin", { cycle: cycleNo, total: cfg.verifyMaxCycles, feedbackCount: feedback.length });
		// Always use current-round page html; never carry old html through retries/cycles.
		const html = await readPageHtmlForAI({ webRpa, page, logger, maxLen: cfg.htmlMaxLen });
		if (typeof onProgressTip === "function") {
			const tipText = buildRunJsTipText(cycle, cfg.verifyMaxCycles);
			await logger?.debug("run_js.ai.cycle.tip", { cycle: cycleNo, text: String(tipText || "").slice(0, 120) });
			await onProgressTip(tipText);
		}
		const payload = buildUserPayload({
			query,
			scope,
			page: { url, title, html: safeCut(html, cfg.htmlMaxLen) },
			feedback,
			profile,
		});
		const baseInput = [
			{ role: "system", content: [{ type: "input_text", text: buildSystemPrompt(cfg, profile) }] },
			{ role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] },
		];
		const first = await generateCodeWithModel({ session, model, baseInput, logger, cfg });
		let gen = first;
		if (!gen.ok && fallbackModel && fallbackModel !== model) {
			const fb = await generateCodeWithModel({ session, model: fallbackModel, baseInput, logger, cfg });
			if (fb.ok) gen = fb;
			else return { ok: false, reason: `primary(${model}) failed: ${first.reason}; fallback(${fallbackModel}) failed: ${fb.reason}` };
		}
		if (!gen.ok && providerFallback && providerFallback !== cfg.provider) {
			const model2 = resolveModelByTier({ provider: providerFallback, purpose: "run_js", tier: "balanced", fallback: false });
			const cfg2 = { ...cfg, provider: providerFallback, model: model2 };
			const xb = await generateCodeWithModel({ session, model: model2, baseInput, logger, cfg: cfg2 });
			if (xb.ok) gen = xb;
			else return { ok: false, reason: `primary(${cfg.provider}/${model}) failed: ${first.reason}; provider-fallback(${providerFallback}/${model2}) failed: ${xb.reason}` };
		}
		if (!gen.ok) return { ok: false, reason: gen.reason || "invalid run_js code" };
		await logger?.info("run_js.ai.cycle.generated", {
			cycle: cycleNo,
			model: gen.model || null,
			codeChars: String(gen.code || "").length,
		});
		const codeLog = await logCandidateCode({
			cfg,
			logger,
			cycle: cycle + 1,
			model: gen.model || null,
			code: gen.code,
			phase: "generated",
		});
		const codeRef = codeLog?.digest ? `code#${codeLog.digest}` : "code#unknown";

		const shouldVerify = cfg.verifyEnabled && scope === "page" && (profile !== "comments" || cfg.verifyCommentsEnabled);
		await logger?.debug("run_js.ai.cycle.verify.plan", { cycle: cycleNo, shouldVerify, scope, verifyEnabled: cfg.verifyEnabled });
		if (!shouldVerify) {
			await logger?.info("run_js.ai.cycle.end", { cycle: cycleNo, decision: "accept_without_verify", elapsedMs: Date.now() - cycleStart });
			return gen;
		}
		const execOut = await executeRunJsCandidateOnPage({ page, code: gen.code, taskQuery: query, verifyInput, profile });
		if (!execOut.ok) {
			const reason = `execution failed: ${execOut.reason || "unknown"}`;
			await logger?.warn("run_js.ai.verify_exec_failed", { reason, cycle: cycle + 1, model: gen.model || null, candidate: codeRef });
			if (/not connected to webdriver bidi/i.test(String(execOut.reason || ""))) {
				await logger?.error("run_js.ai.verify_exec_fatal", {
					cycle: cycle + 1,
					reason,
					candidate: codeRef,
				});
				return { ok: false, reason: "WebDriver BiDi connection lost while verifying run_js code" };
			}
			const cls = classifyExecutionFailure(execOut.reason || reason);
			pushFeedbackLimited(feedback, {
				error_type: cls.errorType,
				failed_step: cls.failedStep,
				message: reason,
				must_fix: [
					"use standard CSS selectors only",
					"avoid unsupported pseudo selectors (:contains/:matches)",
					"function must compile and run without exceptions",
				],
				evidence: [String(execOut.reason || "").slice(0, 260)].filter(Boolean),
				candidate: codeRef,
			}, feedbackKeep);
			await logger?.info("run_js.ai.cycle.end", { cycle: cycleNo, decision: "exec_failed_retry", elapsedMs: Date.now() - cycleStart });
			continue;
		}
		const verify = await verifyRunJsCandidateByAI({
			session,
			cfg,
			logger,
			taskQuery: query,
			pageInfo: { url, title, html },
			execOut,
			verifyInput,
			profile,
		});
		if (!verify.ok) {
			const reason = verify.reason || "verify model failed";
			await logger?.warn("run_js.ai.verify_failed", { reason, cycle: cycle + 1, model: verify.model || null, candidate: codeRef });
			pushFeedbackLimited(feedback, { type: "verify_model_failed", message: reason }, feedbackKeep);
			await logger?.info("run_js.ai.cycle.end", { cycle: cycleNo, decision: "verify_model_failed_retry", elapsedMs: Date.now() - cycleStart });
			continue;
		}
		if (verify.decision.ok) {
			await logger?.info("run_js.ai.verify_pass", { cycle: cycle + 1, model: verify.model || null, candidate: codeRef });
			await logger?.info("run_js.ai.cycle.end", { cycle: cycleNo, decision: "verify_pass", elapsedMs: Date.now() - cycleStart });
			return gen;
		}
		const issues = Array.isArray(verify.decision.issues) ? verify.decision.issues : [];
		const issueText = issues.join("; ") || "result quality not acceptable";
		const execSummary = summarizeExecutionResult(execOut.result, url, profile);
		const issueBlob = issueText.toLowerCase();
		const errorType = issueBlob.includes("empty items")
			? "empty_items"
			: issueBlob.includes("nextcursor")
				? "bad_next_cursor"
				: issueBlob.includes("sidebar") || issueBlob.includes("right")
					? "wrong_region"
					: issueBlob.includes("required")
						? "field_missing"
						: "quality_rejected";
		await logger?.warn("run_js.ai.verify_rejected", { cycle: cycle + 1, issues: issueText, model: verify.model || null, candidate: codeRef });
		pushFeedbackLimited(feedback, {
			error_type: errorType,
			failed_step: "verification",
			message: issueText,
			advice: verify.decision.advice || "",
			must_fix: profile === "comments"
				? [
					"return {action:'comments', items, nextCursor, pageUrl}",
					"ensure items contain clear single-comment text strings",
					"exclude post header/reply-count-only rows/non-comment widgets",
				]
				: [
					"return {action:'list', items, nextCursor, pageUrl}",
					"ensure items contain url/title/summary string fields",
					"prioritize main repeated content area and exclude side widgets",
				],
			evidence: [
				`itemsCount=${execSummary.itemsCount}`,
				(profile === "comments"
					? `missing(id/author/text/summary/time/url)=${execSummary.missingCommentFieldCounts.id}/${execSummary.missingCommentFieldCounts.author}/${execSummary.missingCommentFieldCounts.text}/${execSummary.missingCommentFieldCounts.summary}/${execSummary.missingCommentFieldCounts.time}/${execSummary.missingCommentFieldCounts.url}`
					: `missing(url/title/summary)=${execSummary.missingFieldCounts.url}/${execSummary.missingFieldCounts.title}/${execSummary.missingFieldCounts.summary}`),
				`nextCursorSameAsPage=${execSummary.nextCursorSameAsPage}`,
			],
			resultPreview: safeJson(execOut.result, 1200),
			candidate: codeRef,
		}, feedbackKeep);
		await logger?.info("run_js.ai.cycle.end", { cycle: cycleNo, decision: "verify_rejected_retry", elapsedMs: Date.now() - cycleStart });
	}
	await logger?.warn("run_js.ai.generate.exhausted", { verifyMaxCycles: cfg.verifyMaxCycles });
	return { ok: false, reason: "run_js verification rejected all generated candidates" };
}

async function resolveRunJsCode({ cacheKey, query, verifyInput = null, webRpa = null, page, session = null, scope = "page", logger = null, aiOptions = null }) {
	const key = String(cacheKey || "").trim();
	if (!key) return { status: "failed", reason: "run_js cacheKey required" };
	const t0 = Date.now();
	await logger?.info("run_js.resolve.begin", {
		cacheKey: key,
		scope: scope === "agent" ? "agent" : "page",
		queryPreview: String(query || "").slice(0, 180),
	});
	const cfg = pickAIConfig(aiOptions);
	let pageScope = "";
	try { pageScope = normalizeUrlForCache(await page.url()); } catch (_) {}
	const profile = detectTaskProfile(query);
	const cacheQuery = JSON.stringify({
		pageScope,
		profile,
		scope: scope === "agent" ? "agent" : "page",
		model: cfg.model || "",
		fallbackModel: cfg.fallbackModel || "",
		promptVersion: cfg.promptVersion,
		temperature: cfg.temperature,
		htmlMaxLen: cfg.htmlMaxLen,
		retryMax: cfg.retryMax,
		codeMaxChars: cfg.codeMaxChars,
		codeMaxLines: cfg.codeMaxLines,
		repeatPatternLimit: cfg.repeatPatternLimit,
		verifyEnabled: cfg.verifyEnabled,
		verifyMaxCycles: cfg.verifyMaxCycles,
		verifyModel: cfg.verifyModel,
		verifyFallbackModel: cfg.verifyFallbackModel,
		verifyPromptVersion: cfg.verifyPromptVersion,
		query: String(query || ""),
	});

	let ctx = null;
	try {
		ctx = await CacheAPI.openRuleCache(null, page, { gcOnOpen: true });
	} catch (_) {
	}

	if (ctx) {
		try {
			const rr = CacheAPI.resolveRule(ctx, key);
			if (rr?.kind === "code" && rr.code && rr?.rule?.query === cacheQuery) {
				const v = validateCandidateCode(rr.code, cfg);
				if (!v.ok) {
					await logger?.warn("run_js.cache.invalid", { cacheKey: key, reason: v.reason || "invalid cached code" });
					try {
						CacheAPI.deleteRule(ctx, key, { aggressive: true });
						await CacheAPI.flushRuleCache(ctx);
					} catch (_) {
					}
				} else {
					await logger?.info("run_js.cache.hit", { cacheKey: key });
					await logger?.info("run_js.resolve.done", { cacheKey: key, fromCache: true, elapsedMs: Date.now() - t0 });
					return { status: "done", value: { code: rr.code, fromCache: true } };
				}
			}
			if (rr?.kind === "code" && rr.code && rr?.rule?.query !== cacheQuery) {
				await logger?.info("run_js.cache.stale", { cacheKey: key });
			}
			await logger?.debug("run_js.cache.miss", { cacheKey: key });
		} catch (_) {
		}
	}

	let genResult = null;
	const tipSeed = String(key || "runjs").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64) || "runjs";
	const tipId = await showAiBusyTip({
		webRpa,
		page,
		tipId: `__flow_ai_runjs_${tipSeed}__`,
		text: buildRunJsTipText(0, cfg.verifyMaxCycles),
		logger,
	});
	try {
		genResult = await generateRunJsCodeByAI({
			query,
			verifyInput,
			webRpa,
			page,
			session,
			scope,
			logger,
			aiOptions,
			onProgressTip: async (text) => {
				await showAiBusyTip({
					webRpa,
					page,
					tipId: tipId || `__flow_ai_runjs_${tipSeed}__`,
					text,
					logger,
				});
			},
		});
	} finally {
		await dismissAiBusyTip({ webRpa, page, tipId, logger });
	}
	if (!genResult.ok) {
		await logger?.warn("run_js.resolve.failed", { cacheKey: key, reason: genResult.reason || "run_js ai generate failed", elapsedMs: Date.now() - t0 });
		return { status: "failed", reason: genResult.reason || "run_js ai generate failed" };
	}

	if (ctx) {
		try {
			CacheAPI.setCode(ctx, key, genResult.code, { query: cacheQuery });
			await CacheAPI.flushRuleCache(ctx);
		} catch (_) {
		}
	}
	await logger?.info("run_js.ai.generated", { cacheKey: key, model: genResult.model || null });
	await logger?.info("run_js.resolve.done", { cacheKey: key, fromCache: false, model: genResult.model || null, elapsedMs: Date.now() - t0 });
	return { status: "done", value: { code: genResult.code, fromCache: false, model: genResult.model || null } };
}

export { resolveRunJsCode };
