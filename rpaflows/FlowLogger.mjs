import pathLib from "path";
import { promises as fsp } from "fs";

function nowIso() {
	return new Date().toISOString();
}

function makeRunId(prefix = "flow") {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	const rnd = Math.random().toString(36).slice(2, 8);
	return `${prefix}_${ts}_${rnd}`;
}

async function createFlowLogger({
	logDir,
	runId,
	flowId = "flow",
	echoConsole = true,
	maxInMemory = 300,
}) {
	const dir = logDir || pathLib.join(process.cwd(), "flow-logs");
	await fsp.mkdir(dir, { recursive: true });
	const safeFlowId = String(flowId || "flow").replace(/[^a-zA-Z0-9_.-]+/g, "_");
	const rid = runId || makeRunId(safeFlowId);
	const filePath = pathLib.join(dir, `${safeFlowId}_${rid}.ndjson`);

	let writeQueue = Promise.resolve();
	const records = [];
	let recordsTruncated = false;
	const memLimit = Number.isFinite(Number(maxInMemory)) ? Math.max(20, Number(maxInMemory)) : 300;

	const pushRecord = (rec) => {
		if (recordsTruncated) return;
		if (records.length >= memLimit) {
			recordsTruncated = true;
			return;
		}
		records.push(rec);
	};

	const writeLine = async (line) => {
		writeQueue = writeQueue.then(() => fsp.appendFile(filePath, line, "utf8")).catch(() => {});
		await writeQueue;
	};

	const emit = async (level, event, data = {}) => {
		const rec = {
			ts: nowIso(),
			level,
			runId: rid,
			flowId: safeFlowId,
			event,
			...data,
		};
		pushRecord(rec);
		const line = JSON.stringify(rec) + "\n";
		await writeLine(line);
		if (echoConsole) {
			const short = `[flow:${rid}] ${event}`;
			if (level === "error") console.error(short, data);
			else if (level === "warn") console.warn(short, data);
			else console.log(short, data);
		}
	};

	return {
		runId: rid,
		filePath,
		info: (event, data) => emit("info", event, data),
		warn: (event, data) => emit("warn", event, data),
		error: (event, data) => emit("error", event, data),
		debug: (event, data) => emit("debug", event, data),
		getRecords: () => records.slice(),
		isRecordsTruncated: () => recordsTruncated,
		close: async () => {
			await writeQueue;
		},
	};
}

export { createFlowLogger, makeRunId };
