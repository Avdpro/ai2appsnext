import {
	ensureFlowRegistry,
	resolveFlowEntryById,
	resolveFlowEntriesById,
	resolveFlowEntriesForFind,
} from "./FlowRegistry.mjs";
import pathLib from "path";
import { fileURLToPath } from "url";
import { promises as fsp } from "fs";
import { findBestFlowEntry } from "./FlowFinder.mjs";
import { runFlow } from "./FlowRunner.mjs";
import { parseFlowVal } from "./FlowExpr.mjs";
import { normalizePolicy, getReadOrder, policyUsesCloud } from "./SourcePolicy.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);

function asText(v) {
	return String(v == null ? "" : v).trim();
}

function toObject(v, fallback = {}) {
	if (v && typeof v === "object" && !Array.isArray(v)) return v;
	return fallback;
}

function safeStringifyForLog(value, maxChars = 1200) {
	const seen = new WeakSet();
	let text = "";
	try {
		text = JSON.stringify(value, (k, v) => {
			if (typeof v === "function") return "[Function]";
			if (typeof v === "object" && v) {
				if (seen.has(v)) return "[Circular]";
				seen.add(v);
			}
			return v;
		});
	} catch (_) {
		try { text = String(value); } catch (_) { text = "[Unserializable]"; }
	}
	const s = asText(text);
	if (!s) return "";
	if (s.length <= maxChars) return s;
	return `${s.slice(0, Math.max(0, maxChars - 12))}...(truncated)`;
}

function toFlowRuntimeId(flowId, ownerUserId) {
	const base = asText(flowId || "");
	if (!base) return "";
	const owner = asText(ownerUserId || "system") || "system";
	// Cloud flow uses runtime namespaced id to avoid query-cache collisions across different owners.
	return `${base}@${owner}`;
}

function normIdToken(v) {
	return String(v || "").trim().replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

function toInt(v, fallback = 0) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.floor(n);
}

function cloudCacheEnabled() {
	const v = asText(process.env.FLOW_CLOUD_CACHE_ENABLE || "true").toLowerCase();
	return !["0", "false", "off", "no"].includes(v);
}

function cloudCacheTtlMs() {
	const n = Number(process.env.FLOW_CLOUD_CACHE_TTL_MS || "");
	if (Number.isFinite(n) && n > 0) return Math.floor(n);
	return 24 * 60 * 60 * 1000;
}

function getCloudCacheDir() {
	const envDir = asText(process.env.FLOW_CLOUD_CACHE_DIR || "");
	if (envDir) return pathLib.isAbsolute(envDir) ? envDir : pathLib.resolve(process.cwd(), envDir);
	return pathLib.join(__dirname, "flows", "cache");
}

function buildCloudCacheFileName(ownerUserId, flowId) {
	return `cloud_${normIdToken(ownerUserId || "system")}__${normIdToken(flowId || "flow")}.json`;
}

function normalizeCloudFlowSummary(rawSummary, fallbackSourceMode = "") {
	const summary = toObject(rawSummary, {});
	const content = toObject(summary.content, null);
	const flowId = asText(summary.flowId || content?.id || "");
	if (!flowId || !content || !asText(content.id)) return null;
	return {
		userId: asText(summary.userId || "system") || "system",
		flowId,
		version: toInt(summary.version, 0),
		kind: asText(summary.kind || "rpa") || "rpa",
		capabilities: Array.isArray(summary.capabilities) ? summary.capabilities.map((x) => asText(x)).filter(Boolean) : [],
		filters: Array.isArray(summary.filters) ? summary.filters : [],
		ranks: toObject(summary.ranks, {}) || {},
		content,
		...(fallbackSourceMode ? { sourceMode: fallbackSourceMode } : null),
	};
}

async function writeCloudFlowCache(summary, { logger = null, sourceMode = "" } = {}) {
	if (!cloudCacheEnabled()) return;
	const normalized = normalizeCloudFlowSummary(summary, sourceMode);
	if (!normalized) return;
	const dir = getCloudCacheDir();
	const now = Date.now();
	const ttlMs = cloudCacheTtlMs();
	const fileName = buildCloudCacheFileName(normalized.userId, normalized.flowId);
	const full = pathLib.join(dir, fileName);
	const data = {
		schema: "flow_cloud_cache_v1",
		cachedAt: new Date(now).toISOString(),
		expiresAt: new Date(now + ttlMs).toISOString(),
		ttlMs,
		summary: normalized,
	};
	try {
		await fsp.mkdir(dir, { recursive: true });
		await fsp.writeFile(full, JSON.stringify(data, null, 2), "utf8");
		await logger?.debug("invoke.cloud.cache.write", {
			file: full,
			userId: normalized.userId,
			flowId: normalized.flowId,
			version: normalized.version,
			ttlMs,
		});
	} catch (e) {
		await logger?.warn("invoke.cloud.cache.write_failed", {
			file: full,
			reason: asText(e?.message || e),
		});
	}
}

