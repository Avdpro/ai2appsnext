import { createHash } from "node:crypto";
import CacheAPI from "./FlowRuleCache.mjs";
import {
	getProviderForPurpose,
	getFallbackProviderForPurpose,
	resolveModelByTier,
	callProviderText,
	normalizeSessionMessages,
} from "./AIProviderClient.mjs";

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

function pickAIConfig() {
	const providerSelector = getProviderForPurpose("selector");
	const providerRunAI = getProviderForPurpose("run_ai");
	const providerFallbackSelector = getFallbackProviderForPurpose("selector");
	const providerFallbackRunAI = getFallbackProviderForPurpose("run_ai");
	const temperatureSelector = envFloat("AI_TEMPERATURE_SELECTOR", 0, 0, 1);
	const temperatureRunAI = envFloat("AI_TEMPERATURE_RUN_AI", 0, 0, 1);
	const retrySelector = envInt("AI_RETRY_SELECTOR", 2, 1, 5);
	const retryRunAI = envInt("AI_RETRY_RUN_AI", 2, 1, 5);
	const maxSelectors = envInt("AI_MAX_SELECTORS", 5, 1, 12);
	const selectorHtmlMaxLen = envInt("AI_HTML_MAXLEN_SELECTOR", 120000, 2000, 300000);
	const runAIHtmlMaxLen = envInt("AI_HTML_MAXLEN_RUN_AI", 120000, 2000, 300000);
	const jsonRepairEnabled = envBool("AI_JSON_REPAIR_ENABLED", true);
	const jsonRepairProvider = String(process.env.AI_JSON_REPAIR_PROVIDER || "").trim();
	const jsonRepairModel = String(process.env.AI_JSON_REPAIR_MODEL || "").trim();
	const jsonRepairTimeoutMs = envInt("AI_JSON_REPAIR_TIMEOUT_MS", 15000, 1000, 120000);
	const jsonRepairMaxInputChars = envInt("AI_JSON_REPAIR_MAX_INPUT_CHARS", 16000, 1000, 80000);
	return {
		providerSelector,
		providerRunAI,
		providerFallbackSelector,
		providerFallbackRunAI,
		temperatureSelector,
		temperatureRunAI,
		retrySelector,
		retryRunAI,
		maxSelectors,
		selectorHtmlMaxLen,
		runAIHtmlMaxLen,
		jsonRepairEnabled,
		jsonRepairProvider,
		jsonRepairModel,
		jsonRepairTimeoutMs,
		jsonRepairMaxInputChars,
	};
}

function normalizeAIOptions(aiOptions = null) {
	return (aiOptions && typeof aiOptions === "object") ? aiOptions : {};
}

function pickPurposeProvider({ cfg, purpose = "run_ai", aiOptions = null, action = null }) {
	const ai = normalizeAIOptions(aiOptions);
	if (purpose === "run_ai") {
		return String(
			action?.provider
			|| ai.runAiProvider
			|| ai.run_ai_provider
			|| ai.provider
			|| cfg.providerRunAI
			|| ""
		).trim() || cfg.providerRunAI;
	}
	return String(
		action?.provider
		|| ai.selectorProvider
		|| ai.selector_provider
		|| ai.provider
		|| cfg.providerSelector
		|| ""
	).trim() || cfg.providerSelector;
}

function pickPurposeFallbackProvider({ cfg, purpose = "run_ai", aiOptions = null, action = null }) {
	const ai = normalizeAIOptions(aiOptions);
	if (purpose === "run_ai") {
		return String(
			action?.providerFallback
			|| ai.runAiFallbackProvider
			|| ai.run_ai_fallback_provider
			|| ai.fallbackProvider
			|| cfg.providerFallbackRunAI
			|| ""
		).trim();
	}
	return String(
		action?.providerFallback
		|| ai.selectorFallbackProvider
		|| ai.selector_fallback_provider
		|| ai.fallbackProvider
		|| cfg.providerFallbackSelector
		|| ""
	).trim();
}

function safeCut(text, maxLen = 120000) {
	const s = String(text || "");
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen);
}

