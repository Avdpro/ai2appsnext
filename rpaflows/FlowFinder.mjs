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
	const fields = String(rankStr || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
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

function findBestFlowEntry(entries, findSpec) {
	if (!findSpec || typeof findSpec !== "object") {
		return { ok: false, reason: "invoke.find is required when target missing" };
	}
	const kind = String(findSpec.kind || "rpa");
	const must = Array.isArray(findSpec.must) ? findSpec.must.map((x) => String(x || "").trim()).filter(Boolean) : [];
	const prefer = Array.isArray(findSpec.prefer) ? findSpec.prefer.map((x) => String(x || "").trim()).filter(Boolean) : [];
	const reqFilters = Array.isArray(findSpec.filter) ? findSpec.filter : [];
	const rank = String(findSpec.rank || "");

	const candidates = [];
	for (const e of entries || []) {
		if (kind && String(e.kind || "") !== kind) continue;
		const miss = must.find((k) => !e.capSet?.has(k));
		if (miss) continue;
		const fm = calcFilterMatch(e.filters, reqFilters);
		if (!fm.ok) continue;
		let preferHits = 0;
		for (const k of prefer) if (e.capSet?.has(k)) preferHits++;
		candidates.push({ entry: e, preferHits, filterScore: fm.score });
	}
	if (!candidates.length) {
		return { ok: false, reason: "no flow matched invoke.find" };
	}
	candidates.sort((a, b) => {
		if (a.preferHits !== b.preferHits) return b.preferHits - a.preferHits;
		if (a.filterScore !== b.filterScore) return b.filterScore - a.filterScore;
		const rc = compareRank(a.entry, b.entry, rank);
		if (rc !== 0) return rc;
		return String(a.entry.id).localeCompare(String(b.entry.id));
	});
	return { ok: true, entry: candidates[0].entry, candidates };
}

export { findBestFlowEntry };
