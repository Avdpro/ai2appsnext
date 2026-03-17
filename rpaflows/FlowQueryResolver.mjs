import CacheAPI from "./FlowRuleCache.mjs";
import { resolveSelectorByAI } from "./FlowAIResolver.mjs";
import { getQueryCacheRemoteProvider } from "./RemoteSourceProviders.mjs";
import { getReadOrder, normalizePolicy, normalizeWritePolicy } from "./SourcePolicy.mjs";

function normalizeUrlForCache(url) {
	const s = String(url || "").trim();
	if (!s) return "";
	try {
		const u = new URL(s);
		const mode = String(process.env.AI_SELECTOR_CACHE_SCOPE || "origin").trim().toLowerCase();
		if (mode === "origin_path" || mode === "origin+path" || mode === "path") {
			return `${u.origin}${u.pathname}`;
		}
		return u.origin;
	} catch (_) {
		return s;
	}
}

function scopedSelectorQuery(scope, text) {
	return `scope:${scope}|q:${String(text || "")}`;
}

function selectorQueryMatches(savedQuery, expectedScoped, plainText) {
	const q = String(savedQuery || "");
	if (!q) return true; // backward compatibility
	if (q === expectedScoped) return true;
	if (q === String(plainText || "")) return true; // old cache compatibility
	return false;
}

function normalizeQuerySpec(query, fallbackKind = "selector") {
	if (query && typeof query === "object") {
		return {
			text: query.text || "",
			kind: query.kind || fallbackKind,
			mode: query.mode || "instance",
			policy: query.policy || (query.kind === "selector" ? "pool" : "single"),
		};
	}
	return {
		text: String(query || ""),
		kind: fallbackKind,
		mode: "instance",
		policy: fallbackKind === "selector" ? "pool" : "single",
	};
}

function buildWriteTargets(writePolicyRaw) {
	const policy = normalizeWritePolicy(writePolicyRaw, "local");
	if (policy === "cloud") return ["cloud"];
	if (policy === "both") return ["local", "cloud"];
	return ["local"];
}

