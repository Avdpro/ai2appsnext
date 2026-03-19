import pathLib from "path";
import { fileURLToPath } from "url";
import WebRpa from "./WebDriveRpa.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);

function asText(v) {
	return String(v == null ? "" : v).trim();
}

function asPosInt(v, fallback, min = 1) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.floor(n));
}

function buildSessionId() {
	const t = Date.now().toString(36);
	const r = Math.random().toString(36).slice(2, 8);
	return `fbsm_${t}_${r}`;
}

function safeErr(err) {
	return asText(err?.message || err || "unknown error");
}

class FlowBuilderSessionManager {
	constructor(options = {}) {
		this.options = {
			maxSessions: asPosInt(options.maxSessions ?? process.env.FLOW_BUILDER_MAX_SESSIONS, 5, 1),
			idleTimeoutMs: asPosInt(options.idleTimeoutMs ?? process.env.FLOW_BUILDER_IDLE_TIMEOUT_MS, 30 * 60 * 1000, 30_000),
			cleanupIntervalMs: asPosInt(options.cleanupIntervalMs ?? process.env.FLOW_BUILDER_CLEANUP_INTERVAL_MS, 60 * 1000, 10_000),
			defaultAlias: asText(options.defaultAlias || process.env.FLOW_BUILDER_ALIAS || "flow_builder"),
			defaultLaunchMode: asText(options.defaultLaunchMode || process.env.WEBRPA_WEBDRIVE_MODE || "direct"),
			defaultStartUrl: asText(options.defaultStartUrl || "about:blank"),
			firefoxAppPath: asText(options.firefoxAppPath || process.env.WEBDRIVE_APP || ""),
		};
		this.sessions = new Map();
		this.cleanupTimer = setInterval(() => {
			this.cleanupExpiredSessions().catch(() => {});
		}, this.options.cleanupIntervalMs);
		if (this.cleanupTimer && typeof this.cleanupTimer.unref === "function") {
			this.cleanupTimer.unref();
		}
	}

	_touch(session) {
		if (!session) return;
		session.lastActiveAt = Date.now();
	}

	_toSummary(session) {
		return {
			id: session.id,
			alias: session.alias,
			status: session.status,
			launchMode: session.launchMode,
			startUrl: session.startUrl,
			createdAt: session.createdAt,
			lastActiveAt: session.lastActiveAt,
			activeContextId: asText(session.activeContextId || ""),
			error: asText(session.error || ""),
		};
	}

	_getOrThrow(sessionId) {
		const id = asText(sessionId);
		const session = this.sessions.get(id);
		if (!session) throw new Error("session not found");
		return session;
	}

	async startSession({ alias = "", launchMode = "", startUrl = "" } = {}) {
		const useAlias = asText(alias) || this.options.defaultAlias;
		const useLaunchMode = asText(launchMode) || this.options.defaultLaunchMode;
		const useStartUrl = asText(startUrl) || this.options.defaultStartUrl;

		// Default behavior: reuse an existing ready/starting session with the same alias.
		// This avoids creating duplicate builder sessions on refresh or repeated clicks.
		let reused = null;
		for (const s of this.sessions.values()) {
			if (asText(s.alias) !== useAlias) continue;
			if (s.status !== "ready" && s.status !== "starting") continue;
			if (!reused || Number(s.createdAt || 0) > Number(reused.createdAt || 0)) {
				reused = s;
			}
		}
		if (reused) {
			this._touch(reused);
			return { ...this._toSummary(reused), reused: true };
		}

		await this.cleanupExpiredSessions();
		if (this.sessions.size >= this.options.maxSessions) {
			throw new Error(`too many sessions (max=${this.options.maxSessions})`);
		}
		const sid = buildSessionId();

		const session = {
			id: sid,
			alias: useAlias,
			launchMode: useLaunchMode,
			startUrl: useStartUrl,
			status: "starting",
			error: "",
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
			activeContextId: "",
			webRpa: null,
			browser: null,
		};
		this.sessions.set(sid, session);

		try {
			const sessionStub = { agentNode: null, options: { webDriveMode: useLaunchMode } };
			const webRpa = new WebRpa(sessionStub, {
				webDriveMode: useLaunchMode,
				includeAllNewTabs: true,
			});
			session.webRpa = webRpa;
			const browser = await webRpa.openBrowser(useAlias, {
				launchMode: useLaunchMode,
				pathToFireFox: this.options.firefoxAppPath || undefined,
			});
			session.browser = browser;
			const page = await webRpa.openPage(browser);
			if (useStartUrl) {
				try {
					await page.goto(useStartUrl);
				} catch (_) {
				}
			}
			webRpa.setCurrentPage(page);
			session.webRpa = webRpa;
			session.browser = browser;
			session.activeContextId = asText(page?.context || "");
			session.status = "ready";
			this._touch(session);
			return { ...this._toSummary(session), reused: false };
		} catch (err) {
			session.status = "error";
			session.error = safeErr(err);
			try {
				if (session.webRpa && session.browser) {
					await session.webRpa.closeBrowser(session.browser);
				}
			} catch (_) {
			}
			this.sessions.delete(session.id);
			throw err;
		}
	}

