import { execRunJsAction, parseFlowVal, runBranchAction } from "./FlowExpr.mjs";
import { resolveQuery } from "./FlowQueryResolver.mjs";
import { resolveSelectorByAI, runAIAction } from "./FlowAIResolver.mjs";
import CacheAPI from "./FlowRuleCache.mjs";
import { createHash } from "node:crypto";

function sleep(ms) {
	const n = Number(ms || 0);
	if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
	return new Promise((r) => setTimeout(r, n));
}

function shortHash(value) {
	try {
		const raw = typeof value === "string" ? value : JSON.stringify(value);
		return createHash("sha1").update(String(raw || "")).digest("hex").slice(0, 12);
	} catch (_) {
		return String(value || "").slice(0, 12);
	}
}

function normalizePickValue(raw) {
	if (raw === undefined || raw === null) return null;
	if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
	const s = String(raw).trim();
	if (!s) return null;
	if (/^[+-]?\d+$/.test(s)) return Number.parseInt(s, 10);
	const low = s.toLowerCase();
	if (low === "first") return 1;
	if (low === "last") return -1;
	return s;
}

function parseFlowBool(raw, fallback = false) {
	if (raw === undefined || raw === null || raw === "") return !!fallback;
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "number") return Number.isFinite(raw) ? raw !== 0 : !!fallback;
	const s = String(raw).trim().toLowerCase();
	if (!s) return !!fallback;
	if (["1", "true", "yes", "y", "on"].includes(s)) return true;
	if (["0", "false", "no", "n", "off"].includes(s)) return false;
	return !!fallback;
}

function parsePositiveInt(raw, fallback, min = 1, max = 200000) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseSelectorReviewResult(ret) {
	const out = { action: "abort", feedback: "" };
	if (!Array.isArray(ret)) return out;
	const codes = [];
	for (const item of ret) {
		if (item && typeof item === "object" && typeof item.code === "string") codes.push(String(item.code));
		if (typeof item === "string" && item.trim()) out.feedback = item.trim();
	}
	if (codes.includes("fit")) out.action = "fit";
	else if (codes.includes("retry")) out.action = "retry";
	else if (codes.includes("manual")) out.action = "manual";
	else if (codes.includes("abort")) out.action = "abort";
	else if (out.feedback) out.action = "retry";
	return out;
}

function buildPickedElementQuery(picked, mode, extraFeedback = "") {
	const need = mode === "multi" ? "返回可匹配一组同类元素的稳定 selector" : "返回尽量唯一且稳定的 selector";
	const hintText = String(picked?.text || "").trim();
	const lines = [
		`我已经人工选中了一个网页元素，请根据这个元素生成 selector。目标要求：${need}。`,
		`已选元素信息：tag=${picked?.tagName || ""}, id=${picked?.id || ""}, class=${picked?.className || ""}, name=${picked?.name || ""}, role=${picked?.role || ""}, aria-label=${picked?.ariaLabel || ""}, href=${picked?.href || ""}`,
		`已选元素简易 selector: ${picked?.selector || ""}`,
		`元素文本: ${hintText || "(空)"}`,
		`已选元素 outerHTML 片段: ${picked?.outerHTML || ""}`,
	];
	if (extraFeedback) lines.push(`用户补充要求：${extraFeedback}`);
	return lines.join("\n");
}

async function pickElementDetails(webRpa, page) {
	if (!webRpa || !page || typeof webRpa.inPagePickDomElement !== "function") return null;
	const pickedHandle = await webRpa.inPagePickDomElement(page, {
		preventPageClick: true,
		ignoreSelectors: ["#__ai2apps_prompt_root__", "#__ai2apps_tip_root__", "#__ai2apps_selector_root__"],
	});
	if (!pickedHandle) return null;
	try {
		const details = await page.callFunction(
			function (ret) {
				if (!ret || ret.ok !== true) return null;
				const el = ret.element || null;
				const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
				const attr = (name) => {
					try { return el ? clean(el.getAttribute(name) || "") : ""; } catch (_) { return ""; }
				};
				return {
					ok: true,
					selector: clean(ret.selector || ""),
					tagName: clean(ret.tagName || ""),
					id: clean(ret.id || ""),
					className: clean(ret.className || ""),
					rect: ret.rect || null,
					text: el ? clean(el.innerText || el.textContent || "").slice(0, 280) : "",
					outerHTML: el ? String(el.outerHTML || "").slice(0, 5000) : "",
					name: attr("name"),
					role: attr("role"),
					ariaLabel: attr("aria-label"),
					href: attr("href"),
				};
			},
			[pickedHandle],
			{ awaitPromise: true }
		);
		return details && details.ok ? details : null;
	} finally {
		try { await page.disown(pickedHandle); } catch (_) {}
	}
}

async function reviewSelectorWithUser({ webRpa, page, selector, count }) {
	const ret = await webRpa.inPagePrompt(
		page,
		`候选 selector:\n${selector}\n\n当前高亮匹配数量: ${Number(count || 0)}\n\n请选择操作，可附加文本提示。`,
		{
			modal: true,
			mask: "rgba(0,0,0,0.24)",
			showCancel: false,
			menu: [
				{ text: "合适", code: "fit" },
				{ text: "重试AI", code: "retry" },
				{ text: "手动指定元素", code: "manual" },
				{ text: "中止当前动作", code: "abort" },
			],
			multiSelect: true,
			allowEmpty: false,
			edit: true,
			placeHolder: "可选：给AI的补充提示（例如：不要nth-child，优先data-testid）",
			okText: "确认",
		}
	);
	return parseSelectorReviewResult(ret);
}

async function superviseResolvedSelector({
	webRpa,
	page,
	session,
	aiOptions = null,
	initialSelector,
	queryText = "",
	expectedMulti = false,
	logger = null,
}) {
	if (!webRpa || !page) return { ok: false, reason: "no active page" };
	let candidate = String(initialSelector || "").trim();
	let feedbackNote = "";
	const maxPass = 6;
	await logger?.info("selector.supervision.begin", {
		initialSelector: candidate.slice(0, 180),
		expectedMulti: !!expectedMulti,
	});
	for (let pass = 1; pass <= maxPass; pass++) {
		if (!candidate) return { ok: false, reason: "empty selector candidate" };
		let count = 0;
		try {
			count = await webRpa.inPageShowSelector(page, candidate, { color: "#1890ff", thickness: 2 });
		} catch (_) {
			count = 0;
		}
		await logger?.info("selector.supervision.show", {
			pass,
			selector: candidate.slice(0, 180),
			count: Number(count || 0),
		});
		const decision = await reviewSelectorWithUser({ webRpa, page, selector: candidate, count });
		await logger?.info("selector.supervision.decision", {
			pass,
			action: decision.action,
			hasFeedback: !!String(decision.feedback || "").trim(),
		});
		if (decision.action === "fit") {
			await webRpa.inPageDismissSelector(page);
			await logger?.info("selector.supervision.accepted", { pass, selector: candidate.slice(0, 180) });
			return { ok: true, selector: candidate };
		}
		if (decision.action === "abort") {
			await webRpa.inPageDismissSelector(page);
			await logger?.warn("selector.supervision.aborted", { pass });
			return { ok: false, reason: "selector selection aborted by user" };
		}
		if (decision.action === "manual") {
			await webRpa.inPageDismissSelector(page);
			await webRpa.inPageTip(page, "请点击你希望操作的目标元素（Esc 可取消）", {
				timeout: 2500,
				stack: false,
			});
			const picked = await pickElementDetails(webRpa, page);
			if (!picked) {
				await logger?.warn("selector.supervision.manual_cancelled", { pass });
				return { ok: false, reason: "manual pick cancelled" };
			}
			const manualQuery = buildPickedElementQuery(picked, expectedMulti ? "multi" : "single", decision.feedback || "");
			await logger?.info("selector.supervision.manual_picked", {
				pass,
				tagName: String(picked.tagName || "").slice(0, 48),
				id: String(picked.id || "").slice(0, 96),
				className: String(picked.className || "").slice(0, 120),
			});
			const ai = await resolveSelectorByAI({
				query: manualQuery,
				webRpa,
				page,
				session,
				aiOptions,
				feedbackNote: decision.feedback || "",
				expectedMulti,
			});
			if (!ai?.ok || !Array.isArray(ai.selectors) || !ai.selectors.length) {
				await logger?.warn("selector.supervision.manual_regen_failed", {
					pass,
					reason: ai?.reason || "AI regeneration failed after manual pick",
				});
				return { ok: false, reason: ai?.reason || "AI regeneration failed after manual pick" };
			}
			candidate = String(ai.selectors[0] || "").trim();
			await logger?.info("selector.supervision.manual_regen", { pass, nextCandidate: candidate.slice(0, 180) });
			continue;
		}
		await webRpa.inPageDismissSelector(page);
		feedbackNote = decision.feedback
			? `用户反馈：${decision.feedback}`
			: "上一次候选不合适，请重新生成更稳定、更准确的 selector。";
		const ai = await resolveSelectorByAI({
			query: String(queryText || ""),
			webRpa,
			page,
			session,
			aiOptions,
			feedbackNote,
			expectedMulti,
		});
		if (!ai?.ok || !Array.isArray(ai.selectors) || !ai.selectors.length) {
			await logger?.warn("selector.supervision.retry_failed", {
				pass,
				reason: ai?.reason || "AI regeneration failed",
			});
			return { ok: false, reason: ai?.reason || "AI regeneration failed" };
		}
		candidate = String(ai.selectors[0] || "").trim();
		await logger?.info("selector.supervision.retry", { pass, nextCandidate: candidate.slice(0, 160) });
	}
	try { await webRpa.inPageDismissSelector(page); } catch (_) {}
	await logger?.warn("selector.supervision.max_pass_reached", { maxPass });
	return { ok: false, reason: "selector supervision exceeded max retries" };
}

