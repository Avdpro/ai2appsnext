import crypto from "crypto";
import pathLib from "path";
import { promises as fsp } from "fs";
import { getUserInfo } from "../util/UserUtils.js";

let ensureIndexPromise = null;
let ensureCacheIndexPromise = null;
let systemPubKeyCache = { file: "", pem: "", loadedAt: 0 };

function asText(v) {
	return String(v == null ? "" : v).trim();
}

function asInt(v, fallback = 0) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.floor(n);
}

function isPlainObject(v) {
	if (!v || typeof v !== "object") return false;
	const p = Object.getPrototypeOf(v);
	return p === Object.prototype || p === null;
}

function toObject(v, fallback = null) {
	if (isPlainObject(v)) return v;
	return fallback;
}

function normalizeStatus(raw) {
	const s = asText(raw).toUpperCase();
	if (["DRAFT", "SUBMITTED", "PENDING_PUBLISH_APPROVAL", "APPROVED", "REJECTED", "PUBLISHED", "UNPUBLISHED"].includes(s)) return s;
	return "DRAFT";
}

function normalizeVisibility(raw) {
	const s = asText(raw).toLowerCase();
	if (["private", "public", "unlisted"].includes(s)) return s;
	return "private";
}

function normalizeSignature(raw, fallback = null) {
	const sig = toObject(raw, null) || toObject(fallback, null);
	if (!sig) return null;
	const alg = asText(sig.alg);
	const kid = asText(sig.kid);
	const sign = asText(sig.sig);
	if (!alg || !kid || !sign) return null;
	return {
		alg,
		kid,
		sig: sign,
		signedAt: sig.signedAt ? new Date(sig.signedAt) : new Date(),
		...(isPlainObject(sig.payload) ? { payload: sig.payload } : null),
		...(sig.reviewComment ? { reviewComment: asText(sig.reviewComment) } : null),
		...(sig.reviewedBy ? { reviewedBy: asText(sig.reviewedBy) } : null),
	};
}

function normalizeRiskLevelNumber(raw, fallback = 3) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(1, Math.min(5, Math.floor(n)));
}

function normalizeRiskInfo(raw, fallback = null) {
	const src = toObject(raw, null) || toObject(fallback, null);
	if (!src) return null;
	const level = normalizeRiskLevelNumber(src.level, 3);
	return {
		level,
		desc: asText(src.desc || src.description || ""),
		source: asText(src.source || "manual") || "manual",
		updatedAt: src.updatedAt ? new Date(src.updatedAt) : new Date(),
		updatedBy: asText(src.updatedBy || ""),
		details: toObject(src.details, null),
		audit: toObject(src.audit, null),
	};
}

function parseEnvList(raw) {
	return asText(raw).split(",").map((s) => asText(s)).filter(Boolean);
}

function isFlowReviewer(userInfo, userId = "") {
	const uid = asText(userId || userInfo?._id || userInfo?.id || userInfo?.userId || "");
	const allowIds = new Set(parseEnvList(process.env.FLOW_REVIEWER_IDS || ""));
	if (uid && allowIds.has(uid)) return true;
	const rank = normalizeRankName(userInfo?.rank || "");
	const minRank = normalizeRankName(process.env.FLOW_MIN_REVIEW_RANK || "LORD");
	return rankScore(rank) >= rankScore(minRank);
}

async function getSystemPublicKeyPem() {
	const fileRaw = asText(process.env.FLOW_SYSTEM_PUBLIC_KEY_FILE || "");
	if (fileRaw) {
		const file = pathLib.isAbsolute(fileRaw) ? fileRaw : pathLib.resolve(process.cwd(), fileRaw);
		if (systemPubKeyCache.file === file && systemPubKeyCache.pem) return systemPubKeyCache.pem;
		const pem = asText(await fsp.readFile(file, "utf8"));
		if (!pem) throw new Error(`FLOW_SYSTEM_PUBLIC_KEY_FILE is empty: ${file}`);
		systemPubKeyCache = { file, pem, loadedAt: Date.now() };
		return pem;
	}
	const inlinePem = asText(process.env.FLOW_SYSTEM_PUBLIC_KEY || "");
	if (!inlinePem) throw new Error("Missing FLOW_SYSTEM_PUBLIC_KEY_FILE or FLOW_SYSTEM_PUBLIC_KEY");
	systemPubKeyCache = { file: "", pem: inlinePem, loadedAt: Date.now() };
	return inlinePem;
}

function verifySystemSignature({ payload, signature, publicKeyPem }) {
	const sigText = asText(signature || "");
	if (!isPlainObject(payload) || !sigText) return false;
	const keyObj = crypto.createPublicKey(publicKeyPem);
	const data = Buffer.from(JSON.stringify(payload), "utf8");
	const sig = Buffer.from(sigText, "base64");
	return crypto.verify(null, data, keyObj, sig);
}

function buildReviewLog(event, fields = {}) {
	return {
		event: asText(event || "flow.review"),
		at: new Date(),
		...fields,
	};
}

function normalizeFlowKind(rawKind) {
	const k = asText(rawKind).toLowerCase();
	if (!k) return "rpa";
	return k;
}

function listCapKeys(capabilities) {
	if (!capabilities) return [];
	if (Array.isArray(capabilities)) {
		return capabilities.map((x) => asText(x)).filter(Boolean);
	}
	if (typeof capabilities === "object") {
		const out = new Set();
		if (Array.isArray(capabilities.must)) for (const k of capabilities.must) out.add(asText(k));
		if (Array.isArray(capabilities.prefer)) for (const k of capabilities.prefer) out.add(asText(k));
		if (Array.isArray(capabilities.can)) for (const k of capabilities.can) out.add(asText(k));
		if (Array.isArray(capabilities.caps)) for (const k of capabilities.caps) out.add(asText(k));
		for (const k of Object.keys(capabilities)) {
			if (["must", "prefer", "can", "caps"].includes(k)) continue;
			if (capabilities[k]) out.add(asText(k));
		}
		return Array.from(out).filter(Boolean);
	}
	return [];
}

function normFilters(filters) {
	if (!Array.isArray(filters)) return [];
	return filters.map((f) => {
		if (!f || typeof f !== "object") return null;
		const key = asText(f.key);
		const value = asText(f.value);
		if (!key || !value) return null;
		return { key, value };
	}).filter(Boolean);
}

function normalizeRanks(ranks) {
	if (!ranks || typeof ranks !== "object" || Array.isArray(ranks)) return {};
	return ranks;
}

function sortObjectDeep(v) {
	if (Array.isArray(v)) return v.map(sortObjectDeep);
	if (!v || typeof v !== "object") return v;
	const out = {};
	const keys = Object.keys(v).sort((a, b) => a.localeCompare(b));
	for (const k of keys) out[k] = sortObjectDeep(v[k]);
	return out;
}

function stableStringify(v) {
	return JSON.stringify(sortObjectDeep(v));
}