async function readPageHtmlForAI({ webRpa, page, logger = null, maxLen = 120000 }) {
	try {
		if (webRpa && typeof webRpa.readInnerHTML === "function") {
			const cleaned = await webRpa.readInnerHTML(page, null, { removeHidden: true });
			return safeCut(cleaned, maxLen);
		}
	} catch (e) {
		await logger?.warn("ai.page.cleaned_html_failed", { reason: e?.message || "readInnerHTML failed" });
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
	const obj = s.match(/\{[\s\S]*\}/);
	if (obj) {
		try {
			return JSON.parse(obj[0]);
		} catch (_) {
		}
	}
	const arr = s.match(/\[[\s\S]*\]/);
	if (arr) {
		try {
			return JSON.parse(arr[0]);
		} catch (_) {
		}
	}
	return null;
}

function tryParseJSONObjectLenient(text) {
	const s = String(text || "").trim();
	if (!s) return null;
	const direct = tryParseJSON(s);
	if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;

	const repairUnescapedQuotes = (src) => {
		const input = String(src || "");
		if (!input) return "";
		let out = "";
		let inString = false;
		let escaped = false;
		for (let i = 0; i < input.length; i++) {
			const ch = input[i];
			if (!inString) {
				if (ch === "\"") inString = true;
				out += ch;
				continue;
			}
			if (escaped) {
				out += ch;
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				out += ch;
				escaped = true;
				continue;
			}
			if (ch === "\"") {
				let j = i + 1;
				while (j < input.length && /\s/.test(input[j])) j++;
				const next = j < input.length ? input[j] : "";
				const closes = (next === "" || next === "," || next === "}" || next === "]" || next === ":");
				if (closes) {
					out += ch;
					inString = false;
				} else {
					out += "\\\"";
				}
				continue;
			}
			out += ch;
		}
		return out;
	};

	const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fence && fence[1]) {
		const fromFence = tryParseJSON(fence[1]);
		if (fromFence && typeof fromFence === "object" && !Array.isArray(fromFence)) return fromFence;
		const repairedFence = repairUnescapedQuotes(fence[1]);
		const fromRepairedFence = tryParseJSON(repairedFence);
		if (fromRepairedFence && typeof fromRepairedFence === "object" && !Array.isArray(fromRepairedFence)) return fromRepairedFence;
	}

	if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
		try {
			const unwrapped = JSON.parse(s);
			const fromQuoted = tryParseJSON(unwrapped);
			if (fromQuoted && typeof fromQuoted === "object" && !Array.isArray(fromQuoted)) return fromQuoted;
		} catch (_) {
		}
	}

	const start = s.indexOf("{");
	const end = s.lastIndexOf("}");
	if (start >= 0 && end > start) {
		const slice = s.slice(start, end + 1);
		const fromSlice = tryParseJSON(slice);
		if (fromSlice && typeof fromSlice === "object" && !Array.isArray(fromSlice)) return fromSlice;
		const repairedSlice = repairUnescapedQuotes(slice);
		const fromRepairedSlice = tryParseJSON(repairedSlice);
		if (fromRepairedSlice && typeof fromRepairedSlice === "object" && !Array.isArray(fromRepairedSlice)) return fromRepairedSlice;
	}
	const repaired = repairUnescapedQuotes(s);
	const fromRepaired = tryParseJSON(repaired);
	if (fromRepaired && typeof fromRepaired === "object" && !Array.isArray(fromRepaired)) return fromRepaired;
	return null;
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
		await logger?.debug("ai.session.request", { model });
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
		const out = await session.callSegLLM("rpaflows.ai.fallback", opts, messages, true);
		const raw = normalizeLLMRaw(out);
		if (!String(raw || "").trim()) {
			return { ok: false, reason: "session llm empty response", model, provider: "session" };
		}
		await logger?.debug("ai.session.success", { model });
		return { ok: true, model, raw, provider: "session" };
	} catch (e) {
		await logger?.warn("ai.session.request_error", { model, reason: e?.message || "request failed" });
		return { ok: false, reason: e?.message || "session llm failed", model, provider: "session" };
	}
}

async function callResponsesAPI({ session = null, model, input, logger = null, temperature = 0, purpose = "run_ai", providerOverride = "", timeoutMsOverride = 0, omitTemperature = false, forceJson = false }) {
	const cfg = pickAIConfig();
	const provider = providerOverride || (purpose === "selector" ? cfg.providerSelector : cfg.providerRunAI);
	if (provider === "openai" && !String(process.env.OPENAI_API_KEY || "").trim()) {
		return callBySessionLLM({ session, model, input, logger });
	}
	return callProviderText({
		provider,
		model,
		input,
		logger,
		temperature,
		omitTemperature,
		forceJson,
		timeoutMs: Number(timeoutMsOverride || 0) > 0 ? Number(timeoutMsOverride) : envInt("AI_TIMEOUT_MS", 90000, 3000, 300000),
		purpose,
	});
}

function mapRunAIModel(tier) {
	const cfg = pickAIConfig();
	const k = String(tier || "balanced").toLowerCase();
	return resolveModelByTier({ provider: cfg.providerRunAI, purpose: "run_ai", tier: k, fallback: false });
}

function shortHash(text) {
	try {
		return createHash("sha1").update(String(text || "")).digest("hex").slice(0, 16);
	} catch (_) {
		return String(text || "").slice(0, 16);
	}
}

