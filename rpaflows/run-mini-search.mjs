import pathLib from "path";
import { fileURLToPath } from "url";
import { promises as fsp } from "fs";
import dotenv from "dotenv";
import WebRpa from "./WebDriveRpa.mjs";
import { runFlow } from "./FlowRunner.mjs";
import { createFlowLogger } from "./FlowLogger.mjs";
import { ensureFlowRegistry } from "./FlowRegistry.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
dotenv.config({ path: pathLib.join(__dirname, ".env") });

function getArg(name, fallback = "") {
	const prefix = `--${name}=`;
	const found = process.argv.find((v) => v.startsWith(prefix));
	return found ? found.slice(prefix.length) : fallback;
}

async function loadMiniFlow() {
	const p = pathLib.join(__dirname, "flows", "mini-search-flow.json");
	return JSON.parse(await fsp.readFile(p, "utf8"));
}

async function main() {
	const url = getArg("url", "https://www.google.com");
	const query = getArg("query", "OpenAI");
	const alias = getArg("alias", "mini_search");
	const launchMode = process.env.WEBRPA_WEBDRIVE_MODE || "direct";
	const firefoxAppPath = process.env.WEBDRIVE_APP;

	if (!firefoxAppPath) {
		throw new Error("Missing WEBDRIVE_APP in .env");
	}

	const flow = await loadMiniFlow();
	const logDir = process.env.FLOW_LOG_DIR || pathLib.join(__dirname, "flow-logs");
	const logger = await createFlowLogger({
		logDir,
		flowId: flow.id || "mini_search",
		runId: getArg("run-id", ""),
		echoConsole: process.env.FLOW_LOG_CONSOLE !== "0",
	});
	const sessionStub = { agentNode: null, options: { webDriveMode: launchMode } };
	const webRpa = new WebRpa(sessionStub, { webDriveMode: launchMode });

	let browser = null;
	try {
		await ensureFlowRegistry({ logger });
		await logger.info("runner.start", { alias, url, query });
		browser = await webRpa.openBrowser(alias, {
			launchMode: "direct",
			pathToFireFox: firefoxAppPath,
		});
		const page = await webRpa.openPage(browser);
		await page.goto(url);

		const flowResult = await runFlow({
			flow,
			webRpa,
			page,
			session: sessionStub,
			args: { query },
			opts: {},
			logger,
		});
		await logger.info("runner.flow_result", { status: flowResult.status, reason: flowResult.reason || "" });
		console.log("[mini-search] flow result:", JSON.stringify(flowResult, null, 2));
		console.log(`[mini-search] log file: ${logger.filePath}`);

		// Wait a moment for post-search navigation/update to settle.
		try {
			await page.waitForNavigation({ timeout: 4000 });
		} catch (_) {
		}
		await new Promise((r) => setTimeout(r, 800));

		let promptResult = null;
		let retry = 0;
		const maxRetry = 8;
		while (retry < maxRetry) {
			retry++;
			promptResult = await webRpa.inPagePrompt(
				page,
				`我已执行 mini-search：\n- 点击搜索框\n- 输入关键词: "${query}"\n\n当前页面状态是否正确？`,
				{
					icon: null,
					menu: [
						{ text: "✅ 正确", code: "ok" },
						{ text: "❌ 不正确", code: "bad" }
					],
					modal: true,
					mask: "rgba(0,0,0,0.20)",
					showCancel: false
				}
			);
			if (promptResult && (promptResult.code === "ok" || promptResult.code === "bad")) {
				break;
			}
			console.log(`[mini-search] prompt returned null/invalid, retry=${retry}`);
			await logger.warn("prompt.null_retry", { retry });
			await new Promise((r) => setTimeout(r, 1000));
		}
		console.log("[mini-search] user confirm:", JSON.stringify(promptResult));
		await logger.info("prompt.result", { code: promptResult?.code || null, text: promptResult?.text || null });
	} finally {
		if (browser) {
			await webRpa.closeBrowser(browser);
		}
		await logger?.info("runner.end", {});
		await logger?.close();
	}
}

main().catch((err) => {
	console.error("[run-mini-search] ERROR:", err?.stack || err?.message || err);
	process.exit(1);
});