function calcDigest(content) {
	const text = stableStringify(content);
	const hex = crypto.createHash("sha256").update(text, "utf8").digest("hex");
	return `sha256:${hex}`;
}

function hashText(text) {
	const s = asText(text);
	if (!s) return "";
	const hex = crypto.createHash("sha256").update(s, "utf8").digest("hex");
	return `sha256:${hex}`;
}

function groupFilterByKey(filterList) {
	const m = new Map();
	for (const f of filterList || []) {
		if (!f || !f.key) continue;
		if (!m.has(f.key)) m.set(f.key, []);
		m.get(f.key).push(String(f.value ?? ""));
	}
	return m;
}

function calcFilterMatch(entryFilters, reqFilters) {
	if (!reqFilters || !reqFilters.length) return { ok: true, score: 0 };
	const eMap = groupFilterByKey(entryFilters || []);
	const rMap = groupFilterByKey(reqFilters || []);
	let score = 0;
	for (const [key, vals] of rMap.entries()) {
		const entryVals = eMap.get(key) || [];
		if (!entryVals.length) return { ok: false, score: 0 };
		let matched = false;
		let local = 0;
		for (const want of vals) {
			if (entryVals.includes(want)) {
				matched = true;
				local = Math.max(local, 2);
			}
			if (entryVals.includes("*")) {
				matched = true;
				local = Math.max(local, 1);
			}
		}
		if (!matched) return { ok: false, score: 0 };
		score += local;
	}
	return { ok: true, score };
}

function compareRank(entryA, entryB, rankStr = "") {
	const fields = asText(rankStr).split(",").map((s) => asText(s)).filter(Boolean);
	if (!fields.length) return 0;
	for (const f of fields) {
		const av = Number(entryA?.ranks?.[f]);
		const bv = Number(entryB?.ranks?.[f]);
		if (!Number.isFinite(av) && !Number.isFinite(bv)) continue;
		if (!Number.isFinite(av)) return 1;
		if (!Number.isFinite(bv)) return -1;
		const asc = f === "cost" || f === "size";
		if (av === bv) continue;
		if (asc) return av < bv ? -1 : 1;
		return av > bv ? -1 : 1;
	}
	return 0;
}

function canUseAsPublished(doc) {
	return !!(doc?.published?.isPublished === true && asText(doc?.systemSignature?.sig));
}

function ownershipOf(doc, reqUserId) {
	return asText(doc?.userId) === asText(reqUserId) ? "mine" : "published";
}

function buildFlowSummary(doc, includeContent = false) {
	const out = {
		userId: asText(doc?.userId),
		flowId: asText(doc?.flowId),
		version: asInt(doc?.version, 0),
		kind: asText(doc?.kind || "rpa"),
		capabilities: Array.isArray(doc?.capabilities) ? doc.capabilities : [],
		filters: Array.isArray(doc?.filters) ? doc.filters : [],
		ranks: (doc?.ranks && typeof doc.ranks === "object") ? doc.ranks : {},
		status: asText(doc?.status || "DRAFT"),
		visibility: asText(doc?.visibility || "private"),
		digest: asText(doc?.digest),
		published: doc?.published || { isPublished: false, channel: null, publishedAt: null },
		authorSignature: doc?.authorSignature || null,
		systemSignature: doc?.systemSignature || null,
		publishRequest: (doc?.publishRequest && typeof doc.publishRequest === "object") ? doc.publishRequest : null,
		publishSource: (doc?.publishSource && typeof doc.publishSource === "object") ? doc.publishSource : null,
		risk: (doc?.risk && typeof doc.risk === "object") ? doc.risk : null,
		review: (doc?.review && typeof doc.review === "object") ? doc.review : null,
		createdAt: doc?.createdAt || null,
		updatedAt: doc?.updatedAt || null,
	};
	if (includeContent) out.content = doc?.content || null;
	return out;
}

function parseFindSpec(raw) {
	const find = toObject(raw, {}) || {};
	return {
		kind: asText(find.kind || "rpa"),
		must: Array.isArray(find.must) ? find.must.map((x) => asText(x)).filter(Boolean) : [],
		prefer: Array.isArray(find.prefer) ? find.prefer.map((x) => asText(x)).filter(Boolean) : [],
		filter: Array.isArray(find.filter) ? find.filter : [],
		rank: asText(find.rank || ""),
	};
}

function normalizeScope(raw) {
	const s = asText(raw).toLowerCase();
	if (["mine", "published", "all"].includes(s)) return s;
	return "all";
}

function normalizeOwnershipPolicy(raw) {
	const s = asText(raw).toLowerCase();
	if (["prefermine", "preferpublished", "mineonly", "publishedonly"].includes(s)) return s;
	return "prefermine";
}

function ownershipPriority(ownership, policy) {
	if (policy === "preferpublished") return ownership === "published" ? 1 : 0;
	return ownership === "mine" ? 1 : 0;
}

function normalizeRankName(raw) {
	return asText(raw).toUpperCase();
}

function rankScore(rawRank) {
	const r = normalizeRankName(rawRank);
	const map = {
		GUEST: 0,
		USER: 1,
		MEMBER: 2,
		BARON: 3,
		VISCOUNT: 4,
		COUNT: 5,
		MARQUIS: 6,
		DUKE: 7,
		PRINCE: 8,
		KING: 9,
		LORD: 10,
		ADMIN: 11,
		ROOT: 12,
	};
	if (Object.prototype.hasOwnProperty.call(map, r)) return map[r];
	return 0;
}

function resolveMinRankForDoc(doc) {
	const minRank = asText(doc?.published?.access?.minRank || "");
	if (minRank) return minRank;
	const legacy = asText(doc?.published?.minRank || "");
	if (legacy) return legacy;
	return "";
}

function canAccessPublishedByRank(doc, viewerRankRaw) {
	if (!canUseAsPublished(doc)) return false;
	const minRank = resolveMinRankForDoc(doc);
	if (!minRank) return true;
	const viewerRank = normalizeRankName(viewerRankRaw || "GUEST");
	return rankScore(viewerRank) >= rankScore(minRank);
}

async function ensureFlowIndexes(dbManageFlows) {
	if (ensureIndexPromise) return ensureIndexPromise;
	ensureIndexPromise = (async () => {
		try {
			await dbManageFlows.createIndex({ userId: 1, flowId: 1 }, { unique: true, name: "uniq_user_flow" });
		} catch (_) {}
		try {
			await dbManageFlows.createIndex({ userId: 1, updatedAt: -1 }, { name: "user_updated_at" });
		} catch (_) {}
		try {
			await dbManageFlows.createIndex({ "published.isPublished": 1, flowId: 1, updatedAt: -1 }, { name: "published_flow" });
		} catch (_) {}
	})();
	return ensureIndexPromise;
}

function normalizeCacheKind(raw) {
	const k = asText(raw).toLowerCase();
	if (k === "selector" || k === "code") return k;
	return "";
}

function normalizeCacheStatus(raw) {
	const s = asText(raw).toLowerCase();
	if (s === "disabled") return "disabled";
	return "active";
}