function normalizeUrlForCache(pageUrl) {
	const s = String(pageUrl || "").trim();
	if (!s) return "";
	try {
		const u = new URL(s);
		return `${u.origin}${u.pathname}`;
	} catch (_) {
		return s;
	}
}

function buildRunAICacheQuery({ provider, tier, model, prompt, inputValue, schema, pageUrl }) {
	const raw = JSON.stringify({
		v: 2,
		provider: String(provider || ""),
		tier: String(tier || ""),
		model: String(model || ""),
		prompt: String(prompt || ""),
		input: inputValue === undefined ? null : inputValue,
		schema: schema || null,
		url: normalizeUrlForCache(pageUrl),
	});
	return `run_ai:${shortHash(raw)}`;
}

function buildRunAISystemPrompt() {
	return [
		"你是 RPA Flow 的 run_ai 执行模型。",
		"你必须且只能输出 JSON envelope。",
		"成功: {\"status\":\"ok\",\"result\":...}",
		"失败: {\"status\":\"error\",\"reason\":\"...\"}",
		"不得输出其它顶层字段，不得输出 markdown。",
		"只能依据提供的 prompt/input/page/schema 作答，不得编造。",
		"若信息不足或无法满足 schema，输出 status=error。",
	].join("\n");
}

function normalizeEnvelope(obj) {
	if (!obj || typeof obj !== "object") {
		return { ok: false, reason: "run_ai invalid envelope (not object)" };
	}
	// Compatibility mode: if model returns bare JSON object (no status),
	// treat it as a successful result payload.
	if (!Object.prototype.hasOwnProperty.call(obj, "status")) {
		return { ok: true, envelope: { status: "ok", result: obj } };
	}
	const status = String(obj.status || "").toLowerCase();
	if (status === "ok") {
		if (!("result" in obj)) return { ok: false, reason: "run_ai invalid envelope (missing result)" };
		return { ok: true, envelope: { status: "ok", result: obj.result } };
	}
	if (status === "error") {
		return { ok: true, envelope: { status: "error", reason: String(obj.reason || "run_ai failed") } };
	}
	return { ok: false, reason: "run_ai invalid envelope (status must be ok/error)" };
}

async function repairRunAIEnvelopeRaw({ session = null, raw = "", logger = null, cfg, provider = "", purpose = "run_ai" }) {
	if (!cfg?.jsonRepairEnabled) {
		return { ok: false, reason: "json repair disabled" };
	}
	const badRaw = String(raw || "").trim();
	if (!badRaw) {
		return { ok: false, reason: "empty raw for json repair" };
	}
	const repairProvider = String(cfg.jsonRepairProvider || provider || cfg.providerRunAI || "").trim() || "openai";
	const repairModel = String(cfg.jsonRepairModel || "").trim()
		|| resolveModelByTier({ provider: repairProvider, purpose: "json_repair", tier: "fast", fallback: false })
		|| resolveModelByTier({ provider: repairProvider, purpose: "run_ai", tier: "fast", fallback: false });
	const prompt = [
		"你是 JSON 修复器。",
		"输入是一段模型原始输出，可能接近 JSON 但不合法。",
		"你必须输出且只能输出一个合法 JSON 对象（UTF-8）。",
		"目标结构必须是 run_ai envelope：",
		"- 成功: {\"status\":\"ok\",\"result\":...}",
		"- 失败: {\"status\":\"error\",\"reason\":\"...\"}",
		"禁止输出 markdown、解释、代码块。",
		"若无法可靠修复，请输出 {\"status\":\"error\",\"reason\":\"json repair failed\"}。",
	].join("\n");
	const payload = {
		raw: safeCut(badRaw, cfg.jsonRepairMaxInputChars || 16000),
	};
	await logger?.debug("run_ai.repair.start", { repairProvider, repairModel, purpose });
	const ret = await callResponsesAPI({
		session,
		model: repairModel,
		input: [
			{ role: "system", content: [{ type: "input_text", text: prompt }] },
			{ role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] },
		],
		logger,
		temperature: 0,
		omitTemperature: true,
		forceJson: true,
		purpose,
		providerOverride: repairProvider,
		timeoutMsOverride: cfg.jsonRepairTimeoutMs || 15000,
	});
	if (!ret.ok) {
		await logger?.warn("run_ai.repair.failed", { reason: ret.reason || "repair request failed", repairProvider, repairModel });
		return { ok: false, reason: ret.reason || "repair request failed" };
	}
	const parsed = tryParseJSONObjectLenient(ret.raw);
	const normalized = normalizeEnvelope(parsed);
	if (!normalized.ok) {
		await logger?.warn("run_ai.repair.failed", { reason: normalized.reason, repairProvider, repairModel });
		return { ok: false, reason: normalized.reason || "repair parse failed" };
	}
	await logger?.info("run_ai.repair.success", { repairProvider, repairModel });
	return {
		ok: true,
		envelope: normalized.envelope,
		model: ret.model || repairModel,
		provider: ret.provider || repairProvider,
		raw: ret.raw,
	};
}