async function loadCloudFlowCacheEntries({ logger = null } = {}) {
	if (!cloudCacheEnabled()) return [];
	const dir = getCloudCacheDir();
	let files = [];
	try {
		files = await fsp.readdir(dir, { withFileTypes: true });
	} catch (_) {
		return [];
	}
	const out = [];
	const now = Date.now();
	for (const item of files) {
		if (!item?.isFile?.()) continue;
		if (!/\.json$/i.test(String(item.name || ""))) continue;
		const full = pathLib.join(dir, item.name);
		try {
			const text = await fsp.readFile(full, "utf8");
			const data = JSON.parse(String(text || "{}"));
			const summary = normalizeCloudFlowSummary(data?.summary || null, "cache");
			if (!summary) continue;
			const expiresAt = new Date(asText(data?.expiresAt || ""));
			if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now) continue;
			const entry = buildEntryFromCloudFlow(summary, `remote:cache:${summary.userId}:${summary.flowId}`);
			if (!entry) continue;
			entry.raw = {
				...entry.raw,
				cacheMeta: {
					file: full,
					cachedAt: asText(data?.cachedAt || ""),
					expiresAt: asText(data?.expiresAt || ""),
					ttlMs: toInt(data?.ttlMs, 0),
				},
			};
			out.push(entry);
		} catch (e) {
			await logger?.warn("invoke.cloud.cache.read_failed", {
				file: full,
				reason: asText(e?.message || e),
			});
		}
	}
	return out;
}

function normalizeRiskLevelNum(raw, fallback = 1) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(1, Math.min(5, Math.floor(n)));
}

function getEntryRiskMeta(entry) {
	const rawRisk = toObject(entry?.raw?.risk, null) || toObject(entry?.flow?.risk, null);
	if (!rawRisk) return { level: 1, desc: "", source: "" };
	return {
		level: normalizeRiskLevelNum(rawRisk.level, 1),
		desc: asText(rawRisk.desc || rawRisk.description || ""),
		source: asText(rawRisk.source || ""),
	};
}

function resolveRiskControl(opts = {}) {
	const rc = toObject(opts?.riskControl, {});
	const hasRcInput = opts && typeof opts === "object" && opts.riskControl && typeof opts.riskControl === "object";
	const enabled = (rc.enabled === true) || (hasRcInput && rc.enabled !== false);
	const mode = ["off", "warn", "ask", "block"].includes(asText(rc.mode).toLowerCase())
		? asText(rc.mode).toLowerCase()
		: "warn";
	const askAboveLevel = normalizeRiskLevelNum(
		rc.askAboveLevel ?? rc.askLevel ?? process.env.FLOW_RISK_ASK_ABOVE_LEVEL ?? 2,
		2
	);
	const blockAboveLevel = normalizeRiskLevelNum(
		rc.blockAboveLevel ?? rc.maxAllowedLevel ?? process.env.FLOW_RISK_BLOCK_ABOVE_LEVEL ?? 5,
		5
	);
	const onAskUnavailable = ["block", "warn", "allow"].includes(asText(rc.onAskUnavailable).toLowerCase())
		? asText(rc.onAskUnavailable).toLowerCase()
		: "block";
	return {
		enabled,
		mode,
		askAboveLevel,
		blockAboveLevel: Math.max(askAboveLevel, blockAboveLevel),
		onAskUnavailable,
	};
}

function getRiskApprovalCacheFile() {
	return pathLib.join(getCloudCacheDir(), "risk-approvals.json");
}

function buildRiskApprovalKey(entry) {
	const owner = asText(entry?.raw?.ownerUserId || entry?.raw?.userId || "system") || "system";
	const flowId = asText(entry?.raw?.sourceFlowId || entry?.raw?.flowId || entry?.id || "");
	const digest = asText(entry?.raw?.digest || entry?.flow?.digest || "");
	return `${owner}::${flowId}::${digest || "-"}`;
}

async function readRiskApprovals({ logger = null } = {}) {
	const file = getRiskApprovalCacheFile();
	try {
		const text = await fsp.readFile(file, "utf8");
		const obj = JSON.parse(String(text || "{}"));
		const records = Array.isArray(obj?.records) ? obj.records : [];
		return records;
	} catch (_) {
		await logger?.debug("invoke.risk.approval.read_empty", { file });
		return [];
	}
}

async function writeRiskApprovals(records, { logger = null } = {}) {
	const file = getRiskApprovalCacheFile();
	try {
		await fsp.mkdir(pathLib.dirname(file), { recursive: true });
		await fsp.writeFile(
			file,
			JSON.stringify({
				schema: "risk_approval_v1",
				updatedAt: new Date().toISOString(),
				records: Array.isArray(records) ? records : [],
			}, null, 2),
			"utf8"
		);
	} catch (e) {
		await logger?.warn("invoke.risk.approval.write_failed", { file, reason: asText(e?.message || e) });
	}
}

async function hasPersistentRiskApproval(entry, { logger = null } = {}) {
	const key = buildRiskApprovalKey(entry);
	const now = Date.now();
	const records = await readRiskApprovals({ logger });
	const hit = records.find((r) => asText(r?.key) === key && (!asText(r?.expiresAt) || new Date(r.expiresAt).getTime() > now));
	return !!hit;
}