	getSession(sessionId) {
		const session = this._getOrThrow(sessionId);
		this._touch(session);
		return this._toSummary(session);
	}

	getSessionRuntime(sessionId) {
		const session = this._getOrThrow(sessionId);
		this._touch(session);
		return session;
	}

	listSessions() {
		const out = [];
		for (const session of this.sessions.values()) out.push(this._toSummary(session));
		out.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
		return out;
	}

	async closeSession(sessionId) {
		const session = this._getOrThrow(sessionId);
		session.status = "closed";
		this._touch(session);
		const webRpa = session.webRpa;
		const browser = session.browser;
		try {
			if (webRpa && browser) {
				await webRpa.closeBrowser(browser);
			}
		} catch (_) {
		}
		this.sessions.delete(session.id);
		return { ok: true, id: session.id };
	}

	async listContexts(sessionId) {
		const session = this._getOrThrow(sessionId);
		if (session.status !== "ready" || !session.webRpa) {
			throw new Error(`session is not ready (status=${session.status})`);
		}
		const webRpa = session.webRpa;
		const pages = Array.isArray(webRpa.sessionPages) ? Array.from(webRpa.sessionPages) : [];
		const activeByPage = asText(webRpa.currentPage?.context || "");
		const contexts = [];
		for (const page of pages) {
			const contextId = asText(page?.context || "");
			if (!contextId) continue;
			let url = "";
			let title = "";
			try { url = asText(await page.url()); } catch (_) {}
			try { title = asText(await page.title()); } catch (_) {}
			contexts.push({
				contextId,
				url,
				title,
				active: contextId === activeByPage,
			});
		}
		session.activeContextId = activeByPage || asText(session.activeContextId);
		this._touch(session);
		return {
			activeContextId: session.activeContextId,
			contexts,
		};
	}

	selectContext(sessionId, contextId) {
		const session = this._getOrThrow(sessionId);
		if (session.status !== "ready" || !session.webRpa) {
			throw new Error(`session is not ready (status=${session.status})`);
		}
		const ctx = asText(contextId);
		if (!ctx) throw new Error("contextId is required");
		const webRpa = session.webRpa;
		const page = webRpa.getPageByContextId(ctx);
		if (!page) throw new Error("context not found");
		webRpa.setCurrentPage(page);
		session.activeContextId = ctx;
		this._touch(session);
		return {
			activeContextId: session.activeContextId,
			ok: true,
		};
	}

	async openPage(sessionId, { url = "", setActive = true } = {}) {
		const session = this._getOrThrow(sessionId);
		if (session.status !== "ready" || !session.webRpa || !session.browser) {
			throw new Error(`session is not ready (status=${session.status})`);
		}
		const webRpa = session.webRpa;
		const page = await webRpa.openPage(session.browser);
		const targetUrl = asText(url) || "about:blank";
		try {
			await page.goto(targetUrl);
		} catch (_) {
		}
		if (setActive !== false) {
			webRpa.setCurrentPage(page);
			session.activeContextId = asText(page?.context || "");
		}
		this._touch(session);
		let title = "";
		try { title = asText(await page.title()); } catch (_) {}
		return {
			contextId: asText(page?.context || ""),
			url: targetUrl,
			title,
			activeContextId: asText(session.activeContextId || ""),
		};
	}

	async cleanupExpiredSessions() {
		const now = Date.now();
		const stale = [];
		for (const session of this.sessions.values()) {
			if (now - Number(session.lastActiveAt || 0) > this.options.idleTimeoutMs) {
				stale.push(session.id);
			}
		}
		for (const id of stale) {
			try {
				await this.closeSession(id);
			} catch (_) {
				this.sessions.delete(id);
			}
		}
		return { closed: stale.length };
	}

	async closeAll() {
		const ids = Array.from(this.sessions.keys());
		for (const id of ids) {
			try {
				await this.closeSession(id);
			} catch (_) {
				this.sessions.delete(id);
			}
		}
		return { ok: true, count: ids.length };
	}

	dispose() {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}
}

let singleton = null;
function getFlowBuilderSessionManager(options = null) {
	if (!singleton) {
		singleton = new FlowBuilderSessionManager(options || {});
	}
	return singleton;
}

export {
	FlowBuilderSessionManager,
	getFlowBuilderSessionManager,
};
