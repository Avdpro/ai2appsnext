import pathLib from "path";
import { pathToFileURL } from "url";

const state = {
	flow: {
		loaded: false,
		provider: null,
	},
	queryCache: {
		loaded: false,
		provider: null,
	},
};

function isObject(v) {
	return !!v && typeof v === "object";
}

function noopAsync(v) {
	return Promise.resolve(v);
}

function normalizeFlowProvider(raw) {
	if (!isObject(raw)) {
		return {
			name: "noop-flow-provider",
			async listFlowEntries() { return []; },
		};
	}
	const p = raw;
	return {
		name: String(p.name || "flow-provider").trim() || "flow-provider",
		listFlowEntries: typeof p.listFlowEntries === "function"
			? p.listFlowEntries.bind(p)
			: () => noopAsync([]),
	};
}

function normalizeQueryCacheProvider(raw) {
	if (!isObject(raw)) {
		return {
			name: "noop-query-cache-provider",
			async openRuleCache() { return null; },
			async flushRuleCache() {},
			resolveRule() { return null; },
			findLooseSelector() { return null; },
			saveSelector() { return { changed: false }; },
		};
	}
	const p = raw;
	return {
		name: String(p.name || "query-cache-provider").trim() || "query-cache-provider",
		openRuleCache: typeof p.openRuleCache === "function"
			? p.openRuleCache.bind(p)
			: (() => noopAsync(null)),
		flushRuleCache: typeof p.flushRuleCache === "function"
			? p.flushRuleCache.bind(p)
			: (() => noopAsync()),
		resolveRule: typeof p.resolveRule === "function"
			? p.resolveRule.bind(p)
			: (() => null),
		findLooseSelector: typeof p.findLooseSelector === "function"
			? p.findLooseSelector.bind(p)
			: (() => null),
		saveSelector: typeof p.saveSelector === "function"
			? p.saveSelector.bind(p)
			: (() => ({ changed: false })),
	};
}

async function loadProviderFromEnv(modulePathRaw, logger = null) {
	const modulePath = String(modulePathRaw || "").trim();
	if (!modulePath) return null;
	const full = pathLib.isAbsolute(modulePath)
		? modulePath
		: pathLib.resolve(process.cwd(), modulePath);
	try {
		const mod = await import(pathToFileURL(full).href);
		return mod?.default || mod?.provider || mod || null;
	} catch (e) {
		await logger?.warn("remote.provider.load_failed", {
			modulePath: full,
			reason: e?.message || String(e),
		});
		return null;
	}
}

function setFlowRemoteProvider(provider) {
	state.flow.provider = normalizeFlowProvider(provider);
	state.flow.loaded = true;
}

async function getFlowRemoteProvider({ logger = null } = {}) {
	if (!state.flow.loaded) {
		const raw = await loadProviderFromEnv(process.env.FLOW_REMOTE_PROVIDER_MODULE || "", logger);
		state.flow.provider = normalizeFlowProvider(raw);
		state.flow.loaded = true;
	}
	return state.flow.provider;
}

function setQueryCacheRemoteProvider(provider) {
	state.queryCache.provider = normalizeQueryCacheProvider(provider);
	state.queryCache.loaded = true;
}

async function getQueryCacheRemoteProvider({ logger = null } = {}) {
	if (!state.queryCache.loaded) {
		const raw = await loadProviderFromEnv(process.env.QUERY_CACHE_REMOTE_PROVIDER_MODULE || "", logger);
		state.queryCache.provider = normalizeQueryCacheProvider(raw);
		state.queryCache.loaded = true;
	}
	return state.queryCache.provider;
}

export {
	setFlowRemoteProvider,
	getFlowRemoteProvider,
	setQueryCacheRemoteProvider,
	getQueryCacheRemoteProvider,
};
