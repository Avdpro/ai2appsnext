import http from "http";
import pathLib from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
const projectRoot = pathLib.resolve(__dirname, "..");

const RUN_FLOW = pathLib.join(projectRoot, "run-flow.mjs");
const SERVE_TEST_PAGES = pathLib.join(__dirname, "serve-test-pages.mjs");
const BASE = "http://127.0.0.1:8787";

const cases = [
	{ id: "tip_persist_nav", flow: pathLib.join(projectRoot, "flows", "flow-tip-persist-nav-smoke.json") },
	{ id: "input_clear_append_local", flow: pathLib.join(projectRoot, "flows", "smoke-input-clear-append-local.json") },
	{ id: "loadmore_next_local", flow: pathLib.join(projectRoot, "flows", "smoke-loadmore-next-local.json") },
	{ id: "loadmore_scroll_local", flow: pathLib.join(projectRoot, "flows", "smoke-loadmore-scroll-local.json") },
	{ id: "readlist_ensure_local", flow: pathLib.join(projectRoot, "flows", "smoke-readlist-ensure-local.json") },
	{ id: "read_article_local", flow: pathLib.join(projectRoot, "flows", "smoke-read-article-local.json") },
	{ id: "read_detail_local", flow: pathLib.join(projectRoot, "flows", "smoke-read-detail-local.json") },
];

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGet(url, timeoutMs = 1200) {
	return new Promise((resolve, reject) => {
		const req = http.get(url, { timeout: timeoutMs }, (res) => {
			res.resume();
			resolve({ statusCode: Number(res.statusCode || 0) });
		});
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("timeout")));
	});
}

async function ensureTestPageServer() {
	try {
		const r = await httpGet(`${BASE}/prompt-nav/index.html`, 1000);
		if (r.statusCode >= 200 && r.statusCode < 500) return { proc: null, started: false };
	} catch (_) {
	}

	const proc = spawn("node", [SERVE_TEST_PAGES], {
		cwd: __dirname,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, TEST_PAGES_PORT: "8787" },
	});
	let out = "";
	proc.stdout.on("data", (d) => {
		out += String(d || "");
	});
	proc.stderr.on("data", (d) => {
		out += String(d || "");
	});

	for (let i = 0; i < 20; i++) {
		try {
			const r = await httpGet(`${BASE}/prompt-nav/index.html`, 800);
			if (r.statusCode >= 200 && r.statusCode < 500) return { proc, started: true };
		} catch (_) {
		}
		await sleep(250);
	}
	proc.kill("SIGTERM");
	throw new Error(`test-page server failed to start on 127.0.0.1:8787\n${out}`);
}

function extractLogFile(text) {
	const m = String(text || "").match(/\[run-flow\] log file:\s*(.+)\s*$/m);
	return m ? m[1].trim() : "";
}

async function runOne(testCase) {
	return new Promise((resolve) => {
		const args = [RUN_FLOW, `--flow=${testCase.flow}`, "--close-ms=900"];
		const child = spawn("node", args, {
			cwd: projectRoot,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += String(d || "");
		});
		child.stderr.on("data", (d) => {
			err += String(d || "");
		});
		child.on("close", (code) => {
			resolve({
				id: testCase.id,
				code: Number(code || 0),
				ok: Number(code || 0) === 0,
				logFile: extractLogFile(out),
				out,
				err,
			});
		});
	});
}

async function main() {
	const start = Date.now();
	const { proc, started } = await ensureTestPageServer();
	const results = [];
	try {
		for (const c of cases) {
			// eslint-disable-next-line no-await-in-loop
			const r = await runOne(c);
			results.push(r);
			const mark = r.ok ? "PASS" : "FAIL";
			console.log(`[${mark}] ${c.id}${r.logFile ? ` | ${r.logFile}` : ""}`);
		}
	} finally {
		if (proc) proc.kill("SIGTERM");
	}

	const failed = results.filter((r) => !r.ok);
	const elapsedMs = Date.now() - start;
	console.log(`\nSuite finished in ${elapsedMs}ms. passed=${results.length - failed.length}, failed=${failed.length}`);
	if (started) console.log("test-page server mode: started-by-suite");
	else console.log("test-page server mode: reused-existing");

	if (failed.length) {
		for (const f of failed) {
			const tail = `${f.out}\n${f.err}`.trim().split("\n").slice(-12).join("\n");
			console.log(`\n--- FAIL DETAIL: ${f.id} ---\n${tail}`);
		}
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("[run-smoke-suite] ERROR:", err?.stack || err?.message || err);
	process.exit(1);
});
