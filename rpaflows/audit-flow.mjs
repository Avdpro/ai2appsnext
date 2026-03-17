import pathLib from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promises as fsp } from "fs";
import dotenv from "dotenv";
import { auditFlow, buildAuditPolicyFromRuntime } from "./FlowAudit.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
dotenv.config({ path: pathLib.join(__dirname, ".env") });

function getArg(name, fallback = "") {
	const prefix = `--${name}=`;
	const found = process.argv.find((v) => v.startsWith(prefix));
	return found ? found.slice(prefix.length) : fallback;
}

async function loadFlow(flowPath) {
	if (!flowPath) throw new Error("missing --flow=<path>");
	let full = pathLib.isAbsolute(flowPath) ? flowPath : pathLib.resolve(process.cwd(), flowPath);
	try {
		await fsp.access(full);
	} catch (_) {
		const fallback = pathLib.join(__dirname, "flows", flowPath);
		await fsp.access(fallback);
		full = fallback;
	}
	if (full.endsWith(".json")) return JSON.parse(await fsp.readFile(full, "utf8"));
	const mod = await import(pathToFileURL(full).href);
	const obj = mod.default || mod.flow || mod;
	if (obj && typeof obj === "object" && Array.isArray(obj.steps) && obj.start) return obj;
	if (obj && typeof obj === "object" && obj.flow && Array.isArray(obj.flow.steps) && obj.flow.start) return obj.flow;
	throw new Error("invalid flow module/object: missing flow.start/flow.steps");
}

async function loadJson(inputPath) {
	if (!inputPath) return {};
	const full = pathLib.isAbsolute(inputPath) ? inputPath : pathLib.resolve(process.cwd(), inputPath);
	return JSON.parse(await fsp.readFile(full, "utf8"));
}

async function main() {
	const flowPath = getArg("flow");
	const argsPath = getArg("args", "");
	const optsPath = getArg("opts", "");
	const outputPath = getArg("out", "");
	const flow = await loadFlow(flowPath);
	const args = await loadJson(argsPath);
	const opts = await loadJson(optsPath);
	const policy = buildAuditPolicyFromRuntime({
		cli: {
			mode: getArg("audit-mode", ""),
			allowActions: getArg("audit-allow-actions", ""),
			denyActions: getArg("audit-deny-actions", ""),
			aiEnabled: getArg("audit-ai", "true"),
			aiTier: getArg("audit-ai-tier", ""),
			aiProvider: getArg("audit-ai-provider", ""),
			aiModel: getArg("audit-ai-model", ""),
			aiTimeoutMs: getArg("audit-ai-timeout-ms", ""),
			aiIncludeRunJsWithCode: getArg("audit-ai-run-js-with-code", ""),
		},
		env: process.env,
		opts,
	});
	const report = {
		ts: new Date().toISOString(),
		flowId: String(flow?.id || "flow"),
		start: String(flow?.start || ""),
		stepCount: Array.isArray(flow?.steps) ? flow.steps.length : 0,
		policy,
		result: await auditFlow({ flow, args, policy }),
	};
	const text = JSON.stringify(report, null, 2);
	if (outputPath) {
		const fullOut = pathLib.isAbsolute(outputPath) ? outputPath : pathLib.resolve(process.cwd(), outputPath);
		await fsp.writeFile(fullOut, text, "utf8");
		console.log(`[audit-flow] report written: ${fullOut}`);
	}
	console.log(text);
}

main().catch((err) => {
	console.error("[audit-flow] ERROR:", err?.stack || err?.message || err);
	process.exit(1);
});