function looksLikeCssSelector(text) {
	const s = String(text || "").trim();
	if (!s) return false;
	if (s.startsWith("css=")) return true;
	if (/^css\s*:/i.test(s)) return true;
	if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s)) return true;
	return /^([#.:\[*]|[a-zA-Z][a-zA-Z0-9_-]*[.#[:\s>+~])/.test(s);
}

function looksLikeXPath(text) {
	const s = String(text || "").trim();
	if (!s) return false;
	if (/^xpath\s*:/i.test(s)) return true;
	if (/^xpath\s*=/i.test(s)) return true;
	return /^(\/\/|\/|\(|\.\/|\.\.\/)/.test(s);
}

function normalizeSelectorToken(raw) {
	const s = String(raw || "").trim();
	if (!s) return "";
	if (/^css\s*=/i.test(s)) {
		const expr = s.replace(/^css\s*=/i, "").trim();
		return expr ? `css: ${expr}` : "";
	}
	if (/^css\s*:/i.test(s)) {
		const expr = s.replace(/^css\s*:/i, "").trim();
		return expr ? `css: ${expr}` : "";
	}
	if (/^xpath\s*=/i.test(s)) {
		const expr = s.replace(/^xpath\s*=/i, "").trim();
		return expr ? `xpath: ${expr}` : "";
	}
	if (/^xpath\s*:/i.test(s)) {
		const expr = s.replace(/^xpath\s*:/i, "").trim();
		return expr ? `xpath: ${expr}` : "";
	}
	if (looksLikeXPath(s)) return `xpath: ${s}`;
	return `css: ${s}`;
}

function isSearchInputIntent(text) {
	const q = String(text || "").toLowerCase();
	return /(\bsearch\b|搜索|查询|关键词|关键字|search box|搜索框)/i.test(q);
}

function getHostSearchInputCandidates(pageUrl) {
	let host = "";
	try { host = String(new URL(pageUrl).hostname || "").toLowerCase(); } catch (_) {}
	if (!host) return [];

	// Prefer deterministic selectors on major engines to avoid AI picking chat boxes.
	if (host.endsWith("google.com")) {
		return [
			"css: textarea.gLFyf",
			"css: textarea[name='q']",
			"css: input[name='q']",
		];
	}
	if (host.endsWith("baidu.com")) {
		return [
			"css: input#kw",
			"css: textarea#kw",
			"css: form#form input[name='wd']",
			"css: input[name='wd']",
		];
	}
	if (host.endsWith("bing.com")) {
		return [
			"css: textarea#sb_form_q",
			"css: input#sb_form_q",
			"css: form#sb_form input[name='q']",
			"css: input[name='q']",
		];
	}
	return [];
}

async function validateSelectorCandidate(page, selector, queryText = "", expectedMulti = false) {
	try {
		const r = await page.callFunction(
			function (sel, qText, expectMulti) {
				function asText(v) { return String(v == null ? "" : v).toLowerCase(); }
				const q = asText(qText || "");
				const intentUpload = /(\bupload\b|上传|附件|图片|图像|视频|文件|file\s*input|add image|add video)/i.test(q);
				const hasSearchWords = /(\bsearch\b|搜索|查询|关键词|关键字)/i.test(q);
				const hasInputWords = /(\binput\b|输入框|文本框|search box|搜索框|textarea|编辑框|edit(or)?)/i.test(q);
				const hasResultWords = /(结果|列表|区域|容器|container|list|feed|card|帖子|post|条目|item|区块|面板)/i.test(q);
				const hasButtonWords = /(\bbutton\b|按钮|提交|submit|\bclick\b|点击)/i.test(q);
				// "search" alone is ambiguous. Treat it as input intent only when not explicitly
				// describing result/list/container/button targets.
				const intentInput = !intentUpload && !hasButtonWords && (hasInputWords || (hasSearchWords && !hasResultWords));
				const intentClick = intentUpload || /(\bclick\b|按钮|button|下一页|加载更多|more\b|next\b|submit|提交)/i.test(q);

				function isInputLike(el) {
					if (!el || el.nodeType !== 1) return false;
					const tag = String(el.tagName || "").toLowerCase();
					if (tag === "textarea") return true;
					if (tag === "input") {
						const t = asText(el.getAttribute("type") || "text");
						if (intentUpload && t === "file") return true;
						if (["hidden", "password", "file", "checkbox", "radio", "submit", "button", "image", "reset"].includes(t)) return false;
						return true;
					}
					return !!el.isContentEditable;
				}
				function isClickable(el) {
					if (!el || el.nodeType !== 1) return false;
					const tag = String(el.tagName || "").toLowerCase();
					if (tag === "button" || tag === "a") return true;
					if (tag === "label" && asText(el.getAttribute("for") || "")) return true;
					if (tag === "input") {
						const t = asText(el.getAttribute("type") || "");
						return t === "button" || t === "submit";
					}
					if (intentUpload && el.querySelector && el.querySelector("input[type='file']")) return true;
					const role = asText(el.getAttribute("role") || "");
					if (role === "button" || role === "link" || role === "menuitem") return true;
					const onclick = asText(el.getAttribute("onclick") || "");
					return !!onclick;
				}

					const out = { ok: false, reason: "", count: 0, tag: "" };
					const raw = String(sel || "").trim();
					if (!raw) { out.reason = "empty selector"; return out; }
					function parseSelector(input) {
						const s = String(input || "").trim();
						if (!s) return { kind: "css", expr: "" };
						if (/^css\s*:/i.test(s)) return { kind: "css", expr: s.replace(/^css\s*:/i, "").trim() };
						if (/^css\s*=/i.test(s)) return { kind: "css", expr: s.replace(/^css\s*=/i, "").trim() };
						if (/^xpath\s*:/i.test(s)) return { kind: "xpath", expr: s.replace(/^xpath\s*:/i, "").trim() };
						if (/^xpath\s*=/i.test(s)) return { kind: "xpath", expr: s.replace(/^xpath\s*=/i, "").trim() };
						if (/^(\/\/|\/|\(|\.\/|\.\.\/)/.test(s)) return { kind: "xpath", expr: s };
						return { kind: "css", expr: s };
					}
					const parsed = parseSelector(raw);
					const expr = String(parsed.expr || "").trim();
					if (!expr) { out.reason = "empty selector"; return out; }
					let nodes = [];
					if (parsed.kind === "xpath") {
						try {
							const snap = document.evaluate(expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
							for (let i = 0; i < snap.snapshotLength; i++) {
								const n = snap.snapshotItem(i);
								if (n && n.nodeType === 1) nodes.push(n);
							}
						} catch (_) {
							out.reason = "invalid xpath";
							return out;
						}
					} else {
						try {
							nodes = Array.from(document.querySelectorAll(expr));
						} catch (_) {
							out.reason = "invalid selector";
							return out;
						}
					}
				out.count = nodes.length;
				if (!nodes.length) { out.reason = "not found"; return out; }
				if (!expectMulti && nodes.length > 200) { out.reason = `too broad raw matches: ${nodes.length}`; return out; }
				if (expectMulti && nodes.length > 1000) { out.reason = "too broad for multi (>1000 matches)"; return out; }
				const effective = nodes;
				if (!effective.length) { out.reason = "no match"; return out; }
				if (!expectMulti && !intentUpload && effective.length !== 1) {
					out.reason = effective.length === 0 ? "no match" : `multiple matches: ${effective.length}`;
					return out;
				}
				if (!expectMulti && intentUpload && effective.length > 24) {
					out.reason = `too broad for upload: ${effective.length}`;
					return out;
				}
				if (expectMulti && effective.length > 600) { out.reason = "too broad visible set for multi (>600)"; return out; }

				const first = effective[0];
				out.tag = String(first.tagName || "").toLowerCase();

				if (intentInput) {
					if (effective.length > 4) { out.reason = "too broad for input"; return out; }
					if (!isInputLike(first)) { out.reason = "not input-like"; return out; }
					if (hasSearchWords) {
						const hay = [
							first.getAttribute("name"),
							first.getAttribute("id"),
							first.getAttribute("placeholder"),
							first.getAttribute("aria-label"),
							first.getAttribute("type"),
							first.className
						].map(asText).join(" ");
						if (/\b(chat|assistant|copilot|ai|dialog|conversation|prompt)\b/.test(hay)) {
							out.reason = "chat-like input, not search input";
							return out;
						}
					}
				}

				if (intentClick) {
					if (intentUpload) {
						out.ok = true;
						return out;
					}
					// For editor/input intents, the primary target can be textarea/contenteditable.
					// Such elements may not satisfy strict "clickable" heuristics but are valid targets.
					if (intentInput && isInputLike(first)) {
						out.ok = true;
						return out;
					}
					if (effective.length > 8) { out.reason = "too broad for click"; return out; }
					if (!isClickable(first)) { out.reason = "not clickable"; return out; }
				}

				out.ok = true;
				return out;
			},
			[selector, queryText, !!expectedMulti],
			{ awaitPromise: true }
		);
		if (r && typeof r === "object") return r;
		return { ok: false, reason: "invalid inspector result", count: 0, tag: "" };
	} catch (e) {
		return { ok: false, reason: e?.message || "validate selector failed", count: 0, tag: "" };
	}
}

async function computeSigKey(webRpa, page, selector) {
	try {
		if (!webRpa || typeof webRpa.computeSigKeyForSelector !== "function") return null;
		const sigKey = await webRpa.computeSigKeyForSelector(page, selector, {});
		return typeof sigKey === "string" && sigKey.trim() ? sigKey.trim() : null;
	} catch (_) {
		return null;
	}
}

async function showAiBusyTip({ webRpa, page, tipId, text, logger = null }) {
	try {
		if (!webRpa || !page || typeof webRpa.inPageTip !== "function") return null;
		const ret = await webRpa.inPageTip(page, String(text || "AI 正在定位页面元素，请稍候…"), {
			id: String(tipId || "__flow_ai_selector_busy__"),
			position: "top",
			stack: false,
			timeout: 0,
			opacity: 0.96,
			persistAcrossNav: true,
			persistTtlMs: 30000,
			pollMs: 400,
		});
		return (ret && typeof ret.id === "string" && ret.id.trim()) ? ret.id.trim() : String(tipId || "__flow_ai_selector_busy__");
	} catch (e) {
		await logger?.debug("ui.tip.show_failed", { reason: e?.message || "unknown", tipId: String(tipId || "") });
		return null;
	}
}

function buildSelectorAiTipText(pass, totalPasses) {
	const idx = Number(pass || 0) + 1;
	const total = Math.max(1, Number(totalPasses || 1));
	if (idx <= 1) return `AI 正在定位页面元素（第${idx}/${total}次尝试），请稍候…`;
	return `AI 正在重新定位页面元素（第${idx}/${total}次尝试），请稍候…`;
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

async function resolveQuery({
	webRpa,
	page,
	session = null,
	aiOptions = null,
	cacheKey,
	query,
	cacheKind,
	cachePolicy,
	selectorMode,
	expectedMulti = false,
	forceRegenerate = false,
	aiFeedback = "",
	cacheSourcePolicy = "",
	cacheWritePolicy = "",
	logger = null,
}) {
	const spec = normalizeQuerySpec(query, cacheKind || "selector");
	let pageScope = "";
	try { pageScope = normalizeUrlForCache(await page.url()); } catch (_) {}
	const scopedQuery = scopedSelectorQuery(pageScope, spec.text);
	const sourcePolicy = normalizePolicy(
		cacheSourcePolicy || process.env.QUERY_CACHE_SOURCE_POLICY || "",
		"prefer_local"
	);
	const readOrder = getReadOrder(sourcePolicy, "prefer_local");
	const writeTargets = buildWriteTargets(cacheWritePolicy || process.env.QUERY_CACHE_WRITE_POLICY || "local");

	let localCtx = readOrder.includes("local") || writeTargets.includes("local")
		? await CacheAPI.openRuleCache(null, page)
		: null;
	const remoteProvider = await getQueryCacheRemoteProvider({ logger });
	let remoteCtx = null;
	if (readOrder.includes("cloud") || writeTargets.includes("cloud")) {
		try {
			remoteCtx = await remoteProvider.openRuleCache(null, page, { scope: pageScope });
		} catch (e) {
			remoteCtx = null;
			await logger?.warn("query.cache.remote.open_failed", {
				reason: e?.message || String(e),
				provider: remoteProvider?.name || "unknown",
			});
		}
	}
	await logger?.debug("query.resolve.start", {
		cacheKey,
		kind: spec.kind,
		mode: spec.mode,
		policy: spec.policy,
		text: spec.text,
		sourcePolicy,
		writeTargets,
	});
	if (forceRegenerate) {
		await logger?.info("query.resolve.force_regenerate", { cacheKey });
	}

	const getLiveLocalCacheContext = async () => {
		let liveScope = pageScope;
		let liveScopedQuery = scopedQuery;
		let liveCtx = localCtx;
		try {
			const curUrl = await page.url();
			liveScope = normalizeUrlForCache(curUrl);
			liveScopedQuery = scopedSelectorQuery(liveScope, spec.text);
			if (!localCtx || (liveScope && liveScope !== pageScope)) {
				liveCtx = await CacheAPI.openRuleCache(null, page);
				if (liveCtx) localCtx = liveCtx;
				if (liveScope && liveScope !== pageScope) {
					await logger?.debug("query.cache.scope_rebind", { cacheKey, from: pageScope || "", to: liveScope || "" });
					pageScope = liveScope;
				}
			}
		} catch (_) {
		}
		return { liveCtx, liveScopedQuery };
	};

	const saveSelectorScoped = async ({ selector, sigKey = null, mode = null, policy = "single", share = false, queryOverride = "" }) => {
		const queryText = String(queryOverride || scopedQuery);
		if (writeTargets.includes("local")) {
			const { liveCtx, liveScopedQuery } = await getLiveLocalCacheContext();
			if (liveCtx) {
				CacheAPI.saveSelector(liveCtx, cacheKey, {
					query: String(queryOverride || liveScopedQuery || scopedQuery),
					selectors: selector,
					sigKey: sigKey || null,
					mode: mode || selectorMode || spec.mode || "instance",
					policy,
					share: !!share,
				});
				await CacheAPI.flushRuleCache(liveCtx);
			}
		}
		if (writeTargets.includes("cloud") && remoteCtx) {
			try {
				remoteProvider.saveSelector(remoteCtx, cacheKey, {
					query: queryText,
					selectors: selector,
					sigKey: sigKey || null,
					mode: mode || selectorMode || spec.mode || "instance",
					policy,
					share: !!share,
				});
				await remoteProvider.flushRuleCache(remoteCtx);
			} catch (e) {
				await logger?.warn("query.cache.remote.write_failed", {
					cacheKey,
					reason: e?.message || String(e),
					provider: remoteProvider?.name || "unknown",
				});
			}
		}
	};

	const tryResolveFromCacheStore = async ({ storeName, ctx, api }) => {
		if (!ctx) return null;
		const cached = api.resolveRule(ctx, cacheKey);
		if (cached && (!cacheKind || cached.kind === cacheKind || cached.kind === "status")) {
			await logger?.debug("query.cache.hit", {
				cacheKey,
				cachedKind: cached.kind,
				store: storeName,
			});
			if (cached.kind === "selector") {
				if (!selectorQueryMatches(cached.selector?.query, scopedQuery, spec.text)) {
					await logger?.debug("query.cache.scope_mismatch", { cacheKey, store: storeName });
				} else {
					const selectors = cached.selector?.selectors || [];
					for (const sRaw of selectors) {
						const s = normalizeSelectorToken(sRaw);
						const v = await validateSelectorCandidate(page, s, spec.text, expectedMulti);
						if (v.ok) {
							if (s !== String(sRaw || "").trim()) {
								await saveSelectorScoped({
									selector: s,
									sigKey: cached.selector?.sigKey || null,
									mode: cached.selector?.mode || selectorMode || spec.mode || "instance",
									policy: "single",
									share: true,
									queryOverride: cached.selector?.query || "",
								});
							}
							let sigKey = cached.selector?.sigKey || null;
							if (!sigKey) {
								sigKey = await computeSigKey(webRpa, page, s);
								if (sigKey) {
									await saveSelectorScoped({
										selector: s,
										sigKey,
										mode: cached.selector?.mode || selectorMode || spec.mode || "instance",
										policy: "single",
										share: true,
										queryOverride: cached.selector?.query || "",
									});
								}
							}
							return {
								status: "done",
								value: {
									kind: "selector",
									selector: s,
									sigKey: sigKey || null,
									fromCache: true,
									cacheStore: storeName,
								},
							};
						}
					}
				}
			} else if (cached.kind === "code") {
				return { status: "done", value: { kind: "code", code: cached.code, fromCache: true, cacheStore: storeName } };
			} else if (cached.kind === "status") {
				return { status: "done", value: { kind: "status", status: cached.status, fromCache: true, cacheStore: storeName } };
			}
		}
		await logger?.debug("query.cache.miss", { cacheKey, store: storeName });
		if (spec.kind === "selector") {
			let loose = api.findLooseSelector(ctx, { key: cacheKey, query: scopedQuery });
			if (!loose) loose = api.findLooseSelector(ctx, { key: cacheKey, query: spec.text });
			if (loose && Array.isArray(loose.selectors)) {
				for (const sRaw of loose.selectors) {
					const s = normalizeSelectorToken(sRaw);
					const v = await validateSelectorCandidate(page, s, spec.text, expectedMulti);
					if (v.ok) {
						return {
							status: "done",
							value: {
								kind: "selector",
								selector: s,
								sigKey: loose.sigKey || null,
								fromCache: true,
								loose: true,
								cacheStore: storeName,
							},
						};
					}
				}
			}
		}
		return null;
	};

	if (!forceRegenerate) {
		for (const source of readOrder) {
			if (source === "local" && localCtx) {
				const ret = await tryResolveFromCacheStore({
					storeName: "local",
					ctx: localCtx,
					api: CacheAPI,
				});
				if (ret) return ret;
			}
			if (source === "cloud" && remoteCtx) {
				const ret = await tryResolveFromCacheStore({
					storeName: "cloud",
					ctx: remoteCtx,
					api: remoteProvider,
				});
				if (ret) return ret;
			}
		}
	}

	if (spec.kind === "code") {
		return { status: "failed", reason: "code query fallback is not implemented yet (reserved hook)" };
	}
	if (spec.kind === "status") {
		return { status: "failed", reason: "status query fallback is not implemented yet (reserved hook)" };
	}

	const text = String(spec.text || "").trim();
	if (!text) return { status: "failed", reason: "empty query" };

	const directBy = (looksLikeCssSelector(text) || looksLikeXPath(text)) ? normalizeSelectorToken(text) : "";
	const byDirect = directBy ? await validateSelectorCandidate(page, directBy, spec.text, expectedMulti) : { ok: false };
	if (directBy && byDirect.ok) {
		await logger?.debug("query.by.direct_hit", { cacheKey, selector: directBy });
		const sigKey = await computeSigKey(webRpa, page, directBy);
		await saveSelectorScoped({
			selector: directBy,
			sigKey,
			mode: selectorMode || spec.mode || "instance",
			policy: "single",
		});
		return { status: "done", value: { kind: "selector", selector: directBy, sigKey, fromCache: false } };
	}

	if (!forceRegenerate && isSearchInputIntent(spec.text)) {
		let pageUrl = "";
		try { pageUrl = await page.url(); } catch (_) {}
		const candidates = getHostSearchInputCandidates(pageUrl);
		if (candidates.length) {
			await logger?.debug("query.site_fallback.try", { cacheKey, candidates: candidates.slice(0, 6) });
				for (const candidateRaw of candidates) {
					const candidate = normalizeSelectorToken(candidateRaw);
					const v = await validateSelectorCandidate(page, candidate, spec.text, expectedMulti);
				if (!v.ok) {
					await logger?.debug("query.site_fallback.reject", {
						cacheKey,
						selector: candidate,
						reason: v.reason || "invalid",
						count: Number(v.count || 0),
					});
					continue;
				}
				const sigKey = await computeSigKey(webRpa, page, candidate);
				await saveSelectorScoped({
					selector: candidate,
					sigKey,
					mode: selectorMode || spec.mode || "instance",
					policy: "single",
					share: true,
				});
				await logger?.info("query.site_fallback.hit", { cacheKey, selector: candidate });
				return {
					status: "done",
					value: {
						kind: "selector",
						selector: candidate,
						sigKey,
						fromCache: false,
						byHeuristic: true,
					},
				};
			}
		}
	}

	let feedbackNote = String(aiFeedback || "").trim();
	let lastFailReason = "ai returned selectors but none matched page";
	const tipSeed = String(cacheKey || "selector").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64) || "selector";
	const tipId = await showAiBusyTip({
		webRpa,
		page,
		tipId: `__flow_ai_selector_${tipSeed}__`,
		text: buildSelectorAiTipText(0, 2),
		logger,
	});
	try {
		for (let pass = 0; pass < 2; pass++) {
			if (pass > 0) {
				await showAiBusyTip({
					webRpa,
					page,
					tipId: tipId || `__flow_ai_selector_${tipSeed}__`,
					text: buildSelectorAiTipText(pass, 2),
					logger,
				});
			}
			const ai = await resolveSelectorByAI({ query: spec.text, webRpa, page, session, aiOptions, feedbackNote, expectedMulti, logger });
			if (!ai.ok) {
				await logger?.warn("query.ai.failed", { cacheKey, reason: ai.reason || "unknown", pass: pass + 1 });
				lastFailReason = `resolve selector failed: ${ai.reason || "unknown"}`;
				break;
			}
			await logger?.info("query.ai.candidates", { cacheKey, model: ai.model || null, count: ai.selectors.length, pass: pass + 1 });

			const failures = [];
			for (const candidateRaw of ai.selectors) {
				const candidate = normalizeSelectorToken(candidateRaw);
				const v = await validateSelectorCandidate(page, candidate, spec.text, expectedMulti);
				if (!v.ok) {
					failures.push({ selector: candidate, reason: v.reason || "invalid", count: Number(v.count || 0) });
					continue;
				}
				const sigKey = await computeSigKey(webRpa, page, candidate);
				await saveSelectorScoped({
					selector: candidate,
					sigKey,
					mode: selectorMode || spec.mode || "instance",
					policy: "single",
					share: true,
				});
				return {
					status: "done",
					value: {
						kind: "selector",
						selector: candidate,
						sigKey,
						fromCache: false,
						byAI: true,
						model: ai.model || null,
					},
				};
			}

			lastFailReason = "ai returned selectors but none passed strict validation";
			feedbackNote = `The following selectors failed validation: ${JSON.stringify(failures.slice(0, 5))}. Generate new selectors that match the user intent exactly.`;
			await logger?.warn("query.ai.validation_failed", { cacheKey, pass: pass + 1, failures: failures.slice(0, 5) });
		}
	} finally {
		await dismissAiBusyTip({ webRpa, page, tipId, logger });
	}

	return { status: "failed", reason: lastFailReason };
}

export { resolveQuery, normalizeQuerySpec };
