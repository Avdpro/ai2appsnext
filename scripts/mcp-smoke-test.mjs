#!/usr/bin/env node

import dotEnv from "dotenv";

const envFileName = process.env.ENV_FILE;
if (envFileName) {
	dotEnv.config({ path: envFileName });
} else {
	dotEnv.config();
}

const DEFAULT_PORT = process.env.PORT || "3102";
const DEFAULT_HOST = process.env.HOST || "127.0.0.1";
const BASE_URL = process.env.BASE_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const WS_URL = `${BASE_URL}/ws`;
const MCP_URL = `${BASE_URL}/mcp`;
const TARGET_NODE = process.env.MCP_NODE || "TestNodeChat";
const TARGET_TOOL = process.env.MCP_TOOL || "agenthub.ping";
const TEST_INPUT = process.env.MCP_INPUT || "hello from mcp smoke test";
const SHOULD_START_NODE = process.env.MCP_START_NODE !== "false";
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS || 120000);
const MCP_AUTH_TOKEN = (process.env.MCP_AUTH_TOKEN || "").trim();

function log(msg) {
	process.stdout.write(`${msg}\n`);
}

function fail(msg) {
	process.stderr.write(`[FAIL] ${msg}\n`);
	process.exit(1);
}

async function postJSON(url, body, timeoutMs = REQUEST_TIMEOUT_MS) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		let res;
		try {
			const headers = { "content-type": "application/json" };
			if (url === MCP_URL && MCP_AUTH_TOKEN) {
				headers.authorization = `Bearer ${MCP_AUTH_TOKEN}`;
			}
			res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal
			});
		} catch (err) {
			const hint = `Network error calling ${url}. Ensure server is running (example: AGENT_HUB=TRUE PORT=3102 npm start).`;
			throw new Error(`${hint} Cause: ${err?.message || err}`);
		}
		const text = await res.text();
		let json = null;
		if (text) {
			try {
				json = JSON.parse(text);
			} catch {
				json = null;
			}
		}
		return { status: res.status, ok: res.ok, text, json };
	} finally {
		clearTimeout(timer);
	}
}

async function wsCall(msg, vo) {
	const body = { msg, vo };
	const res = await postJSON(WS_URL, body);
	if (!res.ok) {
		fail(`/ws ${msg} HTTP ${res.status}: ${res.text}`);
	}
	if (!res.json || typeof res.json.code !== "number") {
		fail(`/ws ${msg} invalid response: ${res.text}`);
	}
	if (res.json.code !== 200) {
		fail(`/ws ${msg} failed: ${JSON.stringify(res.json)}`);
	}
	return res.json;
}

async function mcpCall(id, method, params) {
	const body = { jsonrpc: "2.0", id, method, params: params || {} };
	const res = await postJSON(MCP_URL, body);
	if (!res.ok) {
		fail(`/mcp ${method} HTTP ${res.status}: ${res.text}`);
	}
	if (!res.json) {
		fail(`/mcp ${method} invalid JSON: ${res.text}`);
	}
	if (res.json.error) {
		fail(`/mcp ${method} error: ${JSON.stringify(res.json.error)}`);
	}
	return res.json.result;
}

function pickTool(tools, nodeName) {
	if (!Array.isArray(tools) || !tools.length) {
		return null;
	}
	if (TARGET_TOOL) {
		return tools.find((tool) => tool.name === TARGET_TOOL) || null;
	}
	const byPrefix = tools.find((tool) => typeof tool.name === "string" && tool.name.startsWith(`${nodeName}.`));
	return byPrefix || tools[0];
}

async function main() {
	log(`[MCP Smoke] Base URL: ${BASE_URL}`);
	log(`[MCP Smoke] Target node: ${TARGET_NODE}`);

	if (SHOULD_START_NODE && TARGET_TOOL !== "agenthub.ping") {
		log("[MCP Smoke] Step 0: StartAgentNode");
		await wsCall("StartAgentNode", { name: TARGET_NODE });
	}

	log("[MCP Smoke] Step 1: initialize");
	const initResult = await mcpCall(1, "initialize", {});
	if (!initResult || !initResult.capabilities || !initResult.serverInfo) {
		fail(`initialize result missing fields: ${JSON.stringify(initResult)}`);
	}

	log("[MCP Smoke] Step 2: tools/list");
	const listResult = await mcpCall(2, "tools/list", {});
	const tools = listResult?.tools || [];
	log(`[MCP Smoke] tools/list count: ${tools.length}`);
	if (!tools.length) {
		fail("tools/list returned empty tools.");
	}

	const tool = pickTool(tools, TARGET_NODE);
	if (!tool) {
		fail(`No tool found for node "${TARGET_NODE}".`);
	}
	log(`[MCP Smoke] Pick tool: ${tool.name}`);

	log("[MCP Smoke] Step 3: tools/call");
	const callResult = await mcpCall(3, "tools/call", {
		name: tool.name,
		arguments: {
			input: TEST_INPUT,
			timeoutMs: REQUEST_TIMEOUT_MS
		}
	});

	if (!callResult || !Array.isArray(callResult.content)) {
		fail(`tools/call missing content: ${JSON.stringify(callResult)}`);
	}

	const firstText = callResult.content[0]?.text || "";
	log(`[MCP Smoke] tools/call content length: ${firstText.length}`);
	log("[MCP Smoke] PASS");
}

main().catch((err) => {
	fail(`Unhandled error: ${err?.stack || err}`);
});
