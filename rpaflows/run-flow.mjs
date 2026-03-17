import pathLib from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promises as fsp } from "fs";
import dotenv from "dotenv";
import WebRpa from "./WebDriveRpa.mjs";
import { runFlow } from "./FlowRunner.mjs";
import { createFlowLogger } from "./FlowLogger.mjs";
import { ensureFlowRegistry } from "./FlowRegistry.mjs";
import { auditFlow, buildAuditPolicyFromRuntime } from "./FlowAudit.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
dotenv.config({ path: pathLib.join(__dirname, ".env") });

function getArg(name, fallback = "") {
	const prefix = `--${name}=`;
	const found = process.argv.find((v) => v.startsWith(prefix));
	return found ? found.slice(prefix.length) : fallback;
}

function parseBoolArg(raw, fallback = false) {
	if (raw == null || raw === "") return fallback;
	const s = String(raw).trim().toLowerCase();
	if (["1", "true", "yes", "y", "on"].includes(s)) return true;
	if (["0", "false", "no", "n", "off"].includes(s)) return false;
	return fallback;
}

async function loadFlow(flowPath) {
	if (!flowPath) throw new Error("missing --flow=<path>");
	let full = pathLib.isAbsolute(flowPath) ? flowPath : pathLib.resolve(process.cwd(), flowPath);
	try {
		await fsp.access(full);
	} catch (_) {
		const fallback = pathLib.join(__dirname, "flows", flowPath);
		try {
			await fsp.access(fallback);
			full = fallback;
		} catch (_) {
		}
	}
	if (full.endsWith(".json")) {
		return JSON.parse(await fsp.readFile(full, "utf8"));
	}
	const mod = await import(pathToFileURL(full).href);
	return mod.default || mod.flow || mod;
}

function extractFlowObject(obj) {
	if (obj && typeof obj === "object" && Array.isArray(obj.steps) && obj.start) return obj;
	if (obj && typeof obj === "object" && obj.flow && Array.isArray(obj.flow.steps) && obj.flow.start) return obj.flow;
	throw new Error("invalid flow module/object: missing flow.start/flow.steps");
}

async function loadArgs(argsPath) {
	if (!argsPath) return {};
	const full = pathLib.isAbsolute(argsPath) ? argsPath : pathLib.resolve(process.cwd(), argsPath);
	return JSON.parse(await fsp.readFile(full, "utf8"));
}

async function loadOpts(optsPath) {
	if (!optsPath) return {};
	const full = pathLib.isAbsolute(optsPath) ? optsPath : pathLib.resolve(process.cwd(), optsPath);
	return JSON.parse(await fsp.readFile(full, "utf8"));
}

async function main() {
	const flowPath = getArg("flow");
	const argsPath = getArg("args", "");
	const optsPath = getArg("opts", "");
	const url = getArg("url", "");
	const alias = getArg("alias", "flow_runner");
	const holdMs = Number(getArg("hold-ms", "0"));
	const selectorSupervision = parseBoolArg(getArg("supervise-selector", ""), false)
		|| parseBoolArg(process.env.FLOW_SUPERVISE_SELECTOR, false);
	const launchMode = process.env.WEBRPA_WEBDRIVE_MODE || "direct";

	const flowLoaded = await loadFlow(flowPath);
	const flow = extractFlowObject(flowLoaded);
	const args = await loadArgs(argsPath);
	const loadedOpts = await loadOpts(optsPath);
	const aiOpts = {
		provider: String(getArg("ai-provider", "") || "").trim(),
		fallbackProvider: String(getArg("ai-fallback-provider", "") || "").trim(),
		runAiProvider: String(getArg("ai-run-ai-provider", "") || "").trim(),
		runAiFallbackProvider: String(getArg("ai-run-ai-fallback-provider", "") || "").trim(),
		selectorProvider: String(getArg("ai-selector-provider", "") || "").trim(),
		selectorFallbackProvider: String(getArg("ai-selector-fallback-provider", "") || "").trim(),
		runJsProvider: String(getArg("ai-run-js-provider", "") || "").trim(),
		runJsFallbackProvider: String(getArg("ai-run-js-fallback-provider", "") || "").trim(),
	};
	const hasAiOpt = Object.values(aiOpts).some((v) => !!v);
	const runtimeOpts = {
		...(loadedOpts && typeof loadedOpts === "object" ? loadedOpts : {}),
		url,
		selectorSupervision,
		...(hasAiOpt
			? {
				ai: {
					...((loadedOpts && typeof loadedOpts === "object" && loadedOpts.ai && typeof loadedOpts.ai === "object") ? loadedOpts.ai : {}),
					...Object.fromEntries(Object.entries(aiOpts).filter(([, v]) => !!v)),
				},
			}
			: {}),
	};
	const auditPolicy = buildAuditPolicyFromRuntime({
		cli: {
			mode: getArg("audit-mode", ""),
			allowActions: getArg("audit-allow-actions", ""),
			denyActions: getArg("audit-deny-actions", ""),
			aiEnabled: getArg("audit-ai", ""),
			aiTier: getArg("audit-ai-tier", ""),
			aiProvider: getArg("audit-ai-provider", ""),
			aiModel: getArg("audit-ai-model", ""),
			aiTimeoutMs: getArg("audit-ai-timeout-ms", ""),
			aiIncludeRunJsWithCode: getArg("audit-ai-run-js-with-code", ""),
		},
		env: process.env,
		opts: runtimeOpts,
	});
	const logDir = process.env.FLOW_LOG_DIR || pathLib.join(__dirname, "flow-logs");
	const logger = await createFlowLogger({
		logDir,
		flowId: flow.id || "flow",
		runId: getArg("run-id", ""),
		echoConsole: process.env.FLOW_LOG_CONSOLE !== "0",
	});

	const sessionStub = { agentNode: null, options: { webDriveMode: launchMode } };
	const webRpa = new WebRpa(sessionStub, { webDriveMode: launchMode });
	let browser = null;
	try {
		await ensureFlowRegistry({ logger });
		await logger.info("runner.start", { flowPath, alias, url: url || null, selectorSupervision });
		const auditResult = await auditFlow({ flow, args, policy: auditPolicy, logger });
		const previewFindings = Array.isArray(auditResult.findings) ? auditResult.findings.slice(0, 10) : [];
		await logger.info("flow.audit", {
			mode: auditResult.mode,
			blocked: false,
			wouldBlock: !!auditResult.wouldBlock,
			summary: auditResult.summary,
			findings: previewFindings,
			totalFindings: Array.isArray(auditResult.findings) ? auditResult.findings.length : 0,
			maxRiskLevel: auditResult?.overview?.maxRiskLevel || "info",
		});
		browser = await webRpa.openBrowser(alias, {
			launchMode: "direct",
			pathToFireFox: process.env.WEBDRIVE_APP,
		});

		const page = await webRpa.openPage(browser);
		if (url) await page.goto(url);
		const result = await runFlow({ flow, webRpa, page, session: sessionStub, args, opts: runtimeOpts, logger });
		await logger.info("runner.result", { status: result.status, reason: result.reason || "" });
		console.log(JSON.stringify(result, null, 2));
		console.log(`[run-flow] log file: ${logger.filePath}`);
		if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
	} finally {
		if (browser) await webRpa.closeBrowser(browser);
		await logger?.info("runner.end", {});
		await logger?.close();
	}
}

main().catch((err) => {
	console.error("[run-flow] ERROR:", err?.stack || err?.message || err);
	process.exit(1);
});
