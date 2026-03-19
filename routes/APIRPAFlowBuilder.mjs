import { getFlowBuilderSessionManager } from "../rpaflows/FlowBuilderSessionManager.mjs";
import pathLib from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createFlowLogger } from "../rpaflows/FlowLogger.mjs";
import {
	getDefaultBuilderFlowsDir,
	listSavedBuilderFlows,
	loadSavedBuilderFlowFromPath,
	saveBuilderFlowToFile,
	runBuilderStepOnce,
} from "../rpaflows/FlowBuilderCore.mjs";
import { resolveSelectorByAI } from "../rpaflows/FlowAIResolver.mjs";
import rpaKindSpec from "../agentspec/kinds/rpa.mjs";
import { execRunJsAction, parseFlowVal } from "../rpaflows/FlowExpr.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
const PROJECT_ROOT = pathLib.resolve(__dirname, "..");
const BUILDER_PAGE_PATH = pathLib.join(PROJECT_ROOT, "public", "rpaflows", "builder.html");
const BUILDER_LOG_DIR = process.env.FLOW_LOG_DIR || pathLib.join(PROJECT_ROOT, "rpaflows", "flow-logs");
const BUILDER_FLOWS_DIR = getDefaultBuilderFlowsDir();
const AGENT_KIND_DIR = pathLib.join(PROJECT_ROOT, "agentspec", "kinds");
const kindSpecCache = new Map();

let builderLoggerPromise = null;
async function getBuilderLogger() {
	if (!builderLoggerPromise) {
		builderLoggerPromise = createFlowLogger({
			logDir: BUILDER_LOG_DIR,
			flowId: "builder_api",
			echoConsole: false,
			maxInMemory: 2000,
		});
		try {
			const logger = await builderLoggerPromise;
			console.log(`[RPAFLOWS][builder] log file: ${logger.filePath}`);
		} catch (_) {
		}
	}
	return builderLoggerPromise;
}

async function logBuilder(level, event, data = {}) {
	try {
		const logger = await getBuilderLogger();
		const fn = logger && typeof logger[level] === "function" ? logger[level] : logger?.info;
		if (typeof fn === "function") await fn(event, data);
	} catch (_) {
	}
}

function asText(v) {
	return String(v == null ? "" : v).trim();
}

function toObject(v, fallback = {}) {
	if (v && typeof v === "object" && !Array.isArray(v)) return v;
	if (typeof v === "string" && v.trim()) {
		try {
			const obj = JSON.parse(v);
			if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
		} catch (_) {}
	}
	return fallback;
}

function fail(res, status, reason) {
	res.status(status).json({ ok: false, reason: asText(reason || "request failed") });
}

function toDisplayFlowPath(inPath) {
	const abs = asText(inPath);
	if (!abs) return "";
	const rel = pathLib.relative(BUILDER_FLOWS_DIR, abs);
	if (!rel) return "";
	if (rel.startsWith("..") || pathLib.isAbsolute(rel)) return abs;
	return rel.split(pathLib.sep).join("/");
}

function getMgr() {
	return getFlowBuilderSessionManager();
}

function normalizeKindName(rawKind) {
	const raw = asText(rawKind).toLowerCase();
	if (!raw) return "rpa";
	if (!/^[a-z0-9_-]+$/.test(raw)) return "rpa";
	return raw;
}

async function loadKindSpec(kindName) {
	const normalized = normalizeKindName(kindName);
	if (normalized === "rpa") {
		return { requestedKind: normalized, resolvedKind: "rpa", source: "agentspec/kinds/rpa.mjs", fallback: false, spec: rpaKindSpec };
	}
	if (kindSpecCache.has(normalized)) return kindSpecCache.get(normalized);
	const relFile = `${normalized}.mjs`;
	const fullPath = pathLib.join(AGENT_KIND_DIR, relFile);
	try {
		const mod = await import(pathToFileURL(fullPath).href);
		const spec = (mod && (mod.default || mod[normalized] || mod.kind)) ? (mod.default || mod[normalized] || mod.kind) : mod?.default;
		const ret = {
			requestedKind: normalized,
			resolvedKind: normalized,
			source: `agentspec/kinds/${relFile}`,
			fallback: false,
			spec: spec && typeof spec === "object" ? spec : {},
		};
		kindSpecCache.set(normalized, ret);
		return ret;
	} catch (_) {
		const ret = {
			requestedKind: normalized,
			resolvedKind: "rpa",
			source: "agentspec/kinds/rpa.mjs",
			fallback: true,
			spec: rpaKindSpec,
		};
		kindSpecCache.set(normalized, ret);
		return ret;
	}
}

function listInvokeFindKeysFromSpec(specPack) {
	const spec = specPack && typeof specPack === "object" ? specPack.spec : null;
	const caps = (spec && typeof spec === "object" && spec.caps && typeof spec.caps === "object")
		? spec.caps
		: {};
	const capKeys = [];
	const argKeys = [];
	const argDefs = {};
	for (const k of Object.keys(caps)) {
		const key = asText(k);
		if (!key) continue;
		const def = caps[k];
		const kind = asText(def?.kind || "").toLowerCase();
		if (kind === "cap") capKeys.push(key);
		else if (kind === "arg") {
			argKeys.push(key);
			argDefs[key] = {
				type: asText(def?.type || ""),
				desc: asText(def?.desc || ""),
				values: Array.isArray(def?.values) ? def.values : [],
			};
		}
	}
	capKeys.sort();
	argKeys.sort();
	const items = [];
	for (const key of capKeys) items.push({ key, kind: "cap" });
	for (const key of argKeys) {
		const def = argDefs[key] || {};
		items.push({
			key,
			kind: "arg",
			type: asText(def.type || ""),
			values: Array.isArray(def.values) ? def.values : [],
		});
	}
	return {
		requestedKind: asText(specPack?.requestedKind || "rpa"),
		kind: asText(specPack?.resolvedKind || "rpa"),
		source: asText(specPack?.source || "agentspec/kinds/rpa.mjs"),
		fallback: specPack?.fallback === true,
		capKeys,
		argKeys,
		argDefs,
		items,
	};
}

