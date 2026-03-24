import pathLib from "path";
import { fileURLToPath } from "url";
import { promises as fsp } from "fs";
import dotenv from "dotenv";
import WebRpa from "../WebDriveRpa.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
const envPath = pathLib.join(__dirname, "..", ".env");

dotenv.config({ path: envPath });

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickArg(name, fallback) {
	const prefix = `--${name}=`;
	const arg = process.argv.find((item) => item.startsWith(prefix));
	if (!arg) {
		return fallback;
	}
	return arg.substring(prefix.length);
}

async function exists(path) {
	try {
		await fsp.access(path);
		return true;
	} catch (_) {
		return false;
	}
}

async function main() {
	const url = pickArg("url", "https://example.com");
	const holdMs = Number(pickArg("hold-ms", "3000"));
	const alias = pickArg("alias", "acefox_test");
	const firefoxAppPath = process.env.WEBDRIVE_APP;
	const launchMode = process.env.WEBRPA_WEBDRIVE_MODE || "direct";

	if (!firefoxAppPath) {
		throw new Error("Missing WEBDRIVE_APP in .env");
	}
	if (!(await exists(firefoxAppPath))) {
		throw new Error(`WEBDRIVE_APP not found: ${firefoxAppPath}`);
	}

	const sessionStub = {
		agentNode: null,
		options: { webDriveMode: launchMode },
	};

	const webRpa = new WebRpa(sessionStub, { webDriveMode: launchMode });
	let browser = null;
	try {
		browser = await webRpa.openBrowser(alias, {
			launchMode: "direct",
			pathToFireFox: firefoxAppPath,
		});
		const page = await webRpa.openPage(browser);
		await page.goto(url);
		const pageUrl = await page.url();
		const title = await page.title();
		console.log("Opened URL:", pageUrl);
		console.log("Page title:", title);
		if (holdMs > 0) {
			await sleep(holdMs);
		}
	} finally {
		if (browser) {
			await webRpa.closeBrowser(browser);
		}
	}
}

main().catch((err) => {
	console.error("[test-acefox-open-url] ERROR:", err?.stack || err?.message || err);
	process.exit(1);
});
