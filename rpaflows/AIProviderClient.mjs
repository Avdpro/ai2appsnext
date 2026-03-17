function envInt(name, fallback, min = 1, max = 1000000) {
	const raw = process.env[name];
	const n = Number.parseInt(String(raw ?? ""), 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}

function normalizeProviderName(raw, fallback = "openai") {
	const s = String(raw || "").trim().toLowerCase();
	if (!s) return fallback;
	if (s === "openai" || s === "oai") return "openai";
	if (s === "openrouter" || s === "or") return "openrouter";
	if (s === "ollama") return "ollama";
	if (s === "google" || s === "gemini") return "google";
	if (s === "claude" || s === "anthropic") return "anthropic";
	return fallback;
}

function providerPrefix(provider) {
	switch (normalizeProviderName(provider)) {
		case "openrouter":
			return "OPENROUTER";
		case "ollama":
			return "OLLAMA";
		case "google":
			return "GOOGLE";
		case "anthropic":
			return "CLAUDE";
		default:
			return "OPENAI";
	}
}

function purposeKey(purpose = "") {
	const s = String(purpose || "").trim().toUpperCase();
	return s.replace(/[^A-Z0-9]+/g, "_");
}

function getProviderForPurpose(purpose = "run_ai") {
	const p = purposeKey(purpose);
	return normalizeProviderName(
		process.env[`AI_PROVIDER_${p}`] || process.env.AI_PROVIDER || "openai",
		"openai"
	);
}

function getFallbackProviderForPurpose(purpose = "run_ai") {
	const p = purposeKey(purpose);
	const raw = process.env[`AI_PROVIDER_${p}_FALLBACK`] || process.env.AI_PROVIDER_FALLBACK || "";
	if (!String(raw || "").trim()) return "";
	return normalizeProviderName(raw, "");
}

function getDefaultModel(provider) {
	switch (normalizeProviderName(provider)) {
		case "openrouter":
			return "openai/gpt-4o-mini";
		case "ollama":
			return "qwen2.5:7b-instruct";
		case "google":
			return "gemini-2.0-flash";
		case "anthropic":
			return "claude-3-5-sonnet-latest";
		default:
			return "gpt-4o-mini";
	}
}

function resolveModelByTier({ provider, purpose = "run_ai", tier = "balanced", fallback = false }) {
	const pfx = providerPrefix(provider);
	const p = purposeKey(purpose);
	const t = String(tier || "balanced").trim().toUpperCase();
	const fall = fallback ? "_FALLBACK" : "";
	const keys = [
		`${pfx}_MODEL_${p}_${t}${fall}`,
		`${pfx}_MODEL_${t}${fall}`,
		`${pfx}_MODEL_${p}${fall}`,
		`${pfx}_MODEL${fall}`,
		`AI_MODEL_${p}_${t}${fall}`,
		`AI_MODEL_${t}${fall}`,
		`AI_MODEL_${p}${fall}`,
		`AI_MODEL${fall}`,
	];
	for (const k of keys) {
		const v = String(process.env[k] || "").trim();
		if (v) return v;
	}
	return fallback ? "" : getDefaultModel(provider);
}

function normalizeSessionMessages(input) {
	const list = [];
	const rows = Array.isArray(input) ? input : [];
	for (const row of rows) {
		const role0 = String(row?.role || "user").toLowerCase();
		const role = (role0 === "assistant" || role0 === "system") ? role0 : "user";
		const content = row?.content;
		let text = "";
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			text = content.map((it) => {
				if (!it || typeof it !== "object") return "";
				if (typeof it.text === "string") return it.text;
				if (typeof it.input_text === "string") return it.input_text;
				return "";
			}).filter(Boolean).join("\n");
		} else if (content && typeof content === "object") {
			if (typeof content.text === "string") text = content.text;
		}
		list.push({ role, content: String(text || "") });
	}
	return list;
}

function extractRawTextFromOpenAIResponses(data) {
	if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
	if (Array.isArray(data?.output)) {
		const chunks = [];
		for (const item of data.output) {
			if (!Array.isArray(item?.content)) continue;
			for (const c of item.content) {
				if (typeof c?.text === "string") chunks.push(c.text);
			}
		}
		if (chunks.length) return chunks.join("\n");
	}
	return "";
}

function splitSystemAndMessages(input) {
	const src = normalizeSessionMessages(input);
	const systemParts = [];
	const messages = [];
	for (const m of src) {
		if (m.role === "system") systemParts.push(m.content);
		else messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
	}
	const system = systemParts.join("\n\n").trim();
	return { system, messages };
}