function getActivePageRuntime(mgr, sessionId) {
	const session = mgr.getSessionRuntime(sessionId);
	if (session.status !== "ready" || !session.webRpa) {
		throw new Error(`session is not ready (status=${session.status})`);
	}
	const webRpa = session.webRpa;
	let page = null;
	if (session.activeContextId) {
		page = webRpa.getPageByContextId(session.activeContextId);
	}
	if (!page) page = webRpa.currentPage || null;
	if (!page) throw new Error("no active page");
	return {
		webRpa,
		page,
		session: webRpa.session || null,
		activeContextId: asText(page?.context || session.activeContextId || ""),
	};
}

async function readPickedElementDetails(page, pickedHandle) {
	if (!page || !pickedHandle) return null;
	return await page.callFunction(
		function (ret) {
			if (!ret || ret.ok !== true) return null;
			const el = ret.element || null;
			const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
			const attr = (name) => {
				try {
					return el ? clean(el.getAttribute(name) || "") : "";
				} catch (_) {
					return "";
				}
			};
			const text = el ? clean(el.innerText || el.textContent || "").slice(0, 240) : "";
			return {
				ok: true,
				selector: clean(ret.selector || ""),
				text,
				tagName: clean(ret.tagName || ""),
				id: clean(ret.id || ""),
				className: clean(ret.className || ""),
				name: attr("name"),
				role: attr("role"),
				ariaLabel: attr("aria-label"),
				title: attr("title"),
			};
		},
		[pickedHandle],
		{ awaitPromise: true }
	);
}

function buildSelectorAiQuery(details, actionType = "click") {
	const picked = (details && typeof details === "object") ? details : {};
	const textHint = asText(picked.text);
	const action = asText(actionType || "click").toLowerCase();
	return [
		"我已经人工选中了一个网页元素，请给出稳定可用的 selector。",
		"要求：单元素唯一定位优先，避免脆弱的 nth-child 长链。",
		`当前动作类型: ${action}（请在可行时给出与该动作匹配的语义 query，若不确定可留空）`,
		"可在 css: / xpath: 中自行选择最稳健方案。",
		`已选元素信息：tag=${asText(picked.tagName)}, id=${asText(picked.id)}, class=${asText(picked.className)}, name=${asText(picked.name)}, role=${asText(picked.role)}, aria-label=${asText(picked.ariaLabel)}, title=${asText(picked.title)}`,
		`简易 selector: ${asText(picked.selector)}`,
		`元素文本: ${textHint || "(空)"}`,
	].join("\n");
}