async function showAiBusyTip({ webRpa, page, tipId, text, logger = null }) {
	try {
		if (!webRpa || !page || typeof webRpa.inPageTip !== "function") return null;
		const ret = await webRpa.inPageTip(page, String(text || "AI 正在处理，请稍候…"), {
			id: String(tipId || "__flow_ai_run_ai_busy__"),
			position: "top",
			stack: false,
			timeout: 0,
			opacity: 0.96,
			persistAcrossNav: true,
			persistTtlMs: 45000,
			pollMs: 400,
		});
		return (ret && typeof ret.id === "string" && ret.id.trim()) ? ret.id.trim() : String(tipId || "__flow_ai_run_ai_busy__");
	} catch (e) {
		await logger?.debug("ui.tip.show_failed", { reason: e?.message || "unknown", tipId: String(tipId || "") });
		return null;
	}
}

async function dismissAiBusyTip({ webRpa, page, tipId, logger = null }) {
	try {
		if (!tipId) return;
		if (!webRpa || !page || typeof webRpa.inPageTipDismiss !== "function") return;
		await webRpa.inPageTipDismiss(page, String(tipId));
	} catch (e) {
		await logger?.debug("ui.tip.dismiss_failed", { reason: e?.message || "unknown", tipId: String(tipId || "") });
	}
}

function buildRunAITipText(attempt, totalAttempts) {
	const idx = Number(attempt || 0) + 1;
	const total = Math.max(1, Number(totalAttempts || 1));
	if (idx <= 1) return `AI 正在执行分析（第${idx}/${total}次尝试），请稍候…`;
	return `AI 正在重试分析（第${idx}/${total}次尝试），请稍候…`;
}

async function resolveRunAIEnvelopeWithModel({ session = null, provider = "", model, input, logger = null, cfg, onAttempt = null, timeoutMsOverride = 0 }) {
	const failures = [];
	const maxAttempts = cfg?.retryRunAI || 2;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (typeof onAttempt === "function") {
			await onAttempt(attempt, maxAttempts);
		}
		const retryHint = failures.length
			? `Previous failures (fix and retry): ${JSON.stringify(failures).slice(0, 3500)}`
			: "";
		const useInput = retryHint
			? [...input, { role: "user", content: [{ type: "input_text", text: retryHint }] }]
			: input;
		const r = await callResponsesAPI({
			session,
			model,
			input: useInput,
			logger,
			temperature: cfg?.temperatureRunAI ?? 0,
			forceJson: true,
			purpose: "run_ai",
			providerOverride: provider,
			timeoutMsOverride,
		});
		if (!r.ok) return { ok: false, reason: r.reason, model, provider: provider || cfg?.providerRunAI || "" };
		const parsed = tryParseJSONObjectLenient(r.raw);
		const normalized = normalizeEnvelope(parsed);
		if (normalized.ok) {
			return { ok: true, model: r.model || model, provider: r.provider || provider || cfg?.providerRunAI || "", envelope: normalized.envelope, raw: r.raw, attempt: attempt + 1 };
		}
		await logger?.warn("run_ai.repair.triggered", {
			model: r.model || model,
			provider: r.provider || provider || cfg?.providerRunAI || "",
			attempt: attempt + 1,
			reason: normalized.reason,
			rawLen: String(r.raw || "").length,
			rawPreview: String(r.raw || "").slice(0, 360),
			rawTail: String(r.raw || "").slice(-360),
		});
		const repaired = await repairRunAIEnvelopeRaw({
			session,
			raw: r.raw,
			logger,
			cfg,
			provider: r.provider || provider || cfg?.providerRunAI || "",
			purpose: "run_ai",
		});
		if (repaired.ok) {
			return { ok: true, model: repaired.model || r.model || model, provider: repaired.provider || r.provider || provider || cfg?.providerRunAI || "", envelope: repaired.envelope, raw: repaired.raw || r.raw, attempt: attempt + 1 };
		}
		failures.push({
			type: "invalid_envelope",
			reason: normalized.reason,
			// Never feed model raw output back; it may echo long page content.
			// Keep retry hint compact and non-page-bearing.
		});
		await logger?.warn("run_ai.invalid_envelope", { model, attempt: attempt + 1, reason: normalized.reason });
	}
	const last = failures[failures.length - 1];
	return { ok: false, reason: last?.reason || "run_ai invalid envelope", model, provider: provider || cfg?.providerRunAI || "" };
}