function normalizeCacheValue(kind, rawValue) {
	if (kind === "selector") {
		if (Array.isArray(rawValue)) return rawValue.map((x) => asText(x)).filter(Boolean);
		if (asText(rawValue)) return [asText(rawValue)];
		return [];
	}
	return asText(rawValue);
}

function buildCacheSummary(doc) {
	return {
		userId: asText(doc?.userId),
		hostname: asText(doc?.hostname),
		flowId: asText(doc?.flowId),
		lan: asText(doc?.lan || "web"),
		kind: asText(doc?.kind),
		cacheKey: asText(doc?.cacheKey),
		query: asText(doc?.query),
		queryHash: asText(doc?.queryHash),
		mode: asText(doc?.mode || "instance"),
		policy: asText(doc?.policy || "single"),
		sigKey: asText(doc?.sigKey),
		sigKeyHash: asText(doc?.sigKeyHash),
		value: doc?.value ?? null,
		status: asText(doc?.status || "active"),
		score: Number.isFinite(Number(doc?.score)) ? Number(doc.score) : null,
		source: asText(doc?.source),
		version: asInt(doc?.version, 0),
		createdAt: doc?.createdAt || null,
		updatedAt: doc?.updatedAt || null,
	};
}

async function ensureCacheIndexes(dbManageFlowCaches) {
	if (ensureCacheIndexPromise) return ensureCacheIndexPromise;
	ensureCacheIndexPromise = (async () => {
		try {
			await dbManageFlowCaches.createIndex(
				{ hostname: 1, flowId: 1, lan: 1, kind: 1, cacheKey: 1 },
				{ unique: true, name: "uniq_cache_entry" }
			);
		} catch (_) {}
		try {
			await dbManageFlowCaches.createIndex(
				{ hostname: 1, flowId: 1, lan: 1, kind: 1, queryHash: 1 },
				{ name: "cache_query_hash" }
			);
		} catch (_) {}
		try {
			await dbManageFlowCaches.createIndex({ sigKeyHash: 1 }, { name: "cache_sigkey_hash" });
		} catch (_) {}
		try {
			await dbManageFlowCaches.createIndex({ updatedAt: -1 }, { name: "cache_updated_at" });
		} catch (_) {}
	})();
	return ensureCacheIndexPromise;
}