async function savePersistentRiskApproval(entry, scope = "24h", { logger = null } = {}) {
	const key = buildRiskApprovalKey(entry);
	const records = await readRiskApprovals({ logger });
	const now = Date.now();
	const keep = records.filter((r) => {
		if (asText(r?.key) === key) return false;
		const exp = asText(r?.expiresAt);
		if (!exp) return true;
		const ts = new Date(exp).getTime();
		return Number.isFinite(ts) && ts > now;
	});
	keep.push({
		key,
		scope,
		createdAt: new Date(now).toISOString(),
		expiresAt: scope === "always" ? "" : new Date(now + 24 * 60 * 60 * 1000).toISOString(),
		ownerUserId: asText(entry?.raw?.ownerUserId || entry?.raw?.userId || "system"),
		flowId: asText(entry?.raw?.sourceFlowId || entry?.raw?.flowId || entry?.id || ""),
		digest: asText(entry?.raw?.digest || ""),
	});
	await writeRiskApprovals(keep, { logger });
}

function getRunCtx(opts) {
	if (!opts || typeof opts !== "object") return null;
	if (!opts.__flowRunCtx || typeof opts.__flowRunCtx !== "object") opts.__flowRunCtx = {};
	return opts.__flowRunCtx;
}

function hasOneShotRiskApproval(entry, opts = {}) {
	const ctx = getRunCtx(opts);
	if (!ctx) return false;
	if (!(ctx.riskApprovalOnce instanceof Set)) ctx.riskApprovalOnce = new Set();
	return ctx.riskApprovalOnce.has(buildRiskApprovalKey(entry));
}

function setOneShotRiskApproval(entry, opts = {}) {
	const ctx = getRunCtx(opts);
	if (!ctx) return;
	if (!(ctx.riskApprovalOnce instanceof Set)) ctx.riskApprovalOnce = new Set();
	ctx.riskApprovalOnce.add(buildRiskApprovalKey(entry));
}

function parseRiskPromptChoice(ret) {
	if (Array.isArray(ret)) {
		for (const item of ret) {
			if (item && typeof item === "object" && asText(item.code)) return asText(item.code);
			if (typeof item === "string" && asText(item)) return asText(item);
		}
	}
	return asText(ret);
}

async function askRiskApprovalFromPage({ webRpa, page, entry, riskMeta, logger = null }) {
	if (!webRpa || typeof webRpa.inPagePrompt !== "function" || !page) return { ok: false, reason: "ask unavailable: no active session/page" };
	const sourceFlowId = asText(entry?.raw?.sourceFlowId || entry?.raw?.flowId || entry?.id || "");
	const ownerUserId = asText(entry?.raw?.ownerUserId || entry?.raw?.userId || "system");
	const riskDesc = asText(riskMeta?.desc || "无额外描述");
	const prompt = [
		`该 Flow 风险等级为 ${normalizeRiskLevelNum(riskMeta?.level, 1)}（1~5 越高越危险）。`,
		`Flow: ${sourceFlowId}（owner=${ownerUserId}）`,
		`风险说明: ${riskDesc}`,
		"",
		"请选择是否继续执行：",
	].join("\n");
	const ret = await webRpa.inPagePrompt(page, prompt, {
		modal: true,
		mask: "rgba(0,0,0,0.28)",
		showCancel: false,
		menu: [
			{ text: "单次批准", code: "once" },
			{ text: "24小时自动批准", code: "24h" },
			{ text: "永久自动批准", code: "always" },
			{ text: "拒绝执行", code: "deny" },
		],
		multiSelect: false,
		allowEmpty: false,
		okText: "确认",
	});
	const choice = parseRiskPromptChoice(ret).toLowerCase();
	await logger?.info("invoke.risk.ask.result", { choice, flowId: sourceFlowId, ownerUserId, level: normalizeRiskLevelNum(riskMeta?.level, 1) });
	if (["once", "24h", "always"].includes(choice)) return { ok: true, choice };
	return { ok: false, reason: "user denied risk approval" };
}

function buildDefaultWsUrl(apiPath = "/ws/") {
	const port = Number(process.env.PORT || 3301) || 3301;
	const path = asText(apiPath || "/ws/");
	const usePath = path.startsWith("/") ? path : `/${path}`;
	return `http://127.0.0.1:${port}${usePath}`;
}