async function collectRunAIPageData({ actionPage, webRpa, page, logger = null }) {
	const cfg = pickAIConfig();
	if (!actionPage || typeof actionPage !== "object") return null;
	const out = {};
	if (actionPage.url) {
		try { out.url = await page.url(); } catch (_) {}
	}
	if (actionPage.title) {
		try { out.title = await page.title(); } catch (_) {}
	}
	if (actionPage.html) {
		out.html = await readPageHtmlForAI({ webRpa, page, logger, maxLen: cfg.runAIHtmlMaxLen });
	}
	if (actionPage.screenshot) {
		try {
			const data = await page.screenshot({ encoding: "base64", type: "jpeg", fullPage: false, quality: 0.6 });
			out.screenshot = `data:image/jpeg;base64,${data}`;
		} catch (e) {
			await logger?.warn("run_ai.page.screenshot_failed", { reason: e?.message || "screenshot failed" });
		}
	}
	if (actionPage.article) {
		try { out.article = await webRpa.readArticle(page, null, { removeHidden: false }); } catch (_) {}
	}
	await logger?.debug("run_ai.page.collected", {
		hasUrl: typeof out.url === "string" && out.url.length > 0,
		titleLen: typeof out.title === "string" ? out.title.length : 0,
		htmlLen: typeof out.html === "string" ? out.html.length : 0,
		articleLen: typeof out.article === "string" ? out.article.length : 0,
		hasScreenshot: typeof out.screenshot === "string" && out.screenshot.length > 0,
	});
	return out;
}