async function applyPickToSelector(page, selector, pickValue) {
	const pick = normalizePickValue(pickValue);
	if (pick === null) return { ok: true, selector: String(selector || ""), pickApplied: false, count: 1 };
	const by = String(selector || "").trim();
	if (!by) return { ok: false, reason: "empty selector", count: 0 };
	const out = await page.callFunction(
		function (rawBy, rawPick) {
			function asText(v) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim(); }
			function parseBy(raw) {
				const s = asText(raw);
				if (!s) return { kind: "css", expr: "" };
				if (/^css\s*:/i.test(s)) return { kind: "css", expr: s.replace(/^css\s*:/i, "").trim() };
				if (/^xpath\s*:/i.test(s)) return { kind: "xpath", expr: s.replace(/^xpath\s*:/i, "").trim() };
				if (/^(\/\/|\/|\(|\.\/|\.\.\/)/.test(s)) return { kind: "xpath", expr: s };
				return { kind: "css", expr: s };
			}
			function toAbsXpath(el) {
				if (!el || el.nodeType !== 1) return "";
				if (el.id) {
					const safe = String(el.id).replace(/"/g, '\\"');
					return `//*[@id="${safe}"]`;
				}
				const segs = [];
				let n = el;
				while (n && n.nodeType === 1) {
					const tag = String(n.tagName || "").toLowerCase();
					if (!tag) break;
					let idx = 1;
					let p = n.previousElementSibling;
					while (p) {
						if (String(p.tagName || "").toLowerCase() === tag) idx += 1;
						p = p.previousElementSibling;
					}
					segs.unshift(`${tag}[${idx}]`);
					if (n === document.documentElement) break;
					n = n.parentElement;
				}
				return segs.length ? `/${segs.join("/")}` : "";
			}
			function getNodes(parsed) {
				if (!parsed.expr) return [];
				if (parsed.kind === "xpath") {
					try {
						const snap = document.evaluate(parsed.expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
						const arr = [];
						for (let i = 0; i < snap.snapshotLength; i += 1) {
							const n = snap.snapshotItem(i);
							if (n && n.nodeType === 1) arr.push(n);
						}
						return arr;
					} catch (_) {
						return [];
					}
				}
				try { return Array.from(document.querySelectorAll(parsed.expr)); } catch (_) { return []; }
			}
			function choose(nodes, pv) {
				if (!Array.isArray(nodes) || !nodes.length) return { node: null, index: -1 };
				if (typeof pv === "number" && Number.isFinite(pv)) {
					const n = Math.trunc(pv);
					let idx = 0;
					if (n === -1) idx = nodes.length - 1;
					else if (n >= 1) idx = n - 1;
					else if (n <= -2) idx = nodes.length + n;
					if (idx < 0 || idx >= nodes.length) return { node: null, index: -1 };
					return { node: nodes[idx], index: idx };
				}
				const q = asText(pv).toLowerCase();
				if (!q) return { node: nodes[0], index: 0 };
				for (let i = 0; i < nodes.length; i += 1) {
					const el = nodes[i];
					const hay = asText([
						el.innerText || "",
						el.textContent || "",
						el.getAttribute && el.getAttribute("aria-label"),
						el.getAttribute && el.getAttribute("title"),
						el.getAttribute && el.getAttribute("value"),
					].join(" ")).toLowerCase();
					if (hay.includes(q)) return { node: el, index: i };
				}
				return { node: null, index: -1 };
			}
			const parsed = parseBy(rawBy);
			if (!parsed.expr) return { ok: false, reason: "empty selector", count: 0 };
			const nodes = getNodes(parsed);
			if (!nodes.length) return { ok: false, reason: "pick base selector not found", count: 0 };
			const chosen = choose(nodes, rawPick);
			if (!chosen.node) return { ok: false, reason: `pick not found in ${nodes.length} matches`, count: nodes.length };
			const xp = toAbsXpath(chosen.node);
			if (!xp) return { ok: false, reason: "cannot build picked selector", count: nodes.length };
			return { ok: true, by: `xpath: ${xp}`, count: nodes.length, index: chosen.index + 1 };
		},
		[by, pick],
		{ awaitPromise: true }
	);
	if (!out || typeof out !== "object") return { ok: false, reason: "pick failed", count: 0 };
	if (!out.ok) return { ok: false, reason: String(out.reason || "pick failed"), count: Number(out.count || 0) };
	return {
		ok: true,
		selector: String(out.by || by),
		pickApplied: true,
		count: Number(out.count || 0),
		index: Number(out.index || 0),
	};
}

async function ensureInputFocusAfterClick(page, selector) {
	const by = String(selector || "").trim();
	if (!by) return { ok: false, reason: "empty selector" };
	const out = await page.callFunction(
		function (rawBy) {
			function asText(v) { return String(v == null ? "" : v).trim(); }
			function parseBy(raw) {
				const s = asText(raw);
				if (!s) return { kind: "css", expr: "" };
				if (/^css\s*:/i.test(s)) return { kind: "css", expr: s.replace(/^css\s*:/i, "").trim() };
				if (/^xpath\s*:/i.test(s)) return { kind: "xpath", expr: s.replace(/^xpath\s*:/i, "").trim() };
				if (/^(\/\/|\/|\(|\.\/|\.\.\/)/.test(s)) return { kind: "xpath", expr: s };
				return { kind: "css", expr: s };
			}
			function queryAll(parsed) {
				const expr = String(parsed?.expr || "").trim();
				if (!expr) return [];
				if (parsed.kind === "xpath") {
					const arr = [];
					try {
						const snap = document.evaluate(expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
						for (let i = 0; i < snap.snapshotLength; i++) {
							const n = snap.snapshotItem(i);
							if (n && n.nodeType === 1) arr.push(n);
						}
					} catch (_) {}
					return arr;
				}
				try {
					return Array.from(document.querySelectorAll(expr));
				} catch (_) {
					return [];
				}
			}
			function isInputLike(el) {
				if (!el || el.nodeType !== 1) return false;
				const tag = String(el.tagName || "").toLowerCase();
				if (tag === "textarea") return true;
				if (tag === "input") {
					const t = String(el.getAttribute("type") || "text").toLowerCase();
					if (["hidden", "checkbox", "radio", "submit", "button", "image", "reset"].includes(t)) return false;
					return true;
				}
				return !!el.isContentEditable;
			}
			function findFocusableInput(root) {
				if (!root || root.nodeType !== 1) return null;
				if (isInputLike(root)) return root;
				const q = "input:not([type='hidden']):not([disabled]),textarea:not([disabled]),[contenteditable='true'],[contenteditable=''],[contenteditable='plaintext-only']";
				return root.querySelector(q);
			}
			function toAbsXpath(el) {
				if (!el || el.nodeType !== 1) return "";
				if (el.id) {
					const safe = String(el.id).replace(/"/g, '\\"');
					return `//*[@id="${safe}"]`;
				}
				const segs = [];
				let n = el;
				while (n && n.nodeType === 1) {
					const tag = String(n.tagName || "").toLowerCase();
					if (!tag) break;
					let idx = 1;
					let p = n.previousElementSibling;
					while (p) {
						if (String(p.tagName || "").toLowerCase() === tag) idx += 1;
						p = p.previousElementSibling;
					}
					segs.unshift(`${tag}[${idx}]`);
					n = n.parentElement;
				}
				return segs.length ? `/${segs.join("/")}` : "";
			}
			function collectState(targetEl) {
				const active = document.activeElement;
				const focusedInput = isInputLike(active);
				const targetContainsActive = !!(targetEl && active && (active === targetEl || targetEl.contains(active)));
				const activeXp = focusedInput ? toAbsXpath(active) : "";
				return {
					activeTag: active ? String(active.tagName || "").toLowerCase() : "",
					activeType: active && active.getAttribute ? String(active.getAttribute("type") || "").toLowerCase() : "",
					targetTag: targetEl ? String(targetEl.tagName || "").toLowerCase() : "",
					focusedInput,
					targetContainsActive,
					focusedSelector: activeXp ? `xpath: ${activeXp}` : "",
					ok: focusedInput && targetContainsActive,
				};
			}

			const parsed = parseBy(rawBy);
			const nodes = queryAll(parsed);
			const target = nodes[0] || null;
			let state = collectState(target);
			if (state.ok) return { ...state, attemptedRefocus: false, matchedCount: nodes.length };

			const focusTarget = findFocusableInput(target);
			if (focusTarget) {
				try { focusTarget.focus({ preventScroll: true }); } catch (_) {}
				try { focusTarget.click(); } catch (_) {}
			}
			state = collectState(target);
			return { ...state, attemptedRefocus: true, matchedCount: nodes.length };
		},
		[by],
		{ awaitPromise: true }
	);
	if (!out || typeof out !== "object") {
		return { ok: false, reason: "focus check failed" };
	}
	if (out.ok) return { ok: true, value: out };
	return {
		ok: false,
		reason: `input focus not confirmed (activeTag=${String(out.activeTag || "")}, targetTag=${String(out.targetTag || "")}, matched=${Number(out.matchedCount || 0)})`,
		value: out,
	};
}

async function saveSelectorCorrectionToCache(page, { cacheKey, queryText, selector, mode = "instance", sigKey = null }) {
	const key = String(cacheKey || "").trim();
	const by = String(selector || "").trim();
	if (!key || !by) return false;
	const ctx = await CacheAPI.openRuleCache(null, page);
	if (!ctx) return false;
	CacheAPI.saveSelector(ctx, key, {
		query: String(queryText || "").trim(),
		selectors: by,
		sigKey: sigKey || null,
		mode: String(mode || "instance"),
		policy: "single",
		share: true,
	});
	await CacheAPI.flushRuleCache(ctx);
	return true;
}

async function inspectActiveInputFocus(page) {
	const out = await page.callFunction(
		function () {
			function isInputLike(el) {
				if (!el || el.nodeType !== 1) return false;
				const tag = String(el.tagName || "").toLowerCase();
				if (tag === "textarea") return true;
				if (tag === "input") {
					const t = String(el.getAttribute("type") || "text").toLowerCase();
					if (["hidden", "checkbox", "radio", "submit", "button", "image", "reset"].includes(t)) return false;
					return true;
				}
				return !!el.isContentEditable;
			}
			const el = document.activeElement;
			return {
				ok: isInputLike(el),
				activeTag: el ? String(el.tagName || "").toLowerCase() : "",
				activeType: el && el.getAttribute ? String(el.getAttribute("type") || "").toLowerCase() : "",
				activeId: el && el.getAttribute ? String(el.getAttribute("id") || "") : "",
			};
		},
		[],
		{ awaitPromise: true }
	);
	if (!out || typeof out !== "object") return { ok: false, reason: "active focus inspect failed" };
	if (out.ok) return { ok: true, value: out };
	return {
		ok: false,
		reason: `no input-like active element (activeTag=${String(out.activeTag || "")})`,
		value: out,
	};
}

async function waitUrlStable(page, stableMs = 600, maxWaitMs = 6000, pollMs = 120) {
	const stableTarget = Math.max(0, Number(stableMs || 0));
	const maxWait = Math.max(0, Number(maxWaitMs || 0));
	const poll = Math.max(50, Number(pollMs || 120));
	if (stableTarget <= 0 || maxWait <= 0) {
		try {
			return await page.url();
		} catch (_) {
			return "";
		}
	}

	const startedAt = Date.now();
	let last = "";
	try { last = await page.url(); } catch (_) {}
	let unchanged = 0;
	while ((Date.now() - startedAt) < maxWait) {
		await sleep(poll);
		let cur = last;
		try { cur = await page.url(); } catch (_) {}
		if (cur === last) {
			unchanged += poll;
			if (unchanged >= stableTarget) return cur;
		} else {
			last = cur;
			unchanged = 0;
		}
	}
	return last;
}

async function listLivePages(webRpa, fallbackPage = null) {
	const out = [];
	const seen = new Set();
	const pushOne = (p) => {
		if (!p || typeof p !== "object") return;
		const ctx = String(p.context || "").trim();
		if (!ctx || seen.has(ctx)) return;
		seen.add(ctx);
		out.push(p);
	};
	try {
		if (webRpa?.browser && typeof webRpa.browser.getPages === "function") {
			const pages = await webRpa.browser.getPages();
			for (const p of (Array.isArray(pages) ? pages : [])) pushOne(p);
		}
	} catch (_) {
	}
	if (!out.length && Array.isArray(webRpa?.sessionPages)) {
		for (const p of webRpa.sessionPages) pushOne(p);
	}
	pushOne(webRpa?.currentPage || null);
	pushOne(fallbackPage || null);
	return out;
}

async function activatePageBestEffort(webRpa, page) {
	if (!page) return;
	try { webRpa?.setCurrentPage?.(page); } catch (_) {}
	try { await webRpa?.browser?.activate?.(); } catch (_) {}
	try { await page?.bringToFront?.({ focusBrowser: true }); } catch (_) {}
}

function addUsedContext(opts, pageLike) {
	const ctx = String(pageLike?.context || "").trim();
	if (!ctx) return;
	const runCtx = opts?.__flowRunCtx;
	if (runCtx && runCtx.usedContextIds instanceof Set) runCtx.usedContextIds.add(ctx);
}

async function executeStepAction(runtime) {
	const { webRpa, page, session, action, args, opts, vars, lastResult, flowId, stepId, logger } = runtime;
	if (!action || !action.type) return { status: "failed", reason: "missing action.type" };
	await logger?.debug("action.dispatch", { stepId, actionType: action.type });
	const getActivePage = () => webRpa?.currentPage || page || null;
	const requireActivePage = (actionType) => {
		const p = getActivePage();
		if (!p) throw new Error(`${actionType}: no active page (webRpa.currentPage/page missing)`);
		return p;
	};

	const resolveTarget = async ({ forceRegenerate = false, aiFeedback = "" } = {}) => {
		const activePage = getActivePage();
		if (!activePage) {
			return { status: "failed", reason: "no active page for query/by resolution" };
		}
		const byRaw = parseFlowVal(action.by, args, opts, vars, lastResult);
		const by = String(byRaw == null ? "" : byRaw).trim();
		const byLower = by.toLowerCase();
		const byIsExplicit = /^css\s*:/i.test(by) || /^xpath\s*:/i.test(by);
		const byIsXPathExpr = /^(\/\/|\/|\(|\.\/|\.\.\/)/.test(by);
		const byIsInvalidToken = ["css", "xpath", "text"].includes(byLower);
		const byUsable = !!by && !byIsInvalidToken && (byIsExplicit || byIsXPathExpr || !action.query);
		if (byUsable) {
			return { status: "done", value: { selector: by } };
		}
		if (by && !byUsable) {
			await logger?.warn("target.by_ignored", {
				stepId,
				actionType: action.type,
				by,
				reason: byIsInvalidToken ? "invalid token" : "non-prefixed by with query present",
			});
		}
		if (!action.query) {
			return { status: "failed", reason: "missing query/by" };
		}
		const cacheKeyBase = String(
			parseFlowVal(action.cacheKey || `${flowId}_${stepId}`, args, opts, vars, lastResult) || `${flowId}_${stepId}`
		);
		const cacheKeySuffixRaw = action.cacheKeySuffix !== undefined
			? parseFlowVal(action.cacheKeySuffix, args, opts, vars, lastResult)
			: "";
		const cacheKey = String(cacheKeySuffixRaw || "").trim()
			? `${cacheKeyBase}__${shortHash(cacheKeySuffixRaw)}`
			: cacheKeyBase;
			const resolvedQueryText = parseFlowVal(action.query, args, opts, vars, lastResult);
			const cacheSourcePolicy = parseFlowVal(
				action.queryCacheSourcePolicy ?? action.cacheSourcePolicy ?? "",
				args,
				opts,
				vars,
				lastResult
			);
			const cacheWritePolicy = parseFlowVal(
				action.queryCacheWritePolicy ?? action.cacheWritePolicy ?? "",
				args,
				opts,
				vars,
				lastResult
			);
			const resolved = await resolveQuery({
				webRpa,
				page: activePage,
			session,
			aiOptions: opts?.ai || null,
			cacheKey,
			query: resolvedQueryText,
			cacheKind: action.query?.kind || "selector",
			cachePolicy: action.query?.policy || "pool",
			selectorMode: action.query?.mode || "instance",
				expectedMulti: action?.multi === true || normalizePickValue(parseFlowVal(action.pick, args, opts, vars, lastResult)) !== null,
				forceRegenerate: !!forceRegenerate,
				aiFeedback: String(aiFeedback || ""),
				cacheSourcePolicy,
				cacheWritePolicy,
				logger,
			});
		const supervisionOn = !!opts?.selectorSupervision;
		if (
			supervisionOn &&
			resolved?.status === "done" &&
			action.query &&
			resolved?.value?.selector &&
			typeof webRpa?.inPageShowSelector === "function" &&
			typeof webRpa?.inPagePrompt === "function" &&
			typeof webRpa?.inPageDismissSelector === "function"
		) {
			await logger?.info("selector.supervision.start", {
				stepId,
				actionType: action.type,
				query: String(parseFlowVal(action.query, args, opts, vars, lastResult) || "").slice(0, 200),
				selector: String(resolved.value.selector || "").slice(0, 180),
			});
			const supervised = await superviseResolvedSelector({
				webRpa,
				page: activePage,
				session,
				aiOptions: opts?.ai || null,
				initialSelector: resolved.value.selector,
				queryText: parseFlowVal(action.query, args, opts, vars, lastResult),
				expectedMulti: action?.multi === true || normalizePickValue(parseFlowVal(action.pick, args, opts, vars, lastResult)) !== null,
				logger,
			});
			if (!supervised.ok) {
				return { status: "failed", reason: supervised.reason || "selector rejected by user" };
			}
			return {
				...resolved,
				value: {
					...(resolved.value || {}),
					selector: supervised.selector,
					supervised: true,
					cacheKey,
					queryText: String(resolvedQueryText || ""),
					selectorMode: action.query?.mode || "instance",
				},
			};
		}
		if (resolved?.status === "done" && resolved?.value && action.query) {
			return {
				...resolved,
				value: {
					...(resolved.value || {}),
					cacheKey,
					queryText: String(resolvedQueryText || ""),
					selectorMode: action.query?.mode || "instance",
				},
			};
		}
		return resolved;
	};

	try {
			switch (action.type) {
			case "click": {
				const activePage = requireActivePage(action.type);
				const expectInputFocus = action.expectInputFocus === true;
				const maxAttempts = expectInputFocus && action.query ? 2 : 1;
				let feedback = "";
				for (let attempt = 1; attempt <= maxAttempts; attempt++) {
					const r = await resolveTarget({
						forceRegenerate: attempt > 1,
						aiFeedback: feedback,
					});
					if (r.status !== "done") return r;
					const selBase = r.value.selector || r.value?.selector;
					const pick = parseFlowVal(action.pick, args, opts, vars, lastResult);
					const picked = await applyPickToSelector(activePage, selBase, pick);
					if (!picked.ok) return { status: "failed", reason: picked.reason || "pick failed" };
					const sel = picked.selector || selBase;
					const clicked = await activePage.click(sel, {});
					if (clicked === false) return { status: "failed", reason: `click target not found: ${sel}` };

					if (expectInputFocus) {
						const focusCheck = await ensureInputFocusAfterClick(activePage, sel);
						if (!focusCheck.ok) {
							await logger?.warn("click.input_focus_not_confirmed", {
								stepId,
								attempt,
								selector: String(sel || "").slice(0, 180),
								reason: focusCheck.reason,
							});
							if (attempt < maxAttempts) {
								feedback = [
									`上一次 selector 无法聚焦输入元素：${String(sel || "")}`,
									`失败原因：${String(focusCheck.reason || "input focus not confirmed")}`,
									"请重新生成可稳定命中输入框并触发焦点的 selector，避免重复之前答案。",
								].join("\n");
								await logger?.info("click.input_focus_retry", { stepId, attempt, nextAttempt: attempt + 1 });
								continue;
							}
							return { status: "failed", reason: focusCheck.reason || "input focus not confirmed" };
						}
						await logger?.info("click.input_focus_confirmed", {
							stepId,
							attempt,
							selector: String(sel || "").slice(0, 180),
							activeTag: focusCheck.value?.activeTag || "",
							targetTag: focusCheck.value?.targetTag || "",
						});
					}

					const postWaitMs = Math.max(0, Number(action.postWaitMs || 0));
					if (postWaitMs > 0) await sleep(postWaitMs);
					return {
						status: "done",
						value: {
							by: sel,
							byBase: selBase,
							pick: normalizePickValue(pick),
							pickApplied: picked.pickApplied,
							pickCount: picked.count || null,
							pickIndex: picked.index || null,
						},
					};
				}
				return { status: "failed", reason: "click failed after retries" };
			}
			case "hover": {
				const activePage = requireActivePage(action.type);
				const r = await resolveTarget();
				if (r.status !== "done") return r;
				const selBase = r.value.selector || r.value?.selector;
				const pick = parseFlowVal(action.pick, args, opts, vars, lastResult);
				const picked = await applyPickToSelector(activePage, selBase, pick);
				if (!picked.ok) return { status: "failed", reason: picked.reason || "pick failed" };
				const sel = picked.selector || selBase;
				await activePage.hover(sel, {});
				return { status: "done", value: { by: sel, byBase: selBase, pick: normalizePickValue(pick), pickApplied: picked.pickApplied, pickCount: picked.count || null, pickIndex: picked.index || null } };
			}
			case "goto": {
				const url = parseFlowVal(action.url, args, opts, vars, lastResult);
				const newPageRaw = action.newPage === undefined ? false : parseFlowVal(action.newPage, args, opts, vars, lastResult);
				const useNewPage = parseFlowBool(newPageRaw, false);
				const timeoutMs = Number(action.timeoutMs || 0);
				const retryOnAbort = Math.max(0, Number(action.retryOnAbort ?? 1));
				const hasPostWait = Object.prototype.hasOwnProperty.call(action || {}, "postWaitMs");
				const postWaitRaw = hasPostWait
					? parseFlowVal(action.postWaitMs, args, opts, vars, lastResult)
					: 1000;
				const postWaitMs = Number.isFinite(Number(postWaitRaw))
					? Math.max(0, Math.floor(Number(postWaitRaw)))
					: 0;
				const stableMs = Math.max(0, Number(action.stableMs ?? 600));
				const settleTimeoutMs = Math.max(0, Number(action.settleTimeoutMs ?? 6000));
				const settlePollMs = Math.max(50, Number(action.settlePollMs ?? 120));
				const waitByRaw = action.waitBy ?? action.waitFor ?? "";
				const waitBy = waitByRaw ? parseFlowVal(waitByRaw, args, opts, vars, lastResult) : "";
				const waitTimeoutMs = Math.max(0, Number(action.waitTimeoutMs ?? 8000));
				const acceptAbortIfNavigated = action.acceptAbortIfNavigated !== false;
				const autoRecoverNoSuchFrame = action.autoRecoverNoSuchFrame !== false;
				let activePage = getActivePage();
				if (useNewPage) {
					if (!webRpa?.browser || typeof webRpa.openPage !== "function") {
						throw new Error("goto.newPage requires an active webRpa browser session");
					}
					activePage = await webRpa.openPage(webRpa.browser);
				}
				if (!activePage) {
					throw new Error(`${action.type}: no active page (webRpa.currentPage/page missing)`);
				}
				let navError = null;

				for (let attempt = 0; attempt <= retryOnAbort; attempt++) {
					try {
						await activePage.goto(url, { timeout: timeoutMs });
						navError = null;
						break;
					} catch (e) {
						navError = e;
						const msg = String(e?.message || "");
						const isNoSuchFrame = /no such frame|browsing context.+not found|context.+not found/i.test(msg);
						if (isNoSuchFrame && autoRecoverNoSuchFrame) {
							if (!webRpa?.browser || typeof webRpa.openPage !== "function") throw e;
							await logger?.warn("goto.context_lost.recover_open_page", {
								stepId,
								attempt: attempt + 1,
								maxAttempts: retryOnAbort + 1,
								url,
								reason: msg.slice(0, 260),
							});
							try {
								activePage = await webRpa.openPage(webRpa.browser);
								webRpa?.setCurrentPage?.(activePage);
								addUsedContext(opts, activePage);
							} catch (openErr) {
								throw new Error(`goto: failed to recover page after context lost: ${String(openErr?.message || openErr || "unknown")}`);
							}
							continue;
						}
						const isBindingAbort = /NS_BINDING_ABORTED/i.test(msg);
						if (!isBindingAbort) throw e;
						await logger?.warn("goto.binding_aborted", {
							stepId,
							attempt: attempt + 1,
							maxAttempts: retryOnAbort + 1,
							url,
						});
						if (attempt < retryOnAbort) {
							await sleep(250);
							continue;
						}
						if (!acceptAbortIfNavigated) throw e;
						let curUrl = "";
						try { curUrl = await activePage.url(); } catch (_) {}
						if (!curUrl || /^about:blank/i.test(curUrl)) throw e;
						await logger?.info("goto.binding_aborted.accepted", { stepId, url: curUrl });
					}
				}

				if (navError && action.acceptAbortIfNavigated === false) {
					throw navError;
				}
				if (waitBy) {
					await activePage.waitForSelector(waitBy, { timeout: waitTimeoutMs });
				}
				await waitUrlStable(activePage, stableMs, settleTimeoutMs, settlePollMs);
				if (postWaitMs > 0) await sleep(postWaitMs);
				return { status: "done", value: { url: await activePage.url(), newPage: useNewPage, pageId: activePage.context || null } };
			}
			case "closePage": {
				const activePage = getActivePage();
				const allPages = await listLivePages(webRpa, activePage);
				if (!allPages.length) return { status: "failed", reason: "closePage: no page to close" };
				const byContext = new Map();
				for (const p of allPages) {
					const cid = String(p?.context || "").trim();
					if (cid) byContext.set(cid, p);
				}
				const targetRaw = parseFlowVal(action.target ?? "active", args, opts, vars, lastResult);
				const target = String(targetRaw || "active").trim().toLowerCase();
				const ifLast = String(parseFlowVal(action.ifLast ?? "skip", args, opts, vars, lastResult) || "skip").trim().toLowerCase();
				const activateAfterClose = parseFlowBool(parseFlowVal(action.activateAfterClose ?? true, args, opts, vars, lastResult), true);
				const postWaitMs = Math.max(0, Number(parseFlowVal(action.postWaitMs ?? 0, args, opts, vars, lastResult) || 0));
				const activeCtx = String((webRpa?.currentPage || activePage)?.context || "").trim();
				let targetPages = [];
				if (target === "flow") {
					const used = (opts?.__flowRunCtx?.usedContextIds instanceof Set) ? Array.from(opts.__flowRunCtx.usedContextIds) : [];
					targetPages = used.map((cid) => byContext.get(String(cid || "").trim())).filter(Boolean);
				} else if (target === "contextid" || target === "context_id" || target === "context") {
					const cidRaw = parseFlowVal(action.contextId, args, opts, vars, lastResult);
					const cid = String(cidRaw || "").trim();
					if (!cid) return { status: "failed", reason: "closePage: target=contextId requires contextId" };
					const p = byContext.get(cid);
					if (p) targetPages = [p];
				} else if (target === "urlmatch" || target === "url_match" || target === "url") {
					const m = String(parseFlowVal(action.matchUrl, args, opts, vars, lastResult) || "").trim();
					if (!m) return { status: "failed", reason: "closePage: target=urlMatch requires matchUrl" };
					const needle = m.toLowerCase();
					for (const p of allPages) {
						let u = "";
						try { u = String(await p.url() || ""); } catch (_) {}
						if (u.toLowerCase().includes(needle)) targetPages.push(p);
					}
				} else {
					const p = byContext.get(activeCtx);
					if (p) targetPages = [p];
				}
				// unique by context
				const seenClose = new Set();
				targetPages = targetPages.filter((p) => {
					const cid = String(p?.context || "").trim();
					if (!cid || seenClose.has(cid)) return false;
					seenClose.add(cid);
					return true;
				});
				if (!targetPages.length) return { status: "failed", reason: "closePage: target page not found" };

				const closedContextIds = [];
				const skippedContextIds = [];
				let remaining = allPages.length;
				for (const p of targetPages) {
					const cid = String(p?.context || "").trim();
					if (!cid) continue;
					if (remaining <= 1 && ifLast !== "allow") {
						if (ifLast === "fail") {
							return {
								status: "failed",
								reason: `closePage: refuse to close last page (${cid})`,
								value: { closedContextIds, skippedContextIds: [...skippedContextIds, cid], remainingContexts: remaining },
							};
						}
						skippedContextIds.push(cid);
						continue;
					}
					try {
						await webRpa.closePage(p);
						closedContextIds.push(cid);
						remaining = Math.max(0, remaining - 1);
					} catch (e) {
						return {
							status: "failed",
							reason: `closePage: close failed (${cid}): ${String(e?.message || e || "unknown")}`,
							value: { closedContextIds, skippedContextIds, remainingContexts: remaining },
						};
					}
				}
				const leftPages = await listLivePages(webRpa, null);
				let nextActive = webRpa?.currentPage || null;
				if (!nextActive && leftPages.length) nextActive = leftPages[leftPages.length - 1];
				if (nextActive && activateAfterClose) {
					await activatePageBestEffort(webRpa, nextActive);
				}
				addUsedContext(opts, nextActive);
				if (postWaitMs > 0) await sleep(postWaitMs);
				const skippedOnly = !closedContextIds.length && skippedContextIds.length > 0;
				const status = skippedOnly ? "skipped" : "done";
				let activeUrl = "";
				try { activeUrl = String(await nextActive?.url?.() || ""); } catch (_) {}
				return {
					status,
					value: {
						closed: closedContextIds.length > 0,
						target,
						closedCount: closedContextIds.length,
						closedContextIds,
						skippedContextIds,
						remainingContexts: leftPages.length,
						activeContextId: String(nextActive?.context || ""),
						activeUrl,
					},
				};
			}
			case "press_key": {
				const activePage = requireActivePage(action.type);
				const times = Number(action.times || 1);
				const key = parseFlowVal(action.key, args, opts, vars, lastResult);
				const mods = Array.isArray(action.modifiers) ? action.modifiers : [];
				const shortcut = [...mods, key];
				for (let i = 0; i < times; i++) await activePage.pressShortcut(shortcut, {});
				return { status: "done", value: { key, times } };
			}
			case "input": {
				const activePage = requireActivePage(action.type);
				const textRaw = parseFlowVal(action.text, args, opts, vars, lastResult);
				const text = String(textRaw == null ? "" : textRaw);
				if (!text.trim()) {
					await logger?.warn("input.empty_text", {
						stepId,
						actionType: action.type,
						textExpr: typeof action.text === "string" ? action.text : null,
					});
					return { status: "failed", reason: "input text resolved empty" };
				}
				const preEnterWaitMs = Math.max(0, Number(action.preEnterWaitMs ?? action.enterWaitMs ?? 0));
				const postWaitMs = Math.max(0, Number(action.postWaitMs || 0));
				let focusSelector = "";
				let resolvedMeta = null;
				if (action.by || action.query) {
					const r = await resolveTarget();
					if (r.status !== "done") return r;
					const sel = r.value.selector || r.value?.selector;
					resolvedMeta = r.value || null;
					await activePage.click(sel, {});
					focusSelector = String(sel || "").trim();
				} else {
					const prevBy = String(lastResult?.value?.by || lastResult?.by || "").trim();
					if (/^(css|xpath)\s*:/i.test(prevBy)) focusSelector = prevBy;
				}
				if (focusSelector) {
					const focusCheck = await ensureInputFocusAfterClick(activePage, focusSelector);
					if (!focusCheck.ok) {
						await logger?.warn("input.focus_not_confirmed", {
							stepId,
							selector: String(focusSelector || "").slice(0, 180),
							reason: focusCheck.reason,
							detail: focusCheck.value || null,
						});
						return { status: "failed", reason: focusCheck.reason || "input focus not confirmed" };
					}
					await logger?.info("input.focus_confirmed", {
						stepId,
						selector: String(focusSelector || "").slice(0, 180),
						activeTag: focusCheck.value?.activeTag || "",
						targetTag: focusCheck.value?.targetTag || "",
						attemptedRefocus: !!focusCheck.value?.attemptedRefocus,
					});
					const corrected = String(focusCheck.value?.focusedSelector || "").trim();
					const cacheKey = String(resolvedMeta?.cacheKey || "").trim();
					const queryText = String(resolvedMeta?.queryText || "").trim();
					if (corrected && cacheKey && queryText && corrected !== focusSelector) {
						let sigKey = null;
						try {
							if (typeof webRpa?.computeSigKeyForSelector === "function") {
								sigKey = await webRpa.computeSigKeyForSelector(activePage, corrected, {});
							}
						} catch (_) {}
						try {
							const saved = await saveSelectorCorrectionToCache(activePage, {
								cacheKey,
								queryText,
								selector: corrected,
								mode: String(resolvedMeta?.selectorMode || "instance"),
								sigKey: sigKey || null,
							});
							await logger?.info("input.focus_cache_saved", {
								stepId,
								cacheKey,
								oldSelector: String(focusSelector || "").slice(0, 120),
								newSelector: corrected.slice(0, 120),
								saved: !!saved,
							});
						} catch (e) {
							await logger?.warn("input.focus_cache_save_failed", {
								stepId,
								cacheKey,
								reason: String(e?.message || e || "cache save failed"),
							});
						}
					}
				} else {
					const activeCheck = await inspectActiveInputFocus(activePage);
					if (!activeCheck.ok) {
						await logger?.warn("input.active_focus_missing", {
							stepId,
							reason: activeCheck.reason,
							detail: activeCheck.value || null,
						});
						return { status: "failed", reason: activeCheck.reason || "input focus not confirmed" };
					}
					await logger?.info("input.active_focus_ok", {
						stepId,
						activeTag: activeCheck.value?.activeTag || "",
						activeType: activeCheck.value?.activeType || "",
					});
				}
				if (action.clear || action.mode === "fill") {
					await activePage.pressShortcut(["SelectAll", "Backspace"], {});
				} else {
					const caret = action.caret || "end";
					// Ensure selection is collapsed before append; keyboard shortcuts are unreliable
					// on some rich editors and may leave whole-content selection active.
					await activePage.callFunction(
						function (caretPos) {
							const pos = String(caretPos || "end");
							const el = document.activeElement;
							if (!el) return false;
							try {
								const tag = String(el.tagName || "").toLowerCase();
								if (tag === "input" || tag === "textarea") {
									const len = String(el.value || "").length;
									const idx = pos === "start" ? 0 : len;
									if (typeof el.setSelectionRange === "function") {
										el.setSelectionRange(idx, idx);
										return true;
									}
								}
								if (el.isContentEditable) {
									const sel = window.getSelection();
									if (!sel) return false;
									const range = document.createRange();
									range.selectNodeContents(el);
									range.collapse(pos === "start");
									sel.removeAllRanges();
									sel.addRange(range);
									return true;
								}
							} catch (_) {}
							return false;
						},
						[caret],
						{ awaitPromise: true }
					);
				}
				if (action.mode === "paste") await activePage.pasteText(text, {});
				else await activePage.keyboard.type(text, {});
				if (action.pressEnter) {
					if (preEnterWaitMs > 0) await sleep(preEnterWaitMs);
					await activePage.pressShortcut(["Enter"], {});
				}
				if (postWaitMs > 0) await sleep(postWaitMs);
				return { status: "done", value: { text } };
			}
			case "selector": {
				const activePage = requireActivePage(action.type);
				const r = await resolveTarget();
				if (r.status !== "done") return r;
				const selBase = r.value.selector || r.value?.selector;
				const pick = parseFlowVal(action.pick, args, opts, vars, lastResult);
				const picked = await applyPickToSelector(activePage, selBase, pick);
				if (!picked.ok) return { status: "failed", reason: picked.reason || "pick failed" };
				const sel = picked.selector || selBase;
				return {
					status: "done",
					value: {
						by: sel,
						byBase: selBase,
						sigKey: r.value?.sigKey || null,
						fromCache: !!r.value?.fromCache,
						byAI: !!r.value?.byAI,
						model: r.value?.model || null,
						pick: normalizePickValue(pick),
						pickApplied: picked.pickApplied,
						pickCount: picked.count || null,
						pickIndex: picked.index || null,
					},
				};
			}
			case "wait": {
				const activePage = requireActivePage(action.type);
				const timeoutMs = Number(action.timeoutMs || 5000);
				const r = await resolveTarget();
				if (r.status !== "done") return r;
				const selBase = r.value.selector || r.value?.selector;
				const pick = parseFlowVal(action.pick, args, opts, vars, lastResult);
				const picked = await applyPickToSelector(activePage, selBase, pick);
				if (!picked.ok) return { status: "failed", reason: picked.reason || "pick failed" };
				const sel = picked.selector || selBase;
				try {
					await activePage.waitForSelector(sel, { timeout: timeoutMs });
					return { status: "done", value: { by: sel, byBase: selBase, pick: normalizePickValue(pick), pickApplied: picked.pickApplied, pickCount: picked.count || null, pickIndex: picked.index || null } };
				} catch (e) {
					const msg = String(e?.message || "");
					if (/timeout/i.test(msg)) return { status: "timeout", reason: `wait timeout: ${sel}` };
					throw e;
				}
			}
			case "scroll": {
				const activePage = requireActivePage(action.type);
				let selBase = "";
				let sel = "";
				const byCandidate = String(parseFlowVal(action.by, args, opts, vars, lastResult) || "").trim();
				const queryCandidate = String(parseFlowVal(action.query, args, opts, vars, lastResult) || "").trim();
				if (byCandidate || queryCandidate) {
					const r = await resolveTarget();
					if (r.status !== "done") return r;
					selBase = r.value.selector || r.value?.selector || "";
					const pick = parseFlowVal(action.pick, args, opts, vars, lastResult);
					const picked = await applyPickToSelector(activePage, selBase, pick);
					if (!picked.ok) return { status: "failed", reason: picked.reason || "pick failed" };
					sel = picked.selector || selBase;
				}
				const rawDx = parseFlowVal(action.deltaX ?? action.x ?? 0, args, opts, vars, lastResult);
				const rawDy = parseFlowVal(action.deltaY ?? action.y ?? 600, args, opts, vars, lastResult);
				const dx = Number.isFinite(Number(rawDx)) ? Number(rawDx) : 0;
				const dy = Number.isFinite(Number(rawDy)) ? Number(rawDy) : 0;
				const behaviorRaw = parseFlowVal(action.behavior ?? "instant", args, opts, vars, lastResult);
				const behavior = String(behaviorRaw || "").toLowerCase() === "smooth" ? "smooth" : "instant";
				const out = await activePage.callFunction(
					function (rawBy, deltaX, deltaY, scrollBehavior) {
						function asText(v) { return String(v == null ? "" : v).trim(); }
						function parseBy(raw) {
							const s = asText(raw);
							if (!s) return { kind: "css", expr: "" };
							if (/^css\s*:/i.test(s)) return { kind: "css", expr: s.replace(/^css\s*:/i, "").trim() };
							if (/^xpath\s*:/i.test(s)) return { kind: "xpath", expr: s.replace(/^xpath\s*:/i, "").trim() };
							if (/^(\/\/|\/|\(|\.\/|\.\.\/)/.test(s)) return { kind: "xpath", expr: s };
							return { kind: "css", expr: s };
						}
						function queryOne(parsed) {
							if (!parsed.expr) return null;
							if (parsed.kind === "xpath") {
								try {
									const found = document.evaluate(parsed.expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
									return found?.singleNodeValue || null;
								} catch (_) {
									return null;
								}
							}
							try { return document.querySelector(parsed.expr); } catch (_) { return null; }
						}
						const beforeX = Number(window.scrollX || window.pageXOffset || 0);
						const beforeY = Number(window.scrollY || window.pageYOffset || 0);
						let scrolledToTarget = false;
						const parsed = parseBy(rawBy);
						const target = queryOne(parsed);
						if (target && typeof target.scrollIntoView === "function") {
							try {
								target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
								scrolledToTarget = true;
							} catch (_) {}
						}
						const bx = Number.isFinite(Number(deltaX)) ? Number(deltaX) : 0;
						const by = Number.isFinite(Number(deltaY)) ? Number(deltaY) : 0;
						if (bx !== 0 || by !== 0 || !scrolledToTarget) {
							try {
								window.scrollBy({ left: bx, top: by, behavior: scrollBehavior === "smooth" ? "smooth" : "instant" });
							} catch (_) {
								window.scrollBy(bx, by);
							}
						}
						const afterX = Number(window.scrollX || window.pageXOffset || 0);
						const afterY = Number(window.scrollY || window.pageYOffset || 0);
						return {
							beforeX,
							beforeY,
							afterX,
							afterY,
							dx: afterX - beforeX,
							dy: afterY - beforeY,
							scrolledToTarget,
						};
					},
					[sel, dx, dy, behavior],
					{ awaitPromise: true }
				);
				const postWaitMs = Math.max(0, Number(action.postWaitMs || 0));
				if (postWaitMs > 0) await sleep(postWaitMs);
				return {
					status: "done",
					value: {
						by: sel || null,
						byBase: selBase || null,
						requestedDx: dx,
						requestedDy: dy,
						behavior,
						scroll: out && typeof out === "object" ? out : null,
					},
				};
			}
				case "run_js": {
					const activePage = getActivePage();
					if ((action.scope || "page") !== "agent" && !activePage) {
						return { status: "failed", reason: "run_js(page): no active page" };
					}
					const resolvedLogHtmlFlag = action.logHtml !== undefined
						? parseFlowVal(action.logHtml, args, opts, vars, lastResult)
						: (opts?.debug?.runJsHtml ?? process.env.FLOW_LOG_RUN_JS_HTML);
					const shouldLogRunJsHtml = parseFlowBool(resolvedLogHtmlFlag, false);
					const resolvedMaxCharsRaw = action.logHtmlMaxChars !== undefined
						? parseFlowVal(action.logHtmlMaxChars, args, opts, vars, lastResult)
						: (opts?.debug?.runJsHtmlMaxChars ?? process.env.FLOW_LOG_RUN_JS_HTML_MAX_CHARS);
					const runJsHtmlMaxChars = parsePositiveInt(resolvedMaxCharsRaw, 12000, 200, 2000000);
					if (shouldLogRunJsHtml && (action.scope || "page") !== "agent" && activePage) {
						try {
							let url = "";
							let title = "";
							let html = "";
							let snapshotError = "";
							let snapshotSource = "unknown";
							try { url = String(await activePage.url() || ""); } catch (_) {}
							try { title = String(await activePage.title() || ""); } catch (_) {}
							try {
								if (webRpa && typeof webRpa.readInnerHTML === "function") {
									// Prefer WebRpa cleaned HTML snapshot (same mechanism used by resolver/readPage).
									html = String(await webRpa.readInnerHTML(activePage, null, { removeHidden: true }) || "");
									snapshotSource = "webrpa.readInnerHTML(removeHidden=true)";
								}
							} catch (e) {
								snapshotError = String(e?.message || "readInnerHTML failed");
							}
							if (!html) {
								const fallback = await activePage.callFunction(
									function () {
										try {
											return String(document.documentElement?.outerHTML || document.body?.outerHTML || "");
										} catch (_) {
											return "";
										}
									},
									[],
									{ awaitPromise: true }
								);
								html = String(fallback || "");
								snapshotSource = "page.outerHTML";
							}
							await logger?.debug("run_js.html_snapshot", {
								stepId,
								scope: action.scope || "page",
								url,
								title: title.slice(0, 200),
								htmlLength: Number(html.length || 0),
								htmlTruncated: html.length > runJsHtmlMaxChars,
								html: html.slice(0, runJsHtmlMaxChars),
								snapshotSource,
								snapshotError,
							});
						} catch (e) {
							await logger?.warn("run_js.html_snapshot_failed", {
								stepId,
								reason: String(e?.message || "snapshot failed"),
							});
						}
					}
					let runJsAction = action;
					if ((!action.code || !String(action.code).trim()) && action.query) {
						const { resolveRunJsCode } = await import("./FlowRunJsResolver.mjs");
						const queryText = parseFlowVal(action.query, args, opts, vars, lastResult);
						const resolvedCallArgs = parseFlowVal(action.args, args, opts, vars, lastResult);
						let verifyInput = {};
						if (Array.isArray(resolvedCallArgs) && resolvedCallArgs.length > 0) {
							verifyInput = (resolvedCallArgs[0] && typeof resolvedCallArgs[0] === "object") ? resolvedCallArgs[0] : {};
						}
						const codeResolved = await resolveRunJsCode({
							cacheKey: `${flowId}_${stepId}_run_js`,
							query: queryText,
							webRpa,
							page: activePage,
							session,
							aiOptions: opts?.ai || null,
							scope: action.scope || "page",
							verifyInput,
							logger,
						});
						if (codeResolved.status !== "done") return codeResolved;
						runJsAction = {
						...action,
						code: codeResolved.value.code,
					};
				}
					return execRunJsAction(runJsAction, {
						args,
						opts,
						vars,
						result: lastResult,
					parseVal: parseFlowVal,
					pageEval: async (code, callArgs) => {
						return activePage.callFunction(code, callArgs, { awaitPromise: true });
					},
				});
			}
			case "branch": {
				const nextStepId = runBranchAction(action, args, opts, vars, lastResult);
				return { status: "done", value: nextStepId };
			}
			case "done": {
				const conclusion = action.conclusion !== undefined ? action.conclusion : (action.reason !== undefined ? action.reason : true);
				return { status: "done", value: parseFlowVal(conclusion, args, opts, vars, lastResult) };
			}
			case "abort": {
				const reason = action.reason !== undefined ? action.reason : "aborted by flow step";
				return { status: "failed", reason: String(parseFlowVal(reason, args, opts, vars, lastResult) || "aborted by flow step") };
			}
			case "run_ai": {
				const activePage = getActivePage();
				if (action?.page && !activePage) {
					return { status: "failed", reason: "run_ai: no active page for page context" };
				}
				const prompt = parseFlowVal(action.prompt, args, opts, vars, lastResult);
				if (!String(prompt || "").trim()) {
					return { status: "failed", reason: "run_ai: missing prompt" };
				}
				let inputValue;
				if ("input" in action) {
					inputValue = parseFlowVal(action.input, args, opts, vars, lastResult);
				}
				await logger?.info("run_ai.start", { stepId, modelTier: action.model || "balanced", hasInput: "input" in action });
				const aiResult = await runAIAction({
					action: { ...action, prompt },
					inputValue,
					webRpa,
					page: activePage,
					session,
					aiOptions: opts?.ai || null,
					logger,
				});
				if (!aiResult.ok) {
					await logger?.warn("run_ai.failed", { stepId, reason: aiResult.reason || "run_ai failed", model: aiResult.model || null });
					return { status: "failed", reason: aiResult.reason || "run_ai failed", meta: { model: aiResult.model || null } };
				}
				if (aiResult.envelope.status === "error") {
					await logger?.warn("run_ai.envelope_error", { stepId, reason: aiResult.envelope.reason || "run_ai error", model: aiResult.model || null });
					return { status: "failed", reason: aiResult.envelope.reason || "run_ai error", meta: { model: aiResult.model || null } };
				}
				await logger?.info("run_ai.done", { stepId, model: aiResult.model || null });
				return { status: "done", value: aiResult.envelope.result, meta: { model: aiResult.model || null } };
			}
			case "ask_assist":
			case "ask_assistant": {
				const activePage = requireActivePage(action.type);
				const reason = String(parseFlowVal(action.reason || "需要人工协助", args, opts, vars, lastResult) || "需要人工协助");
				const waitUserAction = action.waitUserAction !== false;
				const silent = !!opts?.silent;
				const modal = ("modal" in action)
					? !!parseFlowVal(action.modal, args, opts, vars, lastResult)
					: false;
				const mask = ("mask" in action)
					? parseFlowVal(action.mask, args, opts, vars, lastResult)
					: (modal ? "rgba(0,0,0,0.20)" : false);
				const okText = String(parseFlowVal(action.okText || "已处理，继续", args, opts, vars, lastResult) || "已处理，继续");
				const cancelText = String(parseFlowVal(action.cancelText || "无法处理", args, opts, vars, lastResult) || "无法处理");
				// Default to single prompt attempt. If a flow needs auto re-prompt, set action.maxRetry > 1 explicitly.
				const maxRetry = Math.max(1, Number(action.maxRetry || 1));
				const persistAcrossNav = ("persistAcrossNav" in action)
					? !!parseFlowVal(action.persistAcrossNav, args, opts, vars, lastResult)
					: true;
				const persistTtlMs = Math.max(0, Number(parseFlowVal(action.persistTtlMs ?? 120000, args, opts, vars, lastResult) || 120000));
				const reopenDelayMs = Math.max(50, Number(parseFlowVal(action.reopenDelayMs ?? 180, args, opts, vars, lastResult) || 180));

				if (silent) {
					await logger?.warn("ask_assist.silent_blocked", { stepId, waitUserAction });
					return { status: "failed", reason: "manual assist required but opts.silent=true" };
				}

				if (!waitUserAction) {
					await webRpa.inPageTip(activePage, reason, {
						icon: null,
						stack: false,
						timeout: Math.max(1000, Math.min(30000, Number(parseFlowVal(action.tipTimeoutMs ?? 5000, args, opts, vars, lastResult) || 5000))),
						persistAcrossNav,
						persistTtlMs: persistTtlMs > 0 ? persistTtlMs : 5000,
						pollMs: Math.max(200, Number(parseFlowVal(action.tipPollMs ?? 400, args, opts, vars, lastResult) || 400)),
					});
					await logger?.info("ask_assist.notified", { stepId });
					return { status: "done", value: { assisted: false, notified: true } };
				}

				let promptResult = null;
				for (let i = 0; i < maxRetry; i++) {
					promptResult = await webRpa.inPagePrompt(activePage, `${reason}\n\n完成后请点击“已处理，继续”。`, {
						icon: null,
						modal,
						mask,
						showCancel: true,
						okText,
						cancelText,
						persistAcrossNav,
						persistTtlMs,
						reopenDelayMs,
					});
					if (promptResult === true) break;
					if (promptResult === false) {
						// Page navigations can dismiss prompt and produce a false-like result.
						// Re-prompt until maxRetry; user can still explicitly choose cancel next time.
						await logger?.warn("ask_assist.retry_after_fail_like", { stepId, attempt: i + 1, maxRetry });
						await sleep(300);
						continue;
					}
					await sleep(150);
				}
				if (promptResult !== true) {
					await logger?.warn("ask_assist.failed", { stepId, code: promptResult === false ? "fail" : null });
					return { status: "failed", reason: "manual assist not completed" };
				}
				await logger?.info("ask_assist.done", { stepId });
				return { status: "done", value: { assisted: true, code: "ok" } };
			}
			case "readPage": {
				const activePage = requireActivePage(action.type);
				const field = action.field;
				const readOne = async (name) => {
					switch (name) {
						case "url":
							return await activePage.url();
						case "title":
							return await activePage.title();
						case "html":
							return await webRpa.readInnerHTML(activePage, null, { removeHidden: true });
						case "screenshot": {
							const data = await activePage.screenshot({ encoding: "base64", type: "jpeg", fullPage: false, quality: 0.6 });
							return `data:image/jpeg;base64,${data}`;
						}
						case "article":
							return await webRpa.readArticle(activePage, null, { removeHidden: false });
						default:
							throw new Error(`Unknown readPage field: ${name}`);
					}
				};

				try {
					if (typeof field === "string") {
						await logger?.info("read_page.start", { stepId, mode: "single", field });
						const v = await readOne(field);
						await logger?.info("read_page.done", { stepId, mode: "single", field });
						return { status: "done", value: v };
					}
					if (field && typeof field === "object") {
						const out = {};
						const keys = ["url", "title", "html", "screenshot", "article"];
						const req = keys.filter((k) => !!field[k]);
						await logger?.info("read_page.start", { stepId, mode: "multi", fields: req });
						for (const k of req) {
							out[k] = await readOne(k);
						}
						await logger?.info("read_page.done", { stepId, mode: "multi", fields: req });
						return { status: "done", value: out };
					}
					return { status: "failed", reason: "Invalid field for readPage action" };
				} catch (e) {
					await logger?.warn("read_page.failed", { stepId, reason: e?.message || "readPage failed" });
					return { status: "failed", reason: e?.message || "readPage action failed" };
				}
			}
			case "readElement": {
				const activePage = requireActivePage(action.type);
				const pick = String(parseFlowVal(action.pick, args, opts, vars, lastResult) || "").trim();
				if (!pick) return { status: "failed", reason: "readElement: missing pick" };
				const multi = action.multi === true;

				const r = await resolveTarget();
				if (r.status !== "done") return r;
				const by = r.value.selector || r.value?.selector;
				await logger?.info("read_element.start", { stepId, pick, multi, by });

				const payload = await activePage.callFunction(
					function (selector, pickName, isMulti, maxHtmlLen) {
						function selectAllBy(rawBy) {
							const s = String(rawBy || "").trim();
							if (!s) return [];
							if (s.startsWith("xpath:")) {
								const xp = s.slice(6).trim();
								if (!xp) return [];
								const out = [];
								const it = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
								for (let i = 0; i < it.snapshotLength; i++) {
									const n = it.snapshotItem(i);
									if (n && n.nodeType === 1) out.push(n);
								}
								return out;
							}
							let css = s;
							if (s.startsWith("css:")) css = s.slice(4).trim();
							if (!css) return [];
							try {
								return Array.from(document.querySelectorAll(css));
							} catch (_) {
								return [];
							}
						}

						function normText(el) {
							const raw = (el && (el.innerText || el.textContent)) || "";
							return String(raw).replace(/\s+/g, " ").trim();
						}

						function readOne(el, p) {
							if (!el || el.nodeType !== 1) return null;
							if (p === "text") return normText(el);
							if (p === "value") {
								const tag = (el.tagName || "").toLowerCase();
								if (tag === "input" || tag === "textarea" || tag === "select") {
									return String(el.value ?? "");
								}
								if (el.isContentEditable) return normText(el);
								return String(el.getAttribute("value") ?? "");
							}
							if (p === "html") {
								const raw = String(el.outerHTML || "");
								if (raw.length > maxHtmlLen) return { __truncated: true, value: raw.slice(0, maxHtmlLen) };
								return raw;
							}
							if (p === "html:inner") {
								const raw = String(el.innerHTML || "");
								if (raw.length > maxHtmlLen) return { __truncated: true, value: raw.slice(0, maxHtmlLen) };
								return raw;
							}
							if (p === "rect") {
								const r = el.getBoundingClientRect();
								return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, bottom: r.bottom, right: r.right };
							}
							if (p.startsWith("attr:")) {
								const name = p.slice(5).trim();
								if (!name) return null;
								return el.getAttribute(name);
							}
							return null;
						}

						const nodes = selectAllBy(selector);
						const count = nodes.length;
						if (!isMulti) {
							if (count === 0) return { ok: false, reason: "not found", count };
							if (count > 1) return { ok: false, reason: `multiple matches: ${count}`, count };
							const one = readOne(nodes[0], pickName);
							if (one && typeof one === "object" && one.__truncated) {
								return { ok: true, value: one.value, count: 1, truncated: true };
							}
							return { ok: true, value: one, count: 1, truncated: false };
						}
						if (count === 0) return { ok: false, reason: "not found", count };
						let truncated = false;
						const vals = nodes.map((n) => {
							const v = readOne(n, pickName);
							if (v && typeof v === "object" && v.__truncated) {
								truncated = true;
								return v.value;
							}
							return v;
						});
						return { ok: true, value: vals, count, truncated };
					},
					[by, pick, multi, 20000],
					{ awaitPromise: true }
				);

				if (!payload || !payload.ok) {
					const reason = payload?.reason || "readElement failed";
					await logger?.warn("read_element.failed", { stepId, pick, by, reason, count: payload?.count ?? 0 });
					return { status: "failed", reason, meta: { count: payload?.count ?? 0 }, value: { by } };
				}
				await logger?.info("read_element.done", { stepId, pick, by, count: payload.count, truncated: !!payload.truncated });
				return {
					status: "done",
					value: payload.value,
					meta: { count: payload.count, truncated: !!payload.truncated, by },
				};
			}
			case "invokeMany": {
				const activePage = getActivePage();
				const { invokeFlowAction } = await import("./FlowInvoke.mjs");
				const rawItems = parseFlowVal(action.items, args, opts, vars, lastResult);
				const items = Array.isArray(rawItems) ? rawItems : [];
				const concurrencyRaw = Number(parseFlowVal(action.concurrency ?? 2, args, opts, vars, lastResult));
				const concurrency = Math.max(1, Math.min(8, Number.isFinite(concurrencyRaw) ? Math.floor(concurrencyRaw) : 2));
				const continueOnError = action.continueOnError !== false;
				const itemVar = String(action.itemVar || "item").trim() || "item";
				const indexVar = String(action.indexVar || "itemIndex").trim() || "itemIndex";
				const totalVar = String(action.totalVar || "itemTotal").trim() || "itemTotal";
				const itemTimeoutMsRaw = Number(parseFlowVal(action.itemTimeoutMs ?? action.timeoutMs ?? 0, args, opts, vars, lastResult));
				const itemTimeoutMs = Math.max(0, Number.isFinite(itemTimeoutMsRaw) ? Math.floor(itemTimeoutMsRaw) : 0);

				if (!items.length) {
					return {
						status: "done",
						value: { items: [], meta: { total: 0, okCount: 0, failCount: 0, concurrency } },
					};
				}

				const out = new Array(items.length);
				let nextIndex = 0;
				let hardFailure = null;

				const runOne = async (idx) => {
					const item = items[idx];
					const localVars = {
						...vars,
						[itemVar]: item,
						[indexVar]: idx + 1,
						[totalVar]: items.length,
					};
					const subAction = {
						type: "invoke",
						target: action.target,
						find: parseFlowVal(action.find, args, opts, localVars, lastResult),
						args: parseFlowVal(action.args || {}, args, opts, localVars, lastResult),
						fork: action.fork === undefined ? undefined : parseFlowVal(action.fork, args, opts, localVars, lastResult),
						forkWait: action.forkWait === undefined ? undefined : parseFlowVal(action.forkWait, args, opts, localVars, lastResult),
						timeoutMs: itemTimeoutMs > 0 ? itemTimeoutMs : Number(parseFlowVal(action.timeoutMs || 0, args, opts, localVars, lastResult) || 0),
						onError: "return",
						returnTo: action.returnTo || "caller",
					};

					await logger?.info("invoke_many.item.start", { stepId, idx: idx + 1, total: items.length });
					const ret = await invokeFlowAction({
						action: subAction,
						args,
						opts,
						vars: localVars,
						lastResult,
						session,
						webRpa,
						page: activePage,
						logger,
						callerFlowId: flowId,
					});
					const invokeStatus = String(ret?.meta?.invoke?.status || (ret?.status || "failed")).toLowerCase();
					const normalizedStatus = invokeStatus === "done" ? "done" : "failed";
					const ok = invokeStatus === "done";
					const reason = ok ? "" : String(ret?.meta?.invoke?.reason || ret?.reason || "invokeMany item failed");
					const invokeMeta = {
						flowId: ret?.meta?.invoke?.flowId || String(subAction.target || ""),
						status: normalizedStatus,
						reason,
					};
					out[idx] = {
						index: idx + 1,
						item,
						ok,
						status: normalizedStatus,
						reason,
						value: ret?.value,
						error: reason,
						invoke: invokeMeta,
					};
					if (ok) {
						await logger?.info("invoke_many.item.done", { stepId, idx: idx + 1 });
					} else {
						await logger?.warn("invoke_many.item.failed", { stepId, idx: idx + 1, reason });
						if (!continueOnError && !hardFailure) {
							hardFailure = reason;
						}
					}
				};

				const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => (async () => {
					while (true) {
						if (hardFailure && !continueOnError) break;
						const idx = nextIndex++;
						if (idx >= items.length) break;
						await runOne(idx);
					}
				})());
				await Promise.all(workers);

				if (hardFailure && !continueOnError) {
					return { status: "failed", reason: hardFailure, value: { items: out.filter(Boolean) } };
				}
				const okCount = out.filter((x) => x && x.ok).length;
				const failCount = out.length - okCount;
				return {
					status: "done",
					value: {
						items: out,
						meta: { total: out.length, okCount, failCount, concurrency },
					},
				};
			}
			case "invoke": {
				const activePage = getActivePage();
				const { invokeFlowAction } = await import("./FlowInvoke.mjs");
				return await invokeFlowAction({
					action,
					args,
					opts,
					vars,
					lastResult,
					session,
					webRpa,
					page: activePage,
					logger,
					callerFlowId: flowId,
				});
			}
			case "download": {
				const activePage = requireActivePage(action.type);
				if (!webRpa || typeof webRpa.download !== "function") {
					return { status: "failed", reason: "download: webRpa.download is not available" };
				}

				const beginTimeout = Math.max(500, Number(action.beginTimeoutMs ?? action.beginTimeout ?? action.timeoutMs ?? 15000));
				const endTimeout = Math.max(500, Number(action.endTimeoutMs ?? action.endTimeout ?? action.timeoutMs ?? 60000));
				const waitForEnd = action.waitForEnd !== false;
				const matchContext = action.matchContext === true;
				const url = parseFlowVal(action.url, args, opts, vars, lastResult);
				const dlOpts = { beginTimeout, endTimeout, waitForEnd, matchContext };

				if (url) {
					dlOpts.url = String(url);
				} else {
					const r = await resolveTarget();
					if (r.status !== "done") return r;
					dlOpts.selector = String(r.value.selector || r.value?.selector || "");
					if (!dlOpts.selector) return { status: "failed", reason: "download: missing target selector" };
				}

				const ret = await webRpa.download(activePage, dlOpts);
				if (!ret || !ret.ok) {
					return {
						status: "failed",
						reason: "download failed",
						value: ret || null,
					};
				}
				return { status: "done", value: ret };
			}
			case "uploadFile": {
				const activePage = requireActivePage(action.type);
				const filesRaw = parseFlowVal(
					action.files ?? action.file ?? action.value,
					args,
					opts,
					vars,
					lastResult
				);
				let files = Array.isArray(filesRaw) ? filesRaw : (filesRaw != null ? [filesRaw] : []);
				files = files
					.map((v) => (typeof v === "string" ? v.trim() : String(v || "").trim()))
					.filter(Boolean);
				if (!files.length) return { status: "failed", reason: "uploadFile: missing files" };

				const modeRaw = String(
					parseFlowVal(action.uploadMode ?? action.mode ?? "chooser", args, opts, vars, lastResult) || "chooser"
				).toLowerCase();
				const mode = modeRaw === "user" ? "chooser" : modeRaw;
				const timeoutMs = Math.max(500, Number(action.timeoutMs || 12000));
				const allowSetFilesFallback = action.allowSetFilesFallback !== false;

				let by = "";
				if (action.by || action.query) {
					const r = await resolveTarget();
					if (r.status !== "done") return r;
					by = String(r.value.selector || r.value?.selector || "");
				}

				const inspectTarget = async () => {
					if (!by) return { ok: false, reason: "missing selector", isFileInput: false, count: 0 };
					try {
						const info = await activePage.callFunction(
							function (sel) {
								function one(selector) {
									const s = String(selector || "").trim();
									if (!s) return null;
									let arr = [];
									try { arr = Array.from(document.querySelectorAll(s)); } catch (_) { return null; }
									return arr[0] || null;
								}
								const first = one(sel);
								if (!first) return { ok: false, isFileInput: false, count: 0, tag: "", type: "" };
								const tag = String(first.tagName || "").toLowerCase();
								const type = String(first.getAttribute("type") || "").toLowerCase();
								const count = (() => {
									try { return document.querySelectorAll(String(sel || "")).length; } catch (_) { return 0; }
								})();
								return { ok: true, isFileInput: tag === "input" && type === "file", count, tag, type };
							},
							[by],
							{ awaitPromise: true }
						);
						return (info && typeof info === "object") ? info : { ok: false, isFileInput: false, count: 0 };
					} catch (e) {
						return { ok: false, reason: e?.message || String(e), isFileInput: false, count: 0 };
					}
				};

				const uploadByChooser = async () => {
					if (!by) throw new Error("uploadFile(chooser): missing query/by");
					const chooserP = activePage.waitForFileChooser({ timeout: timeoutMs });
					await activePage.click(by, {});
					const chooser = await chooserP;
					if (!chooser || typeof chooser.accept !== "function") {
						throw new Error("uploadFile(chooser): file chooser not captured");
					}
					await chooser.accept(files);
					return { modeUsed: "chooser", by };
				};

				const uploadBySetFiles = async () => {
					if (!by) throw new Error("uploadFile(setFiles): missing query/by");
					const handle = await activePage.$(by);
					if (!handle) throw new Error(`uploadFile(setFiles): target not found: ${by}`);
					try {
						await activePage.webDrive.sendCommand("input.setFiles", {
							context: activePage.context,
							element: handle,
							files,
						});
					} finally {
						try { await activePage.disown(handle); } catch (_) {}
					}
					return { modeUsed: "setFiles", by };
				};

				let uploaded;
				if (mode === "chooser") {
					const targetInfo = await inspectTarget();
					if (targetInfo.isFileInput && allowSetFilesFallback) {
						await logger?.warn("upload_file.chooser_skip_direct_file_input", {
							stepId,
							by,
							reason: "target is input[type=file], fallback to setFiles",
						});
						uploaded = await uploadBySetFiles();
					} else {
						try {
							uploaded = await uploadByChooser();
						} catch (e) {
							if (!allowSetFilesFallback) throw e;
							await logger?.warn("upload_file.chooser_failed_fallback_setfiles", {
								stepId,
								reason: e?.message || String(e),
							});
							uploaded = await uploadBySetFiles();
						}
					}
				} else if (mode === "setfiles" || mode === "setFiles") {
					uploaded = await uploadBySetFiles();
				} else {
					try {
						uploaded = await uploadByChooser();
					} catch (e) {
						await logger?.warn("upload_file.chooser_failed_fallback_setfiles", {
							stepId,
							reason: e?.message || String(e),
						});
						uploaded = await uploadBySetFiles();
					}
				}

				await logger?.info("upload_file.done", {
					stepId,
					modeUsed: uploaded.modeUsed,
					count: files.length,
					by: uploaded.by || null,
				});
				return {
					status: "done",
					value: {
						uploadedCount: files.length,
						files,
						modeUsed: uploaded.modeUsed,
						by: uploaded.by || null,
					},
				};
			}
			case "setChecked":
			case "setSelect":
			default:
				await logger?.warn("action.unimplemented", { stepId, actionType: action.type });
				return { status: "failed", reason: `action not implemented yet: ${action.type}` };
		}
	} catch (e) {
		await logger?.error("action.error", { stepId, actionType: action?.type, reason: e?.message || String(e) });
		return { status: "failed", reason: e?.message || String(e), error: { name: e?.name, message: e?.message } };
	}
}

export { executeStepAction };
