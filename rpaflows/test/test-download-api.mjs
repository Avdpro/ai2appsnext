import pathLib from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import WebRpa from "../WebDriveRpa.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
dotenv.config({ path: pathLib.join(__dirname, "..", ".env") });

function getArg(name, fallback = "") {
	const prefix = `--${name}=`;
	const hit = process.argv.find((v) => v.startsWith(prefix));
	return hit ? hit.slice(prefix.length) : fallback;
}

async function main() {
	const launchMode = process.env.WEBRPA_WEBDRIVE_MODE || "direct";
	const alias = getArg("alias", "download_api_test");
	const url = getArg("url", "http://127.0.0.1:8787/download/index.html");
	const selector = getArg("selector", "css: #download-link");
	const beginTimeout = Number(getArg("begin-timeout", "15000"));
	const endTimeout = Number(getArg("end-timeout", "20000"));

	const sessionStub = { agentNode: null, options: { webDriveMode: launchMode } };
	const webRpa = new WebRpa(sessionStub, { webDriveMode: launchMode });

	let browser = null;
	try {
		browser = await webRpa.openBrowser(alias, {
			launchMode: "direct",
			pathToFireFox: process.env.WEBDRIVE_APP,
		});
		const page = await webRpa.openPage(browser);
		await page.goto(url);
		const ret = await webRpa.download(page, {
			selector,
			beginTimeout,
			endTimeout,
			waitForEnd: true,
			matchContext: false,
		});
		console.log(JSON.stringify({
			ok: !!ret?.ok,
			started: !!ret?.started,
			finished: !!ret?.finished,
			begin: ret?.begin || null,
			end: ret?.end || null,
			triggerError: ret?.triggerError || "",
			pageUrl: await page.url(),
		}, null, 2));
	} finally {
		if (browser) {
			await webRpa.closeBrowser(browser);
		}
	}
}

main().catch((err) => {
	console.error("[test-download-api] ERROR:", err?.stack || err?.message || err);
	process.exit(1);
});
