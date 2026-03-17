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
	const alias = getArg("alias", "fork_api_test");
	const mainUrl = getArg("main-url", "http://127.0.0.1:8787/nav/index.html");
	const forkUrl = getArg("fork-url", "http://127.0.0.1:8787/nav/inbox.html");

	const sessionStub = { agentNode: null, options: { webDriveMode: launchMode } };
	const webRpa = new WebRpa(sessionStub, { webDriveMode: launchMode });

	let browser = null;
	try {
		browser = await webRpa.openBrowser(alias, {
			launchMode: "direct",
			pathToFireFox: process.env.WEBDRIVE_APP,
		});
		const mainPage = await webRpa.openPage(browser);
		await mainPage.goto(mainUrl);

		const pagesBefore = await browser.getPages();
		const beforeCount = pagesBefore.length;

		const forkResult = await webRpa.withFork({ url: forkUrl }, async (worker) => {
			const page = worker.currentPage;
			return {
				workerIsFork: !!worker.isForkWorker,
				workerPages: worker.sessionPages.length,
				url: page ? await page.url() : "",
				title: page ? await page.title() : "",
			};
		});

		const pagesAfter = await browser.getPages();
		const afterCount = pagesAfter.length;
		const ok = !!forkResult.workerIsFork && beforeCount === afterCount;

		console.log(JSON.stringify({
			ok,
			beforeCount,
			afterCount,
			forkResult,
			mainUrl: await mainPage.url(),
		}, null, 2));
	} finally {
		if (browser) {
			await webRpa.closeBrowser(browser);
		}
	}
}

main().catch((err) => {
	console.error("[test-fork-api] ERROR:", err?.stack || err?.message || err);
	process.exit(1);
});