async function runAIAction({ action, inputValue, webRpa, page, session = null, logger = null, aiOptions = null }) {
	const cfg = pickAIConfig();
	const tier = String(action?.model || "balanced").toLowerCase();
	const primaryProvider = pickPurposeProvider({ cfg, purpose: "run_ai", aiOptions, action });
	const chosenModel = resolveModelByTier({ provider: primaryProvider, purpose: "run_ai", tier, fallback: false });
	const fallbackModel = resolveModelByTier({ provider: primaryProvider, purpose: "run_ai", tier, fallback: true });
	const fallbackProvider = pickPurposeFallbackProvider({ cfg, purpose: "run_ai", aiOptions, action });
	const cacheEnabled = !!(action?.cache === true || (action?.cache && action.cache.enabled !== false));
	const cacheKey = cacheEnabled
		? String(action?.cache?.key || `run_ai_${shortHash(`${tier}|${String(action?.prompt || "")}`)}`).trim()
		: "";
	const payload = {
		prompt: String(action?.prompt || ""),
	};
	if (inputValue !== undefined) payload.input = inputValue;
	if (action?.schema && typeof action.schema === "object") payload.schema = action.schema;
	const pageData = await collectRunAIPageData({ actionPage: action?.page, webRpa, page, logger });
	if (pageData) payload.page = pageData;
	if (action?.model) payload.model = String(action.model);

	let pageUrl = "";
	try { pageUrl = await page.url(); } catch (_) {}
	const cacheQuery = cacheEnabled
		? buildRunAICacheQuery({
			provider: primaryProvider,
			tier,
			model: chosenModel,
			prompt: payload.prompt,
			inputValue,
			schema: action?.schema || null,
			pageUrl,
		})
		: "";
	let cacheCtx = null;
	if (cacheEnabled && cacheKey) {
		try {
			cacheCtx = await CacheAPI.openRuleCache(null, page, { gcOnOpen: true });
			const rr = CacheAPI.resolveRule(cacheCtx, cacheKey);
			const valid = rr?.kind === "value" && rr?.rule?.query === cacheQuery && rr?.value && typeof rr.value === "object";
			if (valid && rr.value.envelope && (rr.value.envelope.status === "ok" || rr.value.envelope.status === "error")) {
				await logger?.info("run_ai.cache.hit", { key: cacheKey, model: rr.value.model || null });
				return {
					ok: true,
					model: rr.value.model || chosenModel,
					envelope: rr.value.envelope,
					raw: rr.value.raw || "",
					cached: true,
				};
			}
			await logger?.debug("run_ai.cache.miss", { key: cacheKey });
		} catch (e) {
			await logger?.warn("run_ai.cache.read_failed", { reason: e?.message || "cache read failed" });
		}
	}

	const input = [
		{ role: "system", content: [{ type: "input_text", text: buildRunAISystemPrompt() }] },
		{ role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] },
	];
	const timeoutMsOverride = Number(action?.timeoutMs || 0) > 0 ? Number(action.timeoutMs) : 0;
	const tipSeed = String(action?.cache?.key || action?.prompt || "run_ai").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64) || "run_ai";
	const tipId = await showAiBusyTip({
		webRpa,
		page,
		tipId: `__flow_ai_runai_${tipSeed}__`,
		text: buildRunAITipText(0, cfg.retryRunAI || 2),
		logger,
	});
	let first;
	try {
		first = await resolveRunAIEnvelopeWithModel({
			session,
			provider: primaryProvider,
			model: chosenModel,
			input,
			logger,
			cfg,
			timeoutMsOverride,
			onAttempt: async (attempt, total) => {
				await showAiBusyTip({
					webRpa,
					page,
					tipId: tipId || `__flow_ai_runai_${tipSeed}__`,
					text: buildRunAITipText(attempt, total),
					logger,
				});
			},
		});
	} finally {
		await dismissAiBusyTip({ webRpa, page, tipId, logger });
	}
	if (first.ok) {
		if (cacheEnabled && cacheCtx && cacheKey) {
			try {
				CacheAPI.setValue(cacheCtx, cacheKey, {
					model: first.model || chosenModel,
					provider: first.provider || primaryProvider,
					envelope: first.envelope,
					raw: String(first.raw || "").slice(0, 2000),
					time: Date.now(),
				}, { query: cacheQuery });
				await CacheAPI.flushRuleCache(cacheCtx);
				await logger?.debug("run_ai.cache.saved", { key: cacheKey, model: first.model || chosenModel });
			} catch (e) {
				await logger?.warn("run_ai.cache.save_failed", { reason: e?.message || "cache save failed" });
			}
		}
		return first;
	}
	if (fallbackModel && fallbackModel !== chosenModel) {
		const fb = await resolveRunAIEnvelopeWithModel({ session, provider: primaryProvider, model: fallbackModel, input, logger, cfg, timeoutMsOverride });
		if (fb.ok) {
			if (cacheEnabled && cacheCtx && cacheKey) {
				try {
					CacheAPI.setValue(cacheCtx, cacheKey, {
						model: fb.model || fallbackModel,
						provider: fb.provider || primaryProvider,
						envelope: fb.envelope,
						raw: String(fb.raw || "").slice(0, 2000),
						time: Date.now(),
					}, { query: cacheQuery });
					await CacheAPI.flushRuleCache(cacheCtx);
					await logger?.debug("run_ai.cache.saved", { key: cacheKey, model: fb.model || fallbackModel });
				} catch (e) {
					await logger?.warn("run_ai.cache.save_failed", { reason: e?.message || "cache save failed" });
				}
			}
			return fb;
		}
		if (fallbackProvider && fallbackProvider !== primaryProvider) {
			const fbProviderModel = resolveModelByTier({ provider: fallbackProvider, purpose: "run_ai", tier, fallback: false });
			const xb = await resolveRunAIEnvelopeWithModel({ session, provider: fallbackProvider, model: fbProviderModel, input, logger, cfg, timeoutMsOverride });
			if (xb.ok) return xb;
			return {
				ok: false,
				reason: `primary(${primaryProvider}/${chosenModel}) failed: ${first.reason}; model-fallback(${fallbackModel}) failed: ${fb.reason}; provider-fallback(${fallbackProvider}/${fbProviderModel}) failed: ${xb.reason}`,
				model: fbProviderModel,
				provider: fallbackProvider,
			};
		}
		return {
			ok: false,
			reason: `primary(${primaryProvider}/${chosenModel}) failed: ${first.reason}; model-fallback(${fallbackModel}) failed: ${fb.reason}`,
			model: fallbackModel,
			provider: primaryProvider,
		};
	}
	if (fallbackProvider && fallbackProvider !== primaryProvider) {
		const fbProviderModel = resolveModelByTier({ provider: fallbackProvider, purpose: "run_ai", tier, fallback: false });
		const xb = await resolveRunAIEnvelopeWithModel({ session, provider: fallbackProvider, model: fbProviderModel, input, logger, cfg, timeoutMsOverride });
		if (xb.ok) return xb;
		return {
			ok: false,
			reason: `primary(${primaryProvider}/${chosenModel}) failed: ${first.reason}; provider-fallback(${fallbackProvider}/${fbProviderModel}) failed: ${xb.reason}`,
			model: fbProviderModel,
			provider: fallbackProvider,
		};
	}
	return { ok: false, reason: first.reason, model: chosenModel, provider: primaryProvider };
}

