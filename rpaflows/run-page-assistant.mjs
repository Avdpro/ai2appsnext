import pathLib from "path";
import { fileURLToPath } from "url";
import { promises as fsp } from "fs";
import dotenv from "dotenv";
import clipboardy from "clipboardy";
import WebRpa from "./WebDriveRpa.mjs";
import { resolveSelectorByAI, runAIAction } from "./FlowAIResolver.mjs";
import { runGoalDrivenLoop } from "./FlowGoalDrivenLoop.mjs";
import { createFlowLogger } from "./FlowLogger.mjs";
import { ensureFlowRegistry, listFlowEntries } from "./FlowRegistry.mjs";
import { findBestFlowEntry } from "./FlowFinder.mjs";
import {
	listSavedBuilderFlows,
	loadSavedBuilderFlowFromPath,
	saveBuilderFlowToFile,
	runBuilderStepOnce,
} from "./FlowBuilderCore.mjs";
import rpaKind from "./rpa.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
dotenv.config({ path: pathLib.join(__dirname, ".env") });

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getArg(name, fallback = "") {
	const prefix = `--${name}=`;
	const found = process.argv.find((v) => v.startsWith(prefix));
	return found ? found.slice(prefix.length) : fallback;
}

function parseBoolArg(raw, fallback = false) {
	if (raw == null || raw === "") return fallback;
	const s = String(raw).trim().toLowerCase();
	if (["1", "true", "yes", "y", "on"].includes(s)) return true;
	if (["0", "false", "no", "n", "off"].includes(s)) return false;
	return fallback;
}

function guessMimeFromExt(filePath) {
	const ext = String(pathLib.extname(filePath || "") || "").toLowerCase();
	if (ext === ".svg") return "image/svg+xml";
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	return "application/octet-stream";
}

async function readFileAsDataURL(filePath) {
	const abs = pathLib.isAbsolute(filePath) ? filePath : pathLib.join(__dirname, filePath);
	const buf = await fsp.readFile(abs);
	const mime = guessMimeFromExt(abs);
	return `data:${mime};base64,${buf.toString("base64")}`;
}

async function cleanupProfileLocks(alias) {
	try {
		const base = String(process.env.WEBRPA_DATADIR || "").trim();
		const name = String(alias || "").trim();
		if (!base || !pathLib.isAbsolute(base) || !name) return;
		const dir = pathLib.join(base, name);
		const targets = [".parentlock", "parent.lock", "lock"];
		for (const one of targets) {
			const fp = pathLib.join(dir, one);
			try { await fsp.unlink(fp); } catch (_) {}
		}
	} catch (_) {
	}
}

function parseShortcut(text) {
	const raw = String(text || "ctrl+shift+p").trim().toLowerCase();
	const tokens = raw.split("+").map((v) => v.trim()).filter(Boolean);
	const out = { ctrl: false, shift: false, alt: false, meta: false, key: "p" };
	for (const t of tokens) {
		if (t === "ctrl" || t === "control") out.ctrl = true;
		else if (t === "shift") out.shift = true;
		else if (t === "alt" || t === "option") out.alt = true;
		else if (t === "cmd" || t === "meta" || t === "command") out.meta = true;
		else out.key = t;
	}
	return out;
}

function shortcutLabel(sc) {
	const parts = [];
	if (sc.ctrl) parts.push("Ctrl");
	if (sc.shift) parts.push("Shift");
	if (sc.alt) parts.push("Alt");
	if (sc.meta) parts.push("Cmd");
	parts.push(String(sc.key || "").toUpperCase());
	return parts.join("+");
}

function isTimeoutError(err) {
	const s = String(err?.message || err || "");
	return /timeout/i.test(s);
}

function isSessionGoneError(err) {
	const s = String(err?.message || err || "").toLowerCase();
	return /no such frame|not connected|browsing context|connection closed|realm|discarded|detached/.test(s);
}

const kShortcutStateKey = "__rpa_selector_picker_shortcut_state__";
const kChatStateKey = "__rpa_selector_picker_chat_state__";
const chatAiLogger = {
	debug: async (event, data) => {
		const ev = String(event || "");
		if (ev === "run_ai.page.collected" || ev === "ai.session.request" || /^ai\.[a-z0-9_]+\.(request|error|success)$/.test(ev)) {
			console.log("[selector-picker][chat-ai]", event, JSON.stringify(data || {}));
		}
	},
	info: async (event, data) => {
		if (String(event || "").startsWith("goal_loop.") || String(event || "").startsWith("invoke.")) {
			console.log("[selector-picker][chat-ai]", event, JSON.stringify(data || {}));
		}
	},
	warn: async (event, data) => {
		console.warn("[selector-picker][chat-ai]", event, JSON.stringify(data || {}));
	},
};

function getRootContext(context, parentByContext) {
	let cur = String(context || "");
	if (!cur) return "";
	const seen = new Set();
	for (let i = 0; i < 32; i++) {
		if (!cur || seen.has(cur)) break;
		seen.add(cur);
		const parent = String(parentByContext.get(cur) || "");
		if (!parent) return cur;
		cur = parent;
	}
	return cur || String(context || "");
}

function getGroupIdForPage(page, parentByContext) {
	const context = String(page?.context || "");
	if (!context) return "";
	return getRootContext(context, parentByContext) || context;
}

function getFlowBuilderSeedForPage(page, parentByContext, flowBuilderStateByGroup) {
	if (!page || !flowBuilderStateByGroup) return null;
	const gid = getGroupIdForPage(page, parentByContext);
	if (!gid) return null;
	const seed = flowBuilderStateByGroup.get(gid);
	return (seed && typeof seed === "object") ? seed : null;
}

async function ensureShortcutInjected(page, shortcut) {
	if (!page || !shortcut) return false;
	try {
		const ret = await page.callFunction(
			function (spec, stateKey) {
				const g = window;
				const sig = JSON.stringify(spec || {});
				const key = String(stateKey || "__rpa_selector_picker_shortcut_state__");
				let st = g[key];
				let installed = false;
				if (!st || st.signature !== sig || typeof st.listener !== "function") {
					if (st && typeof st.listener === "function") {
						try { document.removeEventListener("keydown", st.listener, true); } catch (_) {}
					}
					st = {
						signature: sig,
						queue: [],
						listener: null,
						installedAt: Date.now(),
					};
					st.listener = (ev) => {
						try {
							if (!ev) return;
							const k = String(ev.key || "").toLowerCase();
							const keyExpected = String(spec?.key || "").toLowerCase();
							const matched = (!!spec?.ctrl === !!ev.ctrlKey)
								&& (!!spec?.shift === !!ev.shiftKey)
								&& (!!spec?.alt === !!ev.altKey)
								&& (!!spec?.meta === !!ev.metaKey)
								&& (k === keyExpected);
							if (!matched) return;
							ev.preventDefault();
							ev.stopPropagation();
							if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
							st.queue.push({
								ts: Date.now(),
								key: k,
								url: String(location.href || ""),
								title: String(document.title || ""),
							});
							if (st.queue.length > 30) st.queue.splice(0, st.queue.length - 30);
						} catch (_) {
						}
					};
					document.addEventListener("keydown", st.listener, true);
					g[key] = st;
					installed = true;
				}
				return { ok: true, installed, signature: st.signature };
			},
			[shortcut, kShortcutStateKey],
			{ awaitPromise: true, timeout: 2000 }
		);
		return !!ret?.ok;
	} catch (_) {
		return false;
	}
}

async function waitShortcutOnce(page, shortcut, timeoutMs = 1200) {
	try {
		await ensureShortcutInjected(page, shortcut);
		return await page.waitForFunction(
			function (stateKey) {
				const g = window;
				const state = g[String(stateKey || "__rpa_selector_picker_shortcut_state__")];
				if (!state || !Array.isArray(state.queue) || state.queue.length === 0) return null;
				return state.queue.shift();
			},
			{ timeout: timeoutMs, interval: 120 },
			kShortcutStateKey
		);
	} catch (err) {
		if (isTimeoutError(err)) return null;
		throw err;
	}
}

async function popShortcutEvent(page) {
	if (!page) return null;
	try {
		return await page.callFunction(
			function (stateKey) {
				const g = window;
				const state = g[String(stateKey || "__rpa_selector_picker_shortcut_state__")];
				if (!state || !Array.isArray(state.queue) || state.queue.length === 0) return null;
				return state.queue.shift();
			},
			[kShortcutStateKey],
			{ awaitPromise: true, timeout: 800 }
		);
	} catch (_) {
		return null;
	}
}

async function pickActiveVisiblePage(webRpa) {
	const pages = Array.isArray(webRpa?.sessionPages) ? Array.from(webRpa.sessionPages) : [];
	let visibleOnly = null;
	for (const page of pages) {
		if (!page) continue;
		try {
			const st = await page.callFunction(
				function () {
					return {
						visible: document.visibilityState === "visible",
						focused: !!document.hasFocus(),
					};
				},
				[],
				{ awaitPromise: true, timeout: 800 }
			);
			if (st?.visible && st?.focused) return page;
			if (st?.visible && !visibleOnly) visibleOnly = page;
		} catch (_) {
		}
	}
	return visibleOnly;
}

async function pollShortcutAcrossPages(webRpa, shortcut) {
	const pages = Array.isArray(webRpa?.sessionPages) ? Array.from(webRpa.sessionPages) : [];
	if (!pages.length) return { page: null, trigger: null };

	// Prefer currentPage first for lower latency.
	const ordered = [];
	if (webRpa.currentPage) ordered.push(webRpa.currentPage);
	for (const p of pages) {
		if (!p || ordered.includes(p)) continue;
		ordered.push(p);
	}

	for (const page of ordered) {
		await ensureShortcutInjected(page, shortcut);
		const trigger = await popShortcutEvent(page);
		if (trigger) {
			return { page, trigger };
		}
	}
	return { page: null, trigger: null };
}