function normalizeWsUrl(rawWsUrl = "", rawApiPath = "") {
	const wsUrl = asText(rawWsUrl);
	if (wsUrl) {
		if (/^https?:\/\//i.test(wsUrl)) return wsUrl;
		if (wsUrl.startsWith("/")) return buildDefaultWsUrl(wsUrl);
	}
	const apiPath = asText(rawApiPath || "");
	if (apiPath) {
		if (/^https?:\/\//i.test(apiPath)) return apiPath;
		if (apiPath.startsWith("/")) return buildDefaultWsUrl(apiPath);
	}
	const envWs = asText(process.env.FLOW_WS_URL || process.env.FLOW_MANAGE_WS_URL || "");
	if (envWs) return envWs;
	return buildDefaultWsUrl("/ws/");
}

function extractSystemAuth(opts = {}) {
	const root = toObject(opts.systemAuth, {});
	const loginVO = toObject(root.loginVO, {});
	const userId = asText(root.userId || root.userid || loginVO.userId || loginVO.userid || opts.userId || opts.userid || process.env.FLOW_CLOUD_USER_ID || "");
	const token = asText(root.token || loginVO.token || opts.token || process.env.FLOW_CLOUD_TOKEN || "");
	const apiPath = asText(root.apiPath || loginVO.apiPath || process.env.FLOW_CLOUD_API_PATH || "/ws/");
	const wsUrl = normalizeWsUrl(root.wsUrl || opts.wsUrl || "", apiPath);
	return {
		userId,
		token,
		apiPath,
		wsUrl,
		authVersion: Number(root.authVersion || 0) || 0,
	};
}

async function callWsJson({ wsUrl, msg, vo, timeoutMs = 20000 }) {
	const ctrl = new AbortController();
	const to = Math.max(1000, Number(timeoutMs || 20000));
	const timer = setTimeout(() => {
		try { ctrl.abort(); } catch (_) {}
	}, to);
	try {
		const resp = await fetch(wsUrl, {
			method: "POST",
			cache: "no-cache",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ msg, vo }),
			signal: ctrl.signal,
		});
		const text = await resp.text();
		let data = {};
		try { data = JSON.parse(text || "{}"); } catch (_) { data = { code: resp.status, info: text || "invalid json response" }; }
		if (!Object.prototype.hasOwnProperty.call(data, "code")) data.code = resp.status;
		return data;
	} finally {
		clearTimeout(timer);
	}
}

function buildEntryFromCloudFlow(cloudFlowSummary, fallbackSource = "") {
	const summary = toObject(cloudFlowSummary, {});
	const content = toObject(summary.content, null);
	if (!content || !asText(content.id)) return null;
	const ownerUserId = asText(summary.userId || "system") || "system";
	const sourceFlowId = asText(summary.flowId || content.id);
	const flowId = toFlowRuntimeId(sourceFlowId, ownerUserId);
	const source = asText(fallbackSource || `remote:api:${ownerUserId}:${sourceFlowId}`);
	const flow = { ...content, id: flowId };
	return {
		id: flowId,
		entryId: `remote#${ownerUserId}#${sourceFlowId}#v${Number(summary.version || 0)}`,
		flow,
		source,
		sourceRef: source,
		kind: asText(summary.kind || "rpa"),
		capKeys: Array.isArray(summary.capabilities) ? summary.capabilities.map((x) => asText(x)).filter(Boolean) : [],
		capSet: new Set(Array.isArray(summary.capabilities) ? summary.capabilities.map((x) => asText(x)).filter(Boolean) : []),
		filters: Array.isArray(summary.filters) ? summary.filters : [],
		ranks: toObject(summary.ranks, {}),
		raw: {
			...summary,
			runtimeFlowId: flowId,
			sourceFlowId,
			ownerUserId,
		},
	};
}

async function findFlowByCloudApi({ actionFind, opts, logger = null }) {
	const auth = extractSystemAuth(opts || {});
	const wsUrl = auth.wsUrl;
	const useFind = toObject(actionFind, {});
	const authScope = asText(opts?.flowFindScope || "all") || "all";
	const authOwnershipPolicy = asText(opts?.flowFindOwnershipPolicy || "preferMine") || "preferMine";
	const baseVO = {
		find: useFind,
		topK: 1,
		download: true,
	};
	const canTryAuth = !!(auth.userId && auth.token);
	let authRet = null;
	if (canTryAuth) {
		try {
			authRet = await callWsJson({
				wsUrl,
				msg: "findFlow",
				vo: {
					...baseVO,
					userId: auth.userId,
					token: auth.token,
					scope: authScope,
					ownershipPolicy: authOwnershipPolicy,
				},
			});
		} catch (e) {
			authRet = { code: 0, info: asText(e?.message || e || "cloud findFlow fetch failed") };
		}
		if (Number(authRet?.code || 0) === 200 && authRet?.best?.flow?.content) {
			await writeCloudFlowCache(authRet?.best?.flow, { logger, sourceMode: "findFlow" });
			return {
				ok: true,
				entry: buildEntryFromCloudFlow(authRet.best.flow, `remote:ws:findFlow:${asText(authRet.best.flow?.userId || "")}:${asText(authRet.best.flow?.flowId || "")}`),
				mode: "auth",
				response: authRet,
				auth,
			};
		}
		// findFlow 已覆盖 published 池时，不再重复 findPublishedFlow。
		// 覆盖条件：scope=published，或 scope=all 且 ownershipPolicy 不是 mineonly。
		const authCoveredPublished = authScope === "published" || (authScope === "all" && authOwnershipPolicy !== "mineonly");
		if (Number(authRet?.code || 0) === 200 && authCoveredPublished) {
			await logger?.warn("invoke.cloud.find.no_match", {
				wsUrl,
				mode: "auth-only-covered-published",
				authCode: Number(authRet?.code || 0),
				authInfo: asText(authRet?.info || authRet?.reason || ""),
				pubCode: -1,
				pubInfo: "skipped: findFlow already covered published scope",
				authVersion: Number(auth.authVersion || 0),
			});
			return {
				ok: false,
				reason: asText(authRet?.info || "cloud findFlow no match"),
				auth,
			};
		}
	}
	let pubRet = null;
	try {
		pubRet = await callWsJson({
			wsUrl,
			msg: "findPublishedFlow",
			vo: {
				...baseVO,
				...(canTryAuth ? { userId: auth.userId, token: auth.token } : {}),
			},
		});
	} catch (e) {
		pubRet = { code: 0, info: asText(e?.message || e || "cloud findPublishedFlow fetch failed") };
	}
	if (Number(pubRet?.code || 0) === 200 && pubRet?.best?.flow?.content) {
		await writeCloudFlowCache(pubRet?.best?.flow, { logger, sourceMode: "findPublishedFlow" });
		return {
			ok: true,
			entry: buildEntryFromCloudFlow(pubRet.best.flow, `remote:ws:findPublishedFlow:${asText(pubRet.best.flow?.userId || "system")}:${asText(pubRet.best.flow?.flowId || "")}`),
			mode: "published",
			response: pubRet,
			auth,
		};
	}
	await logger?.warn("invoke.cloud.find.no_match", {
		wsUrl,
		mode: canTryAuth ? "auth+published" : "published-only",
		authCode: Number(authRet?.code || 0),
		authInfo: asText(authRet?.info || authRet?.reason || ""),
		pubCode: Number(pubRet?.code || 0),
		pubInfo: asText(pubRet?.info || pubRet?.reason || ""),
		authVersion: Number(auth.authVersion || 0),
	});
	return {
		ok: false,
		reason: asText(pubRet?.info || authRet?.info || "cloud findFlow no match"),
		auth,
	};
}