export default function (app, router, apiMap) {
	const dbManageFlows = app.get("DBManageFlows");
	const dbManageFlowCaches = app.get("DBManageFlowCaches");

	ensureFlowIndexes(dbManageFlows).catch(() => {});
	if (dbManageFlowCaches) ensureCacheIndexes(dbManageFlowCaches).catch(() => {});

	apiMap["saveFlowDraft"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, flowId, content, contentId, oldDoc;
		let kind, capabilities, filters, ranks, digest, version, nowTime, authorSignature, hasAuthorSignatureField;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		flowId = asText(reqVO.flowId);
		content = toObject(reqVO.content, null);
		if (!userId || !token) {
			res.json({ code: 401, info: "Missing userId/token." });
			return;
		}
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		if (!flowId) {
			res.json({ code: 400, info: "Missing flowId." });
			return;
		}
		if (!content) {
			res.json({ code: 400, info: "Missing flow content." });
			return;
		}
		contentId = asText(content.id);
		if (!contentId || contentId !== flowId) {
			res.json({ code: 400, info: "content.id must equal flowId." });
			return;
		}
		nowTime = new Date();
		digest = calcDigest(content);
		kind = normalizeFlowKind(content.kind);
		capabilities = listCapKeys(content.capabilities);
		filters = normFilters(content.filters);
		ranks = normalizeRanks(content.ranks);
		oldDoc = await dbManageFlows.findOne({ userId, flowId }, { projection: { version: 1, createdAt: 1, authorSignature: 1 } });
		version = (asInt(oldDoc?.version, 0) || 0) + 1;
		hasAuthorSignatureField = Object.prototype.hasOwnProperty.call(reqVO, "authorSignature");
		if (hasAuthorSignatureField) {
			if (reqVO.authorSignature == null || reqVO.authorSignature === "") {
				authorSignature = null;
			} else {
				authorSignature = normalizeSignature(reqVO.authorSignature, null);
				if (!authorSignature) {
					res.json({ code: 400, info: "Invalid authorSignature." });
					return;
				}
			}
		} else {
			authorSignature = normalizeSignature(null, oldDoc?.authorSignature || null);
		}
		await dbManageFlows.updateOne(
			{ userId, flowId },
			{
				$set: {
					userId,
					flowId,
					version,
					kind,
					capabilities,
					filters,
					ranks,
					status: normalizeStatus(reqVO.status || "DRAFT"),
					visibility: normalizeVisibility(reqVO.visibility || "private"),
					digest,
					content,
					authorSignature,
					systemSignature: null,
					published: { isPublished: false, channel: null, publishedAt: null },
					updatedAt: nowTime,
				},
				$setOnInsert: {
					createdAt: nowTime,
				},
			},
			{ upsert: true }
		);
		res.json({
			code: 200,
			flowId,
			version,
			digest,
			status: normalizeStatus(reqVO.status || "DRAFT"),
		});
	};

	apiMap["getMyFlow"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, flowId, doc;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		flowId = asText(reqVO.flowId);
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		if (!flowId) {
			res.json({ code: 400, info: "Missing flowId." });
			return;
		}
		doc = await dbManageFlows.findOne({ userId, flowId });
		if (!doc) {
			res.json({ code: 404, info: "Flow not found." });
			return;
		}
		res.json({ code: 200, flow: buildFlowSummary(doc, true) });
	};

	apiMap["getPublishedFlow"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, flowId, doc, viewerRank, systemOwnerId;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		flowId = asText(reqVO.flowId);
		if (!flowId) {
			res.json({ code: 400, info: "Missing flowId." });
			return;
		}
		userInfo = null;
		if (userId && token) {
			try {
				userInfo = await getUserInfo(req, userId, token);
			} catch (_) {
				userInfo = null;
			}
		}
		viewerRank = normalizeRankName(userInfo?.rank || "GUEST");
		systemOwnerId = asText(process.env.FLOW_SYSTEM_USER_ID || "system");
		doc = await dbManageFlows.findOne({ userId: systemOwnerId, flowId, "published.isPublished": true });
		if (!doc) {
			res.json({ code: 404, info: "Published flow not found." });
			return;
		}
		if (!canAccessPublishedByRank(doc, viewerRank)) {
			res.json({ code: 403, info: `Flow requires rank >= ${resolveMinRankForDoc(doc) || "GUEST"}.` });
			return;
		}
		res.json({ code: 200, flow: buildFlowSummary(doc, true) });
	};

	apiMap["listMyFlows"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, limit, skip, includeContent, cursorTime, queryVO, docs;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		limit = Math.max(1, Math.min(100, asInt(reqVO.limit, 20)));
		skip = Math.max(0, asInt(reqVO.skip, 0));
		includeContent = !!reqVO.includeContent;
		queryVO = { userId };
		cursorTime = reqVO.cursorUpdatedAt ? new Date(reqVO.cursorUpdatedAt) : null;
		if (cursorTime && Number.isFinite(cursorTime.getTime())) {
			queryVO.updatedAt = { $lt: cursorTime };
		}
		docs = await dbManageFlows
			.find(queryVO)
			.sort({ updatedAt: -1, flowId: 1 })
			.skip(skip)
			.limit(limit)
			.toArray();
		const flows = docs.map((doc) => buildFlowSummary(doc, includeContent));
		const nextCursorUpdatedAt = docs.length ? (docs[docs.length - 1]?.updatedAt || null) : null;
		res.json({
			code: 200,
			flows,
			total: flows.length,
			nextCursorUpdatedAt,
		});
	};

	apiMap["listPendingPublishFlows"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, limit, skip, includeContent, ownerUserId, statusList, queryVO, docs;
		let publishedAtFrom, publishedAtTo, fromDate, toDate;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		if (!isFlowReviewer(userInfo, userId)) {
			res.json({ code: 403, info: "Reviewer permission required." });
			return;
		}
		limit = Math.max(1, Math.min(100, asInt(reqVO.limit, 20)));
		skip = Math.max(0, asInt(reqVO.skip, 0));
		includeContent = !!reqVO.includeContent;
		ownerUserId = asText(reqVO.ownerUserId || "");
		statusList = Array.isArray(reqVO.statusList)
			? reqVO.statusList.map((x) => normalizeStatus(x)).filter((x) => x === "SUBMITTED" || x === "PENDING_PUBLISH_APPROVAL" || x === "APPROVED" || x === "REJECTED" || x === "PUBLISHED")
			: [];
		if (!statusList.length) statusList = ["SUBMITTED", "PENDING_PUBLISH_APPROVAL"];
		queryVO = { status: { $in: statusList } };
		if (ownerUserId) queryVO.userId = ownerUserId;
		publishedAtFrom = asText(reqVO.publishedAtFrom || "");
		publishedAtTo = asText(reqVO.publishedAtTo || "");
		if (publishedAtFrom || publishedAtTo) {
			fromDate = publishedAtFrom ? new Date(publishedAtFrom) : null;
			toDate = publishedAtTo ? new Date(publishedAtTo) : null;
			if (fromDate && !Number.isFinite(fromDate.getTime())) {
				res.json({ code: 400, info: "Invalid publishedAtFrom." });
				return;
			}
			if (toDate && !Number.isFinite(toDate.getTime())) {
				res.json({ code: 400, info: "Invalid publishedAtTo." });
				return;
			}
			queryVO["published.publishedAt"] = {
				...(fromDate ? { $gte: fromDate } : null),
				...(toDate ? { $lte: toDate } : null),
			};
		}
		docs = await dbManageFlows
			.find(queryVO)
			.sort({ updatedAt: -1, userId: 1, flowId: 1 })
			.skip(skip)
			.limit(limit)
			.toArray();
		res.json({
			code: 200,
			flows: docs.map((doc) => buildFlowSummary(doc, includeContent)),
			total: docs.length,
		});
	};

	apiMap["getFlowReviewDetail"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, ownerUserId, flowId, doc;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		ownerUserId = asText(reqVO.ownerUserId || userId);
		flowId = asText(reqVO.flowId);
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		if (!isFlowReviewer(userInfo, userId)) {
			res.json({ code: 403, info: "Reviewer permission required." });
			return;
		}
		if (!ownerUserId || !flowId) {
			res.json({ code: 400, info: "Missing ownerUserId/flowId." });
			return;
		}
		doc = await dbManageFlows.findOne({ userId: ownerUserId, flowId });
		if (!doc) {
			res.json({ code: 404, info: "Flow not found." });
			return;
		}
		res.json({
			code: 200,
			flow: buildFlowSummary(doc, true),
		});
	};

	apiMap["reviewFlow"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, ownerUserId, flowId, decision, note, auditSummary, nowTime, flowDoc, nextStatus;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		ownerUserId = asText(reqVO.ownerUserId || userId);
		flowId = asText(reqVO.flowId);
		decision = asText(reqVO.decision || "").toLowerCase();
		note = asText(reqVO.note || reqVO.reviewComment || "");
		auditSummary = toObject(reqVO.auditSummary, null);
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		if (!isFlowReviewer(userInfo, userId)) {
			res.json({ code: 403, info: "Reviewer permission required." });
			return;
		}
		if (!ownerUserId || !flowId) {
			res.json({ code: 400, info: "Missing ownerUserId/flowId." });
			return;
		}
		if (!["approve", "reject"].includes(decision)) {
			res.json({ code: 400, info: "decision must be approve|reject." });
			return;
		}
		flowDoc = await dbManageFlows.findOne({ userId: ownerUserId, flowId });
		if (!flowDoc) {
			res.json({ code: 404, info: "Flow not found." });
			return;
		}
		nowTime = new Date();
		nextStatus = decision === "approve" ? "APPROVED" : "REJECTED";
		await dbManageFlows.updateOne(
			{ userId: ownerUserId, flowId },
			{
				$set: {
					status: nextStatus,
					updatedAt: nowTime,
					review: {
						reviewedAt: nowTime,
						reviewedBy: userId,
						decision,
						...(note ? { note } : null),
						...(auditSummary ? { auditSummary } : null),
					},
				},
				$push: {
					reviewLogs: buildReviewLog(`review.${decision}`, {
						actorUserId: userId,
						ownerUserId,
						flowId,
						version: asInt(flowDoc?.version, 0),
						decision,
						note,
					}),
				},
			}
		);
		const ret = await dbManageFlows.findOne({ userId: ownerUserId, flowId });
		res.json({
			code: 200,
			info: decision === "approve" ? "审核已通过" : "审核已驳回",
			flow: buildFlowSummary(ret, false),
		});
	};

	apiMap["findFlow"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, scope, ownershipPolicy, topK, download, findSpec, viewerRank;
		let queryVO, docs, entries, candidates;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		scope = normalizeScope(reqVO.scope || "all");
		ownershipPolicy = normalizeOwnershipPolicy(reqVO.ownershipPolicy || "preferMine");
		topK = Math.max(1, Math.min(50, asInt(reqVO.topK, 1)));
		download = !!reqVO.download;
		findSpec = parseFindSpec(reqVO.find || {});
		viewerRank = normalizeRankName(userInfo?.rank || "GUEST");

		if (scope === "mine") {
			queryVO = { userId };
		} else if (scope === "published") {
			queryVO = { "published.isPublished": true };
		} else {
			queryVO = { $or: [{ userId }, { "published.isPublished": true }] };
		}
		docs = await dbManageFlows.find(queryVO).limit(1500).toArray();
		entries = [];
		for (const doc of docs) {
			const own = ownershipOf(doc, userId);
			const publishedOk = canUseAsPublished(doc);
			const publishedReadable = canAccessPublishedByRank(doc, viewerRank);
			if (scope === "published" && !publishedOk) continue;
			if (scope === "all" && own !== "mine" && !publishedOk) continue;
			if (ownershipPolicy === "mineonly" && own !== "mine") continue;
			if (ownershipPolicy === "publishedonly" && own !== "published") continue;
			if (own === "published" && !publishedReadable) continue;
			entries.push({
				...doc,
				ownership: own,
				capSet: new Set(Array.isArray(doc.capabilities) ? doc.capabilities : []),
			});
		}

		candidates = [];
		for (const e of entries) {
			if (findSpec.kind && asText(e.kind) !== findSpec.kind) continue;
			const miss = findSpec.must.find((k) => !e.capSet.has(k));
			if (miss) continue;
			const fm = calcFilterMatch(e.filters, findSpec.filter);
			if (!fm.ok) continue;
			let preferHits = 0;
			for (const k of findSpec.prefer) if (e.capSet.has(k)) preferHits += 1;
			candidates.push({
				entry: e,
				preferHits,
				filterScore: fm.score,
				ownershipPriority: ownershipPriority(e.ownership, ownershipPolicy),
			});
		}
		if (!candidates.length) {
			res.json({ code: 200, best: null, candidates: [], reason: "no flow matched find spec" });
			return;
		}

		candidates.sort((a, b) => {
			if (a.preferHits !== b.preferHits) return b.preferHits - a.preferHits;
			if (a.filterScore !== b.filterScore) return b.filterScore - a.filterScore;
			const rc = compareRank(a.entry, b.entry, findSpec.rank);
			if (rc !== 0) return rc;
			if (a.ownershipPriority !== b.ownershipPriority) return b.ownershipPriority - a.ownershipPriority;
			const at = new Date(a.entry.updatedAt || 0).getTime();
			const bt = new Date(b.entry.updatedAt || 0).getTime();
			if (at !== bt) return bt - at;
			return asText(a.entry.flowId).localeCompare(asText(b.entry.flowId));
		});

		const sliced = candidates.slice(0, topK);
		const bestDoc = sliced[0].entry;
		const best = {
			flow: buildFlowSummary(bestDoc, download),
			score: {
				preferHits: sliced[0].preferHits,
				filterScore: sliced[0].filterScore,
				ownership: bestDoc.ownership,
			},
		};
		const outCandidates = sliced.map((row) => ({
			flow: buildFlowSummary(row.entry, false),
			score: {
				preferHits: row.preferHits,
				filterScore: row.filterScore,
				ownership: row.entry.ownership,
			},
		}));
		res.json({
			code: 200,
			best,
			candidates: outCandidates,
				explain: {
					scope,
					ownershipPolicy,
					rank: findSpec.rank || "",
					viewerRank,
				},
			});
		};

	apiMap["findPublishedFlow"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, topK, download, findSpec, docs, candidates, viewerRank, systemOwnerId;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		topK = Math.max(1, Math.min(50, asInt(reqVO.topK, 1)));
		download = !!reqVO.download;
		findSpec = parseFindSpec(reqVO.find || {});
		systemOwnerId = asText(process.env.FLOW_SYSTEM_USER_ID || "system");
		userInfo = null;
		if (userId && token) {
			try {
				userInfo = await getUserInfo(req, userId, token);
			} catch (_) {
				userInfo = null;
			}
		}
		viewerRank = normalizeRankName(userInfo?.rank || "GUEST");
		docs = await dbManageFlows.find({ userId: systemOwnerId, "published.isPublished": true }).limit(1500).toArray();
		candidates = [];
		for (const doc of docs) {
			if (!canAccessPublishedByRank(doc, viewerRank)) continue;
			const capSet = new Set(Array.isArray(doc.capabilities) ? doc.capabilities : []);
			if (findSpec.kind && asText(doc.kind) !== findSpec.kind) continue;
			const miss = findSpec.must.find((k) => !capSet.has(k));
			if (miss) continue;
			const fm = calcFilterMatch(doc.filters, findSpec.filter);
			if (!fm.ok) continue;
			let preferHits = 0;
			for (const k of findSpec.prefer) if (capSet.has(k)) preferHits += 1;
			candidates.push({ entry: doc, preferHits, filterScore: fm.score });
		}
		if (!candidates.length) {
			res.json({
				code: 200,
				best: null,
				candidates: [],
				reason: "no published system flow matched find spec",
				explain: { scope: "published", owner: systemOwnerId, viewerRank, rank: findSpec.rank || "" },
			});
			return;
		}
		candidates.sort((a, b) => {
			if (a.preferHits !== b.preferHits) return b.preferHits - a.preferHits;
			if (a.filterScore !== b.filterScore) return b.filterScore - a.filterScore;
			const rc = compareRank(a.entry, b.entry, findSpec.rank);
			if (rc !== 0) return rc;
			const at = new Date(a.entry.updatedAt || 0).getTime();
			const bt = new Date(b.entry.updatedAt || 0).getTime();
			if (at !== bt) return bt - at;
			return asText(a.entry.flowId).localeCompare(asText(b.entry.flowId));
		});
		const sliced = candidates.slice(0, topK);
		const bestDoc = sliced[0].entry;
		res.json({
			code: 200,
			best: {
				flow: buildFlowSummary(bestDoc, download),
				score: {
					preferHits: sliced[0].preferHits,
					filterScore: sliced[0].filterScore,
					ownership: "published",
				},
			},
			candidates: sliced.map((row) => ({
				flow: buildFlowSummary(row.entry, false),
				score: {
					preferHits: row.preferHits,
					filterScore: row.filterScore,
					ownership: "published",
				},
			})),
			explain: {
				scope: "published",
				owner: systemOwnerId,
				viewerRank,
				rank: findSpec.rank || "",
			},
		});
	};

	apiMap["publishFlow"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, flowId, flowDoc, systemSignature, nowTime, reviewComment, channel;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		flowId = asText(reqVO.flowId);
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		if (!flowId) {
			res.json({ code: 400, info: "Missing flowId." });
			return;
		}
		flowDoc = await dbManageFlows.findOne({ userId, flowId });
		if (!flowDoc) {
			res.json({ code: 404, info: "Flow not found." });
			return;
		}
		systemSignature = normalizeSignature(reqVO.systemSignature, flowDoc.systemSignature || null);
		if (!systemSignature || !asText(systemSignature.sig)) {
			res.json({ code: 409, info: "systemSignature is required for publish." });
			return;
		}
		nowTime = new Date();
		reviewComment = asText(reqVO.reviewComment || systemSignature.reviewComment || "");
		channel = asText(reqVO.channel || "stable") || "stable";
		await dbManageFlows.updateOne(
			{ userId, flowId },
			{
				$set: {
					systemSignature: {
						...systemSignature,
						...(reviewComment ? { reviewComment } : null),
						reviewedBy: asText(reqVO.reviewedBy || userId),
						signedAt: systemSignature.signedAt || nowTime,
					},
					published: {
						isPublished: true,
						channel,
						publishedAt: nowTime,
					},
					status: "PUBLISHED",
					updatedAt: nowTime,
				},
			}
		);
		const ret = await dbManageFlows.findOne({ userId, flowId });
		res.json({ code: 200, flow: buildFlowSummary(ret, false) });
	};

	apiMap["requestPublishFlow"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, flowId, flowDoc, nowTime, note, authorSignature;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		flowId = asText(reqVO.flowId);
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		if (!flowId) {
			res.json({ code: 400, info: "Missing flowId." });
			return;
		}
		flowDoc = await dbManageFlows.findOne({ userId, flowId });
		if (!flowDoc) {
			res.json({ code: 404, info: "Flow not found." });
			return;
		}
		authorSignature = normalizeSignature(flowDoc.authorSignature, null);
		if (!authorSignature || !asText(authorSignature.sig)) {
			res.json({ code: 409, info: "当前云端版本没有开发者签名，无法申请发布。" });
			return;
		}
		nowTime = new Date();
		note = asText(reqVO.note || reqVO.reviewComment || "");
		await dbManageFlows.updateOne(
			{ userId, flowId },
			{
				$set: {
					status: "PENDING_PUBLISH_APPROVAL",
					updatedAt: nowTime,
					publishRequest: {
						requestedAt: nowTime,
						requestedBy: userId,
						version: asInt(flowDoc.version, 0),
						...(note ? { note } : null),
					},
				},
				$push: {
					reviewLogs: buildReviewLog("publish.request", {
						actorUserId: userId,
						ownerUserId: userId,
						flowId,
						version: asInt(flowDoc?.version, 0),
						note,
					}),
				},
			}
		);
		const ret = await dbManageFlows.findOne({ userId, flowId });
		res.json({
			code: 200,
			info: "已标记为待批准发布状态",
			flow: buildFlowSummary(ret, false),
		});
	};

	apiMap["publishApprovedFlow"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, ownerUserId, flowId, flowDoc, nowTime;
		let systemSignature, reviewComment, channel, authorSignature, systemPublicKeyPem;
		let payload, payloadDigest, expectedDigest, systemFlowId, systemOwnerId, forceSystemOverwrite, riskInfo;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		ownerUserId = asText(reqVO.ownerUserId || userId);
		flowId = asText(reqVO.flowId);
		systemFlowId = asText(reqVO.systemFlowId || "");
		systemOwnerId = asText(process.env.FLOW_SYSTEM_USER_ID || "system") || "system";
		forceSystemOverwrite = reqVO.forceSystemOverwrite === true;
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		if (!isFlowReviewer(userInfo, userId)) {
			res.json({ code: 403, info: "Reviewer permission required." });
			return;
		}
		if (!ownerUserId || !flowId) {
			res.json({ code: 400, info: "Missing ownerUserId/flowId." });
			return;
		}
		flowDoc = await dbManageFlows.findOne({ userId: ownerUserId, flowId });
		if (!flowDoc) {
			res.json({ code: 404, info: "Flow not found." });
			return;
		}
		if (asText(flowDoc.status) !== "APPROVED") {
			res.json({ code: 409, info: "Flow status must be APPROVED before publish." });
			return;
		}
		riskInfo = normalizeRiskInfo(reqVO.risk, flowDoc?.risk || null);
		authorSignature = normalizeSignature(flowDoc.authorSignature, null);
		if (!authorSignature || !asText(authorSignature.sig)) {
			res.json({ code: 409, info: "authorSignature is required before publish." });
			return;
		}
		systemSignature = normalizeSignature(reqVO.systemSignature, null);
		if (!systemSignature || !asText(systemSignature.sig)) {
			res.json({ code: 409, info: "systemSignature is required for publish." });
			return;
		}
		if (asText(systemSignature.alg).toLowerCase() !== "ed25519") {
			res.json({ code: 409, info: "systemSignature.alg must be ed25519." });
			return;
		}
		payload = toObject(systemSignature.payload, null);
		if (!payload) {
			res.json({ code: 409, info: "systemSignature.payload is required for verification." });
			return;
		}
		payloadDigest = asText(payload.flowDigest);
		expectedDigest = asText(flowDoc.digest || "");
		if (
			asText(payload.ownerUserId) !== ownerUserId ||
			asText(payload.flowId) !== flowId ||
			(systemFlowId && asText(payload.systemFlowId) !== systemFlowId) ||
			asInt(payload.version, -1) !== asInt(flowDoc.version, -2) ||
			!payloadDigest ||
			(expectedDigest && payloadDigest !== expectedDigest)
		) {
			res.json({ code: 409, info: "systemSignature.payload mismatch." });
			return;
		}
		try {
			systemPublicKeyPem = await getSystemPublicKeyPem();
		} catch (err) {
			res.json({ code: 500, info: `Load system public key failed: ${asText(err?.message || err)}` });
			return;
		}
		if (!verifySystemSignature({ payload, signature: systemSignature.sig, publicKeyPem: systemPublicKeyPem })) {
			res.json({ code: 409, info: "Invalid systemSignature: verification failed." });
			return;
		}
		nowTime = new Date();
		reviewComment = asText(reqVO.reviewComment || systemSignature.reviewComment || "");
		channel = asText(reqVO.channel || "stable") || "stable";
		await dbManageFlows.updateOne(
			{ userId: ownerUserId, flowId },
			{
				$set: {
					systemSignature: {
						...systemSignature,
						...(reviewComment ? { reviewComment } : null),
						reviewedBy: asText(reqVO.reviewedBy || userId),
						signedAt: systemSignature.signedAt || nowTime,
					},
					published: {
						isPublished: true,
						channel,
						publishedAt: nowTime,
					},
					status: "PUBLISHED",
					...(riskInfo ? { risk: { ...riskInfo, updatedBy: asText(riskInfo.updatedBy || userId), updatedAt: riskInfo.updatedAt || nowTime } } : null),
					updatedAt: nowTime,
				},
				$push: {
						reviewLogs: buildReviewLog("publish.approved", {
							actorUserId: userId,
							ownerUserId,
							flowId,
							version: asInt(flowDoc?.version, 0),
							channel,
							reviewComment,
							systemFlowId,
							riskLevel: riskInfo?.level || null,
						}),
					},
				}
			);

		let systemRet = null;
		if (systemFlowId) {
			const flowContent = toObject(flowDoc.content, null);
			if (!flowContent) {
				res.json({ code: 409, info: "flow.content missing, cannot publish to system flow." });
				return;
			}
			const systemContent = { ...flowContent, id: systemFlowId };
			const systemDigest = calcDigest(systemContent);
			const oldSystemDoc = await dbManageFlows.findOne(
				{ userId: systemOwnerId, flowId: systemFlowId },
				{ projection: { version: 1, createdAt: 1 } }
			);
			if (oldSystemDoc && !forceSystemOverwrite) {
				const oldSrc = toObject(oldSystemDoc.publishSource, null);
				const oldOwnerUserId = asText(oldSrc?.ownerUserId || "");
				const oldOwnerFlowId = asText(oldSrc?.ownerFlowId || "");
				const conflict = !!(oldOwnerUserId && oldOwnerFlowId && (oldOwnerUserId !== ownerUserId || oldOwnerFlowId !== flowId));
				if (conflict) {
					res.json({
						code: 409,
						reasonCode: "system_flow_source_conflict",
						info: "系统 Flow 已存在且来源不同，需要确认覆盖。",
						conflict: {
							systemFlowId,
							currentSource: { ownerUserId: oldOwnerUserId, flowId: oldOwnerFlowId, version: asInt(oldSrc?.ownerVersion, 0) },
							incomingSource: { ownerUserId, flowId, version: asInt(flowDoc.version, 0) },
						},
					});
					return;
				}
			}
			const nextSystemVersion = oldSystemDoc ? asInt(oldSystemDoc.version, 0) + 1 : 1;
			const sourceMeta = {
				ownerUserId,
				ownerFlowId: flowId,
				ownerVersion: asInt(flowDoc.version, 0),
				ownerDigest: expectedDigest || payloadDigest || "",
				reviewedBy: userId,
				publishedAt: nowTime,
			};
			await dbManageFlows.updateOne(
				{ userId: systemOwnerId, flowId: systemFlowId },
				{
					$set: {
						userId: systemOwnerId,
						flowId: systemFlowId,
						version: nextSystemVersion,
						kind: asText(flowDoc.kind || "rpa"),
						content: systemContent,
						capabilities: Array.isArray(flowDoc.capabilities) ? flowDoc.capabilities : [],
						filters: Array.isArray(flowDoc.filters) ? flowDoc.filters : [],
						ranks: normalizeRanks(flowDoc.ranks || {}),
						visibility: "public",
						status: "PUBLISHED",
						digest: systemDigest,
						...(riskInfo ? { risk: { ...riskInfo, updatedBy: asText(riskInfo.updatedBy || userId), updatedAt: riskInfo.updatedAt || nowTime } } : null),
						authorSignature: flowDoc.authorSignature || null,
						systemSignature: {
							...systemSignature,
							...(reviewComment ? { reviewComment } : null),
							reviewedBy: asText(reqVO.reviewedBy || userId),
							signedAt: systemSignature.signedAt || nowTime,
						},
						published: {
							isPublished: true,
							channel,
							publishedAt: nowTime,
						},
						publishSource: sourceMeta,
						updatedAt: nowTime,
					},
					$setOnInsert: {
						createdAt: oldSystemDoc?.createdAt || nowTime,
					},
					$push: {
						reviewLogs: buildReviewLog("publish.system.upsert", {
							actorUserId: userId,
							ownerUserId,
							flowId,
							systemFlowId,
							version: nextSystemVersion,
							channel,
						}),
					},
				},
				{ upsert: true }
			);
			systemRet = await dbManageFlows.findOne({ userId: systemOwnerId, flowId: systemFlowId });
		}
		const ret = await dbManageFlows.findOne({ userId: ownerUserId, flowId });
		res.json({
			code: 200,
			flow: buildFlowSummary(ret, false),
			systemFlow: systemRet ? buildFlowSummary(systemRet, false) : null,
		});
	};

	apiMap["unpublishFlow"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, flowId, flowDoc, nowTime;
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		flowId = asText(reqVO.flowId);
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		if (!flowId) {
			res.json({ code: 400, info: "Missing flowId." });
			return;
		}
		flowDoc = await dbManageFlows.findOne({ userId, flowId });
		if (!flowDoc) {
			res.json({ code: 404, info: "Flow not found." });
			return;
		}
		nowTime = new Date();
		await dbManageFlows.updateOne(
			{ userId, flowId },
			{
				$set: {
					published: {
						isPublished: false,
						channel: null,
						publishedAt: null,
					},
					status: "UNPUBLISHED",
					updatedAt: nowTime,
				},
			}
		);
		const ret = await dbManageFlows.findOne({ userId, flowId });
		res.json({ code: 200, flow: buildFlowSummary(ret, false) });
	};

	apiMap["saveQueryCache"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo;
		let hostname, flowId, lan, kind, cacheKey, query, queryHash, mode, policy, sigKey, sigKeyHash, value;
		let source, score, status, nowTime, oldDoc, version;
		if (!dbManageFlowCaches) {
			res.json({ code: 500, info: "DBManageFlowCaches is not enabled." });
			return;
		}
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		hostname = asText(reqVO.hostname).toLowerCase();
		flowId = asText(reqVO.flowId);
		lan = asText(reqVO.lan || "web");
		kind = normalizeCacheKind(reqVO.kind);
		cacheKey = asText(reqVO.cacheKey);
		query = asText(reqVO.query);
		mode = asText(reqVO.mode || "instance");
		policy = asText(reqVO.policy || "single");
		sigKey = asText(reqVO.sigKey);
		source = asText(reqVO.source || "manual");
		score = Number.isFinite(Number(reqVO.score)) ? Number(reqVO.score) : null;
		status = normalizeCacheStatus(reqVO.status || "active");
		if (!hostname || !flowId || !lan || !kind || !cacheKey) {
			res.json({ code: 400, info: "Missing hostname/flowId/lan/kind/cacheKey." });
			return;
		}
		value = normalizeCacheValue(kind, reqVO.value);
		if ((kind === "selector" && (!Array.isArray(value) || !value.length)) || (kind === "code" && !asText(value))) {
			res.json({ code: 400, info: "Invalid cache value." });
			return;
		}
		queryHash = hashText(query);
		sigKeyHash = hashText(sigKey);
		nowTime = new Date();
		oldDoc = await dbManageFlowCaches.findOne({ hostname, flowId, lan, kind, cacheKey }, { projection: { version: 1, createdAt: 1 } });
		version = asInt(oldDoc?.version, 0) + 1;
		await dbManageFlowCaches.updateOne(
			{ hostname, flowId, lan, kind, cacheKey },
			{
				$set: {
					userId,
					hostname,
					flowId,
					lan,
					kind,
					cacheKey,
					query,
					queryHash,
					mode,
					policy,
					sigKey,
					sigKeyHash,
					value,
					status,
					source,
					score,
					version,
					updatedAt: nowTime,
				},
				$setOnInsert: {
					createdAt: nowTime,
				},
			},
			{ upsert: true }
		);
		const doc = await dbManageFlowCaches.findOne({ hostname, flowId, lan, kind, cacheKey });
		res.json({ code: 200, cache: buildCacheSummary(doc) });
	};

	apiMap["getQueryCache"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, hostname, flowId, lan, kind, cacheKey, doc;
		if (!dbManageFlowCaches) {
			res.json({ code: 500, info: "DBManageFlowCaches is not enabled." });
			return;
		}
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		hostname = asText(reqVO.hostname).toLowerCase();
		flowId = asText(reqVO.flowId);
		lan = asText(reqVO.lan || "web");
		kind = normalizeCacheKind(reqVO.kind);
		cacheKey = asText(reqVO.cacheKey);
		if (!hostname || !flowId || !lan || !kind || !cacheKey) {
			res.json({ code: 400, info: "Missing hostname/flowId/lan/kind/cacheKey." });
			return;
		}
		doc = await dbManageFlowCaches.findOne({ hostname, flowId, lan, kind, cacheKey });
		if (!doc) {
			res.json({ code: 404, info: "Query cache not found." });
			return;
		}
		res.json({ code: 200, cache: buildCacheSummary(doc) });
	};

	apiMap["findQueryCache"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, hostname, flowId, lan, kind, cacheKey, query, sigKey;
		let topK, queryHash, sigKeyHash, items = [], ret = [];
		if (!dbManageFlowCaches) {
			res.json({ code: 500, info: "DBManageFlowCaches is not enabled." });
			return;
		}
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		hostname = asText(reqVO.hostname).toLowerCase();
		flowId = asText(reqVO.flowId);
		lan = asText(reqVO.lan || "web");
		kind = normalizeCacheKind(reqVO.kind);
		cacheKey = asText(reqVO.cacheKey);
		query = asText(reqVO.query);
		sigKey = asText(reqVO.sigKey);
		topK = Math.max(1, Math.min(50, asInt(reqVO.topK, 5)));
		if (!hostname || !flowId || !lan || !kind) {
			res.json({ code: 400, info: "Missing hostname/flowId/lan/kind." });
			return;
		}
		queryHash = hashText(query);
		sigKeyHash = hashText(sigKey);

		if (cacheKey) {
			const exact = await dbManageFlowCaches.findOne({ hostname, flowId, lan, kind, cacheKey, status: { $ne: "disabled" } });
			if (exact) {
				res.json({
					code: 200,
					best: buildCacheSummary(exact),
					items: [buildCacheSummary(exact)],
					matchBy: "cacheKey",
				});
				return;
			}
		}

		if (queryHash) {
			const qItems = await dbManageFlowCaches
				.find({ hostname, flowId, lan, kind, queryHash, status: { $ne: "disabled" } })
				.sort({ updatedAt: -1 })
				.limit(topK)
				.toArray();
			if (qItems.length) {
				res.json({
					code: 200,
					best: buildCacheSummary(qItems[0]),
					items: qItems.map(buildCacheSummary),
					matchBy: "queryHash",
				});
				return;
			}
		}

		if (sigKeyHash) {
			items = await dbManageFlowCaches
				.find({ hostname, flowId, lan, kind, sigKeyHash, status: { $ne: "disabled" } })
				.sort({ updatedAt: -1 })
				.limit(topK)
				.toArray();
			if (items.length) {
				res.json({
					code: 200,
					best: buildCacheSummary(items[0]),
					items: items.map(buildCacheSummary),
					matchBy: "sigKeyHash",
				});
				return;
			}
		}

		ret = await dbManageFlowCaches
			.find({ hostname, flowId, lan, kind, status: { $ne: "disabled" } })
			.sort({ updatedAt: -1 })
			.limit(topK)
			.toArray();
		res.json({
			code: 200,
			best: ret.length ? buildCacheSummary(ret[0]) : null,
			items: ret.map(buildCacheSummary),
			matchBy: ret.length ? "fallback_recent" : "none",
		});
	};

	apiMap["listQueryCaches"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, limit, skip, queryVO, items;
		if (!dbManageFlowCaches) {
			res.json({ code: 500, info: "DBManageFlowCaches is not enabled." });
			return;
		}
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		limit = Math.max(1, Math.min(200, asInt(reqVO.limit, 50)));
		skip = Math.max(0, asInt(reqVO.skip, 0));
		queryVO = {};
		if (asText(reqVO.hostname)) queryVO.hostname = asText(reqVO.hostname).toLowerCase();
		if (asText(reqVO.flowId)) queryVO.flowId = asText(reqVO.flowId);
		if (asText(reqVO.lan)) queryVO.lan = asText(reqVO.lan);
		if (asText(reqVO.kind)) queryVO.kind = normalizeCacheKind(reqVO.kind);
		if (asText(reqVO.status)) queryVO.status = normalizeCacheStatus(reqVO.status);
		items = await dbManageFlowCaches
			.find(queryVO)
			.sort({ updatedAt: -1 })
			.skip(skip)
			.limit(limit)
			.toArray();
		res.json({
			code: 200,
			items: items.map(buildCacheSummary),
			total: items.length,
		});
	};

	apiMap["disableQueryCache"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, hostname, flowId, lan, kind, cacheKey, ret;
		if (!dbManageFlowCaches) {
			res.json({ code: 500, info: "DBManageFlowCaches is not enabled." });
			return;
		}
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		hostname = asText(reqVO.hostname).toLowerCase();
		flowId = asText(reqVO.flowId);
		lan = asText(reqVO.lan || "web");
		kind = normalizeCacheKind(reqVO.kind);
		cacheKey = asText(reqVO.cacheKey);
		if (!hostname || !flowId || !lan || !kind || !cacheKey) {
			res.json({ code: 400, info: "Missing hostname/flowId/lan/kind/cacheKey." });
			return;
		}
		await dbManageFlowCaches.updateOne(
			{ hostname, flowId, lan, kind, cacheKey },
			{ $set: { status: "disabled", updatedAt: new Date(), userId } }
		);
		ret = await dbManageFlowCaches.findOne({ hostname, flowId, lan, kind, cacheKey });
		if (!ret) {
			res.json({ code: 404, info: "Query cache not found." });
			return;
		}
		res.json({ code: 200, cache: buildCacheSummary(ret) });
	};

	apiMap["deleteQueryCache"] = async function (req, res, next) {
		let reqVO, userId, token, userInfo, hostname, flowId, lan, kind, cacheKey, delRet;
		if (!dbManageFlowCaches) {
			res.json({ code: 500, info: "DBManageFlowCaches is not enabled." });
			return;
		}
		reqVO = req.body.vo || {};
		userId = asText(reqVO.userId);
		token = reqVO.token;
		userInfo = await getUserInfo(req, userId, token);
		if (!userInfo) {
			res.json({ code: 403, info: "UserId/Token invalid." });
			return;
		}
		hostname = asText(reqVO.hostname).toLowerCase();
		flowId = asText(reqVO.flowId);
		lan = asText(reqVO.lan || "web");
		kind = normalizeCacheKind(reqVO.kind);
		cacheKey = asText(reqVO.cacheKey);
		if (!hostname || !flowId || !lan || !kind || !cacheKey) {
			res.json({ code: 400, info: "Missing hostname/flowId/lan/kind/cacheKey." });
			return;
		}
		delRet = await dbManageFlowCaches.deleteOne({ hostname, flowId, lan, kind, cacheKey });
		if (!delRet?.deletedCount) {
			res.json({ code: 404, info: "Query cache not found." });
			return;
		}
		res.json({ code: 200 });
	};
}
