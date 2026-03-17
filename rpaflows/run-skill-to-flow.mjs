import pathLib from "path";
import { fileURLToPath } from "url";
import { promises as fsp } from "fs";
import dns from "node:dns/promises";
import dotenv from "dotenv";
import { skillToFlow } from "./SkillToFlow.mjs";
import { createFlowLogger } from "./FlowLogger.mjs";
import { getProviderForPurpose } from "./AIProviderClient.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
dotenv.config({ path: pathLib.join(__dirname, ".env") });

function getArg(name, fallback = "") {
	const prefix = `--${name}=`;
	const found = process.argv.find((v) => v.startsWith(prefix));
	return found ? found.slice(prefix.length) : fallback;
}

function getProviderBaseURL(provider) {
	const p = String(provider || "").trim().toLowerCase();
	if (p === "openrouter") {
		return String(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").trim().replace(/\/+$/, "");
	}
	if (p === "ollama") {
		return String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
	}
	if (p === "google") {
		return "https://generativelanguage.googleapis.com";
	}
	if (p === "anthropic") {
		return "https://api.anthropic.com";
	}
	return String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
}

function assertProviderCredentials(provider) {
	const p = String(provider || "").trim().toLowerCase();
	if (p === "ollama") return;
	if (p === "openrouter") {
		const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();
		if (!apiKey) throw new Error("OPENROUTER_API_KEY is required when AI_PROVIDER_RUN_AI=openrouter");
		return;
	}
	if (p === "google") {
		const apiKey = String(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "").trim();
		if (!apiKey) throw new Error("GOOGLE_API_KEY (or GEMINI_API_KEY) is required when AI_PROVIDER_RUN_AI=google");
		return;
	}
	if (p === "anthropic") {
		const apiKey = String(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "").trim();
		if (!apiKey) throw new Error("ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is required when AI_PROVIDER_RUN_AI=anthropic");
		return;
	}
	const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
	if (!apiKey) throw new Error("OPENAI_API_KEY is required when AI_PROVIDER_RUN_AI=openai");
}

async function assertNetworkReadyForSkillToFlow() {
	const allowSandbox = String(process.env.SKILL_TO_FLOW_ALLOW_SANDBOX || "").trim() === "1";
	const sandboxName = String(process.env.CODEX_SANDBOX || "").trim().toLowerCase();
	if (!allowSandbox && sandboxName && sandboxName !== "none") {
		throw new Error(`skill:toflow must run outside sandbox (detected CODEX_SANDBOX=${sandboxName})`);
	}
	const provider = getProviderForPurpose("run_ai");
	assertProviderCredentials(provider);
	const base = getProviderBaseURL(provider);
	let host = "";
	try {
		host = new URL(base).hostname;
	} catch (_) {
		throw new Error(`invalid provider base url for ${provider}: ${base}`);
	}
	try {
		await dns.lookup(host);
	} catch (e) {
		throw new Error(`network/DNS unavailable for ${provider} host ${host} (${e?.code || "ERR"}: ${e?.message || "lookup failed"}). Please run skill:toflow outside sandbox.`);
	}
}

async function readInputText() {
	const text = String(getArg("text", "") || "");
	if (text.trim()) return text;
	const inPath = String(getArg("input", "") || "").trim();
	if (!inPath) throw new Error("missing input: provide --text=... or --input=/path/to/file.md");
	const abs = pathLib.isAbsolute(inPath) ? inPath : pathLib.join(process.cwd(), inPath);
	return await fsp.readFile(abs, "utf8");
}

async function main() {
	const aiProvider = String(getArg("ai-provider", "") || "").trim().toLowerCase();
	const aiProviderFallback = String(getArg("ai-provider-fallback", "") || "").trim().toLowerCase();
	if (aiProvider) process.env.AI_PROVIDER_RUN_AI = aiProvider;
	if (aiProviderFallback) process.env.AI_PROVIDER_RUN_AI_FALLBACK = aiProviderFallback;
	await assertNetworkReadyForSkillToFlow();
	const skillText = await readInputText();
	const outPath = String(getArg("out", "") || "").trim();
	const model = String(getArg("model", "advanced") || "advanced").trim() || "advanced";
	const maxRepair = Number(getArg("max-repair", "1") || 1);
	const maxRegenerate = Number(getArg("max-regenerate", "1") || 1);
	const timeoutMs = Number(getArg("timeout-ms", "600000") || 600000);
	const enableLog = String(process.env.SKILL_TO_FLOW_LOG || "").trim() === "1";
	let logger = null;
	if (enableLog) {
		const logDir = process.env.FLOW_LOG_DIR || pathLib.join(__dirname, "flow-logs");
		logger = await createFlowLogger({
			logDir,
			flowId: "skill_to_flow",
			runId: getArg("run-id", ""),
			echoConsole: process.env.FLOW_LOG_CONSOLE !== "0",
		});
	}

	try {
		const ret = await skillToFlow({
			skillText,
			model,
			maxRepair: Number.isFinite(maxRepair) ? maxRepair : 1,
			maxRegenerate: Number.isFinite(maxRegenerate) ? maxRegenerate : 1,
			timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 600000,
			logger,
		});
	if (!ret?.ok) {
		console.error("[skill-to-flow] failed:", ret?.reason || "unknown");
		if (Array.isArray(ret?.errors) && ret.errors.length) {
			console.error("[skill-to-flow] validation errors:");
			for (const e of ret.errors) console.error("-", e);
		}
		process.exitCode = 2;
		return;
	}

	const outObj = ret?.result && typeof ret.result === "object"
		? ret.result
		: { capabilities: ret.capabilities || { must: [], prefer: [] }, filters: ret.filters || [{ key: "domain", value: "*" }], flow: ret.flow };
	const json = JSON.stringify(outObj, null, 2);
	if (outPath) {
		const absOut = pathLib.isAbsolute(outPath) ? outPath : pathLib.join(process.cwd(), outPath);
		await fsp.writeFile(absOut, `${json}\n`, "utf8");
		console.log("[skill-to-flow] wrote flow:", absOut);
	} else {
		console.log(json);
	}
		if (logger?.filePath) {
			console.log("[skill-to-flow] log file:", logger.filePath);
		}
	} finally {
		if (logger) {
			await logger.close();
		}
	}
}

main().catch((err) => {
	console.error("[skill-to-flow] fatal:", err?.message || err);
	process.exitCode = 1;
});