async function resolveTargetByCloudApi({ targetId, opts, logger = null }) {
	const flowId = asText(targetId);
	if (!flowId) return { ok: false, reason: "empty target id", auth: extractSystemAuth(opts || {}) };
	const auth = extractSystemAuth(opts || {});
	const wsUrl = auth.wsUrl;
	const canTryAuth = !!(auth.userId && auth.token);
	let mineRet = null;
	if (canTryAuth) {
		try {
			mineRet = await callWsJson({
				wsUrl,
				msg: "getMyFlow",
				vo: { userId: auth.userId, token: auth.token, flowId },
			});
		} catch (e) {
			mineRet = { code: 0, info: asText(e?.message || e || "cloud getMyFlow fetch failed") };
		}
		if (Number(mineRet?.code || 0) === 200 && mineRet?.flow?.content) {
			await writeCloudFlowCache(mineRet?.flow, { logger, sourceMode: "getMyFlow" });
			return {
				ok: true,
				entry: buildEntryFromCloudFlow(mineRet.flow, `remote:ws:getMyFlow:${asText(mineRet.flow?.userId || auth.userId)}:${flowId}`),
				mode: "mine",
				response: mineRet,
				auth,
			};
		}
	}
	let pubRet = null;
	try {
		pubRet = await callWsJson({
			wsUrl,
			msg: "getPublishedFlow",
			vo: {
				flowId,
				...(canTryAuth ? { userId: auth.userId, token: auth.token } : {}),
			},
		});
	} catch (e) {
		pubRet = { code: 0, info: asText(e?.message || e || "cloud getPublishedFlow fetch failed") };
	}
	if (Number(pubRet?.code || 0) === 200 && pubRet?.flow?.content) {
		await writeCloudFlowCache(pubRet?.flow, { logger, sourceMode: "getPublishedFlow" });
		return {
			ok: true,
			entry: buildEntryFromCloudFlow(pubRet.flow, `remote:ws:getPublishedFlow:${asText(pubRet.flow?.userId || "system")}:${flowId}`),
			mode: "published",
			response: pubRet,
			auth,
		};
	}
	await logger?.warn("invoke.cloud.target.no_match", {
		targetId: flowId,
		wsUrl,
		mode: canTryAuth ? "mine+published" : "published-only",
		mineCode: Number(mineRet?.code || 0),
		mineInfo: asText(mineRet?.info || mineRet?.reason || ""),
		pubCode: Number(pubRet?.code || 0),
		pubInfo: asText(pubRet?.info || pubRet?.reason || ""),
		authVersion: Number(auth.authVersion || 0),
	});
	return {
		ok: false,
		reason: asText(pubRet?.info || mineRet?.info || `target flow not found: ${flowId}`),
		auth,
	};
}

function isPlainObject(v) {
	if (!v || typeof v !== "object") return false;
	const p = Object.getPrototypeOf(v);
	return p === Object.prototype || p === null;
}

function expandDottedKeys(obj, sep = ".") {
	if (!isPlainObject(obj)) return obj;
	const out = {};
	for (const [rawK, rawV] of Object.entries(obj)) {
		const k = String(rawK || "");
		if (!k.includes(sep)) {
			out[k] = rawV;
			continue;
		}
		const parts = k.split(sep).filter(Boolean);
		if (!parts.length) continue;
		let cur = out;
		for (let i = 0; i < parts.length; i++) {
			const p = parts[i];
			if (i === parts.length - 1) {
				cur[p] = rawV;
				break;
			}
			if (!isPlainObject(cur[p])) cur[p] = {};
			cur = cur[p];
		}
	}
	return out;
}

function extractFindDomainValues(findSpec) {
	const f = toObject(findSpec, {});
	const list = Array.isArray(f.filter) ? f.filter : [];
	return list
		.filter((one) => String(one?.key || "").trim().toLowerCase() === "domain")
		.map((one) => asText(one?.value))
		.filter(Boolean);
}