async function callProviderForSelectors({ session = null, query, pageUrl, pageTitle, pageHtml, maxSelectors = 5, modelOverride = "", providerOverride = "", feedbackNote = "", expectedMulti = false, logger = null }) {
	const cfg = pickAIConfig();
	const useProvider = String(providerOverride || cfg.providerSelector).trim() || cfg.providerSelector;
	const useModel = modelOverride || resolveModelByTier({ provider: useProvider, purpose: "selector", tier: "balanced", fallback: false });

	const systemPrompt = [
		"You are a web element locator assistant.",
		"Task: Given page url/title/html and a natural-language target query, return selectors that likely match target elements.",
		"Return strict JSON only: {\"selectors\":[\"...\"],\"query\":\"...\",\"reason\":\"...\"}.",
		"Rules:",
		"- each selector must start with a prefix: `css: ` or `xpath: `",
		"- `css:` selectors must be valid standard CSS",
		"- `xpath:` selectors must be valid XPath expressions",
		"- you may choose css or xpath per candidate based on robustness",
		"- prefer stable selectors, avoid nth-child unless necessary",
		"- include up to 5 selectors ordered best-first",
		"- `query` is optional and should be a short natural-language target description for flow action.query",
		"- if confidence is low or no clear semantic label exists, set `query` to empty string",
		"- `query` must NOT be selector syntax (no css:/xpath:/querySelector/xpath expression)",
		"- no markdown, no extra text",
		"- selectors should be concise and robust (prefer id/name/aria/role/data-* anchors)",
		"- avoid giant combinator chains and brittle class soup",
		"- if the user intent implies ordinal selection (e.g. first/second/第N个), still prefer list-level selectors and let runtime pick choose the instance",
		expectedMulti
			? "- IMPORTANT: expectedMulti=true, prefer list-level selectors that match a meaningful candidate set (not a single hardcoded nth target)"
			: "- IMPORTANT: expectedMulti=false, prefer selectors that uniquely identify one target element",
	].join("\n");

	const normalizeSelectors = (arr) => {
		if (!Array.isArray(arr)) return [];
		const out = [];
		const seen = new Set();
		for (const x of arr) {
			const s0 = String(x || "").trim();
			if (!s0) continue;
			let normalized = "";
			if (/^css\s*=/i.test(s0)) {
				const expr = s0.replace(/^css\s*=/i, "").trim();
				if (expr) normalized = `css: ${expr}`;
			} else if (/^css\s*:/i.test(s0)) {
				const expr = s0.replace(/^css\s*:/i, "").trim();
				if (expr) normalized = `css: ${expr}`;
			} else if (/^xpath\s*=/i.test(s0)) {
				const expr = s0.replace(/^xpath\s*=/i, "").trim();
				if (expr) normalized = `xpath: ${expr}`;
			} else if (/^xpath\s*:/i.test(s0)) {
				const expr = s0.replace(/^xpath\s*:/i, "").trim();
				if (expr) normalized = `xpath: ${expr}`;
			} else if (/^(\/\/|\/|\(|\.\/|\.\.\/)/.test(s0)) {
				normalized = `xpath: ${s0}`;
			} else {
				normalized = `css: ${s0}`;
			}
			if (!normalized) continue;
			if (normalized.length > 240) continue;
			if (/[{};]/.test(normalized)) continue;
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			out.push(normalized);
			if (out.length >= maxSelectors) break;
		}
		return out;
	};

	const basePayload = {
		task: String(query || ""),
		outputContract: { selectors: "array<string>", query: "string(optional)", reason: "string", maxSelectors },
		page: {
			url: String(pageUrl || ""),
			title: String(pageTitle || ""),
			html: safeCut(pageHtml, cfg.selectorHtmlMaxLen),
		},
		constraints: [
			"selectors must be prefixed with css:/xpath:",
			"avoid brittle chains",
			"prefer stable semantic anchors",
			"no markdown",
			expectedMulti
				? "expectedMulti=true: selector should represent candidate set for downstream pick"
				: "expectedMulti=false: selector should be as unique as possible",
		],
		expectedMulti: !!expectedMulti,
		...(feedbackNote ? { feedback: String(feedbackNote) } : null),
	};

	const normalizeSemanticQuery = (v) => {
		const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
		if (!s) return "";
		if (s.length > 80) return "";
		if (/^(css|xpath)\s*:/i.test(s)) return "";
		if (/^(\/\/|\/|\(|\.\/|\.\.\/)/.test(s)) return "";
		if (/queryselector|document\.|nth-child|nth-of-type|::|\[[^\]]+\]|=>|function\s*\(/i.test(s)) return "";
		const punct = (s.match(/[<>{};=]/g) || []).length;
		if (punct >= 2) return "";
		return s;
	};

	const failures = [];
	for (let attempt = 0; attempt < cfg.retrySelector; attempt++) {
		const payload = failures.length
			? { ...basePayload, previousFailures: failures.slice(-3) }
			: basePayload;
		const r = await callResponsesAPI({
			session,
			model: useModel,
			input: [
				{ role: "system", content: [{ type: "input_text", text: systemPrompt }] },
				{ role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] },
			],
			logger,
			temperature: cfg.temperatureSelector,
			forceJson: true,
			purpose: "selector",
			providerOverride: useProvider,
		});
		if (!r.ok) return r;

		const parsed = tryParseJSON(r.raw);
		if (!parsed || !Array.isArray(parsed.selectors)) {
			failures.push({ type: "invalid_json", reason: "output must be JSON with selectors array" });
			await logger?.warn("ai.selector.invalid_json", { provider: r.provider || useProvider, model: r.model || useModel, attempt: attempt + 1 });
			continue;
		}

		const selectors = normalizeSelectors(parsed.selectors);
		if (!selectors.length) {
			failures.push({ type: "empty_or_invalid_selectors", reason: "no usable selectors after quality filtering", selectors: parsed.selectors.slice(0, 8) });
			await logger?.warn("ai.selector.empty_selectors", { provider: r.provider || useProvider, model: r.model || useModel, attempt: attempt + 1 });
			continue;
		}
		await logger?.info("ai.selector.success", { provider: r.provider || useProvider, model: r.model || useModel, selectors: selectors.length, attempt: attempt + 1 });
		const semanticQuery = normalizeSemanticQuery(parsed.query);
		return {
			ok: true,
			model: r.model || useModel,
			provider: r.provider || useProvider,
			selectors,
			query: semanticQuery,
			reason: parsed.reason || "",
			raw: r.raw,
		};
	}

	return { ok: false, reason: "provider returned no usable selectors after retries", model: useModel, provider: useProvider };
}

async function resolveSelectorByAI({ query, webRpa = null, page, session = null, feedbackNote = "", expectedMulti = false, logger = null, aiOptions = null, action = null }) {
	const cfg = pickAIConfig();
	const primaryProvider = pickPurposeProvider({ cfg, purpose: "selector", aiOptions, action });
	const fallbackModel = resolveModelByTier({ provider: primaryProvider, purpose: "selector", tier: "balanced", fallback: true });
	let pageUrl = "";
	let pageTitle = "";
	let pageHtml = "";
	try {
		pageUrl = await page.url();
	} catch (_) {
	}
	try {
		pageTitle = await page.title();
	} catch (_) {
	}
	pageHtml = await readPageHtmlForAI({ webRpa, page, logger, maxLen: cfg.selectorHtmlMaxLen });
	const primary = await callProviderForSelectors({
		session,
		query,
		pageUrl,
		pageTitle,
		pageHtml,
		maxSelectors: cfg.maxSelectors,
		feedbackNote,
		expectedMulti,
		logger,
		providerOverride: primaryProvider,
	});
	if (primary.ok) {
		return primary;
	}
	const reasons = [
		`primary(${primary.provider || primaryProvider}/${primary.model || "unknown"}) failed: ${primary.reason}`,
	];
	if (fallbackModel && fallbackModel !== primary.model) {
		const fallback = await callProviderForSelectors({
			session,
			query,
			pageUrl,
			pageTitle,
			pageHtml,
			maxSelectors: cfg.maxSelectors,
			modelOverride: fallbackModel,
			feedbackNote,
			expectedMulti,
			logger,
			providerOverride: primaryProvider,
		});
		if (fallback.ok) {
			return fallback;
		}
		reasons.push(`model-fallback(${fallback.provider || primaryProvider}/${fallback.model || fallbackModel}) failed: ${fallback.reason}`);
	}
	const selectorFallbackProvider = pickPurposeFallbackProvider({ cfg, purpose: "selector", aiOptions, action });
	if (selectorFallbackProvider && selectorFallbackProvider !== primaryProvider) {
		const fbProvider = selectorFallbackProvider;
		const fbProviderModel = resolveModelByTier({ provider: fbProvider, purpose: "selector", tier: "balanced", fallback: false });
		const providerFallback = await callProviderForSelectors({
			session,
			query,
			pageUrl,
			pageTitle,
			pageHtml,
			maxSelectors: cfg.maxSelectors,
			modelOverride: fbProviderModel,
			providerOverride: fbProvider,
			feedbackNote,
			expectedMulti,
			logger,
		});
		if (providerFallback.ok) {
			return providerFallback;
		}
		reasons.push(`provider-fallback(${providerFallback.provider || fbProvider}/${providerFallback.model || fbProviderModel || "unknown"}) failed: ${providerFallback.reason}`);
		return {
			ok: false,
			reason: reasons.join("; "),
			model: providerFallback.model || fbProviderModel,
			provider: providerFallback.provider || fbProvider,
		};
	}
	return {
		ok: false,
		reason: reasons.join("; "),
		model: primary.model || fallbackModel,
		provider: primary.provider || primaryProvider,
	};
}

export { resolveSelectorByAI, runAIAction };