async function fetchJsonWithTimeout(url, init, timeoutMs = 90000) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => {
		try { ctrl.abort(new Error(`request timeout after ${timeoutMs}ms`)); } catch (_) {}
	}, Math.max(1000, Number(timeoutMs || 90000)));
	try {
		const resp = await fetch(url, { ...init, signal: ctrl.signal });
		const text = await resp.text();
		let json = null;
		try { json = text ? JSON.parse(text) : null; } catch (_) {}
		return { ok: resp.ok, status: resp.status, text, json };
	} finally {
		clearTimeout(timer);
	}
}

function firstTextFromGoogle(json) {
	const cands = Array.isArray(json?.candidates) ? json.candidates : [];
	for (const c of cands) {
		const parts = Array.isArray(c?.content?.parts) ? c.content.parts : [];
		const text = parts.map((p) => String(p?.text || "")).join("\n").trim();
		if (text) return text;
	}
	return "";
}

function firstTextFromAnthropic(json) {
	const parts = Array.isArray(json?.content) ? json.content : [];
	const text = parts.filter((p) => String(p?.type || "") === "text").map((p) => String(p?.text || "")).join("\n").trim();
	return text;
}

async function callProviderText({
	provider,
	model,
	input,
	logger = null,
	temperature = 0,
	omitTemperature = false,
	forceJson = false,
	timeoutMs = 90000,
	purpose = "run_ai",
}) {
	const useProvider = normalizeProviderName(provider, "openai");
	const useModel = String(model || "").trim() || getDefaultModel(useProvider);
	const msgs = normalizeSessionMessages(input);
	const tag = `ai.${useProvider}`;
	await logger?.debug(`${tag}.request`, { model: useModel, purpose });

	if (useProvider === "openai") {
		const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
		const baseURL = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
		if (!apiKey) return { ok: false, reason: "OPENAI_API_KEY missing", model: useModel, provider: useProvider };
		const body = { model: useModel, input };
		if (forceJson) {
			// Responses API structured JSON mode.
			body.text = { format: { type: "json_object" } };
		}
		const ret = await fetchJsonWithTimeout(`${baseURL}/responses`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
		}, timeoutMs);
		if (!ret.ok) return { ok: false, reason: `openai http ${ret.status}: ${String(ret.text || "").slice(0, 180)}`, model: useModel, provider: useProvider };
		const raw = extractRawTextFromOpenAIResponses(ret.json || {});
		if (!raw.trim()) return { ok: false, reason: "openai empty response", model: useModel, provider: useProvider };
		return { ok: true, raw, model: useModel, provider: useProvider };
	}

	if (useProvider === "openrouter") {
		const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();
		const baseURL = String(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").trim().replace(/\/+$/, "");
		if (!apiKey) return { ok: false, reason: "OPENROUTER_API_KEY missing", model: useModel, provider: useProvider };
		const body = {
			model: useModel,
			messages: msgs.map((m) => ({ role: m.role, content: m.content })),
		};
		if (!omitTemperature && Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
		if (forceJson) {
			// OpenRouter follows OpenAI-compatible Chat Completions JSON mode.
			body.response_format = { type: "json_object" };
		}
		const reqHeaders = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		};
		const referer = String(process.env.OPENROUTER_SITE_URL || process.env.OPENROUTER_HTTP_REFERER || "").trim();
		const appName = String(process.env.OPENROUTER_APP_NAME || process.env.OPENROUTER_X_TITLE || "").trim();
		if (referer) reqHeaders["HTTP-Referer"] = referer;
		if (appName) reqHeaders["X-Title"] = appName;
		const ret = await fetchJsonWithTimeout(`${baseURL}/chat/completions`, {
			method: "POST",
			headers: reqHeaders,
			body: JSON.stringify(body),
		}, timeoutMs);
		if (!ret.ok) return { ok: false, reason: `openrouter http ${ret.status}: ${String(ret.text || "").slice(0, 180)}`, model: useModel, provider: useProvider };
		const raw = String(ret?.json?.choices?.[0]?.message?.content || "").trim();
		if (!raw) return { ok: false, reason: "openrouter empty response", model: useModel, provider: useProvider };
		return { ok: true, raw, model: useModel, provider: useProvider };
	}

	if (useProvider === "ollama") {
		const baseURL = String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
		const options = {};
		if (!omitTemperature && Number.isFinite(Number(temperature))) options.temperature = Number(temperature);
		const ret = await fetchJsonWithTimeout(`${baseURL}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: useModel,
				stream: false,
				messages: msgs.map((m) => ({ role: m.role, content: m.content })),
				options,
			}),
		}, timeoutMs);
		if (!ret.ok) return { ok: false, reason: `ollama http ${ret.status}: ${String(ret.text || "").slice(0, 180)}`, model: useModel, provider: useProvider };
		const raw = String(ret?.json?.message?.content || "").trim();
		if (!raw) return { ok: false, reason: "ollama empty response", model: useModel, provider: useProvider };
		return { ok: true, raw, model: useModel, provider: useProvider };
	}

	if (useProvider === "google") {
		const apiKey = String(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "").trim();
		if (!apiKey) return { ok: false, reason: "GOOGLE_API_KEY missing", model: useModel, provider: useProvider };
		const { system, messages } = splitSystemAndMessages(input);
		const userText = messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n");
		const body = {
			contents: [{ role: "user", parts: [{ text: userText || "" }] }],
		};
		if (!omitTemperature && Number.isFinite(Number(temperature))) body.generationConfig = { temperature: Number(temperature) };
		if (forceJson) {
			if (!body.generationConfig) body.generationConfig = {};
			// Gemini JSON mode: enforce JSON object response shape at transport level.
			body.generationConfig.responseMimeType = "application/json";
		}
		if (system) body.systemInstruction = { parts: [{ text: system }] };
		const ret = await fetchJsonWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}, timeoutMs);
		if (!ret.ok) {
			await logger?.warn(`${tag}.error`, {
				model: useModel,
				purpose,
				status: ret.status,
				body: String(ret.text || "").slice(0, 260),
			});
			return { ok: false, reason: `google http ${ret.status}: ${String(ret.text || "").slice(0, 180)}`, model: useModel, provider: useProvider };
		}
		const raw = firstTextFromGoogle(ret.json || {});
		if (!raw) {
			await logger?.warn(`${tag}.error`, {
				model: useModel,
				purpose,
				status: ret.status,
				body: String(ret.text || "").slice(0, 260),
				reason: "google empty response",
			});
			return { ok: false, reason: "google empty response", model: useModel, provider: useProvider };
		}
		await logger?.debug(`${tag}.success`, {
			model: useModel,
			purpose,
			textLen: raw.length,
			preview: String(raw).slice(0, 260),
		});
		return { ok: true, raw, model: useModel, provider: useProvider };
	}

	const apiKey = String(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "").trim();
	if (!apiKey) return { ok: false, reason: "ANTHROPIC_API_KEY missing", model: useModel, provider: "anthropic" };
	const { system, messages } = splitSystemAndMessages(input);
	const jsonHardRule = "You MUST output exactly one valid JSON object only. No markdown, no code fences, no prose.";
	const systemWithRule = forceJson
		? [String(system || "").trim(), jsonHardRule].filter(Boolean).join("\n\n")
		: system;
	const baseMessages = (messages.length ? messages : [{ role: "user", content: "" }]).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
	const buildBody = () => {
		const anthroMessages = baseMessages.slice();
		const b = {
			model: useModel,
			max_tokens: envInt("ANTHROPIC_MAX_TOKENS", 4096, 128, 8192),
			messages: anthroMessages,
		};
		if (!omitTemperature && Number.isFinite(Number(temperature))) b.temperature = Number(temperature);
		if (systemWithRule) b.system = systemWithRule;
		return b;
	};
	const reqHeaders = {
		"Content-Type": "application/json",
		"x-api-key": apiKey,
		"anthropic-version": String(process.env.ANTHROPIC_VERSION || "2023-06-01"),
	};
	let ret = await fetchJsonWithTimeout("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: reqHeaders,
		body: JSON.stringify(buildBody()),
	}, timeoutMs);
	if (!ret.ok) {
		await logger?.warn(`${tag}.error`, {
			model: useModel,
			purpose,
			status: ret.status,
			body: String(ret.text || "").slice(0, 260),
		});
		return { ok: false, reason: `anthropic http ${ret.status}: ${String(ret.text || "").slice(0, 180)}`, model: useModel, provider: "anthropic" };
	}
	const raw = firstTextFromAnthropic(ret.json || {});
	if (!raw) {
		await logger?.warn(`${tag}.error`, {
			model: useModel,
			purpose,
			status: ret.status,
			body: String(ret.text || "").slice(0, 260),
			reason: "anthropic empty response",
		});
		return { ok: false, reason: "anthropic empty response", model: useModel, provider: "anthropic" };
	}
	await logger?.debug(`${tag}.success`, {
		model: useModel,
		purpose,
		textLen: raw.length,
		preview: String(raw).slice(0, 260),
	});
	return { ok: true, raw, model: useModel, provider: "anthropic" };
}

export {
	normalizeProviderName,
	getProviderForPurpose,
	getFallbackProviderForPurpose,
	resolveModelByTier,
	callProviderText,
	normalizeSessionMessages,
};