function extractEntryDomainValues(entry) {
	const list = Array.isArray(entry?.filters) ? entry.filters : [];
	return list
		.filter((one) => String(one?.key || "").trim().toLowerCase() === "domain")
		.map((one) => asText(one?.value))
		.filter(Boolean);
}

function summarizeFindCandidates(candidates, maxN = 6) {
	const arr = Array.isArray(candidates) ? candidates : [];
	return arr.slice(0, Math.max(1, Number(maxN || 6))).map((one) => ({
		flowId: asText(one?.entry?.id || ""),
		entryId: asText(one?.entry?.entryId || ""),
		domainLevel: asText(one?.domainLevel || ""),
		domainScore: Number(one?.domainScore || 0),
		preferHits: Number(one?.preferHits || 0),
		filterScore: Number(one?.filterScore || 0),
		domains: extractEntryDomainValues(one?.entry || null),
	}));
}

async function invokeFlowAction({ action, args, opts, vars, lastResult, session = null, webRpa, page, logger = null, callerFlowId = "" }) {
	// Always refresh local registry so recently edited flow files are visible
	// to invoke/find immediately (without requiring app restart).
	await ensureFlowRegistry({ force: true, logger });

	const onError = action?.onError === "return" ? "return" : "fail";
	const returnTo = action?.returnTo === "keep" ? "keep" : "caller";
	const timeoutMs = Number(action?.timeoutMs || 0);
	const sourcePolicyRaw = parseFlowVal(
		action?.sourcePolicy ?? opts?.flowSourcePolicy ?? process.env.FLOW_SOURCE_POLICY ?? "",
		args,
		opts,
		vars,
		lastResult
	);
	const sourcePolicy = normalizePolicy(sourcePolicyRaw, "prefer_local");

	let targetEntry = null;
	if (action?.target) {
		const targetRaw = String(action.target || "").trim();
		const policyOrder = getReadOrder(sourcePolicy, "prefer_local");
		let targetReason = "";
		for (const source of policyOrder) {
			if (source === "cloud" && policyUsesCloud(sourcePolicy, "prefer_local")) {
				const cloudRet = await resolveTargetByCloudApi({ targetId: targetRaw, opts, logger });
				if (cloudRet?.ok && cloudRet.entry) {
					targetEntry = cloudRet.entry;
					await logger?.info("invoke.target.cloud.hit", {
						target: targetRaw,
						mode: asText(cloudRet.mode || "unknown"),
						entryId: asText(targetEntry?.entryId || ""),
						sourcePolicy,
						authVersion: Number(cloudRet?.auth?.authVersion || 0),
					});
					break;
				}
				targetReason = asText(cloudRet?.reason || targetReason || "cloud target resolve failed");
				await logger?.warn("invoke.target.cloud.miss", {
					target: targetRaw,
					sourcePolicy,
					reason: targetReason,
					authVersion: Number(cloudRet?.auth?.authVersion || 0),
				});
			}
			if (source === "local") {
				const dupCandidates = await resolveFlowEntriesById(targetRaw, { sourcePolicy: "local", logger });
				const localEntry = await resolveFlowEntryById(targetRaw, { sourcePolicy: "local", logger });
				if (dupCandidates.length > 1 && localEntry) {
					await logger?.warn("invoke.target.duplicate_id", {
						target: targetRaw,
						chosenEntryId: localEntry.entryId || "",
						chosenSource: localEntry.source || "",
						candidateCount: dupCandidates.length,
						candidates: dupCandidates.slice(0, 8).map((e) => ({
							entryId: e.entryId || "",
							source: e.source || "",
						})),
					});
				}
				if (localEntry) {
					targetEntry = localEntry;
					break;
				}
				targetReason = asText(targetReason || `invoke target flow not found: ${action.target} (sourcePolicy=${sourcePolicy})`);
			}
		}
		if (!targetEntry) {
			const reason = targetReason || `invoke target flow not found: ${action.target} (sourcePolicy=${sourcePolicy})`;
			if (onError === "return") return { status: "done", value: { ok: false, reason } };
			return { status: "failed", reason };
		}
	} else {
		const policyOrder = getReadOrder(sourcePolicy, "prefer_local");
		let findReason = "";
		for (const source of policyOrder) {
			if (source === "cloud" && policyUsesCloud(sourcePolicy, "prefer_local")) {
				const cachedCloudEntries = await loadCloudFlowCacheEntries({ logger });
				if (cachedCloudEntries.length) {
					const foundFromCache = findBestFlowEntry(
						cachedCloudEntries.filter((e) => String(e?.id || "") !== String(callerFlowId || "")),
						action?.find || null
					);
					if (foundFromCache?.ok && foundFromCache.entry) {
						targetEntry = foundFromCache.entry;
						await logger?.info("invoke.find.cloud.cache_hit", {
							sourcePolicy,
							flowId: asText(targetEntry?.id || ""),
							entryId: asText(targetEntry?.entryId || ""),
							cacheFile: asText(targetEntry?.raw?.cacheMeta?.file || ""),
							expiresAt: asText(targetEntry?.raw?.cacheMeta?.expiresAt || ""),
							findDomains: extractFindDomainValues(action?.find || null),
							matchedDomains: extractEntryDomainValues(targetEntry),
							candidateTop: summarizeFindCandidates(foundFromCache?.candidates, 5),
						});
						break;
					}
					await logger?.debug("invoke.find.cloud.cache_miss", {
						sourcePolicy,
						cacheEntries: cachedCloudEntries.length,
					});
				}
				const cloudRet = await findFlowByCloudApi({
					actionFind: action?.find || null,
					opts,
					logger,
				});
				if (cloudRet?.ok && cloudRet.entry) {
					targetEntry = cloudRet.entry;
					await logger?.info("invoke.find.cloud.hit", {
						sourcePolicy,
						mode: asText(cloudRet.mode || "unknown"),
						flowId: asText(targetEntry?.id || ""),
						entryId: asText(targetEntry?.entryId || ""),
						authVersion: Number(cloudRet?.auth?.authVersion || 0),
						findDomains: extractFindDomainValues(action?.find || null),
						matchedDomains: extractEntryDomainValues(targetEntry),
					});
					break;
				}
				findReason = asText(cloudRet?.reason || findReason || "cloud find failed");
				await logger?.warn("invoke.find.cloud.miss", {
					sourcePolicy,
					reason: findReason,
					authVersion: Number(cloudRet?.auth?.authVersion || 0),
				});
			}
			if (source === "local") {
				const entries = await resolveFlowEntriesForFind({
					sourcePolicy: "local",
					excludeFlowId: callerFlowId,
					logger,
				});
				const found = findBestFlowEntry(entries, action?.find || null);
				if (found.ok && found.entry) {
					targetEntry = found.entry;
					await logger?.info("invoke.find.local.hit", {
						sourcePolicy,
						flowId: asText(targetEntry?.id || ""),
						entryId: asText(targetEntry?.entryId || ""),
						findDomains: extractFindDomainValues(action?.find || null),
						matchedDomains: extractEntryDomainValues(targetEntry),
						candidateTop: summarizeFindCandidates(found?.candidates, 5),
					});
					break;
				}
				findReason = asText(found.reason || findReason || "local find failed");
			}
		}
		if (!targetEntry) {
			const reason = findReason || "invoke find failed";
			if (onError === "return") return { status: "done", value: { ok: false, reason } };
			return { status: "failed", reason };
		}
	}
	if (targetEntry && callerFlowId && String(targetEntry.id || "") === String(callerFlowId || "")) {
		const reason = `invoke target cannot be current flow itself: ${callerFlowId}`;
		if (onError === "return") return { status: "done", value: { ok: false, reason } };
		return { status: "failed", reason };
	}

	const riskControl = resolveRiskControl(opts || {});
	const riskMeta = getEntryRiskMeta(targetEntry);
	const riskLevel = normalizeRiskLevelNum(riskMeta.level, 1);
	if (riskControl.enabled && riskControl.mode !== "off") {
		const hardBlock = riskLevel > riskControl.blockAboveLevel;
		if (hardBlock) {
			const reason = `invoke blocked by riskControl: risk.level=${riskLevel} > blockAboveLevel=${riskControl.blockAboveLevel}`;
			await logger?.warn("invoke.risk.blocked", {
				flowId: asText(targetEntry?.id || ""),
				sourceFlowId: asText(targetEntry?.raw?.sourceFlowId || targetEntry?.raw?.flowId || ""),
				ownerUserId: asText(targetEntry?.raw?.ownerUserId || targetEntry?.raw?.userId || ""),
				riskLevel,
				blockAboveLevel: riskControl.blockAboveLevel,
			});
			if (onError === "return") return { status: "done", value: { ok: false, reason } };
			return { status: "failed", reason };
		}
		const needAsk = riskControl.mode === "ask" && riskLevel > riskControl.askAboveLevel;
		if (needAsk) {
			let approved = false;
			if (hasOneShotRiskApproval(targetEntry, opts)) approved = true;
			if (!approved && await hasPersistentRiskApproval(targetEntry, { logger })) approved = true;
			if (!approved) {
				const activePage = webRpa?.currentPage || page || null;
				const askRet = await askRiskApprovalFromPage({
					webRpa,
					page: activePage,
					entry: targetEntry,
					riskMeta,
					logger,
				});
				if (askRet.ok) {
					if (askRet.choice === "once") setOneShotRiskApproval(targetEntry, opts);
					else await savePersistentRiskApproval(targetEntry, askRet.choice, { logger });
					approved = true;
				} else {
					if (!activePage || !webRpa?.inPagePrompt) {
						if (riskControl.onAskUnavailable === "warn" || riskControl.onAskUnavailable === "allow") {
							await logger?.warn("invoke.risk.ask_unavailable_bypass", {
								flowId: asText(targetEntry?.id || ""),
								riskLevel,
								mode: riskControl.onAskUnavailable,
							});
							approved = true;
						}
					}
				}
			}
			if (!approved) {
				const reason = `invoke blocked by riskControl ask: risk.level=${riskLevel}, approval required`;
				if (onError === "return") return { status: "done", value: { ok: false, reason } };
				return { status: "failed", reason };
			}
		} else if (riskLevel > riskControl.askAboveLevel) {
			await logger?.warn("invoke.risk.warn", {
				flowId: asText(targetEntry?.id || ""),
				riskLevel,
				askAboveLevel: riskControl.askAboveLevel,
			});
		}
	}

	let invokeArgs = action?.args;
	if (!isPlainObject(invokeArgs)) invokeArgs = {};
	invokeArgs = expandDottedKeys(invokeArgs);
	invokeArgs = parseFlowVal(invokeArgs, args, opts, vars, lastResult);

	const callerPage = webRpa?.currentPage || page || null;
	let subWebRpa = webRpa;
	let subPage = webRpa?.currentPage || page || null;
	let forkWorker = null;
	const forkRaw = parseFlowVal(action?.fork, args, opts, vars, lastResult);
	let forkMode = "none";
	let forkUrl = "";
	if (forkRaw === true || String(forkRaw || "").toLowerCase() === "true") {
		forkMode = "current";
	} else if (typeof forkRaw === "string" && forkRaw.trim() && String(forkRaw).toLowerCase() !== "false") {
		forkMode = "url";
		forkUrl = String(forkRaw).trim();
	}
	if (forkMode !== "none") {
		if (!webRpa || typeof webRpa.fork !== "function") {
			const reason = "invoke fork requested but webRpa.fork is not available";
			if (onError === "return") return { status: "done", value: { ok: false, reason } };
			return { status: "failed", reason };
		}
		if (forkMode === "current" && !callerPage) {
			const reason = "invoke fork=true requires current page";
			if (onError === "return") return { status: "done", value: { ok: false, reason } };
			return { status: "failed", reason };
		}
		const forkWait = String(parseFlowVal(action?.forkWait || "interactive", args, opts, vars, lastResult) || "interactive");
		const forkOpts = (forkMode === "url")
			? { url: forkUrl, wait: forkWait }
			: { currentPage: true, keepBorrowedPage: true };
		forkWorker = await webRpa.fork(forkOpts);
		subWebRpa = forkWorker;
		subPage = forkWorker?.currentPage || null;
	}

	await logger?.info("invoke.start", {
		targetFlowId: targetEntry.id,
		targetEntryId: targetEntry.entryId || "",
		source: targetEntry.source,
		sourcePolicy,
		argsKeys: Object.keys(toObject(invokeArgs, {})),
		argsPreview: safeStringifyForLog(invokeArgs, 1200),
		onError,
		returnTo,
		timeoutMs,
		forkMode,
		forkUrl: forkMode === "url" ? forkUrl : null,
	});

	const runPms = runFlow({
		flow: targetEntry.flow,
		webRpa: subWebRpa,
		page: subPage,
		session: session || opts?.session || subWebRpa?.session || webRpa?.session || null,
		args: invokeArgs,
		opts: { ...(opts || {}), __skipCurrentFlowRiskGate: true },
		logger,
	});

	let subResult;
	try {
		if (timeoutMs > 0) {
			subResult = await Promise.race([
				runPms,
				new Promise((resolve) => setTimeout(() => resolve({ status: "failed", reason: `invoke timeout: ${timeoutMs}ms` }), timeoutMs)),
			]);
		} else {
			subResult = await runPms;
		}
	} finally {
		if (forkWorker && typeof forkWorker.disposeFork === "function") {
			try {
				await forkWorker.disposeFork({ keepBorrowedPage: true });
			} catch (_) {
			}
		}
	}

	if (returnTo === "caller" && callerPage) {
		try {
			webRpa.setCurrentPage(callerPage);
			await logger?.debug("invoke.return_to.caller", { targetFlowId: targetEntry.id });
		} catch (_) {
		}
	}

	const status = String(subResult?.status || "failed").toLowerCase();
	if (status === "done") {
		await logger?.info("invoke.done", { targetFlowId: targetEntry.id });
		return {
			status: "done",
			value: subResult?.value,
			meta: {
				invoke: {
					flowId: targetEntry.id,
					entryId: targetEntry.entryId || "",
					source: targetEntry.source || "",
					sourceRef: targetEntry.sourceRef || "",
					status: subResult.status,
					reason: subResult.reason || "",
				},
			},
		};
	}

	const reason = subResult?.reason || `invoke failed: ${targetEntry.id}`;
	await logger?.warn("invoke.failed", { targetFlowId: targetEntry.id, reason, onError });
	if (onError === "return") {
		return {
			status: "done",
			value: { ok: false, flowId: targetEntry.id, status: subResult?.status || "failed", reason },
			meta: {
				invoke: {
					flowId: targetEntry.id,
					entryId: targetEntry.entryId || "",
					source: targetEntry.source || "",
					sourceRef: targetEntry.sourceRef || "",
					status: subResult?.status || "failed",
					reason,
				},
			},
		};
	}
	return {
		status: "failed",
		reason,
		meta: {
			invoke: {
				flowId: targetEntry.id,
				entryId: targetEntry.entryId || "",
				source: targetEntry.source || "",
				sourceRef: targetEntry.sourceRef || "",
				status: subResult?.status || "failed",
			},
		},
	};
}

export { invokeFlowAction, expandDottedKeys };
