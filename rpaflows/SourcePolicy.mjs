function normalizePolicy(raw, fallback = "prefer_local") {
	const s = String(raw || "").trim().toLowerCase();
	if (s === "local" || s === "cloud" || s === "prefer_local" || s === "prefer_cloud" || s === "merge") {
		return s;
	}
	return fallback;
}

function normalizeWritePolicy(raw, fallback = "local") {
	const s = String(raw || "").trim().toLowerCase();
	if (s === "local" || s === "cloud" || s === "both") return s;
	return fallback;
}

function getReadOrder(policyRaw, fallback = "prefer_local") {
	const policy = normalizePolicy(policyRaw, fallback);
	if (policy === "local") return ["local"];
	if (policy === "cloud") return ["cloud"];
	if (policy === "prefer_cloud") return ["cloud", "local"];
	// prefer_local / merge -> local first
	return ["local", "cloud"];
}

function policyUsesLocal(policyRaw, fallback = "prefer_local") {
	return getReadOrder(policyRaw, fallback).includes("local");
}

function policyUsesCloud(policyRaw, fallback = "prefer_local") {
	return getReadOrder(policyRaw, fallback).includes("cloud");
}

export {
	normalizePolicy,
	normalizeWritePolicy,
	getReadOrder,
	policyUsesLocal,
	policyUsesCloud,
};