function buildPickToken() {
	return `pick_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

async function dismissTipSafe(webRpa, page, tipId) {
	try {
		if (!webRpa || !page || !tipId) return;
		if (typeof webRpa.inPageTipDismiss === "function") {
			await webRpa.inPageTipDismiss(page, String(tipId));
		}
	} catch (_) {
	}
}

async function showTipSafe(webRpa, page, text, tipId = "") {
	try {
		if (!webRpa || !page || typeof webRpa.inPageTip !== "function") return;
		await webRpa.inPageTip(page, String(text || ""), {
			id: tipId || undefined,
			position: "top",
			stack: false,
			timeout: tipId ? 0 : 1800,
			opacity: 0.96,
			persistAcrossNav: !!tipId,
			persistTtlMs: tipId ? 90000 : 0,
			pollMs: 400,
		});
	} catch (_) {
	}
}

async function verifySelectorHitsPicked(page, selector, pickAttrKey, pickToken) {
	const out = await page.callFunction(
		function (rawSelector, attrKey, attrValue) {
			const sel = String(rawSelector || "").trim();
			const key = String(attrKey || "").trim();
			const val = String(attrValue || "").trim();
			if (!sel) return { ok: false, reason: "empty selector", count: 0, hit: false };
			if (!key || !val) return { ok: false, reason: "missing pick marker", count: 0, hit: false };
			const parseSelector = (s) => {
				if (!s) return { mode: "css", expr: "" };
				if (/^css:/i.test(s)) return { mode: "css", expr: s.replace(/^css:/i, "").trim() };
				if (/^xpath:/i.test(s)) return { mode: "xpath", expr: s.replace(/^xpath:/i, "").trim() };
				if (/^(\/\/|\/|\(|\.\/|\.\.\/)/.test(s)) return { mode: "xpath", expr: s };
				return { mode: "css", expr: s };
			};
			const parsed = parseSelector(sel);
			if (!parsed.expr) return { ok: false, reason: "empty selector expr", count: 0, hit: false };
			let list = [];
			try {
				if (parsed.mode === "xpath") {
					const r = document.evaluate(parsed.expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
					for (let i = 0; i < r.snapshotLength; i += 1) {
						const n = r.snapshotItem(i);
						if (n && n.nodeType === 1) list.push(n);
					}
				} else {
					list = Array.from(document.querySelectorAll(parsed.expr));
				}
			} catch (err) {
				return { ok: false, reason: `selector parse failed: ${String(err?.message || err)}`, count: 0, hit: false };
			}
			const count = list.length;
			if (!count) return { ok: false, reason: "selector matched 0 elements", count, hit: false };
			let hit = false;
			for (const el of list) {
				try {
					if (String(el.getAttribute(key) || "") === val) {
						hit = true;
						break;
					}
				} catch (_) {
				}
			}
			if (hit) return { ok: true, reason: "", count, hit: true };
			return { ok: false, reason: `selector matched ${count} elements but not the picked one`, count, hit: false };
		},
		[selector, pickAttrKey, pickToken],
		{ awaitPromise: true }
	);
	return (out && typeof out === "object") ? out : { ok: false, reason: "invalid verify result", count: 0, hit: false };
}

async function countSelectorMatches(page, selector) {
	const out = await page.callFunction(
		function (rawSelector) {
			const sel = String(rawSelector || "").trim();
			if (!sel) return { ok: false, count: 0, reason: "empty selector" };
			const parseSelector = (s) => {
				if (!s) return { mode: "css", expr: "" };
				if (/^css:/i.test(s)) return { mode: "css", expr: s.replace(/^css:/i, "").trim() };
				if (/^xpath:/i.test(s)) return { mode: "xpath", expr: s.replace(/^xpath:/i, "").trim() };
				if (/^(\/\/|\/|\(|\.\/|\.\.\/)/.test(s)) return { mode: "xpath", expr: s };
				return { mode: "css", expr: s };
			};
			const parsed = parseSelector(sel);
			if (!parsed.expr) return { ok: false, count: 0, reason: "empty selector expr" };
			try {
				if (parsed.mode === "xpath") {
					const r = document.evaluate(parsed.expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
					return { ok: true, count: Number(r.snapshotLength || 0), reason: "" };
				}
				const arr = document.querySelectorAll(parsed.expr);
				return { ok: true, count: Number(arr?.length || 0), reason: "" };
			} catch (err) {
				return { ok: false, count: 0, reason: String(err?.message || err || "selector parse failed") };
			}
		},
		[selector],
		{ awaitPromise: true }
	);
	return (out && typeof out === "object") ? out : { ok: false, count: 0, reason: "invalid count result" };
}

async function verifySelectorByWebRpa({ webRpa, page, selector, pickAttrKey, pickToken }) {
	const s = asText(selector);
	if (!s) return { ok: false, reason: "empty selector", count: 0, hit: false };
	let count = 0;
	try {
		if (webRpa && typeof webRpa.inPageShowSelector === "function") {
			count = Number(await webRpa.inPageShowSelector(page, s, { color: "#1890ff", thickness: 2 })) || 0;
		}
	} catch (err) {
		return { ok: false, reason: `show selector failed: ${asText(err?.message || err)}`, count: 0, hit: false };
	}
	let hitRet = { ok: false, reason: "verify failed", count, hit: false };
	try {
		hitRet = await verifySelectorHitsPicked(page, s, pickAttrKey, pickToken);
		hitRet.count = Number(hitRet?.count || count || 0);
	} finally {
		try {
			if (webRpa && typeof webRpa.inPageDismissSelector === "function") {
				await webRpa.inPageDismissSelector(page);
			}
		} catch (_) {
		}
	}
	return hitRet;
}

async function clearPickedMarker(page, pickAttrKey, pickToken) {
	try {
		await page.callFunction(
			function (attrKey, attrValue) {
				const key = String(attrKey || "").trim();
				const val = String(attrValue || "").trim();
				if (!key || !val) return 0;
				const esc = (s) => {
					try { return CSS.escape(s); } catch (_) { return s.replace(/["\\]/g, "\\$&"); }
				};
				const list = Array.from(document.querySelectorAll(`[${esc(key)}="${esc(val)}"]`));
				for (const el of list) {
					try { el.removeAttribute(key); } catch (_) {}
				}
				return list.length;
			},
			[pickAttrKey, pickToken],
			{ awaitPromise: true }
		);
	} catch (_) {
	}
}

async function trySwitchBackToBuilderApp(runtime) {
	try {
		const session = runtime?.session;
		const webRpa = runtime?.webRpa;
		const browser = webRpa?.browser || null;
		const browserId = asText(browser?.browserId || browser?.aaeBrowserId || "");
		if (session && typeof session.callHub === "function" && browserId) {
			await session.callHub("WebDriveBackToApp", { browserId });
		}
	} catch (_) {
	}
}

export default function setupRpaFlowBuilderRoutes(app, router) {
	router.get("/builder", async (req, res) => {
		res.sendFile(BUILDER_PAGE_PATH);
	});

	router.get("/api/builder/log-meta", async (req, res) => {
		try {
			const logger = await getBuilderLogger();
			res.json({ ok: true, data: { filePath: logger.filePath, runId: logger.runId } });
		} catch (err) {
			fail(res, 500, err?.message || err);
		}
	});

	router.get("/api/builder/invoke-find-keys", async (req, res) => {
		try {
			const kind = asText(req.query?.kind || "rpa");
			const specPack = await loadKindSpec(kind);
			const data = listInvokeFindKeysFromSpec(specPack);
			res.json({ ok: true, data });
		} catch (err) {
			fail(res, 500, err?.message || err);
		}
	});

	router.post("/api/builder/session/start", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const mgr = getMgr();
			const data = await mgr.startSession({
				alias: asText(body.alias),
				launchMode: asText(body.launchMode),
				startUrl: asText(body.startUrl),
			});
			await logBuilder("info", "session.start", {
				sessionId: data?.id || "",
				alias: data?.alias || "",
				launchMode: data?.launchMode || "",
				startUrl: data?.startUrl || "",
				reused: data?.reused === true,
				elapsedMs: Date.now() - t0,
			});
			res.json({ ok: true, data });
		} catch (err) {
			await logBuilder("error", "session.start.error", { reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 400, err?.message || err);
		}
	});

	router.get("/api/builder/session/:id", async (req, res) => {
		try {
			const mgr = getMgr();
			const data = mgr.getSession(req.params.id);
			await logBuilder("debug", "session.get", { sessionId: req.params.id, status: data?.status || "" });
			res.json({ ok: true, data });
		} catch (err) {
			await logBuilder("warn", "session.get.error", { sessionId: req.params.id, reason: asText(err?.message || err) });
			fail(res, 404, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/close", async (req, res) => {
		const t0 = Date.now();
		try {
			const mgr = getMgr();
			const data = await mgr.closeSession(req.params.id);
			await logBuilder("info", "session.close", { sessionId: req.params.id, elapsedMs: Date.now() - t0 });
			res.json({ ok: true, data });
		} catch (err) {
			await logBuilder("warn", "session.close.error", { sessionId: req.params.id, reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 404, err?.message || err);
		}
	});

	router.get("/api/builder/session/:id/contexts", async (req, res) => {
		try {
			const mgr = getMgr();
			const data = await mgr.listContexts(req.params.id);
			await logBuilder("debug", "contexts.list", {
				sessionId: req.params.id,
				count: Array.isArray(data?.contexts) ? data.contexts.length : 0,
				activeContextId: data?.activeContextId || "",
			});
			res.json({ ok: true, data });
		} catch (err) {
			await logBuilder("warn", "contexts.list.error", { sessionId: req.params.id, reason: asText(err?.message || err) });
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/contexts/select", async (req, res) => {
		try {
			const body = toObject(req.body, {});
			const mgr = getMgr();
			const data = mgr.selectContext(req.params.id, asText(body.contextId));
			await logBuilder("info", "contexts.select", {
				sessionId: req.params.id,
				contextId: asText(body.contextId),
				activeContextId: data?.activeContextId || "",
			});
			res.json({ ok: true, data });
		} catch (err) {
			await logBuilder("warn", "contexts.select.error", {
				sessionId: req.params.id,
				contextId: asText(req?.body?.contextId),
				reason: asText(err?.message || err),
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/open", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const mgr = getMgr();
			const data = await mgr.openPage(req.params.id, {
				url: asText(body.url),
				setActive: body.setActive !== false,
			});
			await logBuilder("info", "contexts.open", {
				sessionId: req.params.id,
				contextId: data?.contextId || "",
				url: data?.url || "",
				activeContextId: data?.activeContextId || "",
				elapsedMs: Date.now() - t0,
			});
			res.json({ ok: true, data });
		} catch (err) {
			await logBuilder("warn", "contexts.open.error", { sessionId: req.params.id, reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/activate", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		try {
			const body = toObject(req.body, {});
			const contextId = asText(body.contextId || "");
			const mgr = getMgr();
			if (contextId) {
				try {
					mgr.selectContext(sessionId, contextId);
				} catch (_) {
				}
			}
			const runtime = getActivePageRuntime(mgr, sessionId);
			runtime.webRpa.setCurrentPage(runtime.page);
			try {
				await runtime.webRpa.browser?.activate?.();
			} catch (_) {
			}
			try {
				await runtime.page?.bringToFront?.({ focusBrowser: true });
			} catch (_) {
			}
			await logBuilder("info", "session.activate", {
				sessionId,
				contextId: runtime.activeContextId,
				elapsedMs: Date.now() - t0,
			});
			res.json({
				ok: true,
				data: {
					ok: true,
					sessionId,
					contextId: runtime.activeContextId,
				},
			});
		} catch (err) {
			await logBuilder("warn", "session.activate.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/run-step", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const step = (body.step && typeof body.step === "object" && !Array.isArray(body.step)) ? body.step : null;
			if (!step) throw new Error("step is required");
			if (!asText(step?.id)) throw new Error("step.id is required");
			if (!asText(step?.action?.type)) throw new Error("step.action.type is required");

			const mgr = getMgr();
			const runtime = getActivePageRuntime(mgr, req.params.id);
			const runRet = await runBuilderStepOnce({
				webRpa: runtime.webRpa,
				page: runtime.page,
				session: runtime.session,
				step,
			});
			const elapsedMs = Date.now() - t0;
			console.log(
				`[RPAFLOWS][builder] run-step session=${req.params.id} context=${runtime.activeContextId} ` +
				`step=${asText(step.id)} type=${asText(step?.action?.type)} status=${asText(runRet?.status || "failed")} elapsedMs=${elapsedMs}`
			);
			await logBuilder("info", "step.run", {
				sessionId: req.params.id,
				contextId: runtime.activeContextId,
				stepId: asText(step.id),
				actionType: asText(step?.action?.type),
				status: asText(runRet?.status || "failed"),
				reason: asText(runRet?.reason || ""),
				elapsedMs,
			});
			res.json({ ok: true, data: runRet });
		} catch (err) {
			await logBuilder("error", "step.run.error", { sessionId: req.params.id, reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/pick-selector", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		const pickAttrKey = "data-rpaflows-picked-token";
		const pickToken = buildPickToken();
		let runtimeForCleanup = null;
		try {
			const body = toObject(req.body, {});
			const contextId = asText(body.contextId || "");
			const actionType = asText(body.actionType || "click").toLowerCase();
			const mgr = getMgr();
			if (contextId) {
				try {
					mgr.selectContext(sessionId, contextId);
				} catch (_) {
				}
			}
			const runtime = getActivePageRuntime(mgr, sessionId);
			runtimeForCleanup = runtime;
			if (contextId && runtime.activeContextId !== contextId) {
				throw new Error(`context not active: ${contextId}`);
			}
			runtime.webRpa.setCurrentPage(runtime.page);
			try {
				await runtime.webRpa.browser?.activate?.();
			} catch (_) {
			}
			try {
				await runtime.page?.bringToFront?.({ focusBrowser: true });
			} catch (_) {
			}
			console.log(`[RPAFLOWS][builder] pick-selector begin session=${sessionId} context=${runtime.activeContextId}`);
			await logBuilder("info", "selector.pick.begin", {
				sessionId,
				contextId: runtime.activeContextId,
			});
			await showTipSafe(runtime.webRpa, runtime.page, "请选择目标元素（Esc 取消）");
			const pickedHandle = await runtime.webRpa.inPagePickDomElement(runtime.page, {
				preventPageClick: true,
				ignoreSelectors: ["#__ai2apps_prompt_root__", "#__ai2apps_tip_root__", "#__ai2apps_selector_root__"],
				attr: { key: pickAttrKey, value: pickToken },
			});
			if (!pickedHandle) {
				const elapsedMs = Date.now() - t0;
				console.log(`[RPAFLOWS][builder] pick-selector cancel session=${sessionId} context=${runtime.activeContextId} elapsedMs=${elapsedMs}`);
				await logBuilder("info", "selector.pick.cancel", { sessionId, contextId: runtime.activeContextId, elapsedMs });
				return res.json({ ok: true, data: { cancelled: true } });
			}
			let details = null;
			try {
				details = await readPickedElementDetails(runtime.page, pickedHandle);
			} finally {
				try { await runtime.page.disown(pickedHandle); } catch (_) {}
			}
			if (!details || !details.ok || !asText(details.selector)) {
				throw new Error("pick failed: empty selector");
			}
			const aiQuery = buildSelectorAiQuery(details, actionType);
			let selector = "";
			let query = "";
			let aiUsed = false;
			let aiReason = "";
			const verifyFails = [];
			const maxPass = 3;
			let feedbackNote = "";
			const logger = await getBuilderLogger();
			for (let pass = 1; pass <= maxPass && !selector; pass += 1) {
				const tipId = `__builder_pick_ai_${Date.now()}_${pass}__`;
				await showTipSafe(runtime.webRpa, runtime.page, `AI 正在生成并验证 selector（第 ${pass}/${maxPass} 轮）...`, tipId);
				let ai = null;
				try {
					ai = await resolveSelectorByAI({
						query: aiQuery,
						webRpa: runtime.webRpa,
						page: runtime.page,
						session: runtime.session,
						expectedMulti: false,
						feedbackNote,
						logger,
					});
				} finally {
					await dismissTipSafe(runtime.webRpa, runtime.page, tipId);
				}
				aiUsed = true;
				aiReason = asText(ai?.reason || "");
				const aiQueryCandidate = asText(ai?.query || "");
				const cands = Array.isArray(ai?.selectors) ? ai.selectors.map((x) => asText(x)).filter(Boolean) : [];
				console.log(
					`[RPAFLOWS][builder] pick-selector ai session=${sessionId} context=${runtime.activeContextId} ` +
					`pass=${pass} aiOk=${!!ai?.ok} selectors=${cands.length} aiQuery=${aiQueryCandidate ? "yes" : "no"}`
				);
				if (!ai?.ok || !cands.length) {
					verifyFails.push(`pass${pass}: ai failed (${asText(ai?.reason || "unknown")})`);
					feedbackNote = `上一轮生成失败：${asText(ai?.reason || "unknown")}。请重新生成。`;
					continue;
				}
				for (let i = 0; i < cands.length; i += 1) {
					const cand = cands[i];
					const verify = await verifySelectorByWebRpa({
						webRpa: runtime.webRpa,
						page: runtime.page,
						selector: cand,
						pickAttrKey,
						pickToken,
					});
					await logBuilder("debug", "selector.pick.verify", {
						sessionId,
						contextId: runtime.activeContextId,
						pass,
						candidateIndex: i + 1,
						selector: cand,
						ok: !!verify?.ok,
						count: Number(verify?.count || 0),
						reason: asText(verify?.reason || ""),
					});
					if (verify?.ok) {
						selector = cand;
						query = aiQueryCandidate;
						break;
					}
					verifyFails.push(`pass${pass}/cand${i + 1}: ${asText(verify?.reason || "not hit")}`);
				}
				if (!selector) {
					const tail = verifyFails.slice(-2).join(" | ");
					feedbackNote = `上轮候选都没命中已选元素。失败原因：${tail}。请重新生成更稳健且能命中该元素本身的 selector。`;
				}
			}
			if (!selector) {
				const fallback = asText(details.selector);
				const verifyFallback = fallback
					? await verifySelectorByWebRpa({
						webRpa: runtime.webRpa,
						page: runtime.page,
						selector: fallback,
						pickAttrKey,
						pickToken,
					})
					: { ok: false, reason: "empty fallback selector" };
				if (verifyFallback?.ok) {
					selector = fallback;
					query = "";
					aiReason = `${aiReason ? `${aiReason}; ` : ""}fallback used`;
					await logBuilder("warn", "selector.pick.fallback", {
						sessionId,
						contextId: runtime.activeContextId,
						selector,
						reason: "ai candidates not validated; use fallback picked selector",
					});
				} else {
					const brief = verifyFails.slice(-4).join(" | ");
					throw new Error(`selector 验证失败：未能锁定已选元素。${brief || asText(verifyFallback?.reason || "")}`);
				}
			}
			await showTipSafe(runtime.webRpa, runtime.page, "selector 生成并验证成功");
			await trySwitchBackToBuilderApp(runtime);
			const elapsedMs = Date.now() - t0;
			console.log(
				`[RPAFLOWS][builder] pick-selector done session=${sessionId} context=${runtime.activeContextId} ` +
				`selector=${selector} query=${query ? "yes" : "no"} aiUsed=${aiUsed} elapsedMs=${elapsedMs}`
			);
			await logBuilder("info", "selector.pick.done", {
				sessionId,
				contextId: runtime.activeContextId,
				selector,
				query,
				actionType,
				aiUsed,
				aiReason,
				tagName: asText(details.tagName),
				elapsedMs,
			});
			res.json({
				ok: true,
				data: {
					cancelled: false,
					contextId: runtime.activeContextId,
					selector,
					query,
					actionType,
					aiUsed,
					aiReason,
					picked: details,
				},
				});
		} catch (err) {
			await logBuilder("error", "selector.pick.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		} finally {
			if (runtimeForCleanup?.page) {
				await clearPickedMarker(runtimeForCleanup.page, pickAttrKey, pickToken);
			}
		}
	});

	router.post("/api/builder/session/:id/query-selector", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		try {
			const body = toObject(req.body, {});
			const contextId = asText(body.contextId || "");
			const actionType = asText(body.actionType || "click").toLowerCase();
			const query = asText(body.query || "");
			if (!query) throw new Error("query is required");
			const mgr = getMgr();
			if (contextId) {
				try { mgr.selectContext(sessionId, contextId); } catch (_) {}
			}
			const runtime = getActivePageRuntime(mgr, sessionId);
			if (contextId && runtime.activeContextId !== contextId) {
				throw new Error(`context not active: ${contextId}`);
			}
			runtime.webRpa.setCurrentPage(runtime.page);
			try { await runtime.webRpa.browser?.activate?.(); } catch (_) {}
			try { await runtime.page?.bringToFront?.({ focusBrowser: true }); } catch (_) {}

			const tipId = `__builder_query_ai_${Date.now()}__`;
			await showTipSafe(runtime.webRpa, runtime.page, "AI 正在根据 query 生成 selector，请稍候...", tipId);
			let ai = null;
			try {
				const logger = await getBuilderLogger();
				ai = await resolveSelectorByAI({
					query,
					webRpa: runtime.webRpa,
					page: runtime.page,
					session: runtime.session,
					expectedMulti: false,
					logger,
				});
			} finally {
				await dismissTipSafe(runtime.webRpa, runtime.page, tipId);
			}
			const cands = Array.isArray(ai?.selectors) ? ai.selectors.map((x) => asText(x)).filter(Boolean) : [];
			let selector = "";
			let matchedCount = 0;
			const checks = [];
			for (let i = 0; i < cands.length; i += 1) {
				const cand = cands[i];
				const cc = await countSelectorMatches(runtime.page, cand);
				checks.push({ selector: cand, ok: !!cc?.ok, count: Number(cc?.count || 0), reason: asText(cc?.reason || "") });
				if (cc?.ok && Number(cc?.count || 0) > 0) {
					selector = cand;
					matchedCount = Number(cc.count || 0);
					break;
				}
			}
			if (!selector) {
				const reason = asText(ai?.reason || "") || "AI 未返回可用 selector";
				throw new Error(reason);
			}
			await showTipSafe(runtime.webRpa, runtime.page, `已生成 selector（匹配 ${matchedCount} 个元素）`);
			await trySwitchBackToBuilderApp(runtime);
			const elapsedMs = Date.now() - t0;
			await logBuilder("info", "selector.query.done", {
				sessionId,
				contextId: runtime.activeContextId,
				actionType,
				query,
				selector,
				matchedCount,
				candidates: cands.length,
				elapsedMs,
			});
			res.json({
				ok: true,
				data: {
					sessionId,
					contextId: runtime.activeContextId,
					actionType,
					query,
					selector,
					matchedCount,
					aiUsed: true,
					aiReason: asText(ai?.reason || ""),
					aiQuery: asText(ai?.query || ""),
					candidates: cands,
					checks,
				},
			});
		} catch (err) {
			await logBuilder("error", "selector.query.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/run-js-generate", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		try {
			const body = toObject(req.body, {});
			const contextId = asText(body.contextId || "");
			const query = asText(body.query || "");
			const scope = asText(body.scope || "page").toLowerCase() === "agent" ? "agent" : "page";
			const argsArr = Array.isArray(body.args) ? body.args : [];
			const cacheEnabled = !(body.cache === false);
			if (!query) throw new Error("query is required");
			await logBuilder("info", "run_js.generate.begin", {
				sessionId,
				contextId,
				scope,
				cacheEnabled,
				argsCount: argsArr.length,
				queryPreview: query.slice(0, 180),
			});
			const mgr = getMgr();
			if (contextId) {
				try { mgr.selectContext(sessionId, contextId); } catch (_) {}
			}
			const runtime = getActivePageRuntime(mgr, sessionId);
			if (contextId && runtime.activeContextId !== contextId) {
				throw new Error(`context not active: ${contextId}`);
			}
			runtime.webRpa.setCurrentPage(runtime.page);
			try { await runtime.webRpa.browser?.activate?.(); } catch (_) {}
			try { await runtime.page?.bringToFront?.({ focusBrowser: true }); } catch (_) {}

			const { resolveRunJsCode } = await import("../rpaflows/FlowRunJsResolver.mjs");
			const verifyInput = (argsArr[0] && typeof argsArr[0] === "object" && !Array.isArray(argsArr[0])) ? argsArr[0] : {};
			const cacheKey = cacheEnabled
				? `builder_${sessionId}_${runtime.activeContextId || "ctx"}_run_js`
				: `builder_${sessionId}_${runtime.activeContextId || "ctx"}_run_js_nocache_${Date.now()}`;
			const logger = await getBuilderLogger();
			const tr = Date.now();
			const codeResolved = await resolveRunJsCode({
				cacheKey,
				query,
				verifyInput,
				webRpa: runtime.webRpa,
				page: runtime.page,
				session: runtime.session,
				scope,
				aiOptions: {},
				logger,
			});
			await logBuilder("info", "run_js.generate.resolved", {
				sessionId,
				contextId: runtime.activeContextId,
				scope,
				cacheEnabled,
				cacheKey,
				status: asText(codeResolved?.status || "failed"),
				fromCache: !!codeResolved?.value?.fromCache,
				model: asText(codeResolved?.value?.model || ""),
				elapsedMs: Date.now() - tr,
			});
			if (!codeResolved || codeResolved.status !== "done") {
				throw new Error(asText(codeResolved?.reason || "run_js code resolve failed"));
			}
			const code = asText(codeResolved?.value?.code || "");
			if (!code) throw new Error("AI 未返回 run_js.code");
			const runRet = await execRunJsAction({
				type: "run_js",
				code,
				scope,
				args: argsArr,
			}, {
				args: {},
				opts: {},
				vars: {},
				result: {},
				parseVal: parseFlowVal,
				pageEval: async (codeStr, callArgs) => {
					return runtime.page.callFunction(codeStr, callArgs, { awaitPromise: true });
				},
			});
			await logBuilder("info", "run_js.generate.exec", {
				sessionId,
				contextId: runtime.activeContextId,
				runStatus: asText(runRet?.status || "failed"),
				runReason: asText(runRet?.reason || ""),
				codeChars: code.length,
			});
			await trySwitchBackToBuilderApp(runtime);
			const elapsedMs = Date.now() - t0;
			await logBuilder("info", "run_js.generate.done", {
				sessionId,
				contextId: runtime.activeContextId,
				scope,
				query: query.slice(0, 160),
				cacheEnabled,
				codeFromCache: !!codeResolved?.value?.fromCache,
				runStatus: asText(runRet?.status || "failed"),
				elapsedMs,
			});
			res.json({
				ok: true,
				data: {
					sessionId,
					contextId: runtime.activeContextId,
					scope,
					query,
					cacheEnabled,
					code,
					codeFromCache: !!codeResolved?.value?.fromCache,
					model: asText(codeResolved?.value?.model || ""),
					runResult: runRet || { status: "failed", reason: "empty run result" },
				},
			});
		} catch (err) {
			await logBuilder("error", "run_js.generate.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/pick-element", async (req, res) => {
		const t0 = Date.now();
		const sessionId = asText(req.params.id);
		try {
			const body = toObject(req.body, {});
			const contextId = asText(body.contextId || "");
			const selector = asText(body.selector || "");
			if (!selector) throw new Error("selector is required");
			const mgr = getMgr();
			if (contextId) {
				try {
					mgr.selectContext(sessionId, contextId);
				} catch (_) {
				}
			}
			const runtime = getActivePageRuntime(mgr, sessionId);
			if (contextId && runtime.activeContextId !== contextId) {
				throw new Error(`context not active: ${contextId}`);
			}
			runtime.webRpa.setCurrentPage(runtime.page);
			try {
				await runtime.webRpa.browser?.activate?.();
			} catch (_) {
			}
			try {
				await runtime.page?.bringToFront?.({ focusBrowser: true });
			} catch (_) {
			}
			await logBuilder("info", "selector.pick_element.begin", {
				sessionId,
				contextId: runtime.activeContextId,
				selector,
			});

			let matchedCount = 0;
			try {
				if (typeof runtime.webRpa?.inPageShowSelector === "function") {
					matchedCount = Number(await runtime.webRpa.inPageShowSelector(runtime.page, selector, {
						color: "#1890ff",
						thickness: 2,
					})) || 0;
				}
			} finally {
				// keep highlight for confirmation prompt, do not dismiss here
			}
			if (!(matchedCount > 0)) {
				try {
					if (typeof runtime.webRpa?.inPageDismissSelector === "function") {
						await runtime.webRpa.inPageDismissSelector(runtime.page);
					}
				} catch (_) {
				}
				await showTipSafe(runtime.webRpa, runtime.page, "没有选中任何元素");
				await trySwitchBackToBuilderApp(runtime);
				const elapsedMs = Date.now() - t0;
				await logBuilder("info", "selector.pick_element.empty", {
					sessionId,
					contextId: runtime.activeContextId,
					selector,
					elapsedMs,
				});
				return res.json({
					ok: true,
					data: { cancelled: false, matched: false, matchedCount: 0, message: "没有选中任何元素", selector },
				});
			}

			let choiceCode = "";
			let choiceText = "";
			try {
				const ret = await runtime.webRpa.inPagePrompt(runtime.page, `当前 selector 匹配 ${matchedCount} 个元素，请确认是否使用`, {
					modal: true,
					mask: false,
					showCancel: false,
					menu: [
						{ text: "确认使用", code: "fit" },
						{ text: "不合适", code: "reject" },
						{ text: "放弃", code: "cancel" },
					],
				});
				choiceCode = asText(ret?.code || "");
				choiceText = asText(ret?.text || "");
			} finally {
				try {
					if (typeof runtime.webRpa?.inPageDismissSelector === "function") {
						await runtime.webRpa.inPageDismissSelector(runtime.page);
					}
				} catch (_) {
				}
			}
			const confirmed = choiceCode === "fit";
			await showTipSafe(runtime.webRpa, runtime.page, confirmed ? "已确认 selector" : "未确认 selector");
			await trySwitchBackToBuilderApp(runtime);
			const elapsedMs = Date.now() - t0;
			await logBuilder("info", "selector.pick_element.done", {
				sessionId,
				contextId: runtime.activeContextId,
				selector,
				matchedCount,
				confirmed,
				choiceCode,
				choiceText,
				elapsedMs,
			});
			res.json({
				ok: true,
				data: {
					cancelled: choiceCode === "cancel",
					matched: true,
					confirmed,
					contextId: runtime.activeContextId,
					selector,
					matchedCount,
					choiceCode,
				},
			});
		} catch (err) {
			await logBuilder("error", "selector.pick_element.error", {
				sessionId,
				reason: asText(err?.message || err),
				elapsedMs: Date.now() - t0,
			});
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/session/:id/save-flow", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const flow = (body.flow && typeof body.flow === "object" && !Array.isArray(body.flow)) ? body.flow : null;
			if (!flow) throw new Error("flow is required");
			const sourcePath = asText(body.sourcePath || flow?.sourcePath || "");
			const outPath = await saveBuilderFlowToFile(flow, { sourcePath });
			const elapsedMs = Date.now() - t0;
			console.log(
				`[RPAFLOWS][builder] save-flow session=${req.params.id} flowId=${asText(flow?.id || "")} ` +
				`out=${outPath} elapsedMs=${elapsedMs}`
			);
				await logBuilder("info", "flow.save", {
					sessionId: req.params.id,
					flowId: asText(flow?.id || ""),
					path: outPath,
					elapsedMs,
				});
				res.json({
					ok: true,
					data: {
						path: toDisplayFlowPath(outPath),
						absPath: outPath,
						baseDir: BUILDER_FLOWS_DIR,
					},
				});
			} catch (err) {
			await logBuilder("error", "flow.save.error", { sessionId: req.params.id, reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 400, err?.message || err);
		}
	});

	router.post("/api/builder/flows/save", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = toObject(req.body, {});
			const flow = (body.flow && typeof body.flow === "object" && !Array.isArray(body.flow)) ? body.flow : null;
			if (!flow) throw new Error("flow is required");
			const sourcePath = asText(body.sourcePath || flow?.sourcePath || "");
			const outPath = await saveBuilderFlowToFile(flow, { sourcePath });
			const elapsedMs = Date.now() - t0;
			console.log(
				`[RPAFLOWS][builder] save-flow flowId=${asText(flow?.id || "")} ` +
				`out=${outPath} elapsedMs=${elapsedMs}`
			);
			await logBuilder("info", "flow.save", {
				sessionId: "",
				flowId: asText(flow?.id || ""),
				path: outPath,
				elapsedMs,
			});
			res.json({
				ok: true,
				data: {
					path: toDisplayFlowPath(outPath),
					absPath: outPath,
					baseDir: BUILDER_FLOWS_DIR,
				},
			});
		} catch (err) {
			await logBuilder("error", "flow.save.error", { sessionId: "", reason: asText(err?.message || err), elapsedMs: Date.now() - t0 });
			fail(res, 400, err?.message || err);
		}
	});

		router.get("/api/builder/flows", async (req, res) => {
			try {
				const flows = await listSavedBuilderFlows();
				await logBuilder("debug", "flow.list", { count: Array.isArray(flows) ? flows.length : 0 });
				res.json({
					ok: true,
					data: {
						baseDir: BUILDER_FLOWS_DIR,
						flows: (Array.isArray(flows) ? flows : []).map((one) => ({
							...one,
							path: toDisplayFlowPath(one?.path),
							absPath: asText(one?.path),
						})),
					},
				});
			} catch (err) {
			await logBuilder("warn", "flow.list.error", { reason: asText(err?.message || err) });
			fail(res, 500, err?.message || err);
		}
	});

		router.post("/api/builder/flows/load", async (req, res) => {
		try {
			const body = toObject(req.body, {});
				const path = asText(body.path);
				if (!path) throw new Error("path is required");
				const flow = await loadSavedBuilderFlowFromPath(path);
				await logBuilder("info", "flow.load", {
					path,
					flowId: asText(flow?.id || ""),
					stepCount: Array.isArray(flow?.steps) ? flow.steps.length : 0,
				});
				res.json({
					ok: true,
					data: {
						baseDir: BUILDER_FLOWS_DIR,
						flow: {
							...flow,
							sourcePath: toDisplayFlowPath(flow?.sourcePath),
							sourcePathAbs: asText(flow?.sourcePath),
						},
					},
				});
			} catch (err) {
			await logBuilder("warn", "flow.load.error", { path: asText(req?.body?.path), reason: asText(err?.message || err) });
			fail(res, 400, err?.message || err);
		}
	});
}
