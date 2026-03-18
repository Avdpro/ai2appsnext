import pathLib from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promises as fsp } from "fs";
import dotenv from "dotenv";
import { auditFlow, buildAuditPolicyFromRuntime } from "../rpaflows/FlowAudit.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
const PROJECT_ROOT = pathLib.resolve(__dirname, "..");
const FLOWS_ROOT = pathLib.join(PROJECT_ROOT, "rpaflows", "flows");
const AUDIT_PAGE_PATH = pathLib.join(PROJECT_ROOT, "public", "rpaflows", "audit.html");
const RPA_ENV_PATH = pathLib.join(PROJECT_ROOT, "rpaflows", ".env");

// Load rpaflows/.env so tier/provider/model routing for audit can work in web mode.
// Do not override already-exported environment variables.
try {
	dotenv.config({ path: RPA_ENV_PATH, override: false });
} catch (_) {}

function asText(v) {
	return String(v == null ? "" : v).trim();
}

function toObject(v, fallback = {}) {
	if (v && typeof v === "object" && !Array.isArray(v)) return v;
	if (typeof v === "string" && v.trim()) {
		try {
			const obj = JSON.parse(v);
			if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
		} catch (_) {}
	}
	return fallback;
}

function normalizeFlowRelPath(inputPath) {
	const rel = asText(inputPath).replace(/\\/g, "/").replace(/^\/+/, "");
	if (!rel) return "";
	const absPath = pathLib.resolve(FLOWS_ROOT, rel);
	const base = FLOWS_ROOT.endsWith(pathLib.sep) ? FLOWS_ROOT : `${FLOWS_ROOT}${pathLib.sep}`;
	if (absPath !== FLOWS_ROOT && !absPath.startsWith(base)) {
		throw new Error("flowPath out of flows root");
	}
	return pathLib.relative(FLOWS_ROOT, absPath).replace(/\\/g, "/");
}

async function listFlowFiles() {
	const out = [];
	async function walk(dirRel = "") {
		const abs = pathLib.join(FLOWS_ROOT, dirRel);
		const entries = await fsp.readdir(abs, { withFileTypes: true });
		for (const ent of entries) {
			if (ent.name.startsWith(".")) continue;
			const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name;
			if (ent.isDirectory()) {
				await walk(rel);
				continue;
			}
			if (!ent.isFile()) continue;
			if (!/\.(json|js|mjs)$/i.test(ent.name)) continue;
			out.push(rel);
		}
	}
	await walk("");
	out.sort((a, b) => a.localeCompare(b));
	return out;
}

async function loadFlowFromPath(flowPath) {
	const rel = normalizeFlowRelPath(flowPath);
	if (!rel) throw new Error("missing flowPath");
	const abs = pathLib.join(FLOWS_ROOT, rel);
	if (rel.toLowerCase().endsWith(".json")) {
		const jsonObj = JSON.parse(await fsp.readFile(abs, "utf8"));
		const flow = extractFlowObject(jsonObj);
		if (flow) return flow;
		throw new Error(`invalid flow json: ${rel} missing start/steps`);
	}
	const mod = await import(pathToFileURL(abs).href);
	const obj = mod.default || mod.flow || mod;
	const flow = extractFlowObject(obj);
	if (flow) return flow;
	throw new Error("invalid flow module/object: missing flow.start/flow.steps");
}

function makeCliAuditInput(audit) {
	const src = toObject(audit, {});
	const allowActions = Array.isArray(src.allowActions) ? src.allowActions.join(",") : asText(src.allowActions);
	const denyActions = Array.isArray(src.denyActions) ? src.denyActions.join(",") : asText(src.denyActions);
	return {
		mode: asText(src.mode),
		allowActions,
		denyActions,
		aiEnabled: (src.aiEnabled === undefined || src.aiEnabled === null) ? "" : String(!!src.aiEnabled),
		aiTier: asText(src.aiTier),
		aiProvider: asText(src.aiProvider),
		aiModel: asText(src.aiModel),
		aiTimeoutMs: asText(src.aiTimeoutMs),
		aiIncludeRunJsWithCode: (src.aiIncludeRunJsWithCode === undefined || src.aiIncludeRunJsWithCode === null) ? "" : String(!!src.aiIncludeRunJsWithCode),
	};
}

