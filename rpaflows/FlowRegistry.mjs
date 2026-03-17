import pathLib from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promises as fsp } from "fs";
import { getFlowRemoteProvider } from "./RemoteSourceProviders.mjs";
import { normalizePolicy, getReadOrder, policyUsesCloud, policyUsesLocal } from "./SourcePolicy.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);

const state = {
	loaded: false,
	entries: [],
	byId: new Map(),
	byEntryId: new Map(),
	byFlowIdAll: new Map(),
	sources: [],
	remoteLoaded: false,
	remoteEntries: [],
	remoteById: new Map(),
	remoteByEntryId: new Map(),
	remoteByFlowIdAll: new Map(),
};

function splitCSV(v) {
	if (!v) return [];
	return String(v)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function getDefaultFlowDirs() {
	const dirs = [];
	dirs.push(pathLib.join(__dirname, "flows"));
	const envDirs = splitCSV(process.env.FLOW_DIRS || "");
	for (const d of envDirs) dirs.push(pathLib.isAbsolute(d) ? d : pathLib.resolve(process.cwd(), d));
	return Array.from(new Set(dirs));
}

function isFlowFile(name) {
	return /\.(mjs|js|json)$/i.test(name || "");
}

function extractFlowObject(obj) {
	if (obj && typeof obj === "object" && Array.isArray(obj.steps) && obj.start && obj.id) {
		return { root: obj, flow: obj };
	}
	if (obj && typeof obj === "object" && obj.flow && Array.isArray(obj.flow.steps) && obj.flow.start && obj.flow.id) {
		return { root: obj, flow: obj.flow };
	}
	return null;
}

function listCapKeys(capabilities) {
	if (!capabilities) return [];
	if (Array.isArray(capabilities)) return capabilities.map((x) => String(x || "").trim()).filter(Boolean);
	if (typeof capabilities === "object") {
		const out = new Set();
		if (Array.isArray(capabilities.must)) for (const k of capabilities.must) out.add(String(k || "").trim());
		if (Array.isArray(capabilities.prefer)) for (const k of capabilities.prefer) out.add(String(k || "").trim());
		if (Array.isArray(capabilities.can)) for (const k of capabilities.can) out.add(String(k || "").trim());
		if (Array.isArray(capabilities.caps)) for (const k of capabilities.caps) out.add(String(k || "").trim());
		for (const k of Object.keys(capabilities)) {
			if (["must", "prefer", "can", "caps"].includes(k)) continue;
			if (capabilities[k]) out.add(String(k).trim());
		}
		return Array.from(out).filter(Boolean);
	}
	return [];
}

function normFilters(filters) {
	if (!Array.isArray(filters)) return [];
	return filters
		.map((f) => {
			if (!f || typeof f !== "object") return null;
			const key = String(f.key || "").trim();
			const value = String(f.value ?? "").trim();
			if (!key || !value) return null;
			return { key, value };
		})
		.filter(Boolean);
}

function normIdToken(v) {
	return String(v || "").trim().replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

function shortHash36(text) {
	const s = String(text || "");
	let h = 2166136261 >>> 0;
	for (let i = 0; i < s.length; i += 1) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}

function buildSourceRef(source) {
	const raw = String(source || "").trim();
	if (!raw) return "unknown:unknown";
	if (/^remote:/i.test(raw)) return raw;
	if (/^https?:\/\//i.test(raw)) return `url:${raw}`;
	return `file:${pathLib.resolve(raw)}`;
}

function buildEntryId(flowId, source) {
	const base = normIdToken(pathLib.basename(String(source || ""), pathLib.extname(String(source || ""))));
	const hash = shortHash36(buildSourceRef(source));
	return `${normIdToken(flowId)}#${base}_${hash}`;
}

function normalizeEntry({ root, flow, source }) {
	const capabilities = root.capabilities || flow.capabilities || null;
	const filters = root.filters || flow.filters || [];
	const ranks = root.ranks || flow.ranks || {};
	const kind = String(root.kind || flow.kind || "rpa");
	const capKeys = listCapKeys(capabilities);
	const sourceRef = buildSourceRef(source);
	const entry = {
		id: String(flow.id),
		entryId: buildEntryId(String(flow.id), source),
		flow,
		source,
		sourceRef,
		kind,
		capKeys,
		capSet: new Set(capKeys),
		filters: normFilters(filters),
		ranks: ranks && typeof ranks === "object" ? ranks : {},
		raw: root,
	};
	return entry;
}

async function loadFlowFile(fullPath) {
	if (fullPath.endsWith(".json")) {
		return JSON.parse(await fsp.readFile(fullPath, "utf8"));
	}
	const mod = await import(pathToFileURL(fullPath).href);
	return mod.default || mod.flow || mod;
}

async function scanDirs(dirs, logger = null) {
	const entries = [];
	for (const dir of dirs) {
		try {
			const items = await fsp.readdir(dir, { withFileTypes: true });
			for (const item of items) {
				if (!item.isFile()) continue;
				if (!isFlowFile(item.name)) continue;
				const full = pathLib.join(dir, item.name);
				try {
					const loaded = await loadFlowFile(full);
					const parsed = extractFlowObject(loaded);
					if (!parsed) continue;
					entries.push(normalizeEntry({ ...parsed, source: full }));
				} catch (e) {
					await logger?.warn("flow.registry.load_failed", { source: full, reason: e?.message || String(e) });
				}
			}
		} catch (_) {
		}
	}
	return entries;
}

async function ensureFlowRegistry({ force = false, logger = null } = {}) {
	if (state.loaded && !force) return state;
	const dirs = getDefaultFlowDirs();
	const scanned = await scanDirs(dirs, logger);
	const byId = new Map();
	const byEntryId = new Map();
	const byFlowIdAll = new Map();
	const duplicateRows = [];
	for (let i = 0; i < scanned.length; i += 1) {
		const e = scanned[i];
		if (byEntryId.has(e.entryId)) {
			e.entryId = `${e.entryId}_${i + 1}`;
		}
		byEntryId.set(e.entryId, e);
		if (!byFlowIdAll.has(e.id)) byFlowIdAll.set(e.id, []);
		byFlowIdAll.get(e.id).push(e);
		if (!byId.has(e.id)) byId.set(e.id, e);
		else {
			const first = byId.get(e.id);
			duplicateRows.push({
				flowId: e.id,
				first: first?.source || "",
				ignored: e.source || "",
				chosenEntryId: first?.entryId || "",
			});
		}
	}
	state.loaded = true;
	state.entries = scanned;
	state.byId = byId;
	state.byEntryId = byEntryId;
	state.byFlowIdAll = byFlowIdAll;
	state.sources = dirs;
	if (duplicateRows.length) {
		await logger?.warn("flow.registry.duplicate_flow_id", {
			count: duplicateRows.length,
			sample: duplicateRows.slice(0, 10),
			policy: "keep first by scan order; target may use entryId for deterministic selection",
		});
	}
	await logger?.info("flow.registry.loaded", {
		dirs,
		count: scanned.length,
		distinctFlowIds: byId.size,
		duplicateFlowIds: duplicateRows.length,
	});
	return state;
}

function buildMapsFromEntries(scanned) {
	const byId = new Map();
	const byEntryId = new Map();
	const byFlowIdAll = new Map();
	for (let i = 0; i < scanned.length; i += 1) {
		const e = scanned[i];
		if (byEntryId.has(e.entryId)) {
			e.entryId = `${e.entryId}_${i + 1}`;
		}
		byEntryId.set(e.entryId, e);
		if (!byFlowIdAll.has(e.id)) byFlowIdAll.set(e.id, []);
		byFlowIdAll.get(e.id).push(e);
		if (!byId.has(e.id)) byId.set(e.id, e);
	}
	return { byId, byEntryId, byFlowIdAll };
}

function normalizeRemoteSource(rawSource, index) {
	const s = String(rawSource || "").trim();
	if (s) return s;
	return `remote:flow_provider:${index + 1}`;
}

function parseRemoteFlowEntry(raw, index) {
	if (!raw) return null;
	const source = normalizeRemoteSource(raw?.source, index);
	if (raw && typeof raw === "object" && raw.flow && typeof raw.flow === "object") {
		const parsed = extractFlowObject(raw.flow);
		if (!parsed) return null;
		const root = {
			...parsed.root,
			...(raw.capabilities != null ? { capabilities: raw.capabilities } : null),
			...(raw.filters != null ? { filters: raw.filters } : null),
			...(raw.ranks != null ? { ranks: raw.ranks } : null),
			...(raw.kind != null ? { kind: raw.kind } : null),
		};
		return normalizeEntry({ root, flow: parsed.flow, source });
	}
	const parsed = extractFlowObject(raw);
	if (!parsed) return null;
	return normalizeEntry({ ...parsed, source });
}

async function ensureRemoteFlowRegistry({ force = false, logger = null } = {}) {
	if (state.remoteLoaded && !force) {
		return {
			entries: state.remoteEntries,
			byId: state.remoteById,
			byEntryId: state.remoteByEntryId,
			byFlowIdAll: state.remoteByFlowIdAll,
		};
	}
	const provider = await getFlowRemoteProvider({ logger });
	let rawEntries = [];
	try {
		rawEntries = await provider.listFlowEntries({ logger });
		if (!Array.isArray(rawEntries)) rawEntries = [];
	} catch (e) {
		await logger?.warn("flow.remote.list_failed", {
			provider: provider?.name || "unknown",
			reason: e?.message || String(e),
		});
		rawEntries = [];
	}
	const scanned = [];
	for (let i = 0; i < rawEntries.length; i += 1) {
		const parsed = parseRemoteFlowEntry(rawEntries[i], i);
		if (parsed) scanned.push(parsed);
	}
	const maps = buildMapsFromEntries(scanned);
	state.remoteLoaded = true;
	state.remoteEntries = scanned;
	state.remoteById = maps.byId;
	state.remoteByEntryId = maps.byEntryId;
	state.remoteByFlowIdAll = maps.byFlowIdAll;
	await logger?.info("flow.remote.loaded", {
		provider: provider?.name || "unknown",
		count: scanned.length,
		distinctFlowIds: maps.byId.size,
	});
	return {
		entries: scanned,
		byId: maps.byId,
		byEntryId: maps.byEntryId,
		byFlowIdAll: maps.byFlowIdAll,
	};
}

function mergeEntriesByPolicy(localEntries, remoteEntries, policyRaw) {
	const policy = normalizePolicy(policyRaw, "prefer_local");
	if (policy === "local") return Array.from(localEntries || []);
	if (policy === "cloud") return Array.from(remoteEntries || []);
	const order = getReadOrder(policy, "prefer_local");
	if (order[0] === "cloud") {
		return [...(remoteEntries || []), ...(localEntries || [])];
	}
	return [...(localEntries || []), ...(remoteEntries || [])];
}

async function resolveFlowEntryById(id, { sourcePolicy = "", logger = null } = {}) {
	const key = String(id || "").trim();
	if (!key) return null;
	const policy = normalizePolicy(sourcePolicy || process.env.FLOW_SOURCE_POLICY || "", "prefer_local");
	const needLocal = policyUsesLocal(policy, "prefer_local");
	const needRemote = policyUsesCloud(policy, "prefer_local");
	let local = null;
	let remote = null;
	if (needLocal) {
		await ensureFlowRegistry({ logger });
		local = state.byEntryId.get(key) || state.byId.get(key) || null;
	}
	if (needRemote) {
		await ensureRemoteFlowRegistry({ logger });
		remote = state.remoteByEntryId.get(key) || state.remoteById.get(key) || null;
	}
	const order = getReadOrder(policy, "prefer_local");
	for (const src of order) {
		if (src === "local" && local) return local;
		if (src === "cloud" && remote) return remote;
	}
	return null;
}

async function resolveFlowEntriesById(id, { sourcePolicy = "", logger = null } = {}) {
	const key = String(id || "").trim();
	if (!key) return [];
	const policy = normalizePolicy(sourcePolicy || process.env.FLOW_SOURCE_POLICY || "", "prefer_local");
	let localEntries = [];
	let remoteEntries = [];
	if (policyUsesLocal(policy, "prefer_local")) {
		await ensureFlowRegistry({ logger });
		localEntries = [
			...(state.byFlowIdAll.get(key) || []),
			...(state.byEntryId.get(key) ? [state.byEntryId.get(key)] : []),
		];
	}
	if (policyUsesCloud(policy, "prefer_local")) {
		await ensureRemoteFlowRegistry({ logger });
		remoteEntries = [
			...(state.remoteByFlowIdAll.get(key) || []),
			...(state.remoteByEntryId.get(key) ? [state.remoteByEntryId.get(key)] : []),
		];
	}
	const all = mergeEntriesByPolicy(localEntries, remoteEntries, policy);
	const seen = new Set();
	return all.filter((e) => {
		const k = String(e?.entryId || "");
		if (!k || seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

async function resolveFlowEntriesForFind({ sourcePolicy = "", excludeFlowId = "", logger = null } = {}) {
	const policy = normalizePolicy(sourcePolicy || process.env.FLOW_SOURCE_POLICY || "", "prefer_local");
	let localEntries = [];
	let remoteEntries = [];
	if (policyUsesLocal(policy, "prefer_local")) {
		await ensureFlowRegistry({ logger });
		localEntries = Array.from(state.entries || []);
	}
	if (policyUsesCloud(policy, "prefer_local")) {
		await ensureRemoteFlowRegistry({ logger });
		remoteEntries = Array.from(state.remoteEntries || []);
	}
	const all = mergeEntriesByPolicy(localEntries, remoteEntries, policy);
	const exclude = String(excludeFlowId || "").trim();
	if (!exclude) return all;
	return all.filter((e) => String(e?.id || "") !== exclude);
}

function getFlowEntryById(id) {
	const key = String(id || "").trim();
	if (!key) return null;
	return state.byEntryId.get(key) || state.byId.get(key) || null;
}

function getFlowEntriesById(id) {
	const key = String(id || "").trim();
	if (!key) return [];
	return Array.from(state.byFlowIdAll.get(key) || []);
}

function listFlowEntries() {
	return Array.from(state.entries || []);
}

export {
	ensureFlowRegistry,
	getFlowEntryById,
	getFlowEntriesById,
	listFlowEntries,
	resolveFlowEntryById,
	resolveFlowEntriesById,
	resolveFlowEntriesForFind,
};
