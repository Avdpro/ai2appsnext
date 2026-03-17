import {
	ensureFlowRegistry,
	resolveFlowEntryById,
	resolveFlowEntriesById,
	resolveFlowEntriesForFind,
} from "./FlowRegistry.mjs";
import { findBestFlowEntry } from "./FlowFinder.mjs";
import { runFlow } from "./FlowRunner.mjs";
import { parseFlowVal } from "./FlowExpr.mjs";
import { normalizePolicy } from "./SourcePolicy.mjs";

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

async function invokeFlowAction({ action, args, opts, vars, lastResult, session = null, webRpa, page, logger = null, callerFlowId = "" }) {
	await ensureFlowRegistry({ logger });

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
		const dupCandidates = await resolveFlowEntriesById(targetRaw, { sourcePolicy, logger });
		targetEntry = await resolveFlowEntryById(targetRaw, { sourcePolicy, logger });
		if (dupCandidates.length > 1 && targetEntry) {
			await logger?.warn("invoke.target.duplicate_id", {
				target: targetRaw,
				chosenEntryId: targetEntry.entryId || "",
				chosenSource: targetEntry.source || "",
				candidateCount: dupCandidates.length,
				candidates: dupCandidates.slice(0, 8).map((e) => ({
					entryId: e.entryId || "",
					source: e.source || "",
				})),
			});
		}
		if (targetEntry && callerFlowId && String(targetEntry.id || "") === String(callerFlowId || "")) {
			const reason = `invoke target cannot be current flow itself: ${callerFlowId}`;
			if (onError === "return") return { status: "done", value: { ok: false, reason } };
			return { status: "failed", reason };
		}
		if (!targetEntry) {
			const reason = `invoke target flow not found: ${action.target} (sourcePolicy=${sourcePolicy})`;
			if (onError === "return") return { status: "done", value: { ok: false, reason } };
			return { status: "failed", reason };
		}
	} else {
		const entries = await resolveFlowEntriesForFind({
			sourcePolicy,
			excludeFlowId: callerFlowId,
			logger,
		});
		const found = findBestFlowEntry(entries, action?.find || null);
		if (!found.ok || !found.entry) {
			const reason = found.reason || "invoke find failed";
			if (onError === "return") return { status: "done", value: { ok: false, reason } };
			return { status: "failed", reason };
		}
		targetEntry = found.entry;
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
		opts,
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
			meta: { invoke: { flowId: targetEntry.id, status: subResult.status, reason: subResult.reason || "" } },
		};
	}

	const reason = subResult?.reason || `invoke failed: ${targetEntry.id}`;
	await logger?.warn("invoke.failed", { targetFlowId: targetEntry.id, reason, onError });
	if (onError === "return") {
		return {
			status: "done",
			value: { ok: false, flowId: targetEntry.id, status: subResult?.status || "failed", reason },
			meta: { invoke: { flowId: targetEntry.id, status: subResult?.status || "failed", reason } },
		};
	}
	return { status: "failed", reason, meta: { invoke: { flowId: targetEntry.id, status: subResult?.status || "failed" } } };
}

export { invokeFlowAction, expandDottedKeys };