function extractFlowObject(raw) {
	if (!raw || typeof raw !== "object") return null;
	if (Array.isArray(raw.steps) && asText(raw.start)) return raw;
	if (raw.flow && typeof raw.flow === "object" && Array.isArray(raw.flow.steps) && asText(raw.flow.start)) {
		const flow = raw.flow;
		if (!flow.id && raw.id) flow.id = raw.id;
		return flow;
	}
	return null;
}

export default function setupRpaFlowAuditRoutes(app, router) {
	router.get("/audit", async (req, res) => {
		res.sendFile(AUDIT_PAGE_PATH);
	});

	router.get("/api/flows", async (req, res) => {
		try {
			const flows = await listFlowFiles();
			res.json({ ok: true, flows });
		} catch (err) {
			res.status(500).json({ ok: false, reason: err?.message || "list flows failed" });
		}
	});

	router.post("/api/audit", async (req, res) => {
		const t0 = Date.now();
		try {
			const body = (req.body && typeof req.body === "object") ? req.body : {};
			const flowText = asText(body.flowText);
			const flowPath = asText(body.flowPath);
			const args = toObject(body.args, {});
			const opts = toObject(body.opts, {});
			const cliAudit = makeCliAuditInput(body.audit);
			const policy = buildAuditPolicyFromRuntime({ cli: cliAudit, env: process.env, opts });
			const sourceLabel = flowText ? "flowText" : (flowPath || "(none)");
			console.log(
				`[RPAFLOWS][audit] begin source=${sourceLabel} aiEnabled=${!!policy?.ai?.enabled} ` +
				`mode=${policy.mode} aiTier=${asText(policy?.ai?.tier || "-")} aiProvider=${asText(policy?.ai?.provider || "(auto)")}`
			);

			let flow = null;
			if (flowText) {
				const parsed = JSON.parse(flowText);
				flow = extractFlowObject(parsed);
				if (!flow) throw new Error("invalid flowText: missing start/steps (or flow.start/flow.steps)");
			} else if (flowPath) {
				flow = await loadFlowFromPath(flowPath);
			} else {
				throw new Error("missing flowText or flowPath");
			}
			if (!flow || typeof flow !== "object") throw new Error("invalid flow object");

			const result = await auditFlow({ flow, args, policy });
			const elapsedMs = Date.now() - t0;
			console.log(
				`[RPAFLOWS][audit] done flowId=${asText(flow.id || "flow")} steps=${flow.steps.length} ` +
				`elapsedMs=${elapsedMs} findings=${Number(result?.findings?.length || 0)} ` +
				`aiCalls=${Number(result?.ai?.calls || 0)} aiFailures=${Number(result?.ai?.failures || 0)}`
			);
			if (Array.isArray(result?.ai?.runs)) {
				const failed = result.ai.runs.filter((r) => !r?.ok).slice(0, 3);
				if (failed.length) {
					console.log("[RPAFLOWS][audit] ai-fail-sample:", failed.map((x) => `${x.stepId}:${x.reason || "unknown"}`).join(" | "));
				}
				const okRuns = result.ai.runs.filter((r) => r?.ok).slice(0, 3);
				if (okRuns.length) {
					console.log("[RPAFLOWS][audit] ai-ok-sample:", okRuns.map((x) => `${x.stepId}:${x.provider || "?"}/${x.model || "?"}`).join(" | "));
				}
			}
			res.json({
				ok: true,
				report: {
					ts: new Date().toISOString(),
					flowId: asText(flow.id || "flow"),
					start: asText(flow.start),
					stepCount: flow.steps.length,
					policy,
					result,
				},
			});
		} catch (err) {
			console.warn(`[RPAFLOWS][audit] failed elapsedMs=${Date.now() - t0} reason=${err?.message || err}`);
			res.status(400).json({ ok: false, reason: err?.message || "audit failed" });
		}
	});
}
