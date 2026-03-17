import pathLib from "path";
import { fileURLToPath } from "url";
import { promises as fsp } from "fs";
import { spawn } from "child_process";
import rpaKind from "./rpa.mjs";
import { validateFlow } from "./SkillToFlow.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);

function getArg(name, fallback = "") {
	const prefix = `--${name}=`;
	const found = process.argv.find((v) => v.startsWith(prefix));
	return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
	return process.argv.includes(`--${name}`);
}

function fmtBool(v) {
	return v ? "PASS" : "FAIL";
}

function summarizeCaps(caps) {
	const out = { total: 0, cap: 0, arg: 0, result: 0, other: 0 };
	for (const meta of Object.values(caps || {})) {
		out.total += 1;
		const k = String(meta?.kind || "").trim().toLowerCase();
		if (k === "cap") out.cap += 1;
		else if (k === "arg") out.arg += 1;
		else if (k === "result") out.result += 1;
		else out.other += 1;
	}
	return out;
}

function runNode(args, envExtra = {}) {
	return new Promise((resolve) => {
		const cp = spawn(process.execPath, args, {
			cwd: __dirname,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...envExtra },
		});
		let stdout = "";
		let stderr = "";
		cp.stdout.on("data", (d) => { stdout += String(d || ""); });
		cp.stderr.on("data", (d) => { stderr += String(d || ""); });
		cp.on("close", (code) => resolve({ code: Number(code || 0), stdout, stderr }));
	});
}

async function readJsonFile(filePath) {
	const raw = await fsp.readFile(filePath, "utf8");
	return JSON.parse(raw);
}

function reportErrors(title, errors) {
	if (!Array.isArray(errors) || !errors.length) return;
	console.log(`- ${title}:`);
	for (const e of errors) console.log(`  - ${e}`);
}

async function runOneSkillToFlow({ text = "", input = "", outPath, runId }) {
	const args = ["./run-skill-to-flow.mjs"];
	if (text) args.push(`--text=${text}`);
	if (input) args.push(`--input=${input}`);
	args.push(`--out=${outPath}`);
	args.push(`--run-id=${runId}`);
	const ret = await runNode(args);
	return ret;
}

async function main() {
	const skipSkill = hasFlag("skip-skill");
	const skillPathArg = String(getArg("skill", "skills/weibo-search.md") || "").trim();
	const skillPath = pathLib.isAbsolute(skillPathArg) ? skillPathArg : pathLib.join(__dirname, skillPathArg);
	const minOut = pathLib.join(__dirname, "flows", "_rpa-sync-min.json");
	const skillOut = pathLib.join(__dirname, "flows", "_rpa-sync-skill.json");

	let ok = true;
	console.log("[check:rpa-sync] start");

	const caps = (rpaKind && typeof rpaKind === "object" && rpaKind.caps && typeof rpaKind.caps === "object")
		? rpaKind.caps
		: {};
	const capSummary = summarizeCaps(caps);
	const capsOk = capSummary.total > 0 && capSummary.other === 0;
	console.log(`[check:rpa-sync] capability-catalog: ${fmtBool(capsOk)} total=${capSummary.total} cap=${capSummary.cap} arg=${capSummary.arg} result=${capSummary.result} other=${capSummary.other}`);
	if (!capsOk) ok = false;

	const minRun = await runOneSkillToFlow({
		text: "打开页面并读取标题",
		outPath: minOut,
		runId: "rpa_sync_min",
	});
	const minRunOk = minRun.code === 0;
	console.log(`[check:rpa-sync] skill-to-flow(minimal): ${fmtBool(minRunOk)} exit=${minRun.code}`);
	if (!minRunOk) {
		ok = false;
		console.log(minRun.stderr.trim() || minRun.stdout.trim());
	} else {
		const obj = await readJsonFile(minOut);
		const flow = obj?.flow || obj;
		const errors = validateFlow(flow, { capabilityCatalog: caps });
		const flowOk = errors.length === 0;
		console.log(`[check:rpa-sync] validate(minimal): ${fmtBool(flowOk)} errors=${errors.length}`);
		reportErrors("minimal validation errors", errors);
		if (!flowOk) ok = false;
	}

	if (!skipSkill) {
		let hasSkill = true;
		try {
			await fsp.access(skillPath);
		} catch (_) {
			hasSkill = false;
		}
		if (!hasSkill) {
			console.log(`[check:rpa-sync] skill regression: SKIP (not found) ${skillPath}`);
		} else {
			const skillRun = await runOneSkillToFlow({
				input: skillPath,
				outPath: skillOut,
				runId: "rpa_sync_skill",
			});
			const skillRunOk = skillRun.code === 0;
			console.log(`[check:rpa-sync] skill-to-flow(regression): ${fmtBool(skillRunOk)} exit=${skillRun.code} skill=${skillPathArg}`);
			if (!skillRunOk) {
				ok = false;
				console.log(skillRun.stderr.trim() || skillRun.stdout.trim());
			} else {
				const obj = await readJsonFile(skillOut);
				const flow = obj?.flow || obj;
				const errors = validateFlow(flow, { capabilityCatalog: caps });
				const flowOk = errors.length === 0;
				console.log(`[check:rpa-sync] validate(regression): ${fmtBool(flowOk)} errors=${errors.length}`);
				reportErrors("regression validation errors", errors);
				if (!flowOk) ok = false;
			}
		}
	} else {
		console.log("[check:rpa-sync] skill regression: SKIP (--skip-skill)");
	}

	console.log(`[check:rpa-sync] done: ${ok ? "PASS" : "FAIL"}`);
	process.exitCode = ok ? 0 : 2;
}

main().catch((err) => {
	console.error("[check:rpa-sync] fatal:", err?.stack || err?.message || err);
	process.exitCode = 1;
});