async function ensureChatFabInjected(page, iconDataUrl = "", historySeed = [], flowBuilderSeed = null) {
	if (!page) return false;
	try {
		const ret = await page.callFunction(
			function (stateKey, iconUrl, historySeed, flowBuilderSeed) {
					const key = String(stateKey || "__rpa_selector_picker_chat_state__");
					const g = window;
					let st = g[key];
						if (!st || typeof st !== "object") {
							st = {
								requests: [],
								responses: [],
								pickRequests: [],
								flowBuildRequests: [],
								flowBuildResponses: [],
								flowDebugLogs: [],
								seq: 0,
								installed: false,
							};
							g[key] = st;
						}
						if (!Array.isArray(st.pickRequests)) st.pickRequests = [];
						if (!Array.isArray(st.flowBuildRequests)) st.flowBuildRequests = [];
						if (!Array.isArray(st.flowBuildResponses)) st.flowBuildResponses = [];
						if (!Array.isArray(st.flowDebugLogs)) st.flowDebugLogs = [];
						const flowDbg = (event, data) => {
							try {
								st.flowDebugLogs.push({
									ts: Date.now(),
									event: String(event || ""),
									data: (data && typeof data === "object") ? data : { value: String(data == null ? "" : data) },
								});
								if (st.flowDebugLogs.length > 200) st.flowDebugLogs.splice(0, st.flowDebugLogs.length - 200);
							} catch (_) {
							}
						};
					if (st.installed) return { ok: true, installed: false };

					const doc = document;
					const rootId = "__rpa_selector_chat_root__";
					const fabId = "__rpa_selector_chat_fab__";
					const panelId = "__rpa_selector_chat_panel__";
					const inputId = "__rpa_selector_chat_input__";
					if (doc.getElementById(rootId)) {
						st.installed = true;
						return { ok: true, installed: false };
					}

				const root = doc.createElement("div");
				root.id = rootId;
				root.style.position = "fixed";
				root.style.left = "16px";
				root.style.bottom = "16px";
				root.style.zIndex = "2147483644";
				root.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
				root.style.pointerEvents = "auto";

					const fab = doc.createElement("button");
					fab.id = fabId;
					fab.type = "button";
					fab.title = "页面 AI 助手";
				fab.style.width = "46px";
				fab.style.height = "46px";
				fab.style.borderRadius = "999px";
				fab.style.border = "1px solid rgba(0,0,0,0.28)";
				fab.style.background = "#2563eb";
				fab.style.color = "#fff";
				fab.style.fontSize = "14px";
				fab.style.fontWeight = "800";
				fab.style.cursor = "pointer";
				fab.style.boxShadow = "0 8px 20px rgba(0,0,0,0.22)";
				fab.style.display = "grid";
				fab.style.placeItems = "center";
				fab.style.padding = "0";

				if (iconUrl && String(iconUrl).startsWith("data:")) {
					const logo = doc.createElement("img");
					logo.alt = "AI";
					logo.src = String(iconUrl);
					logo.style.width = "24px";
					logo.style.height = "24px";
					logo.style.objectFit = "contain";
					logo.style.pointerEvents = "none";
					// Default ai2apps.svg is dark; make it white on blue button.
					logo.style.filter = "brightness(0) invert(1)";
					fab.appendChild(logo);
				} else {
					fab.textContent = "AI";
				}

					const panel = doc.createElement("div");
					panel.id = panelId;
					panel.style.display = "none";
					const panelWidthDefault = "min(420px, calc(100vw - 24px))";
					const panelWidthFlowExpanded = "min(1240px, calc(100vw - 24px))";

				const menu = doc.createElement("div");
				menu.style.display = "none";
				menu.style.position = "fixed";
				menu.style.left = "0";
				menu.style.top = "0";
				menu.style.minWidth = "180px";
				menu.style.background = "#fff";
				menu.style.border = "1px solid rgba(0,0,0,0.24)";
				menu.style.borderRadius = "10px";
				menu.style.boxShadow = "0 12px 24px rgba(0,0,0,0.20)";
				menu.style.overflow = "hidden";
				menu.style.zIndex = "2147483645";

				const mkMenuItem = (text) => {
					const it = doc.createElement("button");
					it.type = "button";
					it.textContent = text;
					it.style.display = "block";
					it.style.width = "100%";
					it.style.textAlign = "left";
					it.style.padding = "10px 12px";
					it.style.border = "none";
					it.style.background = "#fff";
					it.style.color = "#0f172a";
					it.style.fontSize = "13px";
					it.style.fontWeight = "700";
					it.style.cursor = "pointer";
					it.addEventListener("mouseenter", () => { it.style.background = "#f1f5f9"; });
					it.addEventListener("mouseleave", () => { it.style.background = "#fff"; });
					return it;
				};
				const menuChat = mkMenuItem("与当前页面对话");
				const menuPick = mkMenuItem("制作元素Selector");
				const menuCreateFlow = mkMenuItem("Flow Builder");
					menu.appendChild(menuChat);
					menu.appendChild(menuPick);
					menu.appendChild(menuCreateFlow);
				panel.style.position = "absolute";
				panel.style.left = "0";
				panel.style.bottom = "58px";
					panel.style.width = panelWidthDefault;
				panel.style.height = "min(90vh, calc(100vh - 24px))";
				panel.style.maxHeight = "min(90vh, calc(100vh - 24px))";
				panel.style.background = "#fff";
				panel.style.border = "1px solid rgba(0,0,0,0.24)";
				panel.style.borderRadius = "12px";
				panel.style.boxShadow = "0 14px 32px rgba(0,0,0,0.26)";
				panel.style.overflow = "hidden";
				panel.style.display = "none";
				panel.style.flexDirection = "column";

				const header = doc.createElement("div");
				header.style.display = "flex";
				header.style.alignItems = "center";
				header.style.justifyContent = "space-between";
				header.style.padding = "10px 12px";
				header.style.borderBottom = "1px solid rgba(0,0,0,0.15)";
				header.style.background = "#f8fafc";
				const title = doc.createElement("div");
				title.textContent = "页面 AI 助手";
				title.style.fontSize = "13px";
				title.style.fontWeight = "800";
				const closeBtn = doc.createElement("button");
				closeBtn.type = "button";
				closeBtn.textContent = "×";
				closeBtn.style.border = "none";
				closeBtn.style.background = "transparent";
				closeBtn.style.fontSize = "18px";
				closeBtn.style.lineHeight = "1";
				closeBtn.style.cursor = "pointer";
				closeBtn.style.color = "#334155";
				header.appendChild(title);
				header.appendChild(closeBtn);

				const list = doc.createElement("div");
				list.style.padding = "10px 12px";
				list.style.maxHeight = "none";
				list.style.overflowY = "auto";
				list.style.display = "flex";
				list.style.flexDirection = "column";
				list.style.gap = "8px";
				list.style.flex = "1 1 auto";

				const inputWrap = doc.createElement("div");
				inputWrap.style.padding = "8px 10px";
				inputWrap.style.borderTop = "1px solid rgba(0,0,0,0.15)";
				inputWrap.style.display = "flex";
				inputWrap.style.gap = "8px";
				inputWrap.style.background = "#fff";

					const input = doc.createElement("textarea");
					input.id = inputId;
					input.rows = 2;
				input.placeholder = "输入你的问题（基于当前页面内容）";
				input.style.flex = "1 1 auto";
				input.style.resize = "none";
				input.style.border = "1px solid rgba(0,0,0,0.22)";
				input.style.borderRadius = "8px";
				input.style.padding = "8px";
				input.style.fontSize = "13px";
				input.style.lineHeight = "1.35";
				input.style.outline = "none";
				input.style.color = "#111";
				input.style.background = "#fff";

				const send = doc.createElement("button");
				send.type = "button";
				send.textContent = "发送";
				send.style.flex = "0 0 auto";
				send.style.padding = "0 12px";
				send.style.border = "1px solid rgba(0,0,0,0.22)";
				send.style.borderRadius = "8px";
				send.style.background = "#2563eb";
				send.style.color = "#fff";
				send.style.fontSize = "13px";
				send.style.fontWeight = "700";
				send.style.cursor = "pointer";

				inputWrap.appendChild(input);
				inputWrap.appendChild(send);

				const flowWrap = doc.createElement("div");
				flowWrap.style.display = "none";
				flowWrap.style.padding = "10px 12px";
				flowWrap.style.maxHeight = "none";
				flowWrap.style.overflowY = "auto";
				flowWrap.style.display = "none";
				flowWrap.style.flexDirection = "column";
				flowWrap.style.gap = "8px";
				flowWrap.style.flex = "1 1 auto";

				const mkLabel = (text) => {
					const el = doc.createElement("div");
					el.textContent = String(text || "");
					el.style.fontSize = "12px";
					el.style.fontWeight = "700";
					el.style.color = "#0f172a";
					return el;
				};
				const mkFieldLabel = (text) => {
					const el = doc.createElement("div");
					el.textContent = String(text || "");
					el.style.fontSize = "11px";
					el.style.fontWeight = "700";
					el.style.color = "#334155";
					return el;
				};
				const mkInput = (ph = "") => {
					const el = doc.createElement("input");
					el.type = "text";
					el.placeholder = ph;
					el.style.width = "100%";
					el.style.boxSizing = "border-box";
					el.style.border = "1px solid rgba(0,0,0,0.22)";
					el.style.borderRadius = "8px";
					el.style.padding = "6px 8px";
					el.style.fontSize = "12px";
					return el;
				};
				const mkArea = (ph = "", rows = 3) => {
					const el = doc.createElement("textarea");
					el.rows = rows;
					el.placeholder = ph;
					el.style.width = "100%";
					el.style.boxSizing = "border-box";
					el.style.resize = "vertical";
					el.style.border = "1px solid rgba(0,0,0,0.22)";
					el.style.borderRadius = "8px";
					el.style.padding = "6px 8px";
					el.style.fontSize = "12px";
					el.style.lineHeight = "1.35";
					return el;
				};
				const mkBtn = (text, bg = "#2563eb") => {
					const b = doc.createElement("button");
					b.type = "button";
					b.textContent = text;
					b.style.padding = "6px 10px";
					b.style.border = "1px solid rgba(0,0,0,0.22)";
					b.style.borderRadius = "8px";
					b.style.background = bg;
					b.style.color = "#fff";
					b.style.fontSize = "12px";
					b.style.fontWeight = "700";
					b.style.cursor = "pointer";
					return b;
				};

					const flowGoal = mkArea("先描述要创建的 flow 目标（例如：在当前页面搜索关键词并读取前5条结果）", 2);
					const flowId = mkInput("flow id（可选，例如 page_search_read）");
					const flowCaps = mkArea("caps（逗号分隔）", 2);
					const flowArgs = mkArea("args（逗号分隔）", 2);
					const flowFiltersWrap = doc.createElement("div");
					flowFiltersWrap.style.display = "flex";
					flowFiltersWrap.style.flexDirection = "column";
					flowFiltersWrap.style.gap = "6px";
					const flowFiltersRows = doc.createElement("div");
					flowFiltersRows.style.display = "flex";
					flowFiltersRows.style.flexDirection = "column";
					flowFiltersRows.style.gap = "6px";
					const flowFiltersAddBtn = mkBtn("+ 添加 filter", "#475569");
					flowFiltersAddBtn.style.alignSelf = "flex-start";
					flowFiltersWrap.appendChild(flowFiltersRows);
					flowFiltersWrap.appendChild(flowFiltersAddBtn);
					const shellReadonly = doc.createElement("div");
					shellReadonly.style.display = "none";
					shellReadonly.style.fontSize = "12px";
					shellReadonly.style.lineHeight = "1.45";
					shellReadonly.style.whiteSpace = "pre-wrap";
					shellReadonly.style.border = "1px solid rgba(0,0,0,0.18)";
					shellReadonly.style.borderRadius = "8px";
					shellReadonly.style.background = "#f8fafc";
					shellReadonly.style.padding = "8px";
					const analyzeBtn = mkBtn("解析目标");
					const confirmBtn = mkBtn("确认能力/参数", "#0f766e");
					const savedFlowRow = doc.createElement("div");
					savedFlowRow.style.display = "grid";
					savedFlowRow.style.gridTemplateColumns = "1fr auto auto auto";
					savedFlowRow.style.gap = "6px";
					savedFlowRow.style.alignItems = "center";
					savedFlowRow.style.marginBottom = "2px";
					const savedFlowSelect = doc.createElement("select");
					savedFlowSelect.style.width = "100%";
					savedFlowSelect.style.boxSizing = "border-box";
					savedFlowSelect.style.border = "1px solid rgba(0,0,0,0.22)";
					savedFlowSelect.style.borderRadius = "8px";
					savedFlowSelect.style.padding = "6px 8px";
					savedFlowSelect.style.fontSize = "12px";
					const refreshSavedFlowBtn = mkBtn("刷新", "#475569");
					const newFlowBtn = mkBtn("新建Flow", "#0f766e");
					const flowGraphModeBtn = mkBtn("放大流程图", "#475569");
					refreshSavedFlowBtn.style.padding = "6px 8px";
					newFlowBtn.style.padding = "6px 8px";
					flowGraphModeBtn.style.padding = "6px 8px";
					savedFlowRow.appendChild(savedFlowSelect);
					savedFlowRow.appendChild(refreshSavedFlowBtn);
					savedFlowRow.appendChild(newFlowBtn);
					savedFlowRow.appendChild(flowGraphModeBtn);

				const stepIdInput = mkInput("step id（如 step_1）");
				const actionTypeSel = doc.createElement("select");
				actionTypeSel.style.width = "100%";
				actionTypeSel.style.boxSizing = "border-box";
				actionTypeSel.style.border = "1px solid rgba(0,0,0,0.22)";
				actionTypeSel.style.borderRadius = "8px";
				actionTypeSel.style.padding = "6px 8px";
				actionTypeSel.style.fontSize = "12px";
				for (const t of ["goto", "click", "input", "press_key", "wait", "scroll", "invoke", "run_js", "branch", "ask_assist", "done", "abort"]) {
					const op = doc.createElement("option");
					op.value = t;
					op.textContent = t;
					actionTypeSel.appendChild(op);
				}
				const mkCheck = (text) => {
					const wrap = doc.createElement("label");
					wrap.style.display = "flex";
					wrap.style.alignItems = "center";
					wrap.style.gap = "6px";
					wrap.style.fontSize = "12px";
					const cb = doc.createElement("input");
					cb.type = "checkbox";
					const sp = doc.createElement("span");
					sp.textContent = text;
					wrap.appendChild(cb);
					wrap.appendChild(sp);
					return { wrap, cb };
				};
				const fieldWrap = doc.createElement("div");
				fieldWrap.style.display = "flex";
				fieldWrap.style.flexDirection = "column";
				fieldWrap.style.gap = "6px";
				fieldWrap.style.padding = "8px";
				fieldWrap.style.border = "1px dashed rgba(0,0,0,0.2)";
				fieldWrap.style.borderRadius = "8px";

					const fBy = mkInput("by（可选，如 css: button.search）");
					const fByPickBtn = mkBtn("Pick 元素", "#0f766e");
					fByPickBtn.style.padding = "6px 8px";
					fByPickBtn.style.flex = "0 0 auto";
					const fByRow = doc.createElement("div");
					fByRow.style.display = "flex";
					fByRow.style.alignItems = "center";
					fByRow.style.width = "100%";
					fByRow.style.gap = "4px";
					fByRow.style.flexWrap = "nowrap";
					fBy.style.flex = "1 1 0";
					fBy.style.minWidth = "0";
					fBy.style.width = "100%";
					fByRow.appendChild(fBy);
					fByRow.appendChild(fByPickBtn);
					const fQuery = mkInput("query（可选，如 可见的搜索按钮）");
				const fUrl = mkInput("url（goto 用）");
				const fText = mkArea("text/reason/conclusion（按 action type）", 2);
				const fKey = mkInput("key（press_key，如 Enter）");
				const fModifiers = mkInput("modifiers（逗号分隔，如 Ctrl,Shift）");
				const fTimes = mkInput("times（press_key，默认1）");
				const fPick = mkInput("pick（可选，1/-1/文本）");
				const fTimeout = mkInput("timeoutMs（可选）");
				const fPostWait = mkInput("postWaitMs（可选）");
				const fPreEnterWait = mkInput("preEnterWaitMs（可选）");
				const fDeltaX = mkInput("deltaX（scroll，默认0）");
				const fDeltaY = mkInput("deltaY（scroll，默认600）");
				const fBehavior = mkInput("behavior（scroll：instant/smooth）");
					const fTarget = mkInput("target（invoke 可选，手工指定才生效）");
				const fInvokeFind = mkArea("invoke.find JSON（推荐，优先按 capability 匹配）", 3);
				fInvokeFind.value = "{\"kind\":\"rpa\",\"must\":[]}";
				const invokeSuggestBtn = mkBtn("刷新 invoke 候选", "#475569");
				const fInvokeTargetPick = doc.createElement("select");
				fInvokeTargetPick.style.width = "100%";
				fInvokeTargetPick.style.boxSizing = "border-box";
				fInvokeTargetPick.style.border = "1px solid rgba(0,0,0,0.22)";
				fInvokeTargetPick.style.borderRadius = "8px";
				fInvokeTargetPick.style.padding = "6px 8px";
				fInvokeTargetPick.style.fontSize = "12px";
				const fInvokeArgs = mkArea("invoke.args JSON（可选）", 2);
				fInvokeArgs.value = "{}";
				const fRunJsCode = mkArea("run_js.code（函数文本）", 4);
				const fRunJsQuery = mkInput("run_js.query（可选）");
				const fRunJsArgs = mkArea("run_js.args JSON 数组（可选）", 2);
				fRunJsArgs.value = "[]";
				const fBranchDesc = mkArea("branch 需求描述（可选，给 AI 生成草案）", 2);
				const fBranchAiBtn = mkBtn("AI 生成 branch 草案", "#0f766e");
				const fBranchDefault = mkInput("branch.default（未命中时跳转 stepId）");
				const fBranchCasesWrap = doc.createElement("div");
				fBranchCasesWrap.style.display = "flex";
				fBranchCasesWrap.style.flexDirection = "column";
				fBranchCasesWrap.style.gap = "6px";
				const fBranchAddCaseBtn = mkBtn("+ 添加分支条件", "#475569");
				fBranchAddCaseBtn.style.padding = "6px 8px";
				const fBranchHint = doc.createElement("div");
				fBranchHint.style.fontSize = "12px";
				fBranchHint.style.color = "#64748b";
				fBranchHint.textContent = "支持 exists/truthy/eq/neq/gt/gte/lt/lte/in/contains/match。复杂 and/or/not 可在 JSON 区微调。";
				const fInputMode = doc.createElement("select");
				for (const one of ["type", "paste", "fill"]) {
					const op = doc.createElement("option");
					op.value = one;
					op.textContent = `input.mode=${one}`;
					fInputMode.appendChild(op);
				}
				fInputMode.style.width = "100%";
				fInputMode.style.boxSizing = "border-box";
				fInputMode.style.border = "1px solid rgba(0,0,0,0.22)";
				fInputMode.style.borderRadius = "8px";
				fInputMode.style.padding = "6px 8px";
				fInputMode.style.fontSize = "12px";
				const fCaret = doc.createElement("select");
				for (const one of ["end", "start", "keep"]) {
					const op = doc.createElement("option");
					op.value = one;
					op.textContent = `input.caret=${one}`;
					fCaret.appendChild(op);
				}
				fCaret.style.width = "100%";
				fCaret.style.boxSizing = "border-box";
				fCaret.style.border = "1px solid rgba(0,0,0,0.22)";
				fCaret.style.borderRadius = "8px";
				fCaret.style.padding = "6px 8px";
				fCaret.style.fontSize = "12px";
				const cClear = mkCheck("input.clear=true");
				const cPressEnter = mkCheck("input.pressEnter=true");
				const cExpectFocus = mkCheck("click.expectInputFocus=true");
				const cWaitUserAction = mkCheck("ask_assist.waitUserAction=true");
				cWaitUserAction.cb.checked = true;
				const fOnError = doc.createElement("select");
				for (const one of ["fail", "return"]) {
					const op = doc.createElement("option");
					op.value = one;
					op.textContent = `invoke.onError=${one}`;
					fOnError.appendChild(op);
				}
				fOnError.style.width = "100%";
				fOnError.style.boxSizing = "border-box";
				fOnError.style.border = "1px solid rgba(0,0,0,0.22)";
				fOnError.style.borderRadius = "8px";
				fOnError.style.padding = "6px 8px";
				fOnError.style.fontSize = "12px";
				const fReturnTo = doc.createElement("select");
				for (const one of ["caller", "keep"]) {
					const op = doc.createElement("option");
					op.value = one;
					op.textContent = `invoke.returnTo=${one}`;
					fReturnTo.appendChild(op);
				}
				fReturnTo.style.width = "100%";
				fReturnTo.style.boxSizing = "border-box";
				fReturnTo.style.border = "1px solid rgba(0,0,0,0.22)";
				fReturnTo.style.borderRadius = "8px";
				fReturnTo.style.padding = "6px 8px";
				fReturnTo.style.fontSize = "12px";
				const fRunJsScope = doc.createElement("select");
				for (const one of ["page", "agent"]) {
					const op = doc.createElement("option");
					op.value = one;
					op.textContent = `run_js.scope=${one}`;
					fRunJsScope.appendChild(op);
				}
				fRunJsScope.style.width = "100%";
				fRunJsScope.style.boxSizing = "border-box";
				fRunJsScope.style.border = "1px solid rgba(0,0,0,0.22)";
				fRunJsScope.style.borderRadius = "8px";
				fRunJsScope.style.padding = "6px 8px";
				fRunJsScope.style.fontSize = "12px";

					const appendActionField = (label, el) => {
						const wrap = doc.createElement("div");
						wrap.style.display = "flex";
						wrap.style.flexDirection = "column";
						wrap.style.gap = "4px";
						if (label) wrap.appendChild(mkFieldLabel(label));
						wrap.appendChild(el);
						el.__fieldWrap = wrap;
						fieldWrap.appendChild(wrap);
					};
					appendActionField("by（元素定位）", fByRow);
					appendActionField("query（语义定位）", fQuery);
					appendActionField("url（goto）", fUrl);
					appendActionField("text / reason / conclusion", fText);
					appendActionField("key（press_key）", fKey);
					appendActionField("modifiers（press_key）", fModifiers);
					appendActionField("times（press_key）", fTimes);
					appendActionField("pick", fPick);
					appendActionField("timeoutMs", fTimeout);
					appendActionField("postWaitMs", fPostWait);
					appendActionField("preEnterWaitMs", fPreEnterWait);
					appendActionField("deltaX（scroll）", fDeltaX);
					appendActionField("deltaY（scroll）", fDeltaY);
					appendActionField("behavior（scroll）", fBehavior);
					appendActionField("target（invoke，手工指定才生效）", fTarget);
					appendActionField("invoke.find", fInvokeFind);
					fieldWrap.appendChild(invokeSuggestBtn);
					appendActionField("invoke 候选目标", fInvokeTargetPick);
					appendActionField("invoke.args", fInvokeArgs);
					appendActionField("input.mode", fInputMode);
					appendActionField("input.caret", fCaret);
					fieldWrap.appendChild(cClear.wrap);
					fieldWrap.appendChild(cPressEnter.wrap);
					fieldWrap.appendChild(cExpectFocus.wrap);
					fieldWrap.appendChild(cWaitUserAction.wrap);
					appendActionField("invoke.onError", fOnError);
					appendActionField("invoke.returnTo", fReturnTo);
					appendActionField("run_js.code", fRunJsCode);
					appendActionField("run_js.query", fRunJsQuery);
					appendActionField("run_js.args", fRunJsArgs);
					appendActionField("run_js.scope", fRunJsScope);
					appendActionField("branch 需求描述（AI 生成草案）", fBranchDesc);
					fieldWrap.appendChild(fBranchAiBtn);
					appendActionField("branch.default", fBranchDefault);
					appendActionField("branch.cases", fBranchCasesWrap);
					fieldWrap.appendChild(fBranchAddCaseBtn);
					fieldWrap.appendChild(fBranchHint);

				const actionPayload = mkArea("action JSON（实时从字段同步，可手工微调），例如 {\"type\":\"input\",\"by\":\"query: 搜索框\",\"text\":\"${args.query}\"}", 4);
				actionPayload.value = "{}";
				const aiStepPrompt = mkArea("步骤修改意图（例如：把这一步改成先点击输入框再填入 ${args.query}）", 2);
				const aiRewriteStepBtn = mkBtn("AI 修改当前步骤", "#0f766e");
				const nextDoneInput = mkInput("例如：step_2");
				const nextFailedInput = mkInput("例如：abort");
				const nextSkippedInput = mkInput("例如：step_skip");
				const nextTimeoutInput = mkInput("例如：step_timeout");
				const nextDefaultInput = mkInput("例如：step_fallback");
				const stepNextSection = doc.createElement("div");
				stepNextSection.style.display = "flex";
				stepNextSection.style.flexDirection = "column";
				stepNextSection.style.gap = "6px";
				stepNextSection.appendChild(mkLabel("Step Next"));
				stepNextSection.appendChild(mkFieldLabel("next.done（成功后跳转）"));
				stepNextSection.appendChild(nextDoneInput);
				stepNextSection.appendChild(mkFieldLabel("next.failed（失败后跳转）"));
				stepNextSection.appendChild(nextFailedInput);
				stepNextSection.appendChild(mkFieldLabel("next.skipped（跳过后跳转，可选）"));
				stepNextSection.appendChild(nextSkippedInput);
				stepNextSection.appendChild(mkFieldLabel("next.timeout（超时后跳转，可选）"));
				stepNextSection.appendChild(nextTimeoutInput);
				stepNextSection.appendChild(mkFieldLabel("next.default（兜底跳转，可选）"));
				stepNextSection.appendChild(nextDefaultInput);
				const runStepBtn = mkBtn("执行本步骤", "#7c3aed");
				const acceptStepBtn = mkBtn("成功，写入并下一步", "#0ea5e9");
				const saveFlowBtn = mkBtn("保存 Flow", "#16a34a");
				const createNewStepBtn = mkBtn("新增步骤", "#334155");
				const stepModeRow = doc.createElement("div");
				stepModeRow.style.display = "flex";
				stepModeRow.style.justifyContent = "flex-end";
				stepModeRow.style.gap = "6px";
				stepModeRow.appendChild(createNewStepBtn);
				const committedStepsList = doc.createElement("div");
				committedStepsList.style.display = "flex";
				committedStepsList.style.flexDirection = "column";
				committedStepsList.style.gap = "6px";
				committedStepsList.style.maxHeight = "240px";
				committedStepsList.style.overflow = "auto";
				committedStepsList.style.border = "1px solid rgba(0,0,0,0.14)";
				committedStepsList.style.borderRadius = "8px";
				committedStepsList.style.padding = "6px";
				const committedStepsScrollHint = doc.createElement("div");
				committedStepsScrollHint.style.display = "none";
				committedStepsScrollHint.style.textAlign = "center";
				committedStepsScrollHint.style.fontSize = "11px";
				committedStepsScrollHint.style.color = "#64748b";
				committedStepsScrollHint.style.marginTop = "2px";
				committedStepsScrollHint.textContent = "可向下滚动查看更多";
				const flowGraphTitle = mkLabel("Flow 流程图（Phase 1）");
				const flowGraphViewport = doc.createElement("div");
				flowGraphViewport.style.border = "1px solid rgba(0,0,0,0.14)";
				flowGraphViewport.style.borderRadius = "8px";
					flowGraphViewport.style.background = "#f8fafc";
					flowGraphViewport.style.maxHeight = "320px";
					flowGraphViewport.style.overflow = "auto";
					flowGraphViewport.style.padding = "6px";
					flowGraphViewport.style.cursor = "grab";
					flowGraphViewport.style.position = "relative";
				const flowGraphCanvas = doc.createElement("div");
				flowGraphCanvas.style.position = "relative";
				flowGraphCanvas.style.minHeight = "120px";
				flowGraphCanvas.style.minWidth = "240px";
				flowGraphViewport.appendChild(flowGraphCanvas);
						const flowGraphHoverBanner = doc.createElement("div");
						flowGraphHoverBanner.style.display = "none";
						flowGraphHoverBanner.style.position = "absolute";
						flowGraphHoverBanner.style.left = "12px";
						flowGraphHoverBanner.style.right = "12px";
						flowGraphHoverBanner.style.top = "8px";
						flowGraphHoverBanner.style.margin = "0";
						flowGraphHoverBanner.style.zIndex = "1000";
						flowGraphHoverBanner.style.pointerEvents = "none";
					flowGraphHoverBanner.style.boxSizing = "border-box";
				flowGraphHoverBanner.style.fontSize = "11px";
				flowGraphHoverBanner.style.color = "#0f172a";
					flowGraphHoverBanner.style.background = "#e0f2fe";
					flowGraphHoverBanner.style.border = "1px solid #7dd3fc";
					flowGraphHoverBanner.style.borderRadius = "8px";
					flowGraphHoverBanner.style.padding = "6px 8px";
					flowGraphHoverBanner.style.boxShadow = "0 1px 4px rgba(15,23,42,0.14)";
					flowGraphHoverBanner.style.isolation = "isolate";
					flowGraphHoverBanner.style.whiteSpace = "pre-wrap";
				flowGraphHoverBanner.style.wordBreak = "break-word";
				flowGraphViewport.appendChild(flowGraphHoverBanner);
				const flowStatus = doc.createElement("div");
				flowStatus.style.fontSize = "12px";
				flowStatus.style.color = "#334155";
				flowStatus.style.whiteSpace = "pre-wrap";

					const shellSection = doc.createElement("div");
					shellSection.style.display = "flex";
					shellSection.style.flexDirection = "column";
					shellSection.style.gap = "8px";
						const shellLabelGoal = mkLabel("Flow 目标");
						const shellLabelId = mkLabel("Flow ID");
						const shellLabelCaps = mkLabel("候选 Caps");
							const shellLabelArgs = mkLabel("候选 Args");
							const shellLabelFilters = mkLabel("候选 Filters");
						shellSection.appendChild(shellLabelGoal);
						shellSection.appendChild(flowGoal);
						shellSection.appendChild(shellLabelId);
						shellSection.appendChild(flowId);
						shellSection.appendChild(shellLabelCaps);
						shellSection.appendChild(flowCaps);
						shellSection.appendChild(shellLabelArgs);
							shellSection.appendChild(flowArgs);
							shellSection.appendChild(shellLabelFilters);
							shellSection.appendChild(flowFiltersWrap);
					shellSection.appendChild(shellReadonly);
					const editShellBtn = mkBtn("编辑外壳", "#64748b");
					editShellBtn.style.display = "none";
					shellSection.appendChild(editShellBtn);
					shellSection.appendChild(analyzeBtn);
					shellSection.appendChild(confirmBtn);

					const stepSection = doc.createElement("div");
					stepSection.style.display = "none";
					stepSection.style.flexDirection = "column";
					stepSection.style.gap = "8px";
					const stepContentLayout = doc.createElement("div");
					stepContentLayout.style.display = "flex";
					stepContentLayout.style.flexDirection = "column";
					stepContentLayout.style.gap = "8px";
					const stepLeftCol = doc.createElement("div");
					stepLeftCol.style.display = "flex";
					stepLeftCol.style.flexDirection = "column";
					stepLeftCol.style.gap = "8px";
					stepLeftCol.style.minWidth = "0";
					const stepRightCol = doc.createElement("div");
					stepRightCol.style.display = "flex";
					stepRightCol.style.flexDirection = "column";
					stepRightCol.style.gap = "8px";
					stepRightCol.style.minWidth = "0";
					const stepEditorArea = doc.createElement("div");
					stepEditorArea.style.display = "flex";
					stepEditorArea.style.flexDirection = "column";
					stepEditorArea.style.gap = "8px";
					stepEditorArea.appendChild(mkLabel("Step ID"));
					stepEditorArea.appendChild(stepIdInput);
					stepEditorArea.appendChild(mkLabel("Action Type"));
					stepEditorArea.appendChild(actionTypeSel);
					stepEditorArea.appendChild(mkLabel("Action 字段编辑（按类型自动生效）"));
					stepEditorArea.appendChild(fieldWrap);
					stepEditorArea.appendChild(mkLabel("Action Payload(JSON)"));
					stepEditorArea.appendChild(actionPayload);
					stepEditorArea.appendChild(mkLabel("AI 对话修改当前步骤"));
					stepEditorArea.appendChild(aiStepPrompt);
					stepEditorArea.appendChild(aiRewriteStepBtn);
					stepEditorArea.appendChild(stepNextSection);
					stepEditorArea.appendChild(runStepBtn);
					stepEditorArea.appendChild(acceptStepBtn);
					stepEditorArea.appendChild(saveFlowBtn);
					const committedStepsTitle = mkLabel("已写入步骤（点击即编辑，右侧可删除）");
					stepLeftCol.appendChild(stepModeRow);
					stepLeftCol.appendChild(stepEditorArea);
					stepLeftCol.appendChild(committedStepsTitle);
					stepLeftCol.appendChild(committedStepsList);
					stepLeftCol.appendChild(committedStepsScrollHint);
					stepRightCol.appendChild(flowGraphTitle);
					stepRightCol.appendChild(flowGraphViewport);
					stepContentLayout.appendChild(stepLeftCol);
					stepContentLayout.appendChild(stepRightCol);
					stepSection.appendChild(stepContentLayout);

					flowWrap.appendChild(savedFlowRow);
					flowWrap.appendChild(shellSection);
					flowWrap.appendChild(stepSection);
					flowWrap.appendChild(flowStatus);
				panel.appendChild(header);
				panel.appendChild(list);
				panel.appendChild(flowWrap);
				panel.appendChild(inputWrap);
					root.appendChild(panel);
					root.appendChild(menu);
					root.appendChild(fab);
					(doc.body || doc.documentElement).appendChild(root);
					const isBlankPage = (() => {
						try {
							const href = String(location.href || "").trim().toLowerCase();
							if (href === "about:blank" || href.startsWith("about:blank?")) return true;
						} catch (_) {
						}
						return false;
					})();

					const normalizeRole = (r) => (String(r || "").toLowerCase() === "assistant" ? "assistant" : "user");
					const normalizeText = (v) => String(v || "").trim();
					const history = [];
					const pendingById = new Map();
					const flowPendingById = new Map();
						const flowBuilder = {
							active: false,
							shellConfirmed: false,
							stepNo: 1,
						draft: { id: "", start: "", capabilities: [], filters: [], args: {}, steps: [] },
							lastRunOk: false,
							lastRunStep: null,
						};
						let runStepUiHidden = false;
						let runStepRestoreTimer = null;
						let editingCommittedStepIndex = -1;
						let selectedCommittedStepIndex = -1;
						let liveEditorSnapshot = null;
						let invokeCandidates = [];
						let savedFlowEntries = [];
						let stepEditorMode = "new";
						let flowGraphExpanded = false;
						let graphPanning = false;
						let graphPanStartX = 0;
						let graphPanStartY = 0;
						let graphPanStartLeft = 0;
						let graphPanStartTop = 0;
						const cloneJsonLike = (v, fallback = {}) => {
						try {
							return JSON.parse(JSON.stringify(v));
						} catch (_) {
							return fallback;
						}
					};
					const toDraftStep = (step) => {
						const one = (step && typeof step === "object") ? step : {};
						const sid = String(one.id || "").trim();
						const action = (one.action && typeof one.action === "object") ? cloneJsonLike(one.action, {}) : {};
						const next = (one.next && typeof one.next === "object") ? cloneJsonLike(one.next, {}) : {};
						const payloadText = JSON.stringify(action, null, 2);
						return { id: sid, action, next, __uiActionPayload: payloadText, __uiActionType: String(action.type || "").trim() };
					};
					const getStepActionType = (step) => {
						const direct = String(step?.action?.type || "").trim();
						if (direct) return direct;
						const hint = String(step?.__uiActionType || "").trim();
						if (hint) return hint;
						const raw = String(step?.__uiActionPayload || "").trim();
						if (!raw) return "";
						try {
							const obj = JSON.parse(raw);
							if (obj && typeof obj === "object" && !Array.isArray(obj)) {
								return String(obj.type || "").trim();
							}
						} catch (_) {
						}
							return "";
						};
						const applyFlowGraphLayoutMode = (expanded) => {
							flowGraphExpanded = !!expanded;
							flowGraphModeBtn.textContent = flowGraphExpanded ? "退出大图" : "放大流程图";
							flowGraphModeBtn.style.background = flowGraphExpanded ? "#0f766e" : "#475569";
							if (flowGraphExpanded) {
								panel.style.width = panelWidthFlowExpanded;
								stepContentLayout.style.display = "grid";
								stepContentLayout.style.gridTemplateColumns = "minmax(360px, 45%) minmax(520px, 55%)";
								stepContentLayout.style.alignItems = "start";
								stepContentLayout.style.gap = "10px";
								stepLeftCol.style.width = "";
								stepRightCol.style.width = "";
								flowGraphViewport.style.height = "calc(90vh - 220px)";
								flowGraphViewport.style.maxHeight = "calc(90vh - 220px)";
							} else {
								panel.style.width = panelWidthDefault;
								stepContentLayout.style.display = "flex";
								stepContentLayout.style.flexDirection = "column";
								stepContentLayout.style.alignItems = "stretch";
								stepContentLayout.style.gap = "8px";
								stepLeftCol.style.width = "100%";
								stepRightCol.style.width = "100%";
								flowGraphViewport.style.height = "";
								flowGraphViewport.style.maxHeight = "320px";
							}
							try {
								if (panel.style.position === "fixed") {
									const rect = panel.getBoundingClientRect();
									const vw = window.innerWidth || doc.documentElement.clientWidth || 0;
									const vh = window.innerHeight || doc.documentElement.clientHeight || 0;
									const nx = Math.max(8, Math.min(Math.round(rect.left), Math.max(8, vw - Math.round(rect.width) - 8)));
									const ny = Math.max(8, Math.min(Math.round(rect.top), Math.max(8, vh - Math.round(rect.height) - 8)));
									panel.style.left = `${nx}px`;
									panel.style.top = `${ny}px`;
									panel.style.bottom = "auto";
								}
							} catch (_) {}
						};
						applyFlowGraphLayoutMode(false);
					const stepHasValidAction = (step) => {
						return !!getStepActionType(step);
					};
					const tryBuildStepFromEditorLoose = () => {
						const sid = String(stepIdInput.value || "").trim();
						const type = String(actionTypeSel.value || "").trim().toLowerCase();
						const payload = parseActionPayload();
						if (!sid || !type || payload === null) return null;
						const action = (payload && typeof payload === "object") ? cloneJsonLike(payload, {}) : {};
						if (!String(action.type || "").trim()) action.type = type;
						if (!String(action.type || "").trim()) return null;
						const step = { id: sid, action, next: {} };
						const dn = String(nextDoneInput.value || "").trim();
						const fn = String(nextFailedInput.value || "").trim();
						const sn = String(nextSkippedInput.value || "").trim();
						const tn = String(nextTimeoutInput.value || "").trim();
						const xn = String(nextDefaultInput.value || "").trim();
						if (dn) step.next.done = dn;
						if (fn) step.next.failed = fn;
						if (sn) step.next.skipped = sn;
						if (tn) step.next.timeout = tn;
						if (xn) step.next.default = xn;
						return step;
					};
					const coerceCommittedStep = (primary, fallback, tag = "") => {
						if (stepHasValidAction(primary)) return primary;
						if (stepHasValidAction(fallback)) {
							flowDbg("coerce_committed_step.use_fallback", {
								tag,
								primaryStepId: String(primary?.id || ""),
								fallbackStepId: String(fallback?.id || ""),
								fallbackActionType: String(fallback?.action?.type || ""),
							});
							return fallback;
						}
						const loose = tryBuildStepFromEditorLoose();
						if (stepHasValidAction(loose)) {
							flowDbg("coerce_committed_step.use_loose_editor", {
								tag,
								stepId: String(loose?.id || ""),
								actionType: String(loose?.action?.type || ""),
							});
							return loose;
						}
						flowDbg("coerce_committed_step.failed", {
							tag,
							primaryStepId: String(primary?.id || ""),
							primaryActionType: String(primary?.action?.type || ""),
							fallbackStepId: String(fallback?.id || ""),
							fallbackActionType: String(fallback?.action?.type || ""),
						});
						return null;
					};
					let actionPayloadProgrammatic = false;
					let actionPayloadManualDirty = false;

				const appendBubble = (role, text) => {
					const row = doc.createElement("div");
					row.style.alignSelf = role === "user" ? "flex-end" : "flex-start";
					row.style.maxWidth = "88%";
					row.style.padding = "8px 10px";
					row.style.borderRadius = "10px";
					row.style.whiteSpace = "pre-wrap";
					row.style.wordBreak = "break-word";
					row.style.fontSize = "13px";
					row.style.lineHeight = "1.35";
					if (role === "user") {
						row.style.background = "#dbeafe";
						row.style.color = "#0f172a";
					} else {
						row.style.background = "#f1f5f9";
						row.style.color = "#111827";
					}
					row.textContent = String(text || "");
					list.appendChild(row);
					list.scrollTop = list.scrollHeight;
						return row;
					};
					const seedRows = Array.isArray(historySeed) ? historySeed : [];
					for (const row of seedRows) {
						const role = normalizeRole(row?.role);
						const text = normalizeText(row?.text);
						if (!text) continue;
						history.push({ role, text });
						if (history.length > 24) history.splice(0, history.length - 24);
						appendBubble(role, text);
					}

					const submitQuestion = (question) => {
						const text = String(question || "").trim();
						if (!text) return;
						appendBubble("user", text);
						history.push({ role: "user", text });
						st.seq = Number(st.seq || 0) + 1;
						const id = `q_${Date.now()}_${st.seq}`;
						const pendingNode = appendBubble("assistant", "思考中…");
						pendingById.set(id, pendingNode);
						st.requests.push({
							id,
							question: text,
							history: history.slice(-12),
							url: String(location.href || ""),
							title: String(document.title || ""),
							ts: Date.now(),
						});
						if (st.requests.length > 20) st.requests.splice(0, st.requests.length - 20);
					};
					const ask = () => {
						const question = String(input.value || "").trim();
						if (!question) return;
						input.value = "";
						submitQuestion(question);
					};
					const setShellLocked = (locked) => {
						const on = !!locked;
							shellLabelGoal.style.display = on ? "none" : "";
							shellLabelId.style.display = on ? "none" : "";
							shellLabelCaps.style.display = on ? "none" : "";
							shellLabelArgs.style.display = on ? "none" : "";
								shellLabelFilters.style.display = on ? "none" : "";
								flowGoal.style.display = on ? "none" : "";
								flowId.style.display = on ? "none" : "";
								flowCaps.style.display = on ? "none" : "";
								flowArgs.style.display = on ? "none" : "";
								flowFiltersWrap.style.display = on ? "none" : "";
									if (on) {
										const capList = Array.from(new Set([
											...parseCsv(flowCaps.value),
											...parseCsv(flowArgs.value),
										]));
										const filterRows = readFiltersFromEditor();
									shellReadonly.textContent = [
											`Flow 目标: ${String(flowGoal.value || "").trim() || "-"}`,
											`Flow ID: ${String(flowId.value || "").trim() || "-"}`,
											`Caps: ${String(flowCaps.value || "").trim() || "-"}`,
											`Args: ${String(flowArgs.value || "").trim() || "-"}`,
											`Filters: ${filterRows.length ? JSON.stringify(filterRows) : "-"}`,
											`Capabilities: ${capList.join(", ") || "-"}`,
											`Source: ${String(flowBuilder?.draft?.sourcePath || "").trim() || "-"}`,
										].join("\n");
									}
						shellReadonly.style.display = on ? "block" : "none";
						editShellBtn.style.display = on ? "" : "none";
						analyzeBtn.style.display = locked ? "none" : "";
						confirmBtn.style.display = locked ? "none" : "";
						stepSection.style.display = locked ? "flex" : "none";
					};
					const createBranchCaseRow = (seed = {}) => {
						const row = doc.createElement("div");
						row.style.display = "flex";
						row.style.flexDirection = "column";
						row.style.gap = "6px";
						row.style.border = "1px solid rgba(0,0,0,0.12)";
						row.style.borderRadius = "8px";
						row.style.padding = "6px";
						const head = doc.createElement("div");
						head.style.display = "grid";
						head.style.gridTemplateColumns = "1fr 1fr auto";
						head.style.gap = "6px";
						head.style.alignItems = "center";
						const body = doc.createElement("div");
						body.style.display = "grid";
						body.style.gridTemplateColumns = "1fr 1fr 1fr";
						body.style.gap = "6px";
						body.style.alignItems = "center";
						const sourceSel = doc.createElement("select");
						for (const one of ["args", "opts", "vars", "result"]) {
							const op = doc.createElement("option");
							op.value = one;
							op.textContent = `source=${one}`;
							sourceSel.appendChild(op);
						}
						sourceSel.style.width = "100%";
						const opSel = doc.createElement("select");
						for (const one of ["exists", "truthy", "eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "match"]) {
							const op = doc.createElement("option");
							op.value = one;
							op.textContent = `op=${one}`;
							opSel.appendChild(op);
						}
						opSel.style.width = "100%";
						const pathInput = mkInput("path（如 publish 或 cover.data）");
						const valueInput = mkInput("value/values/regex（JSON 或文本）");
						const toInput = mkInput("to（命中后 stepId）");
						const delBtn = mkBtn("删除", "#b91c1c");
						delBtn.style.padding = "6px 8px";
						if (String(seed.source || "").trim()) sourceSel.value = String(seed.source || "").trim();
						if (String(seed.op || "").trim()) opSel.value = String(seed.op || "").trim();
						pathInput.value = String(seed.path || "");
						valueInput.value = String(seed.valueText || "");
						toInput.value = String(seed.to || "");
						head.appendChild(sourceSel);
						head.appendChild(opSel);
						head.appendChild(delBtn);
						body.appendChild(pathInput);
						body.appendChild(valueInput);
						body.appendChild(toInput);
						row.appendChild(head);
						row.appendChild(body);
						row.__sourceSel = sourceSel;
						row.__opSel = opSel;
						row.__pathInput = pathInput;
						row.__valueInput = valueInput;
						row.__toInput = toInput;
						row.__delBtn = delBtn;
						const sync = () => { syncActionPayloadFromFields(true); };
						sourceSel.addEventListener("change", sync);
						opSel.addEventListener("change", sync);
						pathInput.addEventListener("input", sync);
						valueInput.addEventListener("input", sync);
						toInput.addEventListener("input", sync);
						delBtn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							row.remove();
							syncActionPayloadFromFields(false);
						});
						return row;
					};
					const parseBranchValueText = (text) => {
						const raw = String(text || "").trim();
						if (!raw) return { has: false, value: undefined };
						try {
							return { has: true, value: JSON.parse(raw) };
						} catch (_) {
							return { has: true, value: raw };
						}
					};
					const branchValueToText = (v) => {
						if (v === undefined) return "";
						if (typeof v === "string") return v;
						try {
							return JSON.stringify(v);
						} catch (_) {
							return String(v);
						}
					};
					const readBranchCases = (strict = true) => {
						const rows = Array.from(fBranchCasesWrap.children || []);
						const cases = [];
						for (const row of rows) {
							const source = asText(row?.__sourceSel?.value) || "args";
							const op = asText(row?.__opSel?.value).toLowerCase();
							const path = asText(row?.__pathInput?.value);
							const to = asText(row?.__toInput?.value);
							if (!op && !path && !to) continue;
							if (!op || !path || !to) {
								if (strict) return { ok: false, reason: "branch case 需填写 op/path/to", cases: [] };
								continue;
							}
							const when = { op, path };
							if (source && source !== "args") when.source = source;
							const pv = parseBranchValueText(row?.__valueInput?.value);
							if (op === "eq" || op === "neq" || op === "contains" || op === "gt" || op === "gte" || op === "lt" || op === "lte") {
								if (!pv.has) {
									if (strict) return { ok: false, reason: `branch case(${op}) 缺少 value`, cases: [] };
									continue;
								}
								when.value = pv.value;
							} else if (op === "in") {
								if (!pv.has) {
									if (strict) return { ok: false, reason: "branch case(in) 缺少 values", cases: [] };
									continue;
								}
								when.values = Array.isArray(pv.value) ? pv.value : [pv.value];
							} else if (op === "match") {
								if (!pv.has) {
									if (strict) return { ok: false, reason: "branch case(match) 缺少 regex", cases: [] };
									continue;
								}
								when.regex = String(pv.value || "");
							}
							cases.push({ when, to });
						}
						return { ok: true, reason: "", cases };
					};
					const setBranchCases = (rows) => {
						fBranchCasesWrap.innerHTML = "";
						const list = Array.isArray(rows) ? rows : [];
						for (const one of list) {
							const when = (one?.when && typeof one.when === "object") ? one.when : {};
							const seed = {
								source: String(when.source || "args"),
								op: String(when.op || "exists"),
								path: String(when.path || ""),
								valueText: "",
								to: String(one?.to || ""),
							};
							if ("value" in when) seed.valueText = branchValueToText(when.value);
							else if ("values" in when) seed.valueText = branchValueToText(when.values);
							else if ("regex" in when) seed.valueText = String(when.regex || "");
							fBranchCasesWrap.appendChild(createBranchCaseRow(seed));
						}
						if (!fBranchCasesWrap.children.length) {
							fBranchCasesWrap.appendChild(createBranchCaseRow({ op: "exists", source: "args" }));
						}
					};
					const captureStepFieldState = () => ({
						fBy: String(fBy.value || ""),
						fQuery: String(fQuery.value || ""),
						fUrl: String(fUrl.value || ""),
						fText: String(fText.value || ""),
						fKey: String(fKey.value || ""),
						fModifiers: String(fModifiers.value || ""),
						fTimes: String(fTimes.value || ""),
						fPick: String(fPick.value || ""),
						fTimeout: String(fTimeout.value || ""),
						fPostWait: String(fPostWait.value || ""),
						fPreEnterWait: String(fPreEnterWait.value || ""),
						fDeltaX: String(fDeltaX.value || ""),
						fDeltaY: String(fDeltaY.value || ""),
						fBehavior: String(fBehavior.value || ""),
						fTarget: String(fTarget.value || ""),
						fInvokeFind: String(fInvokeFind.value || ""),
						fInvokeTargetPick: String(fInvokeTargetPick.value || ""),
						fInvokeArgs: String(fInvokeArgs.value || ""),
						fRunJsCode: String(fRunJsCode.value || ""),
						fRunJsQuery: String(fRunJsQuery.value || ""),
						fRunJsArgs: String(fRunJsArgs.value || ""),
						fBranchDesc: String(fBranchDesc.value || ""),
						fBranchDefault: String(fBranchDefault.value || ""),
						fBranchCasesJson: JSON.stringify(readBranchCases(false).cases || []),
						aiStepPrompt: String(aiStepPrompt.value || ""),
						fInputMode: String(fInputMode.value || "type"),
						fCaret: String(fCaret.value || "end"),
						fOnError: String(fOnError.value || "fail"),
						fReturnTo: String(fReturnTo.value || "caller"),
						fRunJsScope: String(fRunJsScope.value || "page"),
						cClear: !!cClear.cb.checked,
						cPressEnter: !!cPressEnter.cb.checked,
						cExpectFocus: !!cExpectFocus.cb.checked,
						cWaitUserAction: !!cWaitUserAction.cb.checked,
						nextSkipped: String(nextSkippedInput.value || ""),
						nextTimeout: String(nextTimeoutInput.value || ""),
						nextDefault: String(nextDefaultInput.value || ""),
					});
					const restoreStepFieldState = (s) => {
						const fs = (s && typeof s === "object") ? s : {};
						if ("fBy" in fs) fBy.value = String(fs.fBy || "");
						if ("fQuery" in fs) fQuery.value = String(fs.fQuery || "");
						if ("fUrl" in fs) fUrl.value = String(fs.fUrl || "");
						if ("fText" in fs) fText.value = String(fs.fText || "");
						if ("fKey" in fs) fKey.value = String(fs.fKey || "");
						if ("fModifiers" in fs) fModifiers.value = String(fs.fModifiers || "");
						if ("fTimes" in fs) fTimes.value = String(fs.fTimes || "");
						if ("fPick" in fs) fPick.value = String(fs.fPick || "");
						if ("fTimeout" in fs) fTimeout.value = String(fs.fTimeout || "");
						if ("fPostWait" in fs) fPostWait.value = String(fs.fPostWait || "");
						if ("fPreEnterWait" in fs) fPreEnterWait.value = String(fs.fPreEnterWait || "");
						if ("fDeltaX" in fs) fDeltaX.value = String(fs.fDeltaX || "");
						if ("fDeltaY" in fs) fDeltaY.value = String(fs.fDeltaY || "");
						if ("fBehavior" in fs) fBehavior.value = String(fs.fBehavior || "");
						if ("fTarget" in fs) fTarget.value = String(fs.fTarget || "");
						if ("fInvokeFind" in fs) fInvokeFind.value = String(fs.fInvokeFind || "{\"kind\":\"rpa\",\"must\":[]}");
						if ("fInvokeTargetPick" in fs) fInvokeTargetPick.value = String(fs.fInvokeTargetPick || "");
						if ("fInvokeArgs" in fs) fInvokeArgs.value = String(fs.fInvokeArgs || "{}");
						if ("fRunJsCode" in fs) fRunJsCode.value = String(fs.fRunJsCode || "");
						if ("fRunJsQuery" in fs) fRunJsQuery.value = String(fs.fRunJsQuery || "");
						if ("fRunJsArgs" in fs) fRunJsArgs.value = String(fs.fRunJsArgs || "[]");
						if ("fBranchDesc" in fs) fBranchDesc.value = String(fs.fBranchDesc || "");
						if ("fBranchDefault" in fs) fBranchDefault.value = String(fs.fBranchDefault || "");
						if ("fBranchCasesJson" in fs) {
							try {
								setBranchCases(JSON.parse(String(fs.fBranchCasesJson || "[]")));
							} catch (_) {
								setBranchCases([]);
							}
						}
						if ("aiStepPrompt" in fs) aiStepPrompt.value = String(fs.aiStepPrompt || "");
						if ("fInputMode" in fs && fs.fInputMode) fInputMode.value = String(fs.fInputMode);
						if ("fCaret" in fs && fs.fCaret) fCaret.value = String(fs.fCaret);
						if ("fOnError" in fs && fs.fOnError) fOnError.value = String(fs.fOnError);
						if ("fReturnTo" in fs && fs.fReturnTo) fReturnTo.value = String(fs.fReturnTo);
						if ("fRunJsScope" in fs && fs.fRunJsScope) fRunJsScope.value = String(fs.fRunJsScope);
						if ("cClear" in fs) cClear.cb.checked = !!fs.cClear;
						if ("cPressEnter" in fs) cPressEnter.cb.checked = !!fs.cPressEnter;
						if ("cExpectFocus" in fs) cExpectFocus.cb.checked = !!fs.cExpectFocus;
						if ("cWaitUserAction" in fs) cWaitUserAction.cb.checked = !!fs.cWaitUserAction;
						if ("nextSkipped" in fs) nextSkippedInput.value = String(fs.nextSkipped || "");
						if ("nextTimeout" in fs) nextTimeoutInput.value = String(fs.nextTimeout || "");
						if ("nextDefault" in fs) nextDefaultInput.value = String(fs.nextDefault || "");
					};
					const normalizeInvokeCandidates = (rows) => {
						const out = [];
						const list = Array.isArray(rows) ? rows : [];
						for (const one of list) {
							const entryId = String(one?.entryId || "").trim();
							const id = String(one?.id || "").trim();
							const source = String(one?.source || "").trim();
							if (!entryId || !id) continue;
							out.push({ entryId, id, source });
						}
						return out.slice(0, 30);
					};
					const normalizeSavedFlowEntries = (rows) => {
						const out = [];
						for (const one of (Array.isArray(rows) ? rows : [])) {
							const id = String(one?.id || "").trim();
							const path = String(one?.path || "").trim();
							const file = String(one?.file || "").trim();
							if (!id || !path) continue;
							out.push({ id, path, file });
						}
						return out.slice(0, 300);
					};
					const renderSavedFlowOptions = (preferredPath = "") => {
						const cur = String(savedFlowSelect.value || "").trim();
						const selected = String(preferredPath || cur || "").trim();
						savedFlowSelect.innerHTML = "";
						const first = doc.createElement("option");
						first.value = "";
						first.textContent = "选择已存 Flow 文件…";
						savedFlowSelect.appendChild(first);
						for (const one of savedFlowEntries) {
							const op = doc.createElement("option");
							op.value = one.path;
							op.textContent = `${one.id}${one.file ? ` (${one.file})` : ""}`;
							savedFlowSelect.appendChild(op);
						}
						if (selected && Array.from(savedFlowSelect.options).some((x) => String(x.value || "") === selected)) {
							savedFlowSelect.value = selected;
						} else {
							savedFlowSelect.value = "";
						}
					};
						const renderInvokeTargetOptions = (preferred = "") => {
							const current = String(fInvokeTargetPick.value || "").trim();
							const selected = current;
							fInvokeTargetPick.innerHTML = "";
						const autoOpt = doc.createElement("option");
						autoOpt.value = "";
						autoOpt.textContent = "按 find 自动匹配（不强制 target）";
						fInvokeTargetPick.appendChild(autoOpt);
						for (const one of invokeCandidates) {
							const op = doc.createElement("option");
							op.value = one.entryId;
							const src = one.source ? String(one.source).split("/").slice(-1)[0] : "";
							op.textContent = `${one.entryId}  (${one.id}${src ? ` | ${src}` : ""})`;
							fInvokeTargetPick.appendChild(op);
						}
						if (selected && Array.from(fInvokeTargetPick.options).some((x) => String(x.value || "") === selected)) {
							fInvokeTargetPick.value = selected;
						} else {
							fInvokeTargetPick.value = "";
						}
					};
						const collectBuilderState = () => ({
						active: !!flowBuilder.active,
						shellConfirmed: !!flowBuilder.shellConfirmed,
							stepNo: Number(flowBuilder.stepNo || 1),
							flowGoal: String(flowGoal.value || ""),
								flowId: String(flowId.value || ""),
								flowCaps: String(flowCaps.value || ""),
								flowArgs: String(flowArgs.value || ""),
								flowFilters: JSON.stringify(readFiltersFromEditor()),
								draft: (flowBuilder.draft && typeof flowBuilder.draft === "object") ? flowBuilder.draft : { id: "", start: "", capabilities: [], filters: [], args: {}, steps: [] },
						lastRunOk: !!flowBuilder.lastRunOk,
						lastRunStep: flowBuilder.lastRunStep || null,
						invokeCandidates: normalizeInvokeCandidates(invokeCandidates),
						savedFlowEntries: normalizeSavedFlowEntries(savedFlowEntries),
						stepEditor: {
							stepId: String(stepIdInput.value || ""),
							actionType: String(actionTypeSel.value || ""),
							actionPayload: String(actionPayload.value || ""),
							actionPayloadManualDirty: !!actionPayloadManualDirty,
							nextDone: String(nextDoneInput.value || ""),
							nextFailed: String(nextFailedInput.value || ""),
							fields: captureStepFieldState(),
						},
					});
					const applyBuilderState = (seed, opts = {}) => {
						const applyStepEditor = opts?.applyStepEditor !== false;
						const s = (seed && typeof seed === "object") ? seed : null;
						if (!s) return;
						flowDbg("apply_builder_state", {
							applyStepEditor: !!applyStepEditor,
							hasStepEditor: !!(s && s.stepEditor),
							shellConfirmed: !!s.shellConfirmed,
							stepNo: Number(s.stepNo || 0),
							draftSteps: Array.isArray(s?.draft?.steps) ? s.draft.steps.length : 0,
						});
						if (typeof s.stepNo === "number" && Number.isFinite(s.stepNo) && s.stepNo >= 1) flowBuilder.stepNo = Math.floor(s.stepNo);
						flowBuilder.shellConfirmed = !!s.shellConfirmed;
						flowBuilder.lastRunOk = !!s.lastRunOk;
						flowBuilder.lastRunStep = s.lastRunStep || null;
						editingCommittedStepIndex = -1;
						selectedCommittedStepIndex = -1;
						if (s.draft && typeof s.draft === "object") flowBuilder.draft = s.draft;
						invokeCandidates = normalizeInvokeCandidates(s.invokeCandidates);
						savedFlowEntries = normalizeSavedFlowEntries(s.savedFlowEntries);
						if (typeof s.flowGoal === "string") flowGoal.value = s.flowGoal;
								if (typeof s.flowId === "string") flowId.value = s.flowId;
								if (typeof s.flowCaps === "string") flowCaps.value = s.flowCaps;
								if (typeof s.flowArgs === "string") flowArgs.value = s.flowArgs;
								if (Array.isArray(s.flowFilters)) {
									setFiltersEditorRows(s.flowFilters);
								} else if (typeof s.flowFilters === "string") {
									setFiltersEditorRows(parseFiltersText(s.flowFilters));
								} else if (Array.isArray(s?.draft?.filters)) {
									setFiltersEditorRows(s.draft.filters);
								}
						if (applyStepEditor && s.stepEditor && typeof s.stepEditor === "object") {
							flowDbg("apply_builder_state.step_editor", {
								stepId: String(s.stepEditor.stepId || ""),
								actionType: String(s.stepEditor.actionType || ""),
								payloadLen: String(s.stepEditor.actionPayload || "").length,
								manualDirty: !!s.stepEditor.actionPayloadManualDirty,
							});
							if (typeof s.stepEditor.stepId === "string") stepIdInput.value = s.stepEditor.stepId;
							if (typeof s.stepEditor.actionType === "string" && s.stepEditor.actionType) actionTypeSel.value = s.stepEditor.actionType;
							if (typeof s.stepEditor.actionPayload === "string") {
								actionPayloadProgrammatic = true;
								actionPayload.value = s.stepEditor.actionPayload;
								actionPayloadProgrammatic = false;
							}
							actionPayloadManualDirty = !!s.stepEditor.actionPayloadManualDirty;
							if (typeof s.stepEditor.nextDone === "string") nextDoneInput.value = s.stepEditor.nextDone;
							if (typeof s.stepEditor.nextFailed === "string") nextFailedInput.value = s.stepEditor.nextFailed;
							if (typeof s.stepEditor.nextSkipped === "string") nextSkippedInput.value = s.stepEditor.nextSkipped;
							if (typeof s.stepEditor.nextTimeout === "string") nextTimeoutInput.value = s.stepEditor.nextTimeout;
							if (typeof s.stepEditor.nextDefault === "string") nextDefaultInput.value = s.stepEditor.nextDefault;
							if (s.stepEditor.fields && typeof s.stepEditor.fields === "object") restoreStepFieldState(s.stepEditor.fields);
						}
						setShellLocked(flowBuilder.shellConfirmed);
						updateActionFieldVisibility();
						renderInvokeTargetOptions();
						renderSavedFlowOptions(String(flowBuilder?.draft?.sourcePath || ""));
						setStepEditorMode(editingCommittedStepIndex >= 0 ? "saved" : (stepEditorMode === "idle" ? "idle" : "new"));
						renderCommittedSteps();
						if (s.active === true) setFlowBuilderMode(true);
					};
						const setFlowBuilderMode = (on) => {
							flowBuilder.active = !!on;
							if (flowBuilder.active) {
								title.textContent = "Flow Builder";
								list.style.display = "none";
								inputWrap.style.display = "none";
								flowWrap.style.display = "flex";
								applyFlowGraphLayoutMode(flowGraphExpanded);
								setShellLocked(!!flowBuilder.shellConfirmed);
								renderCommittedSteps();
								renderSavedFlowOptions(String(flowBuilder?.draft?.sourcePath || ""));
								if (!stepIdInput.value) stepIdInput.value = `step_${flowBuilder.stepNo}`;
							} else {
								title.textContent = "页面 AI 助手";
								list.style.display = "flex";
								inputWrap.style.display = "flex";
								flowWrap.style.display = "none";
								panel.style.width = panelWidthDefault;
							}
						};
					st.applyFlowBuilderState = (seed) => { try { applyBuilderState(seed); } catch (_) {} };
					const emitFlowReq = (kind, payload) => {
						st.seq = Number(st.seq || 0) + 1;
						const id = `fb_${Date.now()}_${st.seq}`;
						st.flowBuildRequests.push({
							id,
							kind: String(kind || ""),
							payload: {
								...((payload && typeof payload === "object") ? payload : {}),
								builderState: collectBuilderState(),
							},
							url: String(location.href || ""),
							title: String(document.title || ""),
							ts: Date.now(),
						});
						if (st.flowBuildRequests.length > 30) st.flowBuildRequests.splice(0, st.flowBuildRequests.length - 30);
						return id;
					};
						const parseCsv = (text) => String(text || "")
							.split(",")
							.map((x) => String(x || "").trim())
							.filter(Boolean);
						const normalizeFilters = (rows) => {
							const list = Array.isArray(rows) ? rows : [];
							const out = [];
							for (const one of list) {
								if (!one || typeof one !== "object") continue;
								const key = String(one.key || "").trim();
								const value = String(one.value || "").trim();
								if (!key || !value) continue;
								out.push({ key, value });
							}
							return out;
						};
						const readFiltersFromEditor = () => {
							const rows = Array.from(flowFiltersRows.children || []);
							const out = [];
							for (const row of rows) {
								const keyInput = row && row.__keyInput;
								const valueInput = row && row.__valueInput;
								const key = String(keyInput?.value || "").trim();
								const value = String(valueInput?.value || "").trim();
								out.push({ key, value });
							}
							return normalizeFilters(out);
						};
						const addFilterRow = (key = "", value = "") => {
							const row = doc.createElement("div");
							row.style.display = "grid";
							row.style.gridTemplateColumns = "1fr 1fr auto";
							row.style.gap = "6px";
							row.style.alignItems = "center";
							const keyInput = mkInput("key（如 domain）");
							const valueInput = mkInput("value（如 * 或 xiaohongshu.com）");
							keyInput.value = String(key || "");
							valueInput.value = String(value || "");
							const delBtn = mkBtn("删除", "#b91c1c");
							delBtn.style.padding = "6px 8px";
							delBtn.addEventListener("click", (ev) => {
								ev.preventDefault();
								ev.stopPropagation();
								row.remove();
							});
							row.__keyInput = keyInput;
							row.__valueInput = valueInput;
							row.appendChild(keyInput);
							row.appendChild(valueInput);
							row.appendChild(delBtn);
							flowFiltersRows.appendChild(row);
							return row;
						};
						const setFiltersEditorRows = (rows) => {
							flowFiltersRows.innerHTML = "";
							const list = normalizeFilters(rows);
							if (!list.length) {
								addFilterRow("", "");
								return;
							}
							for (const one of list) addFilterRow(one.key, one.value);
						};
						const parseFiltersText = (text) => {
							const s = String(text || "").trim();
							if (!s) return [];
							try {
								return normalizeFilters(JSON.parse(s));
							} catch (_) {
								return null;
							}
						};
						const asText = (v) => String(v == null ? "" : v).trim();
					const asNum = (v) => {
						const s = asText(v);
						if (!s) return null;
						const n = Number(s);
						return Number.isFinite(n) ? n : null;
					};
					const parseJsonObject = (text) => {
						const s = asText(text);
						if (!s) return {};
						try {
							const obj = JSON.parse(s);
							return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : null;
						} catch (_) {
							return null;
						}
					};
					const parseJsonArray = (text) => {
						const s = asText(text);
						if (!s) return [];
						try {
							const arr = JSON.parse(s);
							return Array.isArray(arr) ? arr : null;
						} catch (_) {
							return null;
						}
					};
					const parseActionPayload = () => {
						const text = String(actionPayload.value || "").trim();
						if (!text) return {};
						try {
							const obj = JSON.parse(text);
							if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
							return {};
						} catch (_) {
							return null;
						}
					};
					let invokeSuggestTimer = null;
					const requestInvokeTargetSuggestions = (force = false) => {
						if (String(actionTypeSel.value || "").toLowerCase() !== "invoke") return;
						const find = parseJsonObject(fInvokeFind.value);
						if (find === null) {
							if (force) flowStatus.textContent = "invoke.find 不是合法 JSON 对象，无法拉取候选。";
							return;
						}
						const reqId = emitFlowReq("suggest_invoke_targets", { find: find || {}, topN: 12 });
						flowPendingById.set(reqId, "invoke_targets");
						if (force) flowStatus.textContent = "正在刷新 invoke 候选…";
					};
					const setFieldVisible = (el, on, showDisplay = "") => {
						const target = (el && el.__fieldWrap && el.__fieldWrap.style) ? el.__fieldWrap : el;
						if (!target || !target.style) return;
						target.style.display = on ? String(showDisplay || "") : "none";
					};
						const updateActionFieldVisibility = () => {
							const t = asText(actionTypeSel.value).toLowerCase();
							const commonByQuery = ["click", "hover", "wait", "scroll"].includes(t);
						setFieldVisible(fByRow, commonByQuery);
							setFieldVisible(fQuery, commonByQuery);
						setFieldVisible(fPick, ["click", "hover", "wait", "scroll"].includes(t));
						setFieldVisible(fUrl, t === "goto");
						setFieldVisible(fText, ["input", "ask_assist", "done", "abort"].includes(t));
						setFieldVisible(fInputMode, t === "input");
						setFieldVisible(fCaret, t === "input");
						setFieldVisible(cClear.wrap, t === "input");
						setFieldVisible(cPressEnter.wrap, t === "input");
						setFieldVisible(fPreEnterWait, t === "input");
						setFieldVisible(cExpectFocus.wrap, t === "click");
						setFieldVisible(fKey, t === "press_key");
						setFieldVisible(fModifiers, t === "press_key");
						setFieldVisible(fTimes, t === "press_key");
						setFieldVisible(fTimeout, ["wait", "goto"].includes(t));
						setFieldVisible(fPostWait, ["click", "hover", "input", "scroll", "goto"].includes(t));
						setFieldVisible(fDeltaX, t === "scroll");
						setFieldVisible(fDeltaY, t === "scroll");
						setFieldVisible(fBehavior, t === "scroll");
						setFieldVisible(fTarget, t === "invoke");
						setFieldVisible(fInvokeFind, t === "invoke");
						setFieldVisible(invokeSuggestBtn, t === "invoke");
						setFieldVisible(fInvokeTargetPick, t === "invoke");
						setFieldVisible(fInvokeArgs, t === "invoke");
						setFieldVisible(fOnError, t === "invoke");
						setFieldVisible(fReturnTo, t === "invoke");
						setFieldVisible(cWaitUserAction.wrap, t === "ask_assist");
						setFieldVisible(fRunJsCode, t === "run_js");
						setFieldVisible(fRunJsQuery, t === "run_js");
						setFieldVisible(fRunJsArgs, t === "run_js");
						setFieldVisible(fRunJsScope, t === "run_js");
						setFieldVisible(fBranchDesc, t === "branch");
						setFieldVisible(fBranchAiBtn, t === "branch");
						setFieldVisible(fBranchDefault, t === "branch");
						setFieldVisible(fBranchCasesWrap, t === "branch");
						setFieldVisible(fBranchAddCaseBtn, t === "branch");
						setFieldVisible(fBranchHint, t === "branch");
						setFieldVisible(stepNextSection, t !== "branch", "flex");
						const branchMode = t === "branch";
						actionPayload.readOnly = branchMode;
						actionPayload.style.background = branchMode ? "#f8fafc" : "#ffffff";
						if (branchMode) {
							actionPayloadManualDirty = false;
							syncActionPayloadFromFields(true);
						}
					};
					const buildActionFromFields = (strict = true) => {
						const t = asText(actionTypeSel.value).toLowerCase();
						if (!t) return { ok: false, reason: "action.type 不能为空", action: null };
						const a = { type: t };
						if (["click", "hover", "wait", "scroll"].includes(t)) {
							const by = asText(fBy.value);
							const query = asText(fQuery.value);
							if (by) a.by = by;
							if (query) a.query = query;
						}
						if (["click", "hover", "wait", "scroll"].includes(t)) {
							const pick = asText(fPick.value);
							if (pick) a.pick = pick;
						}
						if (t === "goto") {
							const url = asText(fUrl.value);
							if (!url) {
								if (strict) return { ok: false, reason: "goto.url 不能为空", action: null };
							} else {
								a.url = url;
							}
							const timeoutMs = asNum(fTimeout.value);
							if (timeoutMs !== null) a.timeoutMs = timeoutMs;
							const postWaitMs = asNum(fPostWait.value);
							if (postWaitMs !== null) a.postWaitMs = postWaitMs;
						}
						if (t === "click") {
							const postWaitMs = asNum(fPostWait.value);
							if (postWaitMs !== null) a.postWaitMs = postWaitMs;
							if (cExpectFocus.cb.checked) a.expectInputFocus = true;
						}
						if (t === "hover") {
							const postWaitMs = asNum(fPostWait.value);
							if (postWaitMs !== null) a.postWaitMs = postWaitMs;
						}
						if (t === "wait") {
							const timeoutMs = asNum(fTimeout.value);
							if (timeoutMs !== null) a.timeoutMs = timeoutMs;
						}
						if (t === "input") {
							const text = asText(fText.value);
							if (!text) {
								if (strict) return { ok: false, reason: "input.text 不能为空", action: null };
							} else {
								a.text = text;
							}
							const mode = asText(fInputMode.value);
							if (mode) a.mode = mode;
							const caret = asText(fCaret.value);
							if (caret) a.caret = caret;
							if (cClear.cb.checked) a.clear = true;
							if (cPressEnter.cb.checked) a.pressEnter = true;
							const preEnterWaitMs = asNum(fPreEnterWait.value);
							if (preEnterWaitMs !== null) a.preEnterWaitMs = preEnterWaitMs;
							const postWaitMs = asNum(fPostWait.value);
							if (postWaitMs !== null) a.postWaitMs = postWaitMs;
						}
						if (t === "press_key") {
							const key = asText(fKey.value);
							if (!key) {
								if (strict) return { ok: false, reason: "press_key.key 不能为空", action: null };
							} else {
								a.key = key;
							}
							const times = asNum(fTimes.value);
							if (times !== null) a.times = Math.max(1, Math.floor(times));
							const mods = parseCsv(fModifiers.value);
							if (mods.length) a.modifiers = mods;
						}
						if (t === "scroll") {
							const dx = asNum(fDeltaX.value);
							const dy = asNum(fDeltaY.value);
							const bh = asText(fBehavior.value).toLowerCase();
							if (dx !== null) a.deltaX = dx;
							if (dy !== null) a.deltaY = dy;
							if (bh === "smooth" || bh === "instant") a.behavior = bh;
							const postWaitMs = asNum(fPostWait.value);
							if (postWaitMs !== null) a.postWaitMs = postWaitMs;
						}
						if (t === "invoke") {
							const target = asText(fTarget.value);
							if (target) a.target = target;
							const invokeFind = parseJsonObject(fInvokeFind.value);
							if (invokeFind === null) return { ok: false, reason: "invoke.find 不是合法 JSON 对象", action: null };
							if (Object.keys(invokeFind).length) a.find = invokeFind;
							const invokeArgs = parseJsonObject(fInvokeArgs.value);
							if (invokeArgs === null) return { ok: false, reason: "invoke.args 不是合法 JSON 对象", action: null };
							if (Object.keys(invokeArgs).length) a.args = invokeArgs;
							const onError = asText(fOnError.value);
							if (onError) a.onError = onError;
							const returnTo = asText(fReturnTo.value);
							if (returnTo) a.returnTo = returnTo;
						}
						if (t === "run_js") {
							const code = String(fRunJsCode.value || "").trim();
							if (!code) {
								if (strict) return { ok: false, reason: "run_js.code 不能为空", action: null };
							} else {
								a.code = code;
							}
							const scope = asText(fRunJsScope.value);
							if (scope) a.scope = scope;
							const query = asText(fRunJsQuery.value);
							if (query) a.query = query;
							const arr = parseJsonArray(fRunJsArgs.value);
							if (arr === null) return { ok: false, reason: "run_js.args 不是合法 JSON 数组", action: null };
							if (arr.length) a.args = arr;
						}
						if (t === "branch") {
							const readRet = readBranchCases(strict);
							if (!readRet.ok) return { ok: false, reason: readRet.reason || "branch.cases 不完整", action: null };
							if (!readRet.cases.length && strict) return { ok: false, reason: "branch.cases 至少要有 1 条", action: null };
							const defaultTo = asText(fBranchDefault.value);
							if (!defaultTo) {
								if (strict) return { ok: false, reason: "branch.default 不能为空", action: null };
							} else {
								a.default = defaultTo;
							}
							a.cases = readRet.cases;
						}
						if (t === "ask_assist") {
							const reason = asText(fText.value);
							if (!reason) {
								if (strict) return { ok: false, reason: "ask_assist.reason 不能为空", action: null };
							} else {
								a.reason = reason;
							}
							a.waitUserAction = !!cWaitUserAction.cb.checked;
						}
						if (t === "done") {
							const conclusion = asText(fText.value);
							if (conclusion) a.conclusion = conclusion;
						}
						if (t === "abort") {
							const reason = asText(fText.value);
							if (!reason) {
								if (strict) return { ok: false, reason: "abort.reason 不能为空", action: null };
							} else {
								a.reason = reason;
							}
						}
						return { ok: true, reason: "", action: a };
					};
					const writeActionPayload = (obj) => {
						const raw = (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
						actionPayloadProgrammatic = true;
						actionPayload.value = JSON.stringify(raw, null, 2);
						actionPayloadProgrammatic = false;
					};
					const syncActionPayloadFromFields = (force = false) => {
						if (actionPayloadManualDirty && !force) return;
						const preview = buildActionFromFields(false);
						if (!preview.ok || !preview.action) return;
						writeActionPayload(preview.action);
					};
					const buildCurrentStep = () => {
						const id = String(stepIdInput.value || "").trim() || `step_${flowBuilder.stepNo}`;
						const payload = parseActionPayload();
						if (payload === null) return { ok: false, reason: "action payload 不是合法 JSON 对象" };
						const built = buildActionFromFields(true);
						if (!built.ok || !built.action) return { ok: false, reason: built.reason || "action 字段不完整" };
						const action = { ...(built.action || {}), ...(payload || {}) };
						action.type = String((built.action || {}).type || action.type || "").trim();
						if (!action.type) return { ok: false, reason: "action.type 不能为空" };
						const step = { id, action, next: {} };
						if (action.type !== "done" && action.type !== "abort" && action.type !== "branch") {
							const dn = String(nextDoneInput.value || "").trim() || `step_${flowBuilder.stepNo + 1}`;
							step.next.done = dn;
							const fn = String(nextFailedInput.value || "").trim();
							const sn = String(nextSkippedInput.value || "").trim();
							const tn = String(nextTimeoutInput.value || "").trim();
							const xn = String(nextDefaultInput.value || "").trim();
							if (fn) step.next.failed = fn;
							if (sn) step.next.skipped = sn;
							if (tn) step.next.timeout = tn;
							if (xn) step.next.default = xn;
						}
						return { ok: true, step };
					};
					const buildCommittedStepFromPayload = () => {
						const id = String(stepIdInput.value || "").trim();
						if (!id) return { ok: false, reason: "step id 不能为空", step: null };
						const payload = parseActionPayload();
						if (payload === null) return { ok: false, reason: "action payload 不是合法 JSON 对象", step: null };
						const action = (payload && typeof payload === "object") ? cloneJsonLike(payload, {}) : {};
						const type = String(action.type || actionTypeSel.value || "").trim().toLowerCase();
						if (!type) return { ok: false, reason: "action.type 不能为空", step: null };
						action.type = type;
						const step = { id, action, next: {} };
						const dn = String(nextDoneInput.value || "").trim();
						const fn = String(nextFailedInput.value || "").trim();
						const sn = String(nextSkippedInput.value || "").trim();
						const tn = String(nextTimeoutInput.value || "").trim();
						const xn = String(nextDefaultInput.value || "").trim();
						if (dn) step.next.done = dn;
						if (fn) step.next.failed = fn;
						if (sn) step.next.skipped = sn;
						if (tn) step.next.timeout = tn;
						if (xn) step.next.default = xn;
						return { ok: true, reason: "", step };
					};
					const buildStepForAiRewrite = () => {
						const id = String(stepIdInput.value || "").trim() || `step_${flowBuilder.stepNo}`;
						const payload = parseActionPayload();
						if (payload === null) return { ok: false, reason: "action payload 不是合法 JSON 对象", step: null };
						const action = (payload && typeof payload === "object") ? cloneJsonLike(payload, {}) : {};
						const t = asText(actionTypeSel.value).toLowerCase();
						if (!String(action.type || "").trim() && t) action.type = t;
						if (!String(action.type || "").trim()) return { ok: false, reason: "action.type 不能为空", step: null };
						const step = { id, action, next: {} };
						const dn = String(nextDoneInput.value || "").trim();
						const fn = String(nextFailedInput.value || "").trim();
						if (dn) step.next.done = dn;
						if (fn) step.next.failed = fn;
						return { ok: true, reason: "", step };
					};
					const captureEditorSnapshot = () => ({
						stepId: String(stepIdInput.value || ""),
						actionType: String(actionTypeSel.value || ""),
						actionPayload: String(actionPayload.value || ""),
						actionPayloadManualDirty: !!actionPayloadManualDirty,
						nextDone: String(nextDoneInput.value || ""),
						nextFailed: String(nextFailedInput.value || ""),
						nextSkipped: String(nextSkippedInput.value || ""),
						nextTimeout: String(nextTimeoutInput.value || ""),
						nextDefault: String(nextDefaultInput.value || ""),
						fields: captureStepFieldState(),
					});
					const restoreEditorSnapshot = (snap) => {
						const s = (snap && typeof snap === "object") ? snap : null;
						if (!s) return false;
						if (typeof s.stepId === "string") stepIdInput.value = s.stepId;
						if (typeof s.actionType === "string" && s.actionType) actionTypeSel.value = s.actionType;
						if (typeof s.actionPayload === "string") {
							actionPayloadProgrammatic = true;
							actionPayload.value = s.actionPayload;
							actionPayloadProgrammatic = false;
						}
						actionPayloadManualDirty = !!s.actionPayloadManualDirty;
						if (typeof s.nextDone === "string") nextDoneInput.value = s.nextDone;
						if (typeof s.nextFailed === "string") nextFailedInput.value = s.nextFailed;
						if (typeof s.nextSkipped === "string") nextSkippedInput.value = s.nextSkipped;
						if (typeof s.nextTimeout === "string") nextTimeoutInput.value = s.nextTimeout;
						if (typeof s.nextDefault === "string") nextDefaultInput.value = s.nextDefault;
						if (s.fields && typeof s.fields === "object") restoreStepFieldState(s.fields);
						updateActionFieldVisibility();
						return true;
					};
					const setStepEditorMode = (mode) => {
						const m = String(mode || "").trim().toLowerCase();
						stepEditorMode = (m === "saved" || m === "new" || m === "idle") ? m : "new";
						const editingSaved = stepEditorMode === "saved";
						const idle = stepEditorMode === "idle";
						stepEditorArea.style.display = idle ? "none" : "flex";
						runStepBtn.disabled = idle;
						runStepBtn.style.opacity = idle ? "0.55" : "1";
						runStepBtn.style.cursor = idle ? "not-allowed" : "pointer";
						acceptStepBtn.disabled = idle;
						acceptStepBtn.style.opacity = idle ? "0.55" : "1";
						acceptStepBtn.style.cursor = idle ? "not-allowed" : "pointer";
						acceptStepBtn.textContent = editingSaved ? "更新已写入步骤" : "成功，写入并下一步";
					};
					const applyActionFieldsFromAction = (action) => {
						const a = (action && typeof action === "object") ? action : {};
						const t = String(a.type || "").trim().toLowerCase();
						fBy.value = String(a.by || "");
						fQuery.value = String(a.query || "");
						fUrl.value = String(a.url || "");
						fText.value = "";
						fKey.value = String(a.key || "");
						fModifiers.value = Array.isArray(a.modifiers) ? a.modifiers.join(",") : "";
						fTimes.value = (a.times == null) ? "" : String(a.times);
						fPick.value = String(a.pick || "");
						fTimeout.value = (a.timeoutMs == null) ? "" : String(a.timeoutMs);
						fPostWait.value = (a.postWaitMs == null) ? "" : String(a.postWaitMs);
						fPreEnterWait.value = (a.preEnterWaitMs == null) ? "" : String(a.preEnterWaitMs);
						fDeltaX.value = (a.deltaX == null) ? "" : String(a.deltaX);
						fDeltaY.value = (a.deltaY == null) ? "" : String(a.deltaY);
						fBehavior.value = String(a.behavior || "");
						fTarget.value = String(a.target || "");
						fInvokeFind.value = JSON.stringify((a.find && typeof a.find === "object" && !Array.isArray(a.find)) ? a.find : { kind: "rpa", must: [] }, null, 2);
						fInvokeArgs.value = JSON.stringify((a.args && typeof a.args === "object" && !Array.isArray(a.args)) ? a.args : {}, null, 2);
						fRunJsCode.value = String(a.code || "");
						fRunJsQuery.value = String(a.query || "");
						fRunJsArgs.value = JSON.stringify(Array.isArray(a.args) ? a.args : [], null, 2);
						fInputMode.value = String(a.mode || "type");
						fCaret.value = String(a.caret || "end");
						fOnError.value = String(a.onError || "fail");
						fReturnTo.value = String(a.returnTo || "caller");
						fRunJsScope.value = String(a.scope || "page");
						cClear.cb.checked = !!a.clear;
						cPressEnter.cb.checked = !!a.pressEnter;
						cExpectFocus.cb.checked = !!a.expectInputFocus;
						cWaitUserAction.cb.checked = ("waitUserAction" in a) ? !!a.waitUserAction : true;
						if (t === "input") fText.value = String(a.text || "");
						if (t === "ask_assist") fText.value = String(a.reason || "");
						if (t === "done") fText.value = String(a.conclusion || "");
						if (t === "abort") fText.value = String(a.reason || "");
						if (t === "branch") {
							fBranchDefault.value = String(a.default || "");
							setBranchCases(Array.isArray(a.cases) ? a.cases : []);
						} else {
							fBranchDefault.value = "";
							setBranchCases([]);
						}
					};
					const applyStepToEditor = (step) => {
						const one = (step && typeof step === "object") ? step : null;
						if (!one) return;
						stepIdInput.value = String(one.id || "").trim();
						const action = (one.action && typeof one.action === "object") ? one.action : {};
						const actionType = String(action.type || "").trim();
						if (actionType) actionTypeSel.value = actionType;
						applyActionFieldsFromAction(action);
						updateActionFieldVisibility();
						const payloadText = (typeof one.__uiActionPayload === "string" && one.__uiActionPayload.trim())
							? one.__uiActionPayload
							: JSON.stringify(action, null, 2);
						flowDbg("apply_step_to_editor", {
							stepId: String(one.id || ""),
							actionType: String(actionType || ""),
							payloadLen: String(payloadText || "").length,
							hasUiPayload: typeof one.__uiActionPayload === "string",
						});
						actionPayloadProgrammatic = true;
						actionPayload.value = payloadText;
						actionPayloadProgrammatic = false;
						actionPayloadManualDirty = false;
						const next = (one.next && typeof one.next === "object") ? one.next : {};
						nextDoneInput.value = String(next.done || "").trim();
						nextFailedInput.value = String(next.failed || "").trim();
						nextSkippedInput.value = String(next.skipped || "").trim();
						nextTimeoutInput.value = String(next.timeout || "").trim();
						nextDefaultInput.value = String(next.default || "").trim();
					};
					const clearEditorForNewStep = () => {
						selectedCommittedStepIndex = -1;
						editingCommittedStepIndex = -1;
						setStepEditorMode("new");
						liveEditorSnapshot = null;
						stepIdInput.value = `step_${flowBuilder.stepNo}`;
						nextDoneInput.value = "";
						nextFailedInput.value = "";
						nextSkippedInput.value = "";
						nextTimeoutInput.value = "";
						nextDefaultInput.value = "";
						actionPayloadManualDirty = false;
						writeActionPayload({});
						fBy.value = "";
						fQuery.value = "";
						fUrl.value = "";
						fText.value = "";
						fKey.value = "";
						fModifiers.value = "";
						fTimes.value = "";
						fPick.value = "";
						fTimeout.value = "";
						fPostWait.value = "";
						fPreEnterWait.value = "";
						fDeltaX.value = "";
						fDeltaY.value = "";
						fBehavior.value = "";
						fTarget.value = "";
						fInvokeTargetPick.value = "";
						fInvokeFind.value = "{\"kind\":\"rpa\",\"must\":[]}";
						fInvokeArgs.value = "{}";
						fRunJsCode.value = "";
						fRunJsQuery.value = "";
						fRunJsArgs.value = "[]";
						aiStepPrompt.value = "";
						fBranchDesc.value = "";
						fBranchDefault.value = "";
						setBranchCases([]);
						cClear.cb.checked = false;
						cPressEnter.cb.checked = false;
						cExpectFocus.cb.checked = false;
						cWaitUserAction.cb.checked = true;
						actionTypeSel.value = "goto";
						updateActionFieldVisibility();
						syncActionPayloadFromFields(true);
						renderCommittedSteps();
					};
					const openCommittedStepForEdit = (index) => {
						const i = Number(index);
						const steps = Array.isArray(flowBuilder?.draft?.steps) ? flowBuilder.draft.steps : [];
						if (!Number.isInteger(i) || i < 0 || i >= steps.length) return false;
						const step = (steps[i] && typeof steps[i] === "object") ? steps[i] : {};
						const sid = String(step.id || `step_${i + 1}`);
						const type = getStepActionType(step) || "-";
						if (!liveEditorSnapshot) {
							liveEditorSnapshot = captureEditorSnapshot();
						}
						flowDbg("open_committed_step", {
							index: i,
							stepId: sid,
							actionType: type,
							snapshotStepId: String(liveEditorSnapshot?.stepId || ""),
							snapshotPayloadLen: String(liveEditorSnapshot?.actionPayload || "").length,
						});
						selectedCommittedStepIndex = i;
						editingCommittedStepIndex = i;
						setStepEditorMode("saved");
						const repairedStep = coerceCommittedStep(step, null, "open_committed_step");
						if (repairedStep && repairedStep !== step) {
							flowBuilder.draft.steps[i] = toDraftStep(repairedStep);
						}
						applyStepToEditor(repairedStep || step);
						renderCommittedSteps();
						flowStatus.textContent = "正在编辑已写入步骤（可执行验证，需手动点“更新已写入步骤”才覆盖）。";
						return true;
					};
					const renderFlowGraph = () => {
						const steps = Array.isArray(flowBuilder?.draft?.steps) ? flowBuilder.draft.steps : [];
						flowGraphCanvas.innerHTML = "";
						flowGraphHoverBanner.style.display = "none";
						flowGraphHoverBanner.textContent = "";
						if (!steps.length) {
							const empty = doc.createElement("div");
							empty.style.fontSize = "12px";
							empty.style.color = "#64748b";
							empty.textContent = "暂无步骤可绘制。";
							flowGraphCanvas.appendChild(empty);
							return;
						}
						const nodeW = 220;
						const nodeH = 64;
						const xGap = 270;
						const yGap = 100;
						const marginX = 20;
						const marginY = 54;
						const indexById = new Map();
						for (let i = 0; i < steps.length; i += 1) {
							const sid = String(steps[i]?.id || "").trim();
							if (sid) indexById.set(sid, i);
						}
						const getEdgesFromStep = (step) => {
							const out = [];
							const one = (step && typeof step === "object") ? step : {};
							const action = (one.action && typeof one.action === "object") ? one.action : {};
							const t = String(action.type || "").trim().toLowerCase();
							if (t === "branch") {
								const cases = Array.isArray(action.cases) ? action.cases : [];
								for (let i = 0; i < cases.length; i += 1) {
									const c = (cases[i] && typeof cases[i] === "object") ? cases[i] : {};
									const to = String(c.to || "").trim();
									if (!to) continue;
									const when = (c.when && typeof c.when === "object") ? c.when : {};
									const op = String(when.op || "").trim();
									const path = String(when.path || "").trim();
									const tag = path ? `${op}(${path})` : (op || `case${i + 1}`);
									out.push({
										to,
										label: `C${i + 1}`,
										detail: `case${i + 1}: ${tag} -> ${to}`,
										routeKind: "branch_case",
									});
								}
								const defTo = String(action.default || "").trim();
								if (defTo) out.push({
									to: defTo,
									label: "D",
									detail: `default -> ${defTo}`,
									routeKind: "default",
								});
								return out;
							}
							const next = (one.next && typeof one.next === "object") ? one.next : {};
							for (const k of ["done", "failed", "skipped", "timeout", "default"]) {
								const to = String(next?.[k] || "").trim();
								if (to) out.push({
									to,
									label: k,
									detail: `${k} -> ${to}`,
									routeKind: k,
								});
							}
							return out;
						};
						const routeStyle = (e, missing = false, useDash = false, isBack = false) => {
							if (missing) return { stroke: "#dc2626", label: "#b91c1c", dash: "4 3" };
							const dash = useDash ? "3 3" : "";
							if (isBack) return { stroke: "#7c3aed", label: "#6d28d9", dash };
							const k = String(e?.routeKind || e?.label || "").toLowerCase();
							if (k === "failed") return { stroke: "#ef4444", label: "#b91c1c", dash };
							if (k === "timeout") return { stroke: "#f97316", label: "#c2410c", dash };
							if (k === "default") return { stroke: "#64748b", label: "#475569", dash };
							if (k === "skipped") return { stroke: "#a855f7", label: "#6d28d9", dash };
							if (k === "branch_case") return { stroke: "#0ea5e9", label: "#0369a1", dash };
							return { stroke: "#64748b", label: "#475569", dash };
						};
						const selectedSourceId = (() => {
							const idx = (editingCommittedStepIndex >= 0) ? editingCommittedStepIndex : selectedCommittedStepIndex;
							const step = (Number.isInteger(idx) && idx >= 0) ? steps[idx] : null;
							return String(step?.id || "").trim();
						})();
						const startId = String(flowBuilder?.draft?.start || steps[0]?.id || "").trim();
						const levelById = new Map();
						const queue = [];
						if (startId && indexById.has(startId)) {
							levelById.set(startId, 0);
							queue.push(startId);
						}
						while (queue.length) {
							const cur = queue.shift();
							const curLevel = Number(levelById.get(cur) || 0);
							const idx = indexById.get(cur);
							const step = (typeof idx === "number") ? steps[idx] : null;
							for (const e of getEdgesFromStep(step)) {
								if (!indexById.has(e.to)) continue;
								if (!levelById.has(e.to)) {
									levelById.set(e.to, curLevel + 1);
									queue.push(e.to);
								}
							}
						}
						const reachableSet = new Set(levelById.keys());
						let maxLevel = -1;
						for (const v of levelById.values()) maxLevel = Math.max(maxLevel, Number(v || 0));
						for (const step of steps) {
							const sid = String(step?.id || "").trim();
							if (!sid || levelById.has(sid)) continue;
							maxLevel += 1;
							levelById.set(sid, maxLevel);
						}
						const rowsByLevel = new Map();
						for (let i = 0; i < steps.length; i += 1) {
							const sid = String(steps[i]?.id || "").trim();
							if (!sid) continue;
							const lv = Number(levelById.get(sid) || 0);
							if (!rowsByLevel.has(lv)) rowsByLevel.set(lv, []);
							rowsByLevel.get(lv).push(i);
						}
						const posById = new Map();
						let maxX = marginX + nodeW;
						let maxY = marginY + nodeH;
						const sortedLevels = Array.from(rowsByLevel.keys()).sort((a, b) => a - b);
						for (const lv of sortedLevels) {
							const idxs = rowsByLevel.get(lv) || [];
							for (let r = 0; r < idxs.length; r += 1) {
								const i = idxs[r];
								const sid = String(steps[i]?.id || "").trim();
								const x = marginX + lv * xGap;
								const y = marginY + r * yGap;
								posById.set(sid, { x, y });
								maxX = Math.max(maxX, x + nodeW + marginX);
								maxY = Math.max(maxY, y + nodeH + marginY);
							}
						}
						flowGraphCanvas.style.width = `${maxX}px`;
						flowGraphCanvas.style.height = `${maxY}px`;
							const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
						svg.setAttribute("width", String(maxX));
						svg.setAttribute("height", String(maxY));
						svg.style.position = "absolute";
						svg.style.left = "0";
						svg.style.top = "0";
							svg.style.zIndex = "2";
							svg.style.pointerEvents = "auto";
							const svgTop = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
							svgTop.setAttribute("width", String(maxX));
							svgTop.setAttribute("height", String(maxY));
							svgTop.style.position = "absolute";
							svgTop.style.left = "0";
							svgTop.style.top = "0";
							svgTop.style.zIndex = "40";
							svgTop.style.pointerEvents = "none";
						const defs = doc.createElementNS("http://www.w3.org/2000/svg", "defs");
						const marker = doc.createElementNS("http://www.w3.org/2000/svg", "marker");
						marker.setAttribute("id", "flowEdgeArrow");
						marker.setAttribute("viewBox", "0 0 10 10");
						marker.setAttribute("refX", "9");
						marker.setAttribute("refY", "5");
						marker.setAttribute("markerWidth", "8");
						marker.setAttribute("markerHeight", "8");
						marker.setAttribute("orient", "auto-start-reverse");
							const mkTri = doc.createElementNS("http://www.w3.org/2000/svg", "path");
							mkTri.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
							mkTri.setAttribute("fill", "context-stroke");
							marker.appendChild(mkTri);
							defs.appendChild(marker);
							const markerSmall = doc.createElementNS("http://www.w3.org/2000/svg", "marker");
							markerSmall.setAttribute("id", "flowEdgeArrowSmall");
							markerSmall.setAttribute("viewBox", "0 0 10 10");
							markerSmall.setAttribute("refX", "9");
							markerSmall.setAttribute("refY", "5");
							markerSmall.setAttribute("markerWidth", "4");
							markerSmall.setAttribute("markerHeight", "4");
							markerSmall.setAttribute("orient", "auto-start-reverse");
							const mkTriSmall = doc.createElementNS("http://www.w3.org/2000/svg", "path");
							mkTriSmall.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
							mkTriSmall.setAttribute("fill", "context-stroke");
							markerSmall.appendChild(mkTriSmall);
							defs.appendChild(markerSmall);
							svg.appendChild(defs);
							const defsTop = doc.createElementNS("http://www.w3.org/2000/svg", "defs");
							const markerTop = doc.createElementNS("http://www.w3.org/2000/svg", "marker");
							markerTop.setAttribute("id", "flowEdgeArrowTop");
							markerTop.setAttribute("viewBox", "0 0 10 10");
							markerTop.setAttribute("markerUnits", "userSpaceOnUse");
							markerTop.setAttribute("refX", "7");
							markerTop.setAttribute("refY", "5");
							markerTop.setAttribute("markerWidth", "4");
							markerTop.setAttribute("markerHeight", "4");
							markerTop.setAttribute("orient", "auto-start-reverse");
							const mkTriTop = doc.createElementNS("http://www.w3.org/2000/svg", "path");
							mkTriTop.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
							mkTriTop.setAttribute("fill", "context-stroke");
							markerTop.appendChild(mkTriTop);
							defsTop.appendChild(markerTop);
							svgTop.appendChild(defsTop);
							flowGraphCanvas.appendChild(svg);
							const setGraphHoverBanner = (text) => {
								const s = String(text || "").trim();
								if (!s) {
									flowGraphHoverBanner.style.display = "none";
									flowGraphHoverBanner.textContent = "";
									return;
								}
								flowGraphHoverBanner.textContent = s;
								flowGraphHoverBanner.style.display = "block";
							};
							const mkLine = (x1, y1, x2, y2, color = "#64748b", dash = "", markSource = false) => {
								const p = doc.createElementNS("http://www.w3.org/2000/svg", "path");
								const mx = Math.round((x1 + x2) / 2);
								p.setAttribute("d", `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
							p.setAttribute("fill", "none");
							p.setAttribute("stroke", color);
							p.setAttribute("stroke-width", "1.6");
							p.setAttribute("stroke-linecap", "round");
							p.setAttribute("stroke-linejoin", "round");
								if (dash) p.setAttribute("stroke-dasharray", dash);
								p.setAttribute("marker-end", "url(#flowEdgeArrow)");
								p.style.pointerEvents = "stroke";
								p.style.cursor = "pointer";
								svg.appendChild(p);
								if (markSource) {
									const c = doc.createElementNS("http://www.w3.org/2000/svg", "circle");
									c.setAttribute("cx", String(x1));
								c.setAttribute("cy", String(y1));
								c.setAttribute("r", "2.6");
								c.setAttribute("fill", "#ffffff");
								c.setAttribute("stroke", color);
								c.setAttribute("stroke-width", "1.6");
								c.style.pointerEvents = "none";
								svg.appendChild(c);
							}
							return p;
						};
						const mkDashedCurve = (srcNode, dstNode, color = "#64748b", dash = "3 3", markSource = false) => {
							const p = doc.createElementNS("http://www.w3.org/2000/svg", "path");
							const stub = 24;
							const x1 = srcNode.x + Math.round(nodeW / 2);
							const y1 = srcNode.y + nodeH;
							const srcCenterY = srcNode.y + Math.round(nodeH / 2);
							const dstCenterY = dstNode.y + Math.round(nodeH / 2);
							const endAtTop = dstCenterY > srcCenterY;
							const endDir = endAtTop ? 1 : -1;
							const x2 = dstNode.x + Math.round(nodeW / 2);
							const y2 = endAtTop ? dstNode.y : (dstNode.y + nodeH);
							const y1s = y1 + stub;
							const y2s = y2 - (endDir * stub);
							const c1x = x1;
							const c1y = y1s + 36;
							const c2x = x2;
							const c2y = y2s - (endDir * 36);
								const d = [
								`M ${x1} ${y1}`,
								`L ${x1} ${y1s}`,
								`C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2s}`,
								`L ${x2} ${y2}`,
							].join(" ");
								const pBase = doc.createElementNS("http://www.w3.org/2000/svg", "path");
								pBase.setAttribute("d", d);
								pBase.setAttribute("fill", "none");
								pBase.setAttribute("stroke", color);
								pBase.setAttribute("stroke-width", "3.4");
								pBase.setAttribute("stroke-opacity", "0.28");
								pBase.setAttribute("stroke-linecap", "round");
								pBase.setAttribute("stroke-linejoin", "round");
								pBase.style.pointerEvents = "stroke";
								pBase.style.cursor = "pointer";
								svg.appendChild(pBase);
								p.setAttribute("d", d);
								p.setAttribute("fill", "none");
								p.setAttribute("stroke", color);
								p.setAttribute("stroke-width", "3.2");
								p.setAttribute("stroke-opacity", "1");
								p.setAttribute("stroke-linecap", "butt");
								p.setAttribute("stroke-linejoin", "round");
								p.setAttribute("stroke-dasharray", "5 6");
								p.setAttribute("marker-end", "url(#flowEdgeArrowSmall)");
								p.style.pointerEvents = "stroke";
								p.style.cursor = "pointer";
							svg.appendChild(p);
							if (markSource) {
								const c = doc.createElementNS("http://www.w3.org/2000/svg", "circle");
								c.setAttribute("cx", String(x1));
								c.setAttribute("cy", String(y1));
								c.setAttribute("r", "2.8");
								c.setAttribute("fill", "#ffffff");
								c.setAttribute("stroke", color);
									c.setAttribute("stroke-width", "1.8");
									c.style.pointerEvents = "none";
									svg.appendChild(c);
									const cTop = doc.createElementNS("http://www.w3.org/2000/svg", "circle");
									cTop.setAttribute("cx", String(x1));
									cTop.setAttribute("cy", String(y1));
									cTop.setAttribute("r", "2.8");
									cTop.setAttribute("fill", "#ffffff");
									cTop.setAttribute("stroke", color);
									cTop.setAttribute("stroke-width", "1.8");
									svgTop.appendChild(cTop);
								}
								return {
									path: p,
									hoverPaths: [pBase, p],
									labelX: Math.round((x1 + (3 * c1x) + (3 * c2x) + x2) / 8),
									labelY: Math.round((y1s + (3 * c1y) + (3 * c2y) + y2s) / 8) - 10,
								};
							};
							const mkTopEdgeLabel = (x, y, text, color = "#475569") => {
								const t = doc.createElementNS("http://www.w3.org/2000/svg", "text");
								t.setAttribute("x", String(x));
								t.setAttribute("y", String(y));
								t.setAttribute("fill", color);
								t.setAttribute("font-size", "10");
								const raw = String(text || "");
								const short = raw.length > 24 ? `${raw.slice(0, 23)}…` : raw;
								t.textContent = short;
								const tt = doc.createElementNS("http://www.w3.org/2000/svg", "title");
								tt.textContent = raw;
								t.appendChild(tt);
								svgTop.appendChild(t);
								return t;
							};
						const mkEdgeLabel = (x, y, text, color = "#475569") => {
							const t = doc.createElementNS("http://www.w3.org/2000/svg", "text");
							t.setAttribute("x", String(x));
							t.setAttribute("y", String(y));
							t.setAttribute("fill", color);
							t.setAttribute("font-size", "10");
							const raw = String(text || "");
							const short = raw.length > 24 ? `${raw.slice(0, 23)}…` : raw;
							t.textContent = short;
							const tt = doc.createElementNS("http://www.w3.org/2000/svg", "title");
							tt.textContent = raw;
								t.appendChild(tt);
								t.style.pointerEvents = "auto";
								t.style.cursor = "pointer";
							svg.appendChild(t);
							return t;
						};
							for (let i = 0; i < steps.length; i += 1) {
							const step = steps[i];
							const sid = String(step?.id || "").trim();
							const src = posById.get(sid);
							if (!src) continue;
							const sx = src.x + nodeW;
							const sy = src.y + Math.round(nodeH / 2);
							const srcLevel = Number(levelById.get(sid) || 0);
							for (const e of getEdgesFromStep(step)) {
								const dst = posById.get(e.to);
								if (!dst) {
									const ex = sx + 110;
									const ey = sy;
									const st = routeStyle(e, true, false);
									const lp = mkLine(sx, sy, ex, ey, st.stroke, st.dash, Boolean(st.dash));
									const detail = `${String(e.detail || e.label || "")} (missing:${e.to})`;
									const lt = mkEdgeLabel(Math.round((sx + ex) / 2), ey - 4, String(e.label || ""), st.label);
									lp.addEventListener("mouseenter", () => { setGraphHoverBanner(detail); });
									lp.addEventListener("mouseleave", () => { setGraphHoverBanner(""); });
									lt.addEventListener("mouseenter", () => { setGraphHoverBanner(detail); });
									lt.addEventListener("mouseleave", () => { setGraphHoverBanner(""); });
									continue;
								}
								const tx = dst.x;
								const ty = dst.y + Math.round(nodeH / 2);
								const dstLevel = Number(levelById.get(e.to) || 0);
								const isBack = dstLevel <= srcLevel;
								const isFarRight = dstLevel > (srcLevel + 1);
								const shouldDash = isBack || isFarRight;
								const st = routeStyle(e, false, shouldDash, isBack);
								if (st.dash && sid !== selectedSourceId) continue;
								const drawn = st.dash
									? mkDashedCurve(src, dst, st.stroke, st.dash, true)
									: { path: mkLine(sx, sy, tx, ty, st.stroke, st.dash, false), hoverPaths: null, labelX: Math.round((sx + tx) / 2), labelY: Math.round((sy + ty) / 2) - 4 };
								const dirArrow = (tx < sx) ? "←" : "→";
								const labelText = `${e.label} ${dirArrow}${isBack ? "*" : ""}`;
								const detailText = `${String(e.detail || e.label || "")}${isBack ? " (loop)" : ""}`;
								const lt = mkEdgeLabel(drawn.labelX, drawn.labelY, labelText, st.label);
								if (st.dash) mkTopEdgeLabel(drawn.labelX, drawn.labelY, labelText, st.label);
								const hoverTargets = Array.isArray(drawn.hoverPaths) && drawn.hoverPaths.length ? drawn.hoverPaths : [drawn.path];
								for (const hp of hoverTargets) {
									hp.addEventListener("mouseenter", () => { setGraphHoverBanner(detailText); });
									hp.addEventListener("mouseleave", () => { setGraphHoverBanner(""); });
								}
								lt.addEventListener("mouseenter", () => { setGraphHoverBanner(detailText); });
								lt.addEventListener("mouseleave", () => { setGraphHoverBanner(""); });
							}
						}
						const graphTip = doc.createElement("div");
						graphTip.style.position = "absolute";
						graphTip.style.left = "10px";
						graphTip.style.top = "8px";
						graphTip.style.fontSize = "11px";
						graphTip.style.color = "#475569";
						graphTip.style.background = "rgba(255,255,255,0.9)";
						graphTip.style.border = "1px solid rgba(15,23,42,0.14)";
						graphTip.style.borderRadius = "999px";
						graphTip.style.padding = "2px 8px";
						graphTip.style.pointerEvents = "none";
						graphTip.textContent = "点击节点进入编辑；拖拽空白区域可平移";
						flowGraphCanvas.appendChild(graphTip);
						for (let i = 0; i < steps.length; i += 1) {
							const step = steps[i];
							const sid = String(step?.id || "").trim();
							const p = posById.get(sid);
							if (!p) continue;
							const type = getStepActionType(step) || "-";
							const isReachable = reachableSet.has(sid);
							const card = doc.createElement("button");
							card.type = "button";
								card.style.position = "absolute";
								card.style.zIndex = "8";
								card.style.left = `${p.x}px`;
							card.style.top = `${p.y}px`;
							card.style.width = `${nodeW}px`;
							card.style.height = `${nodeH}px`;
							card.style.borderRadius = "8px";
							card.style.border = "1px solid rgba(15,23,42,0.24)";
							card.style.padding = "6px 8px";
							card.style.textAlign = "left";
							card.style.cursor = "pointer";
							card.style.background = (i === editingCommittedStepIndex)
								? "#dbeafe"
								: (i === selectedCommittedStepIndex ? "#eff6ff" : (isReachable ? "#ffffff" : "#fffbeb"));
							if (!isReachable) card.style.border = "1px solid #f59e0b";
							if (type === "done") card.style.border = "1px solid #10b981";
							if (type === "abort") card.style.border = "1px solid #ef4444";
							if (sid && sid === startId) {
								card.style.boxShadow = "inset 0 0 0 2px rgba(16,185,129,0.45)";
							}
							const line1 = doc.createElement("div");
							line1.style.fontSize = "12px";
							line1.style.fontWeight = "700";
							line1.style.color = "#0f172a";
							line1.style.whiteSpace = "nowrap";
							line1.style.overflow = "hidden";
							line1.style.textOverflow = "ellipsis";
							line1.textContent = sid || `step_${i + 1}`;
							const line2 = doc.createElement("div");
							line2.style.fontSize = "11px";
							line2.style.color = "#334155";
							line2.style.marginTop = "3px";
							line2.textContent = `action: ${type}`;
							const line3 = doc.createElement("div");
							line3.style.fontSize = "10px";
							line3.style.color = "#64748b";
							line3.style.marginTop = "4px";
							line3.textContent = isReachable ? "" : "未从 start 可达";
							card.appendChild(line1);
							card.appendChild(line2);
							if (line3.textContent) card.appendChild(line3);
							if (sid && sid === startId) {
								const startBadge = doc.createElement("div");
								startBadge.textContent = "S";
								startBadge.style.position = "absolute";
								startBadge.style.right = "6px";
								startBadge.style.top = "4px";
								startBadge.style.fontSize = "10px";
								startBadge.style.fontWeight = "700";
								startBadge.style.color = "#047857";
								startBadge.style.background = "rgba(16,185,129,0.12)";
								startBadge.style.borderRadius = "999px";
								startBadge.style.padding = "1px 6px";
								card.appendChild(startBadge);
							}
							card.addEventListener("click", (ev) => {
								ev.preventDefault();
								ev.stopPropagation();
								selectedCommittedStepIndex = i;
								openCommittedStepForEdit(i);
							});
								flowGraphCanvas.appendChild(card);
							}
							flowGraphCanvas.appendChild(svgTop);
						};
					const renderCommittedSteps = () => {
						const steps = Array.isArray(flowBuilder?.draft?.steps) ? flowBuilder.draft.steps : [];
						committedStepsList.innerHTML = "";
						if (!steps.length) {
							const empty = doc.createElement("div");
							empty.style.fontSize = "12px";
							empty.style.color = "#64748b";
							empty.textContent = "暂无已写入步骤";
							committedStepsList.appendChild(empty);
							renderFlowGraph();
							updateCommittedStepsScrollHint();
							return;
						}
						for (let i = 0; i < steps.length; i += 1) {
							const step = (steps[i] && typeof steps[i] === "object") ? steps[i] : {};
							const row = doc.createElement("div");
							row.style.display = "grid";
							row.style.gridTemplateColumns = "1fr auto";
							row.style.gap = "6px";
							row.style.alignItems = "center";
							row.style.border = "1px solid rgba(0,0,0,0.16)";
							row.style.borderRadius = "6px";
							row.style.padding = "6px 8px";
							row.style.background = i === editingCommittedStepIndex
								? "#dbeafe"
								: (i === selectedCommittedStepIndex ? "#eff6ff" : "#fff");
							row.style.color = "#0f172a";
							row.style.fontSize = "12px";
							const sid = String(step.id || `step_${i + 1}`);
							const type = getStepActionType(step) || "-";
							const openBtn = doc.createElement("button");
							openBtn.type = "button";
							openBtn.style.textAlign = "left";
							openBtn.style.border = "0";
							openBtn.style.background = "transparent";
							openBtn.style.color = "#0f172a";
							openBtn.style.padding = "0";
							openBtn.style.cursor = "pointer";
							openBtn.textContent = `${i + 1}. ${sid} (${type})`;
							openBtn.addEventListener("click", (ev) => {
								ev.preventDefault();
								ev.stopPropagation();
								openCommittedStepForEdit(i);
							});
							const delBtn = mkBtn("删除", "#b91c1c");
							delBtn.style.padding = "4px 8px";
							delBtn.addEventListener("click", (ev) => {
								ev.preventDefault();
								ev.stopPropagation();
								const removed = flowBuilder.draft.steps.splice(i, 1);
								const removedId = String(removed?.[0]?.id || "");
								if (editingCommittedStepIndex === i) {
									editingCommittedStepIndex = -1;
									selectedCommittedStepIndex = -1;
									setStepEditorMode("new");
									if (restoreEditorSnapshot(liveEditorSnapshot)) {
										flowStatus.textContent = "已删除当前已写入步骤，已返回最新步骤编辑状态。";
									} else {
										flowStatus.textContent = "已删除当前已写入步骤。";
									}
									liveEditorSnapshot = null;
								} else if (selectedCommittedStepIndex === i) {
									selectedCommittedStepIndex = -1;
									flowStatus.textContent = `已删除步骤：${removedId || sid}`;
								} else if (editingCommittedStepIndex > i) {
									editingCommittedStepIndex -= 1;
									if (selectedCommittedStepIndex > i) selectedCommittedStepIndex -= 1;
									flowStatus.textContent = `已删除步骤：${removedId || sid}`;
								} else {
									if (selectedCommittedStepIndex > i) selectedCommittedStepIndex -= 1;
									flowStatus.textContent = `已删除步骤：${removedId || sid}`;
								}
								if (flowBuilder?.draft?.start && String(flowBuilder.draft.start) === removedId) {
									const firstId = String(flowBuilder?.draft?.steps?.[0]?.id || "").trim();
									flowBuilder.draft.start = firstId || "";
								}
								renderCommittedSteps();
							});
							row.appendChild(openBtn);
							row.appendChild(delBtn);
							committedStepsList.appendChild(row);
						}
						renderFlowGraph();
						updateCommittedStepsScrollHint();
					};
					const updateCommittedStepsScrollHint = () => {
						const canScroll = committedStepsList.scrollHeight > committedStepsList.clientHeight + 1;
						const atBottom = (committedStepsList.scrollTop + committedStepsList.clientHeight) >= (committedStepsList.scrollHeight - 1);
						committedStepsScrollHint.style.display = (canScroll && !atBottom) ? "block" : "none";
					};
						const prepareFlowForSave = () => {
							const draft = (flowBuilder.draft && typeof flowBuilder.draft === "object") ? flowBuilder.draft : {};
						const rawSteps = Array.isArray(draft.steps) ? draft.steps : [];
						const steps = [];
						for (const one of rawSteps) {
							if (!one || typeof one !== "object") continue;
							const sid = String(one.id || "").trim();
							const action = (one.action && typeof one.action === "object") ? one.action : null;
							const at = String(action?.type || "").trim();
							if (!sid || !action || !at) continue;
							const next = (one.next && typeof one.next === "object") ? one.next : {};
							steps.push({ id: sid, action, next });
						}
							if (!steps.length) return null;
							const args = (draft.args && typeof draft.args === "object" && !Array.isArray(draft.args)) ? draft.args : {};
							const capabilities = Array.from(new Set(
								(Array.isArray(draft.capabilities) ? draft.capabilities : [])
									.map((x) => String(x || "").trim())
									.filter(Boolean),
							));
							const filters = normalizeFilters(draft.filters);
							const id = String(draft.id || flowId.value || "flow_builder").trim();
							let start = String(draft.start || "").trim();
							if (!start || !steps.some((s) => String(s?.id || "") === start)) {
								start = String(steps[0]?.id || "").trim();
							}
							if (!id || !start) return null;
							return { ...draft, id, start, args, capabilities, filters, steps };
						};
						const applyFlowResp = (it) => {
						const kind = String(it?.kind || "");
						flowDbg("apply_flow_resp", {
							kind,
							message: String(it?.message || "").slice(0, 80),
							builderStepNo: Number(it?.builderState?.stepNo || 0),
						});
						if (kind === "analyze_result") {
							if (it?.flowIdHint) flowId.value = String(it.flowIdHint);
							flowCaps.value = Array.isArray(it?.caps) ? it.caps.join(", ") : "";
							flowArgs.value = Array.isArray(it?.args) ? it.args.join(", ") : "";
							flowStatus.textContent = String(it?.message || "已解析目标，请确认 caps/args。");
							return;
						}
						if (kind === "saved_flows_result") {
							savedFlowEntries = normalizeSavedFlowEntries(it?.flows);
							renderSavedFlowOptions(String(flowBuilder?.draft?.sourcePath || ""));
							flowStatus.textContent = String(it?.message || "已刷新本地 Flow 列表。");
							return;
						}
						if (kind === "confirm_result") {
							const shell = (it?.shell && typeof it.shell === "object") ? it.shell : {};
							flowBuilder.draft = shell;
							const shellFilters = Array.isArray(shell?.filters) ? shell.filters : [];
							setFiltersEditorRows(shellFilters);
							flowBuilder.shellConfirmed = true;
							flowBuilder.stepNo = Number(it?.nextStepNo || 1);
							editingCommittedStepIndex = -1;
							selectedCommittedStepIndex = -1;
							setStepEditorMode("new");
							stepIdInput.value = `step_${flowBuilder.stepNo}`;
							setShellLocked(true);
							renderCommittedSteps();
							flowStatus.textContent = String(it?.message || "Flow 外壳已创建，开始编写步骤。");
							return;
						}
						if (kind === "load_flow_result") {
							const flow = (it?.flow && typeof it.flow === "object") ? it.flow : {};
							flowBuilder.draft = flow;
							flowBuilder.shellConfirmed = true;
							flowBuilder.stepNo = Number(it?.builderState?.stepNo || Math.max(1, (Array.isArray(flow?.steps) ? flow.steps.length : 0) + 1));
							editingCommittedStepIndex = -1;
							selectedCommittedStepIndex = -1;
							liveEditorSnapshot = null;
							clearEditorForNewStep();
							setStepEditorMode("idle");
							setShellLocked(true);
							renderCommittedSteps();
							renderSavedFlowOptions(String(flow?.sourcePath || ""));
							flowId.value = String(flow?.id || "");
							flowCaps.value = "";
							flowArgs.value = "";
							setFiltersEditorRows(Array.isArray(flow?.filters) ? flow.filters : []);
							flowStatus.textContent = String(it?.message || "已加载本地 Flow。当前为浏览模式：点击步骤即编辑，或点“新增步骤”。");
							return;
						}
						if (kind === "run_step_result") {
							flowBuilder.lastRunOk = !!it?.ok;
							flowBuilder.lastRunStep = it?.step || null;
							const msg = String(it?.message || "");
							flowStatus.textContent = msg || `执行状态：${String(it?.status || "failed")}`;
							return;
						}
						if (kind === "rewrite_step_result") {
							const step = (it?.step && typeof it.step === "object") ? it.step : null;
							if (!step) {
								flowStatus.textContent = String(it?.message || "AI 未返回可用步骤");
								return;
							}
							applyStepToEditor(step);
							setStepEditorMode(editingCommittedStepIndex >= 0 ? "saved" : "new");
							flowStatus.textContent = String(it?.message || "AI 已回填当前步骤，请执行验证或继续修改。");
							return;
						}
							if (kind === "invoke_targets_result") {
								invokeCandidates = normalizeInvokeCandidates(it?.candidates);
								renderInvokeTargetOptions(String(it?.bestEntryId || ""));
								flowStatus.textContent = String(it?.message || "invoke 候选已更新");
								return;
							}
							if (kind === "pick_selector_result") {
								const selector = String(it?.selector || "").trim();
								if (selector) {
									fBy.value = selector;
									syncActionPayloadFromFields(false);
								}
								flowStatus.textContent = String(it?.message || (selector ? `已回填 by: ${selector}` : "未获取到 selector"));
								return;
							}
							if (kind === "branch_draft_result") {
								const action = (it?.action && typeof it.action === "object") ? it.action : {};
								actionTypeSel.value = "branch";
								fBranchDefault.value = String(action?.default || "");
								setBranchCases(Array.isArray(action?.cases) ? action.cases : []);
								actionPayloadManualDirty = false;
								updateActionFieldVisibility();
								syncActionPayloadFromFields(true);
								flowStatus.textContent = String(it?.message || "已回填 AI 生成的 branch 草案。");
								return;
							}
							if (kind === "save_result") {
								const p = String(it?.path || "").trim();
								if (p) {
									if (!flowBuilder.draft || typeof flowBuilder.draft !== "object") flowBuilder.draft = {};
									flowBuilder.draft.sourcePath = p;
									const existed = savedFlowEntries.some((x) => String(x.path || "") === p);
									if (!existed) {
										savedFlowEntries.push({
											id: String(flowBuilder?.draft?.id || flowId.value || "").trim() || "flow",
											path: p,
											file: String(p).split("/").slice(-1)[0],
										});
									}
									savedFlowEntries = normalizeSavedFlowEntries(savedFlowEntries);
									renderSavedFlowOptions(p);
								}
								flowStatus.textContent = String(it?.message || "Flow 已保存。");
								return;
							}
						if (kind === "error") {
							flowStatus.textContent = String(it?.message || "操作失败");
						}
						};
						const setRunStepUiHidden = (hidden) => {
							const on = !!hidden;
							runStepUiHidden = on;
							hideMenu();
							if (on) {
								panel.style.display = "none";
								fab.style.display = "none";
								return;
							}
							fab.style.display = "flex";
							if (flowBuilder.active) {
								setFlowBuilderMode(true);
								panel.style.display = "flex";
							}
						};
						const clearRunStepRestoreTimer = () => {
							if (runStepRestoreTimer) {
								clearTimeout(runStepRestoreTimer);
								runStepRestoreTimer = null;
							}
						};
						const scheduleRunStepUiRestoreFallback = () => {
							clearRunStepRestoreTimer();
							runStepRestoreTimer = setTimeout(() => {
								if (runStepUiHidden) setRunStepUiHidden(false);
							}, 25000);
						};
						const hideMenu = () => { menu.style.display = "none"; };
					const showMenuAt = (x, y) => {
						const vw = window.innerWidth || doc.documentElement.clientWidth || 0;
						const vh = window.innerHeight || doc.documentElement.clientHeight || 0;
						menu.style.visibility = "hidden";
						menu.style.display = "block";
						const rect = menu.getBoundingClientRect();
						const mw = Math.max(180, Math.ceil(rect.width || 180));
						const mh = Math.max(40, Math.ceil(rect.height || 40));
						const nx = Math.max(8, Math.min(Math.round(x), Math.max(8, vw - mw - 8)));
						const ny = Math.max(8, Math.min(Math.round(y), Math.max(8, vh - mh - 8)));
						menu.style.left = `${nx}px`;
						menu.style.top = `${ny}px`;
						menu.style.visibility = "visible";
					};

					const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
					const viewport = () => ({
						w: window.innerWidth || doc.documentElement.clientWidth || 0,
						h: window.innerHeight || doc.documentElement.clientHeight || 0,
					});
					const placeRootByTopLeft = (x, y) => {
						const vw = viewport().w;
						const vh = viewport().h;
						const fabSize = 46;
						const nx = clamp(Math.round(x), 8, Math.max(8, vw - fabSize - 8));
						const ny = clamp(Math.round(y), 8, Math.max(8, vh - fabSize - 8));
						root.style.left = `${nx}px`;
						root.style.top = `${ny}px`;
						root.style.bottom = "auto";
					};
					// Initial position: left-bottom
					{
						const vh = viewport().h;
						placeRootByTopLeft(16, Math.max(16, vh - 16 - 46));
					}

					const movePanelByTopLeft = (x, y) => {
						const vw = viewport().w;
						const vh = viewport().h;
						const r = panel.getBoundingClientRect();
						const pw = Math.max(260, Math.round(r.width || 360));
						const ph = Math.max(180, Math.round(r.height || 320));
						const nx = clamp(Math.round(x), 8, Math.max(8, vw - pw - 8));
						const ny = clamp(Math.round(y), 8, Math.max(8, vh - ph - 8));
						panel.style.position = "fixed";
						panel.style.left = `${nx}px`;
						panel.style.top = `${ny}px`;
						panel.style.bottom = "auto";
					};

					let fabDragging = false;
					let fabDragMoved = false;
					let fabStartX = 0;
					let fabStartY = 0;
					let fabOriginLeft = 16;
					let fabOriginTop = 16;
					const onFabMove = (ev) => {
						if (!fabDragging) return;
						const dx = ev.clientX - fabStartX;
						const dy = ev.clientY - fabStartY;
						if (Math.abs(dx) > 3 || Math.abs(dy) > 3) fabDragMoved = true;
						placeRootByTopLeft(fabOriginLeft + dx, fabOriginTop + dy);
					};
					const onFabUp = () => {
						if (!fabDragging) return;
						fabDragging = false;
						window.removeEventListener("pointermove", onFabMove, true);
						window.removeEventListener("pointerup", onFabUp, true);
						fab.style.cursor = "pointer";
					};
					fab.addEventListener("pointerdown", (ev) => {
						fabDragging = true;
						fabDragMoved = false;
						const rect = root.getBoundingClientRect();
						fabOriginLeft = rect.left;
						fabOriginTop = rect.top;
						fabStartX = ev.clientX;
						fabStartY = ev.clientY;
						fab.style.cursor = "grabbing";
						window.addEventListener("pointermove", onFabMove, true);
						window.addEventListener("pointerup", onFabUp, true);
					});

					let panelDragging = false;
					let panelStartX = 0;
					let panelStartY = 0;
					let panelOriginLeft = 0;
					let panelOriginTop = 0;
					const onPanelMove = (ev) => {
						if (!panelDragging) return;
						const dx = ev.clientX - panelStartX;
						const dy = ev.clientY - panelStartY;
						movePanelByTopLeft(panelOriginLeft + dx, panelOriginTop + dy);
					};
					const onPanelUp = () => {
						if (!panelDragging) return;
						panelDragging = false;
						window.removeEventListener("pointermove", onPanelMove, true);
						window.removeEventListener("pointerup", onPanelUp, true);
						header.style.cursor = "default";
					};
					header.addEventListener("pointerdown", (ev) => {
						if (ev.target === closeBtn) return;
						ev.preventDefault();
						const rect = panel.getBoundingClientRect();
						movePanelByTopLeft(rect.left, rect.top);
						panelDragging = true;
						panelStartX = ev.clientX;
						panelStartY = ev.clientY;
						panelOriginLeft = rect.left;
						panelOriginTop = rect.top;
						header.style.cursor = "grabbing";
						window.addEventListener("pointermove", onPanelMove, true);
						window.addEventListener("pointerup", onPanelUp, true);
					});

					fab.addEventListener("click", (ev) => {
						if (fabDragMoved) {
							fabDragMoved = false;
							return;
						}
						ev.preventDefault();
						ev.stopPropagation();
						hideMenu();
						panel.style.display = panel.style.display === "none" ? "flex" : "none";
						if (panel.style.display === "block") {
							if (panel.style.position !== "fixed") {
								const r = root.getBoundingClientRect();
								const vw = viewport().w;
								const estimatedW = Math.min(420, Math.max(280, vw - 24));
								const left = Math.min(Math.max(8, r.left), Math.max(8, vw - estimatedW - 8));
								const top = Math.max(8, r.top - 380);
								movePanelByTopLeft(left, top);
							}
							setTimeout(() => { try { input.focus(); } catch (_) {} }, 0);
						}
					});
					closeBtn.addEventListener("click", (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						panel.style.display = "none";
						hideMenu();
					});
				send.addEventListener("click", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					ask();
				});
					input.addEventListener("keydown", (ev) => {
					if (!ev) return;
					if (ev.key === "Enter" && !ev.shiftKey) {
						ev.preventDefault();
						ev.stopPropagation();
						ask();
						}
					});
					const bindLiveSync = (el, ev) => {
						if (!el || typeof el.addEventListener !== "function") return;
						el.addEventListener(ev, () => { syncActionPayloadFromFields(false); });
					};
					actionTypeSel.addEventListener("change", () => {
						updateActionFieldVisibility();
						syncActionPayloadFromFields(false);
						if (String(actionTypeSel.value || "").toLowerCase() === "invoke") {
							requestInvokeTargetSuggestions(false);
						}
					});
						invokeSuggestBtn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							requestInvokeTargetSuggestions(true);
						});
						fByPickBtn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							const t = asText(actionTypeSel.value).toLowerCase();
							if (!["click", "hover", "wait", "scroll"].includes(t)) {
								flowStatus.textContent = "当前 action 不支持 by 选取。";
								return;
							}
							fByPickBtn.disabled = true;
							fByPickBtn.style.opacity = "0.6";
							const reqId = emitFlowReq("pick_selector", { actionType: t, query: asText(fQuery.value) });
							flowPendingById.set(reqId, "pick_selector");
							flowStatus.textContent = "请选择页面元素，完成后将自动回填到 by。";
							setRunStepUiHidden(true);
							scheduleRunStepUiRestoreFallback();
						});
						fBranchAddCaseBtn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							fBranchCasesWrap.appendChild(createBranchCaseRow({ op: "exists", source: "args" }));
							syncActionPayloadFromFields(true);
						});
						fBranchDefault.addEventListener("input", () => { syncActionPayloadFromFields(true); });
						fBranchAiBtn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							const t = asText(actionTypeSel.value).toLowerCase();
							if (t !== "branch") {
								flowStatus.textContent = "请先将 Action Type 设为 branch。";
								return;
							}
							const desc = String(fBranchDesc.value || "").trim();
							if (!desc) {
								flowStatus.textContent = "请先填写 branch 需求描述。";
								return;
							}
							const reqId = emitFlowReq("generate_branch_draft", {
								description: desc,
								stepId: asText(stepIdInput.value),
								nextDoneHint: asText(nextDoneInput.value),
								nextFailedHint: asText(nextFailedInput.value),
							});
							flowPendingById.set(reqId, "branch_draft");
							flowStatus.textContent = "正在用 AI 生成 branch 草案…";
						});
						refreshSavedFlowBtn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							const reqId = emitFlowReq("list_saved_flows", {});
							flowPendingById.set(reqId, "list_saved_flows");
							flowStatus.textContent = "正在刷新本地 Flow 列表…";
						});
						newFlowBtn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							flowBuilder.draft = { id: "", start: "", capabilities: [], filters: [], args: {}, steps: [] };
							flowBuilder.shellConfirmed = false;
							flowBuilder.stepNo = 1;
							flowBuilder.lastRunOk = false;
							flowBuilder.lastRunStep = null;
							editingCommittedStepIndex = -1;
							selectedCommittedStepIndex = -1;
							liveEditorSnapshot = null;
							flowGoal.value = "";
							flowId.value = "";
							flowCaps.value = "";
							flowArgs.value = "";
							savedFlowSelect.value = "";
							setFiltersEditorRows([]);
							clearEditorForNewStep();
							setShellLocked(false);
							setStepEditorMode("idle");
							renderCommittedSteps();
							renderSavedFlowOptions("");
							flowStatus.textContent = "已切换到新建 Flow。先填写目标，再确认外壳。";
							try { flowGoal.focus(); } catch (_) {}
						});
						savedFlowSelect.addEventListener("change", () => {
							const p = String(savedFlowSelect.value || "").trim();
							if (!p) {
								flowStatus.textContent = "请选择要加载的 Flow。";
								return;
							}
							const reqId = emitFlowReq("load_saved_flow", { path: p });
							flowPendingById.set(reqId, "load_saved_flow");
							flowStatus.textContent = "正在加载已存 Flow…";
						});
						flowGraphModeBtn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							applyFlowGraphLayoutMode(!flowGraphExpanded);
							flowStatus.textContent = flowGraphExpanded
								? "已进入放大流程图模式（左侧编辑，右侧大图）。"
								: "已退出放大流程图模式。";
						});
						aiRewriteStepBtn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							const instruction = String(aiStepPrompt.value || "").trim();
							if (!instruction) {
								flowStatus.textContent = "请先输入你希望 AI 如何修改当前步骤。";
								return;
							}
							const built = buildStepForAiRewrite();
							if (!built.ok || !built.step) {
								flowStatus.textContent = built.reason || "当前步骤无效";
								return;
							}
							const reqId = emitFlowReq("rewrite_step_with_ai", {
								instruction,
								step: built.step,
							});
							flowPendingById.set(reqId, "rewrite_step_with_ai");
							flowStatus.textContent = "AI 正在改写当前步骤…";
						});
						createNewStepBtn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							clearEditorForNewStep();
							flowStatus.textContent = "已进入新增步骤模式。";
						});
						flowFiltersAddBtn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							addFilterRow("", "");
						});
						fInvokeTargetPick.addEventListener("change", () => {
							const v = String(fInvokeTargetPick.value || "").trim();
							flowStatus.textContent = v
								? "已选择候选（默认仍按 find 匹配；如需固定目标，请手工填写 target）。"
								: "已切换为仅按 find 自动匹配。";
							syncActionPayloadFromFields(false);
						});
					fInvokeFind.addEventListener("input", () => {
						if (invokeSuggestTimer) clearTimeout(invokeSuggestTimer);
						invokeSuggestTimer = setTimeout(() => { requestInvokeTargetSuggestions(false); }, 380);
					});
					actionPayload.addEventListener("input", () => {
						if (!actionPayloadProgrammatic) actionPayloadManualDirty = true;
					});
					for (const one of [
						fBy, fQuery, fUrl, fText, fKey, fModifiers, fTimes, fPick, fTimeout, fPostWait, fPreEnterWait,
						fDeltaX, fDeltaY, fBehavior, fTarget, fInvokeFind, fInvokeArgs, fRunJsCode, fRunJsQuery, fRunJsArgs, fBranchDefault,
						nextDoneInput, nextFailedInput, nextSkippedInput, nextTimeoutInput, nextDefaultInput
					]) bindLiveSync(one, "input");
						for (const one of [fInputMode, fCaret, fOnError, fReturnTo, fRunJsScope]) bindLiveSync(one, "change");
						for (const one of [cClear.cb, cPressEnter.cb, cExpectFocus.cb, cWaitUserAction.cb]) bindLiveSync(one, "change");
						committedStepsList.addEventListener("scroll", () => { updateCommittedStepsScrollHint(); });
						flowGraphViewport.addEventListener("pointerdown", (ev) => {
							const tgt = ev?.target;
							if (tgt && typeof tgt.closest === "function" && tgt.closest("button")) return;
							graphPanning = true;
							graphPanStartX = ev.clientX;
							graphPanStartY = ev.clientY;
							graphPanStartLeft = flowGraphViewport.scrollLeft;
							graphPanStartTop = flowGraphViewport.scrollTop;
							flowGraphViewport.style.cursor = "grabbing";
						});
						window.addEventListener("pointermove", (ev) => {
							if (!graphPanning) return;
							const dx = ev.clientX - graphPanStartX;
							const dy = ev.clientY - graphPanStartY;
							flowGraphViewport.scrollLeft = graphPanStartLeft - dx;
							flowGraphViewport.scrollTop = graphPanStartTop - dy;
						}, true);
						window.addEventListener("pointerup", () => {
							if (!graphPanning) return;
							graphPanning = false;
							flowGraphViewport.style.cursor = "grab";
						}, true);
						setFiltersEditorRows([]);
						setBranchCases([]);
						updateActionFieldVisibility();
					setStepEditorMode("new");
					renderCommittedSteps();
					renderInvokeTargetOptions();
					renderSavedFlowOptions();
					syncActionPayloadFromFields(true);
					setShellLocked(!!flowBuilder.shellConfirmed);
					if (flowBuilderSeed && typeof flowBuilderSeed === "object") {
						applyBuilderState(flowBuilderSeed);
						if (!actionPayloadManualDirty) syncActionPayloadFromFields(true);
					}
					analyzeBtn.addEventListener("click", (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						const goal = String(flowGoal.value || "").trim();
						if (!goal) {
							flowStatus.textContent = "请先输入 Flow 目标。";
							return;
						}
						const reqId = emitFlowReq("analyze_goal", { goal });
						flowPendingById.set(reqId, "analyze");
						flowStatus.textContent = "正在分析目标并匹配 caps/args…";
					});
					editShellBtn.addEventListener("click", (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						flowBuilder.shellConfirmed = false;
						setShellLocked(false);
						flowStatus.textContent = "已进入外壳编辑模式。修改后请重新点击“2）确认能力/参数”。";
					});
						confirmBtn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							const goal = String(flowGoal.value || "").trim();
							if (!goal) {
								flowStatus.textContent = "请先输入 Flow 目标。";
								return;
							}
								const filters = readFiltersFromEditor();
								const payload = {
									goal,
								flowId: String(flowId.value || "").trim(),
								caps: parseCsv(flowCaps.value),
								args: parseCsv(flowArgs.value),
								filters,
							};
							const reqId = emitFlowReq("confirm_caps", payload);
						flowPendingById.set(reqId, "confirm");
						flowStatus.textContent = "已提交确认，正在生成 flow 外壳…";
					});
						runStepBtn.addEventListener("click", (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						const built = buildCurrentStep();
						if (!built.ok) {
							flowStatus.textContent = built.reason || "步骤无效";
							return;
						}
							const reqId = emitFlowReq("run_step", { step: built.step });
							flowPendingById.set(reqId, "run_step");
							flowStatus.textContent = editingCommittedStepIndex >= 0
								? "正在执行已写入步骤（仅验证，不自动保存）…"
								: "正在执行当前步骤…";
							flowBuilder.lastRunOk = false;
							flowBuilder.lastRunStep = built.step;
							setRunStepUiHidden(true);
							scheduleRunStepUiRestoreFallback();
						});
					acceptStepBtn.addEventListener("click", (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						if (editingCommittedStepIndex >= 0) {
							flowDbg("accept_saved_step.begin", {
								index: editingCommittedStepIndex,
								liveSnapshotStepId: String(liveEditorSnapshot?.stepId || ""),
								liveSnapshotPayloadLen: String(liveEditorSnapshot?.actionPayload || "").length,
							});
							const built = buildCommittedStepFromPayload();
							if (!built.ok || !built.step) {
								flowDbg("accept_saved_step.invalid", {
									reason: String(built.reason || "invalid"),
									stepId: String(stepIdInput.value || ""),
									actionType: String(actionTypeSel.value || ""),
									payloadLen: String(actionPayload.value || "").length,
								});
								flowStatus.textContent = built.reason || "步骤无效";
								return;
							}
							if (!flowBuilder.draft || typeof flowBuilder.draft !== "object") {
								flowStatus.textContent = "flow 草稿不存在，请重新确认外壳。";
								return;
							}
							if (!Array.isArray(flowBuilder.draft.steps) || !flowBuilder.draft.steps[editingCommittedStepIndex]) {
								flowStatus.textContent = "目标步骤不存在，请重新选择。";
								return;
							}
							const oldStep = flowBuilder.draft.steps[editingCommittedStepIndex];
							flowBuilder.draft.steps[editingCommittedStepIndex] = toDraftStep(built.step);
							if (!flowBuilder.draft.start || String(flowBuilder.draft.start || "") === String(oldStep?.id || "")) {
								flowBuilder.draft.start = String(built.step.id || "").trim();
							}
							editingCommittedStepIndex = -1;
							selectedCommittedStepIndex = -1;
							setStepEditorMode("new");
							if (!restoreEditorSnapshot(liveEditorSnapshot)) {
								stepIdInput.value = `step_${flowBuilder.stepNo}`;
								actionPayloadManualDirty = false;
								syncActionPayloadFromFields(true);
								flowDbg("accept_saved_step.restore_fallback", {
									stepNo: Number(flowBuilder.stepNo || 0),
									stepId: String(stepIdInput.value || ""),
									payloadLen: String(actionPayload.value || "").length,
								});
							} else {
								flowDbg("accept_saved_step.restore_ok", {
									stepId: String(stepIdInput.value || ""),
									actionType: String(actionTypeSel.value || ""),
									payloadLen: String(actionPayload.value || "").length,
								});
							}
							liveEditorSnapshot = null;
							renderCommittedSteps();
							flowStatus.textContent = "已更新该步骤（未执行），已返回最新步骤编辑状态。";
							return;
						}
						const builtNow = buildCurrentStep();
						if (!builtNow.ok || !builtNow.step) {
							flowStatus.textContent = builtNow.reason || "当前步骤无效";
							return;
						}
						const currentStepId = String(builtNow.step.id || "").trim();
						const ranStepId = String(flowBuilder?.lastRunStep?.id || "").trim();
						const hasFreshRun = !!(flowBuilder.lastRunOk && flowBuilder.lastRunStep && ranStepId && ranStepId === currentStepId);
						const step = hasFreshRun
							? coerceCommittedStep(flowBuilder.lastRunStep, builtNow.step, "accept_new_step")
							: builtNow.step;
						if (!step) {
							flowStatus.textContent = "当前步骤 action 丢失，无法写入。请重新执行本步骤。";
							return;
						}
						if (!flowBuilder.draft || typeof flowBuilder.draft !== "object") {
							flowBuilder.draft = { id: String(flowId.value || "").trim() || "flow_builder", start: "", args: {}, steps: [] };
						}
						if (!Array.isArray(flowBuilder.draft.steps)) flowBuilder.draft.steps = [];
						flowBuilder.draft.steps.push(toDraftStep(step));
						flowDbg("accept_new_step.push", {
							stepId: String(step.id || ""),
							actionType: String(step?.action?.type || ""),
							draftSteps: flowBuilder.draft.steps.length,
						});
						if (!flowBuilder.draft.start) flowBuilder.draft.start = String(step.id || "");
						renderCommittedSteps();
						if (String(step?.action?.type || "").toLowerCase() === "done") {
							const flowToSave = prepareFlowForSave();
							if (!flowToSave) {
								flowStatus.textContent = "Flow 对象不完整：请至少保留一个合法步骤（含 id/action.type）。";
								return;
							}
							const reqId = emitFlowReq("save_flow", {
								flow: flowToSave,
								sourcePath: String(flowBuilder?.draft?.sourcePath || "").trim(),
							});
							flowPendingById.set(reqId, "save");
							flowStatus.textContent = "步骤已写入，正在保存 Flow…";
							return;
						}
						editingCommittedStepIndex = -1;
						selectedCommittedStepIndex = -1;
						liveEditorSnapshot = null;
						flowBuilder.stepNo += 1;
						clearEditorForNewStep();
						flowBuilder.lastRunOk = false;
						flowBuilder.lastRunStep = null;
						flowStatus.textContent = hasFreshRun
							? "步骤已写入，请编写下一步。"
							: "步骤已写入（未执行验证），请编写下一步。";
					});
					saveFlowBtn.addEventListener("click", (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						if (!flowBuilder.draft || !Array.isArray(flowBuilder.draft.steps) || !flowBuilder.draft.steps.length) {
							flowStatus.textContent = "还没有可保存的步骤。";
							return;
						}
						const flowToSave = prepareFlowForSave();
						if (!flowToSave) {
							flowStatus.textContent = "Flow 对象不完整：请检查步骤是否都有 id 和 action.type。";
							return;
						}
						const reqId = emitFlowReq("save_flow", {
							flow: flowToSave,
							sourcePath: String(flowBuilder?.draft?.sourcePath || "").trim(),
						});
						flowPendingById.set(reqId, "save");
						flowStatus.textContent = "正在保存 Flow…";
					});
					doc.addEventListener("click", () => { hideMenu(); }, true);
					fab.addEventListener("contextmenu", (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						showMenuAt(ev.clientX, ev.clientY);
					});
					menuChat.addEventListener("click", (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						hideMenu();
						setFlowBuilderMode(false);
						panel.style.display = "flex";
						if (panel.style.position !== "fixed") {
							const r = root.getBoundingClientRect();
							const vw = viewport().w;
							const estimatedW = Math.min(420, Math.max(280, vw - 24));
							const left = Math.min(Math.max(8, r.left), Math.max(8, vw - estimatedW - 8));
							const top = Math.max(8, r.top - 380);
							movePanelByTopLeft(left, top);
						}
						setTimeout(() => { try { input.focus(); } catch (_) {} }, 0);
					});
					menuPick.addEventListener("click", (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						hideMenu();
						st.seq = Number(st.seq || 0) + 1;
						st.pickRequests.push({
							id: `pick_${Date.now()}_${st.seq}`,
							url: String(location.href || ""),
							title: String(document.title || ""),
							source: "fab_menu",
							ts: Date.now(),
						});
						if (st.pickRequests.length > 20) st.pickRequests.splice(0, st.pickRequests.length - 20);
					});
					menuCreateFlow.addEventListener("click", (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						hideMenu();
						setFlowBuilderMode(true);
						panel.style.display = "flex";
						if (panel.style.position !== "fixed") {
							const r = root.getBoundingClientRect();
							const vw = viewport().w;
							const estimatedW = Math.min(420, Math.max(280, vw - 24));
							const left = Math.min(Math.max(8, r.left), Math.max(8, vw - estimatedW - 8));
							const top = Math.max(8, r.top - 380);
							movePanelByTopLeft(left, top);
						}
						setTimeout(() => { try { flowGoal.focus(); } catch (_) {} }, 0);
						flowStatus.textContent = "先输入 flow 目标，点“解析目标”，再确认 caps/args。";
						const reqId = emitFlowReq("list_saved_flows", {});
						flowPendingById.set(reqId, "list_saved_flows");
					});

					st.responseTimer = setInterval(() => {
					try {
						const rs = Array.isArray(st.responses) ? st.responses.splice(0, st.responses.length) : [];
						for (const it of rs) {
							const rid = String(it?.id || "");
							const text = String(it?.answer || "");
							const node = pendingById.get(rid);
							if (node) {
								node.textContent = text || "(无输出)";
								pendingById.delete(rid);
							} else {
								appendBubble("assistant", text || "(无输出)");
							}
							history.push({ role: "assistant", text });
							if (history.length > 24) history.splice(0, history.length - 24);
						}
							const frs = Array.isArray(st.flowBuildResponses) ? st.flowBuildResponses.splice(0, st.flowBuildResponses.length) : [];
							for (const fr of frs) {
								const rid = String(fr?.id || "");
								const pendingKind = rid ? String(flowPendingById.get(rid) || "") : "";
								if (rid) flowPendingById.delete(rid);
								applyFlowResp(fr);
								const frKind = String(fr?.kind || "");
								if ((frKind === "pick_selector_result") || (frKind === "error" && pendingKind === "pick_selector")) {
									fByPickBtn.disabled = false;
									fByPickBtn.style.opacity = "1";
									if (runStepUiHidden) {
										clearRunStepRestoreTimer();
										setRunStepUiHidden(false);
									}
								}
								if (runStepUiHidden && (
									frKind === "run_step_result"
									|| (frKind === "error" && pendingKind === "run_step")
								)) {
									clearRunStepRestoreTimer();
									setRunStepUiHidden(false);
								}
							}
					} catch (_) {
					}
					}, 220);
					if (isBlankPage) {
						panel.style.display = "flex";
						if (panel.style.position !== "fixed") {
							const r = root.getBoundingClientRect();
							const vw = viewport().w;
							const estimatedW = Math.min(420, Math.max(280, vw - 24));
							const left = Math.min(Math.max(8, r.left), Math.max(8, vw - estimatedW - 8));
							const top = Math.max(8, r.top - 380);
							movePanelByTopLeft(left, top);
						}
						setTimeout(() => { try { input.focus(); } catch (_) {} }, 0);
					}

					st.installed = true;
					return { ok: true, installed: true };
				},
				[kChatStateKey, iconDataUrl || "", Array.isArray(historySeed) ? historySeed : [], (flowBuilderSeed && typeof flowBuilderSeed === "object") ? flowBuilderSeed : null],
				{ awaitPromise: true, timeout: 2500 }
			);
			return !!ret?.ok;
	} catch (_) {
		return false;
	}
}

async function popChatRequest(page) {
	if (!page) return null;
	try {
		return await page.callFunction(
			function (stateKey) {
				const g = window;
				const st = g[String(stateKey || "__rpa_selector_picker_chat_state__")];
				if (!st || !Array.isArray(st.requests) || !st.requests.length) return null;
				return st.requests.shift();
			},
			[kChatStateKey],
			{ awaitPromise: true, timeout: 800 }
		);
	} catch (_) {
		return null;
	}
}

async function popFabPickRequest(page) {
	if (!page) return null;
	try {
		return await page.callFunction(
			function (stateKey) {
				const g = window;
				const st = g[String(stateKey || "__rpa_selector_picker_chat_state__")];
				if (!st || !Array.isArray(st.pickRequests) || !st.pickRequests.length) return null;
				return st.pickRequests.shift();
			},
			[kChatStateKey],
			{ awaitPromise: true, timeout: 800 }
		);
	} catch (_) {
		return null;
	}
}

async function popFlowBuildRequest(page) {
	if (!page) return null;
	try {
		return await page.callFunction(
			function (stateKey) {
				const g = window;
				const st = g[String(stateKey || "__rpa_selector_picker_chat_state__")];
				if (!st || !Array.isArray(st.flowBuildRequests) || !st.flowBuildRequests.length) return null;
				return st.flowBuildRequests.shift();
			},
			[kChatStateKey],
			{ awaitPromise: true, timeout: 800 }
		);
	} catch (_) {
		return null;
	}
}

async function popFlowDebugLogs(page, limit = 40) {
	if (!page) return [];
	try {
		return await page.callFunction(
			function (stateKey, limit) {
				const g = window;
				const st = g[String(stateKey || "__rpa_selector_picker_chat_state__")];
				if (!st || !Array.isArray(st.flowDebugLogs) || !st.flowDebugLogs.length) return [];
				const n = Math.max(1, Math.min(200, Number(limit || 40)));
				return st.flowDebugLogs.splice(0, n);
			},
			[kChatStateKey, Number(limit || 40)],
			{ awaitPromise: true, timeout: 800 }
		);
	} catch (_) {
		return [];
	}
}

async function pushChatResponse(page, response) {
	if (!page || !response) return false;
	try {
		const safeStateKey = String(kChatStateKey || "__rpa_selector_picker_chat_state__");
		let safeResponse = response;
		try { safeResponse = JSON.parse(JSON.stringify(response)); } catch (_) {}
		const ret = await page.callFunction(
			function (stateKey, payload) {
				const g = window;
				const st = g[String(stateKey || "__rpa_selector_picker_chat_state__")];
				if (!st || !Array.isArray(st.responses)) return false;
				st.responses.push(payload || {});
				if (st.responses.length > 30) st.responses.splice(0, st.responses.length - 30);
				return true;
			},
			[safeStateKey, safeResponse],
			{ awaitPromise: true, timeout: 800 }
		);
		return !!ret;
	} catch (_) {
		return false;
	}
}

async function pushFlowBuildResponse(page, payload) {
	if (!page || !payload) return { ok: false, reason: "missing_page_or_payload" };
	try {
		const safeStateKey = String(kChatStateKey || "__rpa_selector_picker_chat_state__");
		let payloadText = "";
		try {
			payloadText = JSON.stringify(payload ?? {});
		} catch (err) {
			return { ok: false, reason: `json_stringify_failed:${String(err?.message || err || "unknown")}` };
		}
		const ret = await page.callFunction(
			function (stateKey, itemText) {
				const g = window;
				const key = String(stateKey || "__rpa_selector_picker_chat_state__");
				let item = {};
				try {
					item = JSON.parse(String(itemText || "{}"));
				} catch (_) {
					item = {};
				}
				let st = g[key];
				if (!st || typeof st !== "object") {
					st = { requests: [], responses: [], pickRequests: [], flowBuildRequests: [], flowBuildResponses: [], seq: 0, installed: false };
					g[key] = st;
				}
				if (!Array.isArray(st.flowBuildResponses)) st.flowBuildResponses = [];
				st.flowBuildResponses.push(item || {});
				if (st.flowBuildResponses.length > 60) st.flowBuildResponses.splice(0, st.flowBuildResponses.length - 60);
				return true;
			},
			[safeStateKey, payloadText],
			{ awaitPromise: true, timeout: 2200 }
		);
		return { ok: !!ret, reason: !!ret ? "" : "push_returned_false" };
	} catch (err) {
		return { ok: false, reason: String(err?.message || err || "unknown") };
	}
}

function normalizeChatAnswer(runRet) {
	const env = runRet?.envelope;
	const status = String(env?.status || "").toLowerCase();
	if (status === "error") {
		const reason = String(env?.reason || "").trim();
		if (reason) return `不确定，需要更多页面信息。(${reason})`;
		return "不确定，需要更多页面信息。";
	}
	const res = env?.result;
	if (typeof res === "string" && res.trim()) return res.trim();
	if (res && typeof res === "object") {
		if (typeof res.answer === "string" && res.answer.trim()) return res.answer.trim();
		if (typeof res.text === "string" && res.text.trim()) return res.text.trim();
		try {
			return JSON.stringify(res);
		} catch (_) {
			return "抱歉，本次回答结果格式异常。";
		}
	}
	return "抱歉，我暂时无法回答这个问题。";
}

function buildHelpAnswerText() {
	return [
		"我是当前页面助手，可以做这些事：",
		"1. 回答与当前页面内容相关的问题（基于页面 URL/标题/正文/HTML）。",
		"2. 右键悬浮球选择“制作元素Selector”，进入元素选择与 selector 生成流程。",
		"3. 右键悬浮球选择“Flow Builder”，进入悬浮式 Flow Builder（逐步编辑+每步即时执行）。",
		"4. 输入以 ':' 或 '>' 开头的目标指令，进入自动分步执行（Goal 模式）。",
		"",
		"请告诉我你希望我基于当前页面做什么。",
	].join("\n");
}

function normalizeChatDecision(runRet) {
	const env = runRet?.envelope;
	const status = String(env?.status || "").toLowerCase();
	if (status === "error") {
		const reason = String(env?.reason || "").trim();
		return {
			kind: "help",
			answer: reason ? `我只能回答与当前页面内容相关的问题，请基于当前页面提问。(${reason})` : "我只能回答与当前页面内容相关的问题，请基于当前页面提问。",
		};
	}
	const res = env?.result;
	if (!res || typeof res !== "object") {
		const fallback = normalizeChatAnswer(runRet);
		return { kind: "done", answer: fallback };
	}
	const kind = String(res.status || "done").trim().toLowerCase();
	const answer = String(res.answer || "").trim();
	if (kind === "greeting") {
		return { kind: "greeting", answer: answer || "你好，我在。请告诉我你希望我基于当前页面做什么。" };
	}
	if (kind === "help") {
		return { kind: "help", answer: answer || buildHelpAnswerText() };
	}
	return { kind: "done", answer: answer || "不确定，需要更多页面信息。" };
}

function parseObjectLike(raw, fallback = {}) {
	if (!raw) return fallback;
	if (typeof raw === "object" && !Array.isArray(raw)) return raw;
	if (typeof raw !== "string") return fallback;
	try {
		const obj = JSON.parse(raw);
		if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
		return fallback;
	} catch (_) {
		return fallback;
	}
}

function normalizeFlowIdHint(text) {
	const s = String(text || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
	if (s) return s.slice(0, 64);
	return `flow_${Date.now()}`;
}

function buildRpaCapsCatalog(limit = 240) {
	const caps = (rpaKind && rpaKind.caps && typeof rpaKind.caps === "object") ? rpaKind.caps : {};
	const rows = [];
	for (const [key, spec] of Object.entries(caps)) {
		if (!spec || typeof spec !== "object") continue;
		const kind = String(spec.kind || "");
		if (kind !== "cap" && kind !== "arg") continue;
		rows.push({
			key,
			kind,
			type: kind === "arg" ? String(spec.type || "") : "",
			desc: String(spec.desc || "").replace(/\s+/g, " ").trim(),
		});
	}
	rows.sort((a, b) => a.key.localeCompare(b.key));
	return rows.slice(0, Math.max(10, Number(limit || 240)));
}

function heuristicSuggestCapsArgs(goalText) {
	const q = String(goalText || "").toLowerCase();
	const caps = [];
	const args = [];
	if (/小红书|xhs|发帖|帖子|笔记|发布|compose/.test(q)) {
		if (/开始|启动|打开/.test(q)) caps.push("compose.start");
		else if (/输入|填写|正文|标题/.test(q)) caps.push("compose.input");
		else if (/发布|发送|提交/.test(q)) caps.push("compose.publish");
		else caps.push("compose.start");
		args.push("compose.action");
	} else if (/搜索|search|查找/.test(q)) {
		caps.push("search");
		args.push("search.query");
	} else if (/读取|列表|评论|详情|资料|read/.test(q)) {
		caps.push("read.list");
		args.push("read.action");
	} else if (/滚动|加载更多|more|next/.test(q)) {
		caps.push("loadMore");
	} else if (/输入|填写|表单|fill/.test(q)) {
		caps.push("fill");
	} else {
		caps.push("find.until");
		args.push("find.goal");
	}
	return {
		caps: Array.from(new Set(caps)).slice(0, 3),
		args: Array.from(new Set(args)).slice(0, 6),
	};
}

async function suggestFlowCapsArgsByAI({ goal, webRpa, page, session, logger = null }) {
	const catalog = buildRpaCapsCatalog(260);
	const catalogText = catalog.map((it) => `${it.key} [${it.kind}${it.type ? `:${it.type}` : ""}] - ${it.desc}`).join("\n");
	try {
		const ai = await withTimeout(runAIAction({
			action: {
				model: "advanced",
				prompt: [
					"你是 RPA Flow 需求解析器。",
					"任务：根据用户目标，从给定 capability/arg 目录里挑选“这个 Flow 的主功能能力”。",
					"仅输出 JSON 到 envelope.result，结构：",
					"{\"flowIdHint\":\"snake_case\",\"caps\":[\"cap...\"],\"args\":[\"arg...\"],\"reason\":\"string\"}",
					"约束：",
					"- caps 只能来自目录中 kind=cap 的 key。",
					"- args 只能来自目录中 kind=arg 的 key。",
					"- 不要输出目录外 key。",
					"- caps 只保留主功能能力，优先 1 个，最多 3 个。",
					"- 不要把登录、弹窗清理等“实现过程能力”当作主 cap，除非用户目标本身就是登录/清理。",
					"- args 保持最小化（最多 6 个），只保留主功能必须参数。",
					"- 示例：用户说“开始编写小红书帖子”，主 cap 应是 compose.start，不应给 login.ensure。",
				].join("\n"),
				schema: {
					type: "object",
					required: ["flowIdHint", "caps", "args", "reason"],
					properties: {
						flowIdHint: { type: "string" },
						caps: { type: "array", items: { type: "string" } },
						args: { type: "array", items: { type: "string" } },
						reason: { type: "string" },
					},
					additionalProperties: false,
				},
				page: { url: true, title: true, article: false, html: false },
				cache: false,
			},
			inputValue: {
				goal: String(goal || ""),
				catalog: catalogText,
			},
			webRpa,
			page,
			session,
			logger,
		}), 45000, "flow builder analyze timeout");
		const raw = ai?.envelope?.result;
		const obj = parseObjectLike(raw, {});
		const capSet = new Set(catalog.filter((x) => x.kind === "cap").map((x) => x.key));
		const argSet = new Set(catalog.filter((x) => x.kind === "arg").map((x) => x.key));
		const caps = Array.isArray(obj.caps) ? obj.caps.map((x) => String(x || "").trim()).filter((x) => capSet.has(x)) : [];
		const args = Array.isArray(obj.args) ? obj.args.map((x) => String(x || "").trim()).filter((x) => argSet.has(x)) : [];
		const fallback = heuristicSuggestCapsArgs(goal);
		return {
			ok: true,
			flowIdHint: normalizeFlowIdHint(obj.flowIdHint || ""),
			caps: (caps.length ? caps : fallback.caps).slice(0, 3),
			args: (args.length ? args : fallback.args).slice(0, 6),
			reason: String(obj.reason || "AI 已完成候选能力匹配。"),
		};
	} catch (_) {
		const fallback = heuristicSuggestCapsArgs(goal);
		return {
			ok: false,
			flowIdHint: normalizeFlowIdHint(goal),
			caps: fallback.caps,
			args: fallback.args,
			reason: "AI 解析失败，已给出启发式候选。",
		};
	}
}

function sanitizeBranchAction(rawAction, fallbackDefault = "") {
	const one = (rawAction && typeof rawAction === "object") ? rawAction : {};
	const allowedOps = new Set(["exists", "truthy", "eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "match"]);
	const allowedSources = new Set(["args", "opts", "vars", "result"]);
	const cases = [];
	const rawCases = Array.isArray(one.cases) ? one.cases : [];
	for (const row of rawCases) {
		const whenRaw = (row?.when && typeof row.when === "object") ? row.when : {};
		const op = String(whenRaw.op || "").trim().toLowerCase();
		const path = String(whenRaw.path || "").trim();
		const to = String(row?.to || "").trim();
		if (!allowedOps.has(op) || !path || !to) continue;
		const when = { op, path };
		const source = String(whenRaw.source || "").trim().toLowerCase();
		if (allowedSources.has(source) && source !== "args") when.source = source;
		if (op === "eq" || op === "neq" || op === "contains" || op === "gt" || op === "gte" || op === "lt" || op === "lte") {
			if (!("value" in whenRaw)) continue;
			when.value = whenRaw.value;
		}
		if (op === "in") {
			if (!("values" in whenRaw)) continue;
			const vals = Array.isArray(whenRaw.values) ? whenRaw.values : [whenRaw.values];
			when.values = vals;
		}
		if (op === "match") {
			const regex = String(whenRaw.regex || "").trim();
			if (!regex) continue;
			when.regex = regex;
			const flags = String(whenRaw.flags || "").trim();
			if (flags) when.flags = flags;
		}
		cases.push({ when, to });
	}
	const defaultTo = String(one.default || fallbackDefault || "").trim();
	return {
		type: "branch",
		cases,
		default: defaultTo,
	};
}

function sanitizeBuilderStepObject(rawStep, fallbackStep = null) {
	const knownTypes = new Set(["goto", "click", "input", "press_key", "wait", "scroll", "invoke", "run_js", "branch", "ask_assist", "done", "abort"]);
	const src = (rawStep && typeof rawStep === "object") ? rawStep : {};
	const fb = (fallbackStep && typeof fallbackStep === "object") ? fallbackStep : {};
	const id = String(src.id || fb.id || "").trim() || "step_1";
	const rawAction = (src.action && typeof src.action === "object" && !Array.isArray(src.action))
		? src.action
		: ((fb.action && typeof fb.action === "object" && !Array.isArray(fb.action)) ? fb.action : {});
	const action = JSON.parse(JSON.stringify(rawAction || {}));
	const t = String(action.type || fb?.action?.type || "").trim().toLowerCase();
	if (!knownTypes.has(t)) {
		throw new Error(`unsupported action.type: ${t || "-"}`);
	}
	if (t === "branch") {
		const branchFallbackDefault = String(rawStep?.next?.done || fb?.next?.done || "").trim();
		const branch = sanitizeBranchAction(action, branchFallbackDefault);
		return { id, action: branch, next: {} };
	}
	action.type = t;
	const nextRaw = (src.next && typeof src.next === "object" && !Array.isArray(src.next))
		? src.next
		: ((fb.next && typeof fb.next === "object" && !Array.isArray(fb.next)) ? fb.next : {});
	const next = {};
	for (const k of ["done", "failed", "skipped", "timeout", "default"]) {
		const v = String(nextRaw?.[k] || "").trim();
		if (v) next[k] = v;
	}
	return { id, action, next };
}

async function suggestStepRewriteByAI({ instruction, step, builderState = {}, webRpa, page, session, logger = null }) {
	const ask = String(instruction || "").trim();
	if (!ask) throw new Error("instruction is required");
	const current = sanitizeBuilderStepObject(step, step);
	const flowDraft = (builderState?.draft && typeof builderState.draft === "object") ? builderState.draft : {};
	const sampleStepIds = (Array.isArray(flowDraft.steps) ? flowDraft.steps : [])
		.map((x) => String(x?.id || "").trim())
		.filter(Boolean)
		.slice(0, 120);
	const ai = await withTimeout(runAIAction({
		action: {
			model: "advanced",
			prompt: [
				"你是 Flow Builder 的 step 修改助手（遵循 rpa-flow-spec-v0.55）。",
				"任务：根据用户修改意图，返回一个完整的 step JSON（id/action/next）。",
				"只输出 envelope.result JSON，结构：",
				"{\"step\":{\"id\":\"...\",\"action\":{},\"next\":{}},\"reason\":\"string\"}",
				"硬规则：",
				"- action.type 只能是 goto/click/input/press_key/wait/scroll/invoke/run_js/branch/ask_assist/done/abort。",
				"- branch 通过 action.cases/default 路由；branch 的 step.next 设为空对象。",
				"- 非 branch 可使用 next.done/failed/skipped/timeout/default。",
				"- 默认保留现有 step.id，除非用户明确要求改名。",
				"- 返回严格 JSON，不要额外文本。",
			].join("\n"),
			schema: {
				type: "object",
				required: ["step", "reason"],
				properties: {
					reason: { type: "string" },
					step: {
						type: "object",
						required: ["id", "action"],
						properties: {
							id: { type: "string" },
							action: { type: "object" },
							next: { type: "object" },
						},
						additionalProperties: false,
					},
				},
				additionalProperties: false,
			},
			page: { url: true, title: true, article: false, html: false },
			cache: false,
		},
		inputValue: {
			instruction: ask,
			currentStep: current,
			currentFlowId: String(flowDraft?.id || ""),
			knownStepIds: sampleStepIds,
		},
		webRpa,
		page,
		session,
		logger,
	}), 45000, "flow builder rewrite step timeout");
	const obj = parseObjectLike(ai?.envelope?.result, {});
	const revised = sanitizeBuilderStepObject(obj?.step, current);
	return {
		step: revised,
		reason: String(obj?.reason || "AI 已改写当前步骤。"),
	};
}

async function suggestBranchDraftByAI({ description, builderState = {}, webRpa, page, session, logger = null }) {
	const d = String(description || "").trim();
	if (!d) throw new Error("branch 描述不能为空");
	const steps = Array.isArray(builderState?.draft?.steps) ? builderState.draft.steps : [];
	const knownStepIds = steps.map((x) => String(x?.id || "").trim()).filter(Boolean).slice(0, 80);
	const ai = await withTimeout(runAIAction({
		action: {
			model: "advanced",
			prompt: [
				"你是 RPA Flow branch 设计器。",
				"任务：根据用户描述，生成符合 spec 的 branch action。",
				"只输出 envelope.result JSON，结构：",
				"{\"default\":\"stepId\",\"cases\":[{\"when\":Cond,\"to\":\"stepId\"}],\"reason\":\"string\"}",
				"规则：",
				"- action.type 固定是 branch（外层会补上）。",
				"- when.op 仅允许 exists/truthy/eq/neq/gt/gte/lt/lte/in/contains/match。",
				"- when.path 必填（如 publish 或 cover.data）。",
				"- when.source 可选，默认 args；仅可用 args/opts/vars/result。",
				"- eq/neq/contains 用 value；in 用 values 数组；match 用 regex/flags。",
				"- cases 按顺序命中第一个。",
				"- default 必填。",
				"- 不要输出 JS，不要输出解释文本。",
			].join("\n"),
			schema: {
				type: "object",
				required: ["default", "cases", "reason"],
				properties: {
					default: { type: "string" },
					cases: {
						type: "array",
						items: {
							type: "object",
							required: ["when", "to"],
							properties: {
								to: { type: "string" },
								when: {
									type: "object",
									required: ["op", "path"],
									properties: {
										op: { type: "string" },
										path: { type: "string" },
										source: { type: "string" },
										value: {},
										values: { type: "array", items: {} },
										regex: { type: "string" },
										flags: { type: "string" },
									},
									additionalProperties: false,
								},
							},
							additionalProperties: false,
						},
					},
					reason: { type: "string" },
				},
				additionalProperties: false,
			},
			page: { url: true, title: true, article: false, html: false },
			cache: false,
		},
		inputValue: {
			description: d,
			knownStepIds,
		},
		webRpa,
		page,
		session,
		logger,
	}), 45000, "flow builder branch draft timeout");
	const obj = parseObjectLike(ai?.envelope?.result, {});
	const action = sanitizeBranchAction(obj, "");
	if (!action.default) {
		const hint = knownStepIds.find((x) => /^done/i.test(x)) || knownStepIds[0] || "";
		action.default = hint;
	}
	if (!action.default || !action.cases.length) {
		throw new Error("AI branch 草案不完整，请补充更具体描述");
	}
	return {
		action,
		reason: String(obj.reason || "AI 已生成 branch 草案。"),
	};
}

function parseGoalCommand(question) {
	const raw = String(question || "");
	if (!raw) return { isGoal: false, goal: "" };
	const t = raw.trim();
	if (!t) return { isGoal: false, goal: "" };
	const c = t[0];
	if (c !== ":" && c !== ">") return { isGoal: false, goal: "" };
	const goal = t.slice(1).trim();
	return { isGoal: true, goal };
}

function formatGoalLoopAnswer(ret) {
	if (!ret || typeof ret !== "object") {
		return "目标执行结束：未知结果。";
	}
	const status = String(ret.status || "failed");
	const reason = String(ret.reason || "").trim();
	const steps = Number(ret.stepsUsed || 0);
	if (status === "done") {
		return `目标执行完成（steps=${steps}）。`;
	}
	if (status === "aborted") {
		return `目标已中止（steps=${steps}）：${reason || "无"}。`;
	}
	if (status === "max_steps") {
		return `目标执行达到步数上限（steps=${steps}）：${reason || "max_steps"}。`;
	}
	return `目标执行失败（steps=${steps}）：${reason || "unknown"}。`;
}

function normalizeChatRole(role) {
	return String(role || "").toLowerCase() === "assistant" ? "assistant" : "user";
}

function normalizeChatText(text) {
	return String(text || "").trim();
}

function mergeChatTimeline(base, incoming, maxLen = 48) {
	const out = Array.isArray(base) ? base.slice() : [];
	const rows = Array.isArray(incoming) ? incoming : [];
	for (const row of rows) {
		const role = normalizeChatRole(row?.role);
		const text = normalizeChatText(row?.text);
		if (!text) continue;
		const last = out.length ? out[out.length - 1] : null;
		if (last && last.role === role && last.text === text) continue;
		out.push({ role, text });
	}
	const keep = Math.max(4, Number(maxLen || 48));
	if (out.length > keep) out.splice(0, out.length - keep);
	return out;
}

async function setChatFabVisibility(page, visible) {
	if (!page) return false;
	try {
		return !!(await page.callFunction(
			function (show) {
				const root = document.getElementById("__rpa_selector_chat_root__");
				if (!root) return false;
				root.style.display = show ? "block" : "none";
				return true;
			},
			[!!visible],
			{ awaitPromise: true, timeout: 800 }
		));
	} catch (_) {
		return false;
	}
}

async function openChatFabPanel(page) {
	if (!page) return false;
	try {
		return !!(await page.callFunction(
			function () {
				const panel = document.getElementById("__rpa_selector_chat_panel__");
				const input = document.getElementById("__rpa_selector_chat_input__");
				if (!panel) return false;
				panel.style.display = "flex";
				if (input && typeof input.focus === "function") {
					setTimeout(() => { try { input.focus(); } catch (_) {} }, 0);
				}
				return true;
			},
			[],
			{ awaitPromise: true, timeout: 800 }
		));
	} catch (_) {
		return false;
	}
}

async function buildGoalConclusionAnswer({ webRpa, page, session, goal, loopRet, logger = null }) {
	const fallback = formatGoalLoopAnswer(loopRet);
	try {
		const ai = await withTimeout(runAIAction({
			action: {
				model: "advanced",
				prompt: "你是RPA执行总结助手。根据给定的目标与执行结果，用简体中文直接回答用户问题。必须给出明确结论；若无法确定，明确说明不确定并说明原因。输出到 envelope.result 的字符串。",
				page: { url: true, title: true, article: true },
				cache: false,
			},
			inputValue: {
				goal: String(goal || ""),
				result: {
					status: String(loopRet?.status || ""),
					stepsUsed: Number(loopRet?.stepsUsed || 0),
					reason: String(loopRet?.reason || ""),
					lastResult: loopRet?.lastResult || null,
					history: Array.isArray(loopRet?.history) ? loopRet.history.slice(-8) : [],
				},
			},
			webRpa,
			page,
			session,
			logger,
		}), 60000, "goal summary ai timeout");
		if (!ai?.ok) return fallback;
		const ans = normalizeChatAnswer(ai);
		return ans || fallback;
	} catch (_) {
		return fallback;
	}
}

async function withTimeout(promise, ms, label = "timeout") {
	let timer = null;
	const timeoutP = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(label)), Math.max(1000, Number(ms || 30000)));
	});
	try {
		return await Promise.race([promise, timeoutP]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function pickElementDetails(webRpa, page) {
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
					try {
						return el ? clean(el.getAttribute(name) || "") : "";
					} catch (_) {
						return "";
					}
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

async function askPickMode(webRpa, page) {
	const ret = await webRpa.inPagePrompt(page, "你要生成哪种 selector？", {
		modal: true,
		mask: "rgba(0,0,0,0.22)",
		showCancel: false,
		menu: [
			{ text: "单个元素（唯一匹配）", code: "single" },
			{ text: "一类元素（列表匹配）", code: "multi" },
			{ text: "放弃", code: "cancel" },
		],
	});
	return ret?.code || "cancel";
}

function buildQueryFromPicked(picked, mode) {
	const need = mode === "multi" ? "返回可匹配一组同类元素的稳定 selector" : "返回尽量唯一且稳定的 selector";
	const textHint = picked.text ? `元素文本: ${picked.text}` : "元素文本: (空)";
	return [
		`我已经人工选中了一个网页元素，请根据这个元素生成 selector。目标要求：${need}。`,
		`已选元素基本信息：tag=${picked.tagName || ""}, id=${picked.id || ""}, class=${picked.className || ""}, name=${picked.name || ""}, role=${picked.role || ""}, aria-label=${picked.ariaLabel || ""}, href=${picked.href || ""}`,
		`已选元素简易 selector: ${picked.selector || ""}`,
		textHint,
		`已选元素 outerHTML 片段: ${picked.outerHTML || ""}`,
	].join("\n");
}

function parseReviewResult(ret) {
	const out = { action: "cancel", feedback: "" };
	if (!Array.isArray(ret)) return out;
	const codes = [];
	for (const item of ret) {
		if (item && typeof item === "object" && typeof item.code === "string") {
			codes.push(item.code);
		}
		if (typeof item === "string" && item.trim()) {
			out.feedback = item.trim();
		}
	}
	if (codes.includes("cancel")) out.action = "cancel";
	else if (codes.includes("fit")) out.action = "fit";
	else if (codes.includes("reject")) out.action = "reject";
	else if (out.feedback) out.action = "reject";
	return out;
}

async function reviewSelector(webRpa, page, selector, count) {
	const ret = await webRpa.inPagePrompt(
		page,
		`候选 selector:\n${selector}\n\n当前高亮匹配数量: ${Number(count || 0)}\n\n请选择结果，可附加文本提示让 AI 重新生成。`,
		{
			modal: true,
			mask: "rgba(0,0,0,0.24)",
			showCancel: false,
			menu: [
				{ text: "合适", code: "fit" },
				{ text: "不合适", code: "reject" },
				{ text: "放弃", code: "cancel" },
			],
			multiSelect: true,
			allowEmpty: false,
			edit: true,
			placeHolder: "可选：输入让 AI 更好生成 selector 的提示（例如：不要用 nth-child，优先 data-testid）",
			okText: "确认",
		}
	);
	return parseReviewResult(ret);
}

async function generateSelectorFlow({ webRpa, page, session, picked, mode }) {
	let feedbackNote = "";
	const maxPass = 5;
	for (let pass = 1; pass <= maxPass; pass++) {
		const query = buildQueryFromPicked(picked, mode);
		const tipId = `__selector_picker_ai_busy_${Date.now()}_${pass}__`;
		await webRpa.inPageTip(page, "AI 正在生成 selector，请稍候…", {
			id: tipId,
			position: "top",
			stack: false,
			timeout: 0,
			opacity: 0.96,
			persistAcrossNav: true,
			persistTtlMs: 45000,
			pollMs: 400,
		});
		let ai;
		try {
			ai = await resolveSelectorByAI({
				query,
				webRpa,
				page,
				session,
				feedbackNote,
				expectedMulti: mode === "multi",
			});
		} finally {
			await webRpa.inPageTipDismiss(page, tipId);
		}
		if (!ai?.ok || !Array.isArray(ai.selectors) || !ai.selectors.length) {
			await webRpa.inPageDismissSelector(page);
			await webRpa.inPageTip(page, `AI 生成失败：${ai?.reason || "未知错误"}`, { timeout: 2500, stack: false });
			return null;
		}
		let roundFeedback = "";
		for (const selector of ai.selectors) {
			const count = await webRpa.inPageShowSelector(page, selector, { color: "#1890ff", thickness: 2 });
			const decision = await reviewSelector(webRpa, page, selector, count);
			if (decision.action === "fit") {
				await webRpa.inPageDismissSelector(page);
				await clipboardy.write(selector);
				await webRpa.inPageTip(page, "selector 已复制到剪贴板", { timeout: 1800, stack: false });
				console.log("[selector-picker] copied:", selector);
				return selector;
			}
			if (decision.action === "cancel") {
				await webRpa.inPageDismissSelector(page);
				return null;
			}
			if (decision.feedback) {
				roundFeedback = decision.feedback;
				break;
			}
		}
		await webRpa.inPageDismissSelector(page);
		feedbackNote = roundFeedback
			? `用户反馈：${roundFeedback}`
			: "上一次候选不合适，请重新生成更稳定、可读、抗页面变化的 selector。";
	}
	return null;
}

async function handleFlowBuildRequest({ req, webRpa, page, session, logger = null }) {
	const id = String(req?.id || "");
	const kind = String(req?.kind || "").trim().toLowerCase();
	const payload = (req?.payload && typeof req.payload === "object") ? req.payload : {};
	const builderStateBase = (payload?.builderState && typeof payload.builderState === "object") ? payload.builderState : {};
	if (!kind) {
		return { id, kind: "error", message: "flow builder 请求缺少 kind", builderState: builderStateBase };
	}
	try {
		if (kind === "analyze_goal") {
			const goal = String(payload.goal || "").trim();
			if (!goal) return { id, kind: "error", message: "请输入 flow 目标", builderState: builderStateBase };
			const ret = await suggestFlowCapsArgsByAI({ goal, webRpa, page, session, logger });
			const nextBuilderState = {
				...builderStateBase,
				active: true,
				flowGoal: goal,
				flowId: String(ret.flowIdHint || normalizeFlowIdHint(goal)),
				flowCaps: Array.isArray(ret.caps) ? ret.caps.join(", ") : "",
				flowArgs: Array.isArray(ret.args) ? ret.args.join(", ") : "",
			};
			return {
				id,
				kind: "analyze_result",
				flowIdHint: String(ret.flowIdHint || normalizeFlowIdHint(goal)),
				caps: Array.isArray(ret.caps) ? ret.caps : [],
				args: Array.isArray(ret.args) ? ret.args : [],
				message: String(ret.reason || "已完成能力匹配"),
				builderState: nextBuilderState,
			};
		}
		if (kind === "confirm_caps") {
			const goal = String(payload.goal || "").trim();
			const flowId = normalizeFlowIdHint(payload.flowId || goal || "flow_builder");
			const caps = Array.isArray(payload.caps) ? payload.caps.map((x) => String(x || "").trim()).filter(Boolean) : [];
			const args = Array.isArray(payload.args) ? payload.args.map((x) => String(x || "").trim()).filter(Boolean) : [];
			const filters = (Array.isArray(payload.filters) ? payload.filters : [])
				.map((x) => {
					const key = String(x?.key || "").trim();
					const value = String(x?.value || "").trim();
					return (key && value) ? { key, value } : null;
				})
				.filter(Boolean);
			const capabilities = Array.from(new Set([...caps, ...args]));
			const defs = {};
			for (const one of args) defs[one] = { type: "string", required: false, desc: `from flow builder: ${one}` };
			const prevDraft = (builderStateBase?.draft && typeof builderStateBase.draft === "object") ? builderStateBase.draft : {};
			const prevStepsRaw = Array.isArray(prevDraft.steps) ? prevDraft.steps : [];
			const prevSteps = [];
			for (const one of prevStepsRaw) {
				if (!one || typeof one !== "object") continue;
				const sid = String(one.id || "").trim();
				const action = (one.action && typeof one.action === "object" && !Array.isArray(one.action)) ? one.action : null;
				const at = String(action?.type || "").trim();
				if (!sid || !action || !at) continue;
				const next = (one.next && typeof one.next === "object" && !Array.isArray(one.next)) ? one.next : {};
				prevSteps.push({ ...one, id: sid, action, next });
			}
			let start = String(prevDraft.start || "").trim();
			if (!start || !prevSteps.some((s) => String(s?.id || "").trim() === start)) {
				start = String(prevSteps[0]?.id || "").trim();
			}
			const sourcePath = String(prevDraft.sourcePath || "").trim();
			const shell = { id: flowId, start, capabilities, filters, args: defs, steps: prevSteps, ...(sourcePath ? { sourcePath } : {}) };
			const prevStepNo = Number(builderStateBase?.stepNo || 1);
			const nextStepNo = (Number.isFinite(prevStepNo) && prevStepNo >= 1) ? Math.floor(prevStepNo) : 1;
			const nextBuilderState = {
				...builderStateBase,
				active: true,
				shellConfirmed: true,
				stepNo: nextStepNo,
				flowGoal: goal,
				flowId,
				flowCaps: caps.join(", "),
				flowArgs: args.join(", "),
				flowFilters: filters.length ? JSON.stringify(filters, null, 2) : "",
				draft: shell,
				lastRunOk: false,
				lastRunStep: null,
			};
			return {
				id,
				kind: "confirm_result",
				shell,
				nextStepNo,
				message: "已创建 flow 外壳。请开始逐步编写并执行步骤。",
				builderState: nextBuilderState,
			};
		}
		if (kind === "list_saved_flows") {
			const rows = await listSavedBuilderFlows();
			return {
				id,
				kind: "saved_flows_result",
				ok: true,
				flows: rows,
				message: rows.length ? `已加载 ${rows.length} 个本地 Flow` : "未找到本地 Flow 文件",
				builderState: { ...builderStateBase, active: true },
			};
		}
		if (kind === "load_saved_flow") {
			const p = String(payload.path || "").trim();
			if (!p) return { id, kind: "error", message: "请选择要加载的 Flow", builderState: builderStateBase };
			const loaded = await loadSavedBuilderFlowFromPath(p);
			const shellConfirmed = true;
			const steps = Array.isArray(loaded.steps) ? loaded.steps : [];
			const nextStepNo = Math.max(1, steps.length + 1);
			const nextBuilderState = {
				...builderStateBase,
				active: true,
				shellConfirmed,
				stepNo: nextStepNo,
				flowGoal: String(builderStateBase?.flowGoal || ""),
				flowId: String(loaded.id || ""),
				flowCaps: "",
				flowArgs: "",
				flowFilters: JSON.stringify(Array.isArray(loaded.filters) ? loaded.filters : []),
				draft: loaded,
				lastRunOk: false,
				lastRunStep: null,
			};
			return {
				id,
				kind: "load_flow_result",
				ok: true,
				flow: loaded,
				message: `已加载 Flow：${String(loaded.id || "")}`,
				builderState: nextBuilderState,
			};
		}
		if (kind === "generate_branch_draft") {
			const description = String(payload.description || "").trim();
			if (!description) return { id, kind: "error", message: "branch 描述不能为空", builderState: builderStateBase };
			const ret = await suggestBranchDraftByAI({
				description,
				builderState: builderStateBase,
				webRpa,
				page,
				session,
				logger,
			});
			return {
				id,
				kind: "branch_draft_result",
				ok: true,
				action: ret.action,
				message: String(ret.reason || "已生成 branch 草案"),
				builderState: { ...builderStateBase, active: true },
			};
		}
		if (kind === "rewrite_step_with_ai") {
			const instruction = String(payload.instruction || "").trim();
			const step = (payload.step && typeof payload.step === "object") ? payload.step : null;
			if (!instruction) return { id, kind: "error", message: "请先输入步骤修改意图", builderState: builderStateBase };
			if (!step) return { id, kind: "error", message: "step 不能为空", builderState: builderStateBase };
			const ret = await suggestStepRewriteByAI({
				instruction,
				step,
				builderState: builderStateBase,
				webRpa,
				page,
				session,
				logger,
			});
			return {
				id,
				kind: "rewrite_step_result",
				ok: true,
				step: ret.step,
				message: String(ret.reason || "AI 已改写当前步骤。"),
				builderState: { ...builderStateBase, active: true },
			};
		}
			if (kind === "run_step") {
				const step = (payload.step && typeof payload.step === "object") ? payload.step : null;
				if (!step) return { id, kind: "error", message: "step 不能为空", builderState: builderStateBase };
				const runRet = await runBuilderStepOnce({ webRpa, page, session, step });
				const status = String(runRet?.status || "failed");
				const ok = status === "done";
				const reason = String(runRet?.reason || "").trim();
				const lastResult = runRet?.lastResult || null;
				const hist = Array.isArray(runRet?.history) ? runRet.history.slice(-3) : [];
				const lastReason = String(lastResult?.reason || "").trim();
				const histBrief = hist.map((h) => ({
					stepId: String(h?.stepId || ""),
					status: String(h?.result?.status || h?.status || ""),
					reason: String(h?.result?.reason || h?.reason || ""),
					actionType: String(h?.actionType || ""),
				}));
				const summary = ok
					? "步骤执行成功。请确认后进入下一步。"
					: `步骤执行失败：${reason || status}`;
				const detail = (!ok && (lastReason || histBrief.length))
					? `\nlastReason=${lastReason || "-"}\nhistory=${JSON.stringify(histBrief)}`
					: "";
				const nextBuilderState = {
					...builderStateBase,
					active: true,
					lastRunOk: ok,
					lastRunStep: step,
			};
				return {
					id,
					kind: "run_step_result",
				ok,
				status,
				step,
					reason,
					lastResult,
					history: hist,
					message: `${summary}\nstatus=${status}${reason ? `\nreason=${reason}` : ""}${detail}`,
					builderState: nextBuilderState,
					};
				}
				if (kind === "pick_selector") {
					await webRpa.inPageTip(page, "请选择页面元素（Esc 取消）", { timeout: 1200, stack: false });
					const picked = await pickElementDetails(webRpa, page);
					if (!picked) {
						return {
							id,
							kind: "pick_selector_result",
							ok: false,
							selector: "",
							picked: null,
							message: "未选中元素。",
							builderState: { ...builderStateBase, active: true },
						};
					}
					const mode = await askPickMode(webRpa, page);
					if (mode === "cancel") {
						return {
							id,
							kind: "pick_selector_result",
							ok: false,
							selector: "",
							picked,
							message: "已取消 selector 生成。",
							builderState: { ...builderStateBase, active: true },
						};
					}
					const selector = String((await generateSelectorFlow({ webRpa, page, session, picked, mode })) || "").trim();
					return {
						id,
						kind: "pick_selector_result",
						ok: !!selector,
						selector,
						picked: picked || null,
						message: selector
							? `已选中元素并生成 selector：${selector}`
							: "未生成 selector（可能已取消）。",
						builderState: {
							...builderStateBase,
							active: true,
						},
					};
				}
				if (kind === "suggest_invoke_targets") {
				await ensureFlowRegistry({ logger });
				const topN = Math.max(1, Math.min(30, Number(payload.topN || 12)));
				const find = (payload.find && typeof payload.find === "object" && !Array.isArray(payload.find))
					? payload.find
					: {};
				const reqKind = String(find.kind || "rpa").trim() || "rpa";
				const entries = listFlowEntries().filter((e) => String(e?.kind || "") === reqKind);
				const found = findBestFlowEntry(entries, find);
				const raw = (found.ok && Array.isArray(found.candidates) && found.candidates.length)
					? found.candidates.map((x) => x?.entry).filter(Boolean)
					: entries;
				const picked = raw.slice(0, topN).map((e) => ({
					entryId: String(e?.entryId || ""),
					id: String(e?.id || ""),
					source: String(e?.source || ""),
				}));
				const bestEntryId = (found.ok && found.entry) ? String(found.entry.entryId || "") : "";
				const nextBuilderState = {
					...builderStateBase,
					active: true,
					invokeCandidates: picked,
				};
				return {
					id,
					kind: "invoke_targets_result",
					ok: picked.length > 0,
					find,
					bestEntryId,
					candidates: picked,
					message: picked.length
						? `已找到 ${picked.length} 个 invoke 候选`
						: `未找到匹配 invoke 候选（kind=${reqKind}）`,
					builderState: nextBuilderState,
				};
			}
			if (kind === "save_flow") {
				const flow = (payload.flow && typeof payload.flow === "object") ? payload.flow : null;
				if (!flow) return { id, kind: "error", message: "flow 不能为空", builderState: builderStateBase };
				const sourcePath = String(payload.sourcePath || flow?.sourcePath || builderStateBase?.draft?.sourcePath || "").trim();
				const outPath = await saveBuilderFlowToFile(flow, { sourcePath });
				const nextDraft = (builderStateBase?.draft && typeof builderStateBase.draft === "object")
					? { ...builderStateBase.draft, sourcePath: outPath }
					: { ...flow, sourcePath: outPath };
				const nextBuilderState = {
					...builderStateBase,
					active: true,
					draft: nextDraft,
				};
			return {
				id,
				kind: "save_result",
				ok: true,
				path: outPath,
				message: sourcePath ? `Flow 已覆盖保存：${outPath}` : `Flow 已保存：${outPath}`,
				builderState: nextBuilderState,
			};
		}
		return { id, kind: "error", message: `不支持的 flow builder kind: ${kind}`, builderState: builderStateBase };
	} catch (err) {
		return { id, kind: "error", message: `flow builder 执行失败：${err?.message || err}`, builderState: builderStateBase };
	}
}

async function main() {
	const alias = getArg("alias", "selector_picker");
	const launchMode = process.env.WEBRPA_WEBDRIVE_MODE || "direct";
	const firefoxAppPath = process.env.WEBDRIVE_APP;
	const startUrl = getArg("url", "about:blank");
	const shortcut = parseShortcut(getArg("shortcut", "ctrl+shift+p"));
	const shortcutText = shortcutLabel(shortcut);
	const enableChatFab = parseBoolArg(getArg("chat-fab", ""), true);
	let chatFabIcon = "";
	if (enableChatFab) {
		try {
			chatFabIcon = await readFileAsDataURL(pathLib.join(__dirname, "ai2apps.svg"));
		} catch (_) {
			chatFabIcon = "";
		}
	}

	if (!firefoxAppPath) {
		throw new Error("Missing WEBDRIVE_APP in .env");
	}
	await cleanupProfileLocks(alias);

	const sessionStub = { agentNode: null, options: { webDriveMode: launchMode } };
	const webRpa = new WebRpa(sessionStub, {
		webDriveMode: launchMode,
		includeAllNewTabs: true,
	});
	const logDir = process.env.FLOW_LOG_DIR || pathLib.join(__dirname, "flow-logs");
	const paLogger = await createFlowLogger({
		logDir,
		flowId: "page_assistant",
		echoConsole: false,
		maxInMemory: 1200,
	});
	console.log(`[page-assistant] log file: ${paLogger.filePath}`);
	await paLogger.info("runner.start", { alias, launchMode, startUrl, enableChatFab });
	const logEvent = (level, event, data = {}) => {
		try {
			const fn = paLogger && paLogger[level];
			if (typeof fn === "function") fn(event, data).catch(() => {});
		} catch (_) {
		}
	};
	let browser = null;
	let closed = false;
	let focusProbeTimer = null;
	const eventBindings = [];
	const parentByContext = new Map();
	const groupStates = new Map();
	const chatTimelineByContext = new Map();
	const flowBuilderStateByGroup = new Map();
	let goalExecutionTasks = 0;
	const runningPickTasks = new Set();
	const runningChatTasks = new Set();
	try {
		browser = await webRpa.openBrowser(alias, {
			launchMode: "direct",
			pathToFireFox: firefoxAppPath,
		});
		browser.on("browser.exit", () => { closed = true; });
		browser.on("browser.willExit", () => { closed = true; });

			const page = await webRpa.openPage(browser);
			await page.goto(startUrl);
			await ensureShortcutInjected(page, shortcut);
			if (enableChatFab) {
				const ctxId = String(page.context || "");
				await ensureChatFabInjected(
					page,
					chatFabIcon,
					chatTimelineByContext.get(ctxId) || [],
					getFlowBuilderSeedForPage(page, parentByContext, flowBuilderStateByGroup)
				);
			}
			parentByContext.set(String(page.context || ""), "");

			const ensureByContext = async (context) => {
				if (!context || closed) return;
					const p = webRpa.getPageByContextId(context);
					if (!p) return;
					await ensureShortcutInjected(p, shortcut);
					if (enableChatFab) {
						const ctxId = String(p.context || "");
						await ensureChatFabInjected(
							p,
							chatFabIcon,
							chatTimelineByContext.get(ctxId) || [],
							getFlowBuilderSeedForPage(p, parentByContext, flowBuilderStateByGroup)
						);
						await setChatFabVisibility(p, goalExecutionTasks <= 0);
					}
				};
		const getOrInitGroup = (groupId) => {
			const gid = String(groupId || "");
			if (!gid) return { active: false, activeContext: "", canceled: false, lastBusyTipAt: 0 };
			if (!groupStates.has(gid)) {
				groupStates.set(gid, { active: false, activeContext: "", canceled: false, lastBusyTipAt: 0 });
			}
			return groupStates.get(gid);
		};
		const acquireGroup = (groupId, context) => {
			const st = getOrInitGroup(groupId);
			if (st.active) return false;
			st.active = true;
			st.activeContext = String(context || "");
			st.canceled = false;
			groupStates.set(groupId, st);
			return true;
		};
		const releaseGroup = (groupId, context) => {
			const st = getOrInitGroup(groupId);
			if (!st.active) return;
			if (context && st.activeContext && String(context) !== String(st.activeContext)) return;
			st.active = false;
			st.activeContext = "";
			st.canceled = false;
			groupStates.set(groupId, st);
		};
			const markCanceledByContext = (context) => {
			const ctx = String(context || "");
			if (!ctx) return;
			for (const [gid, st] of groupStates.entries()) {
				if (String(st.activeContext || "") !== ctx) continue;
				st.canceled = true;
				st.active = false;
				st.activeContext = "";
				groupStates.set(gid, st);
			}
			};

		const onContextCreated = async (params) => {
			const context = String(params?.context || "");
			const parent = String(params?.parent || "");
			if (context) parentByContext.set(context, parent);
			try { await ensureByContext(context); } catch (_) {}
		};
		const onNavLike = async (params) => {
			try { await ensureByContext(params?.context || ""); } catch (_) {}
		};
				const onContextDestroyed = async (params) => {
					const context = String(params?.context || "");
					if (!context) return;
						const root = getRootContext(context, parentByContext) || context;
						markCanceledByContext(context);
						chatTimelineByContext.delete(context);
					parentByContext.delete(context);
					for (const [k, v] of Array.from(parentByContext.entries())) {
						if (String(v || "") === context) {
							parentByContext.delete(k);
							chatTimelineByContext.delete(String(k || ""));
						}
					}
					const st = groupStates.get(root);
					if (st && !st.active) {
						groupStates.delete(root);
						flowBuilderStateByGroup.delete(root);
					}
			};
		for (const b of [
			{ eventName: "browsingContext.contextCreated", handler: onContextCreated },
			{ eventName: "browsingContext.navigationCommitted", handler: onNavLike },
			{ eventName: "browsingContext.historyUpdated", handler: onNavLike },
			{ eventName: "browsingContext.load", handler: onNavLike },
			{ eventName: "browsingContext.contextDestroyed", handler: onContextDestroyed },
		]) {
			browser.on(b.eventName, b.handler);
			eventBindings.push(b);
		}

		focusProbeTimer = setInterval(async () => {
			if (closed) return;
			try {
				const visiblePage = await pickActiveVisiblePage(webRpa);
				if (!visiblePage) return;
				if (webRpa.currentPage !== visiblePage) {
					webRpa.setCurrentPage(visiblePage);
				}
						await ensureShortcutInjected(visiblePage, shortcut);
						if (enableChatFab) {
							const ctxId = String(visiblePage.context || "");
							await ensureChatFabInjected(
								visiblePage,
								chatFabIcon,
								chatTimelineByContext.get(ctxId) || [],
								getFlowBuilderSeedForPage(visiblePage, parentByContext, flowBuilderStateByGroup)
							);
							await setChatFabVisibility(visiblePage, goalExecutionTasks <= 0);
						}
					} catch (_) {
					}
			}, 1200);

			console.log(`[selector-picker] started. Press ${shortcutText} in page to pick element.`);

		while (!closed) {
			if (enableChatFab) {
					const pages = Array.isArray(webRpa?.sessionPages) ? Array.from(webRpa.sessionPages) : [];
					for (const p of pages) {
							if (!p) continue;
								const pageCtxId = String(p.context || "");
								await ensureChatFabInjected(
									p,
									chatFabIcon,
									chatTimelineByContext.get(pageCtxId) || [],
									getFlowBuilderSeedForPage(p, parentByContext, flowBuilderStateByGroup)
								);
								await setChatFabVisibility(p, goalExecutionTasks <= 0);
									const dbgRows = await popFlowDebugLogs(p, 80);
									if (Array.isArray(dbgRows) && dbgRows.length) {
										const ctx = String(p.context || "");
										for (const row of dbgRows) {
											const ev = String(row?.event || "");
											const data = row?.data && typeof row.data === "object" ? row.data : {};
											console.log("[flow-builder][ui]", JSON.stringify({ context: ctx, event: ev, data }));
											logEvent("debug", "flow_builder.ui", { context: ctx, event: ev, data });
										}
									}
								const req = await popChatRequest(p);
								if (req) {
								console.log("[selector-picker] chat request:", JSON.stringify({
									context: String(p.context || ""),
									url: String(req.url || ""),
									question: String(req.question || "").slice(0, 80),
									historyCount: Array.isArray(req.history) ? req.history.length : 0,
									pageMode: "full",
								}));
								const task = (async () => {
									const qid = String(req.id || "");
									const contextId = String(p.context || "");
								let timeline = mergeChatTimeline(
									chatTimelineByContext.get(contextId) || [],
									Array.isArray(req.history) ? req.history : [],
									48
								);
								const qText = normalizeChatText(req.question || "");
								if (qText) {
									timeline = mergeChatTimeline(timeline, [{ role: "user", text: qText }], 48);
								}
								chatTimelineByContext.set(contextId, timeline);
								try {
									await webRpa.inPageTip(p, "AI 正在思考页面问答，请稍候…", {
									timeout: 1200,
									stack: false,
									});
								console.log("[selector-picker] chat ai start:", qid);
								const command = parseGoalCommand(String(req.question || ""));
								let answer = "";
									if (command.isGoal) {
										if (!command.goal) {
											answer = "命令格式：以 ':' 或 '>' 开头，后面填写目标。例如：: 打开微博并找到热搜第一条";
										} else {
											goalExecutionTasks += 1;
											const allPages = Array.isArray(webRpa?.sessionPages) ? Array.from(webRpa.sessionPages) : [];
											for (const hp of allPages) {
												try { await setChatFabVisibility(hp, false); } catch (_) {}
											}
											await webRpa.inPageTip(p, "已进入目标执行模式，AI 将分步完成目标，请稍候…", {
												timeout: 1600,
												stack: false,
											});
											let loopRet = null;
											try {
												loopRet = await runGoalDrivenLoop({
													goal: command.goal,
													webRpa,
													page: p,
													session: sessionStub,
													args: {},
													opts: {},
													notes: "来自页面聊天悬浮球的目标执行请求。",
													actionScope: "all",
													invokeScope: "all",
													maxSteps: 12,
													maxConsecutiveFails: 3,
													aiModel: "advanced",
													aiTimeoutMs: 60000,
													logger: chatAiLogger,
												});
											} finally {
												goalExecutionTasks = Math.max(0, goalExecutionTasks - 1);
												const restorePages = Array.isArray(webRpa?.sessionPages) ? Array.from(webRpa.sessionPages) : [];
												for (const sp of restorePages) {
													try { await setChatFabVisibility(sp, goalExecutionTasks <= 0); } catch (_) {}
												}
											}
											console.log("[selector-picker] goal loop done:", JSON.stringify({
												qid,
												status: String(loopRet?.status || ""),
												stepsUsed: Number(loopRet?.stepsUsed || 0),
												reason: String(loopRet?.reason || "").slice(0, 120),
											}));
											answer = await buildGoalConclusionAnswer({
												webRpa,
												page: p,
												session: sessionStub,
												goal: command.goal,
												loopRet,
												logger: chatAiLogger,
											});
										}
									} else {
										const ai = await withTimeout(runAIAction({
											action: {
												model: "advanced",
												prompt: [
													"你是网页问答助手。你必须先判断用户问题类型，再输出状态化结果。",
													"仅允许输出到 envelope.result 的 JSON 对象，结构如下：",
													"{\"status\":\"done|greeting|help\",\"answer\":\"string\"}",
													"判定规则：",
													"- greeting: 用户在打招呼/寒暄。",
													"- help: 用户询问系统能力、怎么用，或问题与当前页面无关。",
													"- done: 用户在问当前页面相关内容，且你给出回答。",
													"回答要求：",
													"- 使用简体中文，简洁明确。",
													"- done 只基于给定页面信息和对话历史作答；若页面证据不足，answer 写：不确定，需要更多页面信息。",
													"- help 的 answer 简短说明“只能回答当前页面相关问题，并可制作 selector/执行 : 或 > 目标”。",
													"- greeting 的 answer 简短友好，并引导用户基于当前页面提问。",
												].join("\n"),
												schema: {
													type: "object",
													required: ["status", "answer"],
													properties: {
														status: { type: "string", enum: ["done", "greeting", "help"] },
														answer: { type: "string" },
													},
													additionalProperties: false,
												},
												page: { url: true, title: true, article: true, html: true },
												cache: false,
											},
												inputValue: {
													question: String(req.question || ""),
													history: timeline.slice(-24),
												pageHint: { url: String(req.url || ""), title: String(req.title || "") },
											},
												webRpa,
											page: p,
											session: sessionStub,
											logger: chatAiLogger,
										}), 60000, "chat ai timeout");
									console.log("[selector-picker] chat ai done:", qid, "ok=", !!ai?.ok);
									console.log("[selector-picker] chat ai envelope:", String(ai?.envelope?.status || "none"), String(ai?.envelope?.reason || "").slice(0, 120));
									if (!ai?.ok) {
										console.warn("[selector-picker] chat ai failed:", ai?.reason || "unknown");
										}
										if (ai?.ok) {
											const decision = normalizeChatDecision(ai);
											console.log("[selector-picker] chat ai decision:", JSON.stringify({ kind: decision.kind, preview: String(decision.answer || "").slice(0, 120) }));
											answer = decision.answer || buildHelpAnswerText();
										} else {
											answer = `抱歉，AI 暂时不可用：${ai?.reason || "unknown"}`;
										}
									}
									timeline = mergeChatTimeline(timeline, [{ role: "assistant", text: answer }], 48);
									let responsePage = webRpa?.currentPage || p;
									try {
										const pages = Array.isArray(webRpa?.sessionPages) ? Array.from(webRpa.sessionPages) : [];
										if (!responsePage || !pages.includes(responsePage)) responsePage = p;
									} catch (_) {
										responsePage = p;
									}
									const responseContextId = String(responsePage?.context || contextId || "");
									chatTimelineByContext.set(responseContextId, timeline);
									if (responseContextId && responseContextId !== contextId) {
										chatTimelineByContext.set(contextId, timeline);
									}
									try {
										await ensureChatFabInjected(
											responsePage,
											chatFabIcon,
											timeline,
											getFlowBuilderSeedForPage(responsePage, parentByContext, flowBuilderStateByGroup)
										);
										await setChatFabVisibility(responsePage, true);
										await openChatFabPanel(responsePage);
									} catch (_) {
									}
									console.log("[selector-picker] chat ai answer:", String(answer || "").slice(0, 200));
									const pushed = await pushChatResponse(responsePage, { id: qid, answer });
									if (!pushed) {
										console.warn("[selector-picker] chat response push failed:", qid);
										if (responsePage !== p) {
											const pushedFallback = await pushChatResponse(p, { id: qid, answer });
											if (!pushedFallback) {
												console.warn("[selector-picker] chat response push failed(fallback):", qid);
											}
										}
								}
							} catch (err) {
								if (!isSessionGoneError(err)) {
									console.warn("[selector-picker] chat task warning:", err?.message || err);
								}
								try {
									const contextId = String(p.context || "");
									const timeline = mergeChatTimeline(
										chatTimelineByContext.get(contextId) || [],
										[{ role: "assistant", text: "抱歉，本轮对话失败，请重试。" }],
										48
									);
									chatTimelineByContext.set(contextId, timeline);
									const responsePage = webRpa?.currentPage || p;
									await setChatFabVisibility(responsePage, true);
									await openChatFabPanel(responsePage);
								} catch (_) {
								}
								const responsePage = webRpa?.currentPage || p;
								const pushed = await pushChatResponse(responsePage, { id: qid, answer: "抱歉，本轮对话失败，请重试。" });
								if (!pushed) {
									console.warn("[selector-picker] chat response push failed(after error):", qid);
								}
							}
								})();
								runningChatTasks.add(task);
								task.finally(() => { runningChatTasks.delete(task); });
							}
									const flowReq = await popFlowBuildRequest(p);
									if (flowReq) {
										const flowTask = (async () => {
											const rid = String(flowReq?.id || "");
											const reqKind = String(flowReq?.kind || "");
											logEvent("info", "flow_builder.req", {
												id: rid,
												kind: reqKind,
												context: String(p?.context || ""),
												url: String(flowReq?.url || ""),
												builderStepId: String(flowReq?.payload?.builderState?.stepEditor?.stepId || ""),
												builderActionType: String(flowReq?.payload?.builderState?.stepEditor?.actionType || ""),
												builderPayloadLen: String(flowReq?.payload?.builderState?.stepEditor?.actionPayload || "").length,
												draftSteps: Array.isArray(flowReq?.payload?.builderState?.draft?.steps) ? flowReq.payload.builderState.draft.steps.length : 0,
												step: flowReq?.payload?.step && typeof flowReq.payload.step === "object"
													? {
														id: String(flowReq.payload.step.id || ""),
														actionType: String(flowReq.payload.step?.action?.type || ""),
														findKeys: flowReq.payload.step?.action?.find && typeof flowReq.payload.step.action.find === "object"
															? Object.keys(flowReq.payload.step.action.find)
															: [],
														findMust: Array.isArray(flowReq.payload.step?.action?.find?.must)
															? flowReq.payload.step.action.find.must
															: [],
														target: String(flowReq.payload.step?.action?.target || ""),
													}
													: null,
												flowStepCount: Array.isArray(flowReq?.payload?.flow?.steps) ? flowReq.payload.flow.steps.length : 0,
												flowStart: String(flowReq?.payload?.flow?.start || ""),
											});
											const groupId = getGroupIdForPage(p, parentByContext) || String(p.context || "");
										const reqBuilderState = (flowReq?.payload?.builderState && typeof flowReq.payload.builderState === "object")
											? flowReq.payload.builderState
											: null;
										if (groupId && reqBuilderState) {
											flowBuilderStateByGroup.set(groupId, reqBuilderState);
										}
											const response = await handleFlowBuildRequest({
												req: flowReq,
												webRpa,
												page: p,
												session: sessionStub,
												logger: chatAiLogger,
											});
											logEvent("info", "flow_builder.resp", {
												id: rid,
												kind: String(response?.kind || ""),
												message: String(response?.message || "").slice(0, 180),
												reason: String(response?.reason || ""),
												lastResultStatus: String(response?.lastResult?.status || ""),
												lastResultReason: String(response?.lastResult?.reason || ""),
												historyBrief: Array.isArray(response?.history)
													? response.history.slice(-5).map((h) => ({
														stepId: String(h?.stepId || ""),
														status: String(h?.result?.status || h?.status || ""),
														reason: String(h?.result?.reason || h?.reason || ""),
														actionType: String(h?.actionType || ""),
													}))
													: [],
												builderStepNo: Number(response?.builderState?.stepNo || 0),
												builderShellConfirmed: !!response?.builderState?.shellConfirmed,
												builderDraftSteps: Array.isArray(response?.builderState?.draft?.steps) ? response.builderState.draft.steps.length : 0,
											});
										if (groupId && response?.builderState && typeof response.builderState === "object") {
											flowBuilderStateByGroup.set(groupId, response.builderState);
										}
										let responsePage = webRpa?.currentPage || p;
										try {
											const all = Array.isArray(webRpa?.sessionPages) ? Array.from(webRpa.sessionPages) : [];
											if (!responsePage || !all.includes(responsePage)) responsePage = p;
										} catch (_) {
											responsePage = p;
										}
										const responseGroupId = getGroupIdForPage(responsePage, parentByContext) || String(responsePage?.context || "");
										if (responseGroupId && response?.builderState && typeof response.builderState === "object") {
											flowBuilderStateByGroup.set(responseGroupId, response.builderState);
										}
										try {
											const reqCtx = String(p?.context || "");
											await ensureChatFabInjected(
												p,
												chatFabIcon,
												chatTimelineByContext.get(reqCtx) || [],
												getFlowBuilderSeedForPage(p, parentByContext, flowBuilderStateByGroup)
											);
										} catch (_) {
										}
										try {
											const responseCtx = String(responsePage?.context || "");
											await ensureChatFabInjected(
												responsePage,
												chatFabIcon,
												chatTimelineByContext.get(responseCtx) || [],
												getFlowBuilderSeedForPage(responsePage, parentByContext, flowBuilderStateByGroup)
											);
											await setChatFabVisibility(responsePage, true);
											await openChatFabPanel(responsePage);
										} catch (_) {
										}
											let primaryRet = await pushFlowBuildResponse(p, response);
											let pushedPrimaryRetry = false;
											if (!primaryRet.ok) {
												await sleep(120);
												pushedPrimaryRetry = true;
												primaryRet = await pushFlowBuildResponse(p, response);
											}
											let pushedPrimary = !!primaryRet.ok;
											logEvent("debug", "flow_builder.push.primary", {
												id: rid,
												ok: !!pushedPrimary,
												retry: !!pushedPrimaryRetry,
												reason: String(primaryRet?.reason || ""),
												context: String(p?.context || ""),
											});
											let pushedAny = !!pushedPrimary;
											if (responsePage && responsePage !== p) {
												let mirrorRet = await pushFlowBuildResponse(responsePage, response);
												let pushedMirrorRetry = false;
												if (!mirrorRet.ok) {
													await sleep(120);
													pushedMirrorRetry = true;
													mirrorRet = await pushFlowBuildResponse(responsePage, response);
												}
												const pushedMirror = !!mirrorRet.ok;
												logEvent("debug", "flow_builder.push.mirror", {
													id: rid,
													ok: !!pushedMirror,
													retry: !!pushedMirrorRetry,
													reason: String(mirrorRet?.reason || ""),
													context: String(responsePage?.context || ""),
												});
												pushedAny = pushedAny || !!pushedMirror;
											}
											if (!pushedAny) {
												const allPages = Array.isArray(webRpa?.sessionPages) ? Array.from(webRpa.sessionPages) : [];
												for (const cand of allPages) {
													if (!cand || cand === p || cand === responsePage) continue;
													const fbRet = await pushFlowBuildResponse(cand, response);
													logEvent("debug", "flow_builder.push.fallback", {
														id: rid,
														ok: !!fbRet.ok,
														reason: String(fbRet?.reason || ""),
														context: String(cand?.context || ""),
													});
													if (fbRet.ok) {
														pushedAny = true;
														break;
													}
												}
											}
											if (!pushedAny) {
												console.warn("[selector-picker] flow builder response push failed(all):", rid);
											}
										})();
								runningChatTasks.add(flowTask);
								flowTask.finally(() => { runningChatTasks.delete(flowTask); });
							}
						}
				}

			let trigger = null;
			let activePage = null;
			try {
				const hit = await pollShortcutAcrossPages(webRpa, shortcut);
				trigger = hit.trigger;
				activePage = hit.page;
				if ((!trigger || !activePage) && enableChatFab) {
					const pages = Array.isArray(webRpa?.sessionPages) ? Array.from(webRpa.sessionPages) : [];
					for (const p of pages) {
						if (!p) continue;
						const pickReq = await popFabPickRequest(p);
						if (pickReq) {
							trigger = {
								url: String(pickReq.url || ""),
								title: String(pickReq.title || ""),
								source: String(pickReq.source || "fab_menu"),
							};
							activePage = p;
							break;
						}
					}
				}
			} catch (err) {
				if (!isTimeoutError(err)) {
					console.warn("[selector-picker] poll shortcut warning:", err?.message || err);
				}
				trigger = null;
				activePage = null;
			}
			if (!trigger || !activePage) {
				await sleep(180);
				continue;
			}
			if (webRpa.currentPage !== activePage) {
				webRpa.setCurrentPage(activePage);
			}
			const groupId = getGroupIdForPage(activePage, parentByContext);
			if (!groupId) {
				continue;
			}
			const st = getOrInitGroup(groupId);
			if (st.active) {
				console.log("[selector-picker] group busy, rejected:", JSON.stringify({
					groupId,
					activeContext: st.activeContext || "",
					currentContext: String(activePage?.context || ""),
					url: String(trigger?.url || ""),
				}));
				const now = Date.now();
				if (!st.lastBusyTipAt || (now - st.lastBusyTipAt > 1000)) {
					st.lastBusyTipAt = now;
					groupStates.set(groupId, st);
					try {
						await webRpa.inPageTip(
							activePage,
							"当前会话已有进行中的 Pick，请先完成后再发起新的 Pick。",
							{ timeout: 1500, stack: false }
						);
					} catch (_) {
					}
				}
				continue;
			}
			if (!acquireGroup(groupId, activePage.context)) {
				continue;
			}

			const task = (async () => {
				try {
			console.log("[selector-picker] triggered on:", trigger.url || "(unknown)", "source:", trigger.source || "shortcut");
					await webRpa.inPageTip(activePage, "请选择页面元素（Esc 取消）", { timeout: 1200, stack: false });
					const picked = await pickElementDetails(webRpa, activePage);
					if (!picked) {
						await webRpa.inPageTip(activePage, "已取消选择", { timeout: 1000, stack: false });
						return;
					}
					const mode = await askPickMode(webRpa, activePage);
					if (mode === "cancel") {
						await webRpa.inPageTip(activePage, "已放弃本次生成", { timeout: 1000, stack: false });
						return;
					}
					await generateSelectorFlow({
						webRpa,
						page: activePage,
						session: sessionStub,
						picked,
						mode,
					});
				} catch (err) {
					if (!isSessionGoneError(err)) {
						console.warn("[selector-picker] pick session warning:", err?.message || err);
					}
				} finally {
					try { await webRpa.inPageDismissSelector(activePage); } catch (_) {}
					releaseGroup(groupId, activePage.context);
				}
			})();
			runningPickTasks.add(task);
			task.finally(() => { runningPickTasks.delete(task); });
		}
		console.log("[selector-picker] browser closed, tool finished.");
	} finally {
		if (runningPickTasks.size > 0) {
			await Promise.allSettled(Array.from(runningPickTasks));
		}
		if (runningChatTasks.size > 0) {
			await Promise.allSettled(Array.from(runningChatTasks));
		}
		if (focusProbeTimer) {
			clearInterval(focusProbeTimer);
			focusProbeTimer = null;
		}
		if (browser) {
			for (const binding of eventBindings) {
				try {
					browser.off(binding.eventName, binding.handler);
				} catch (_) {
				}
			}
		}
			if (browser && !closed) {
				try {
					await webRpa.closeBrowser(browser);
				} catch (_) {
				}
			}
			try {
				await paLogger.info("runner.end", { closed });
				await paLogger.close();
			} catch (_) {
			}
		}
	}

main().catch((err) => {
	console.error("[selector-picker] ERROR:", err?.stack || err?.message || err);
	process.exit(1);
});
