function groupFilterByKey(filterList) {
	const m = new Map();
	for (const f of filterList || []) {
		if (!f || !f.key) continue;
		if (!m.has(f.key)) m.set(f.key, []);
		m.get(f.key).push(String(f.value ?? ""));
	}
	return m;
}

function normalizeDomainToken(raw) {
	let s = String(raw ?? "").trim().toLowerCase();
	if (!s) return "";
	// Accept either plain host or URL-like text.
	try {
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
			const u = new URL(s);
			s = String(u.hostname || "").trim().toLowerCase();
		}
	} catch (_) {
	}
	if (!s) return "";
	// Strip leading dot, trailing dot and port part.
	s = s.replace(/^\.+/, "").replace(/\.+$/, "");
	s = s.replace(/:\d+$/, "");
	return s;
}

function matchDomainLevel(entryValue, wantedValue) {
	const e = normalizeDomainToken(entryValue);
	const w = normalizeDomainToken(wantedValue);
	if (!e || !w) return 0;
	if (e === "*") return 1; // wildcard
	if (e === w) return 3; // exact domain
	// parent-domain match: request is subdomain of entry domain
	if (w.endsWith(`.${e}`)) return 2;
	return 0;
}

function domainLevelLabel(n) {
	const v = Number(n || 0);
	if (v >= 3) return "exact";
	if (v >= 2) return "parent";
	if (v >= 1) return "wildcard";
	return "none";
}

function calcFilterMatch(entryFilters, reqFilters) {
	if (!reqFilters || !reqFilters.length) return { ok: true, score: 0, domainScore: 0 };
	const eMap = groupFilterByKey(entryFilters || []);
	const rMap = groupFilterByKey(reqFilters || []);
	let score = 0;
	let domainScore = 0;
	for (const [key, vals] of rMap.entries()) {
		const entryVals = eMap.get(key) || [];
		if (!entryVals.length) return { ok: false, score: 0, domainScore: 0 };
		let matched = false;
		let local = 0;
		if (String(key || "").toLowerCase() === "domain") {
			for (const want of vals) {
				for (const ent of entryVals) {
					const lv = matchDomainLevel(ent, want);
					if (lv > 0) {
						matched = true;
						local = Math.max(local, lv); // exact(3) > parent(2) > wildcard(1)
					}
				}
			}
			if (!matched) return { ok: false, score: 0, domainScore: 0 };
			domainScore += local;
			score += local;
			continue;
		}
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
		if (!matched) return { ok: false, score: 0, domainScore: 0 };
		score += local;
	}
	return { ok: true, score, domainScore };
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
		candidates.push({
			entry: e,
			preferHits,
			filterScore: fm.score,
			domainScore: Number(fm.domainScore || 0),
			domainLevel: domainLevelLabel(fm.domainScore),
		});
	}
	if (!candidates.length) {
		return { ok: false, reason: "no flow matched invoke.find" };
	}
	candidates.sort((a, b) => {
		// Domain match specificity has higher priority than preferHits.
		// exact(3) > parent(2) > wildcard(1)
		if (a.domainScore !== b.domainScore) return b.domainScore - a.domainScore;
		if (a.preferHits !== b.preferHits) return b.preferHits - a.preferHits;
		if (a.filterScore !== b.filterScore) return b.filterScore - a.filterScore;
		const rc = compareRank(a.entry, b.entry, rank);
		if (rc !== 0) return rc;
		return String(a.entry.id).localeCompare(String(b.entry.id));
	});
	return { ok: true, entry: candidates[0].entry, candidates };
}

export { findBestFlowEntry };
