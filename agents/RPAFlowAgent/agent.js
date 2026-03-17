import pathLib from "path";
import { promises as fsp } from "fs";
import { URL, pathToFileURL } from "url";
import WebRpa from "../../rpaflows/WebDriveRpa.mjs";
import { runFlow } from "../../rpaflows/FlowRunner.mjs";
import { runGoalDrivenLoop } from "../../rpaflows/FlowGoalDrivenLoop.mjs";
import {
  ensureFlowRegistry,
  resolveFlowEntryById,
  listFlowEntries,
} from "../../rpaflows/FlowRegistry.mjs";
import { createFlowLogger } from "../../rpaflows/FlowLogger.mjs";

const agentURL = decodeURIComponent((new URL(import.meta.url)).pathname);
const basePath = pathLib.dirname(agentURL);
const repoRoot = pathLib.resolve(basePath, "../..");
const rpaflowsDir = pathLib.join(repoRoot, "rpaflows");

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function toBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

function parseInput(input) {
  if (isObj(input)) return input;
  if (typeof input !== "string") return { mode: "goal_loop", goal: String(input ?? "") };
  const s = input.trim();
  if (!s) return { mode: "list_flows" };
  try {
    const parsed = JSON.parse(s);
    if (isObj(parsed)) return parsed;
  } catch (_) {
  }
  if (s.startsWith("flow:")) return { mode: "run_flow", flowId: s.slice(5).trim() };
  if (s.startsWith("goal:")) return { mode: "goal_loop", goal: s.slice(5).trim() };
  if (s === "list" || s === "flows" || s === "list_flows") return { mode: "list_flows" };
  return { mode: "goal_loop", goal: s };
}

function normalizeRequest(rawReq) {
  const req = isObj(rawReq) ? { ...rawReq } : {};
  req.mode = String(req.mode || "").trim() || (req.flowId || req.flowPath ? "run_flow" : (req.goal ? "goal_loop" : "list_flows"));
  req.alias = String(req.alias || "rpa_flow_agent").trim();
  req.args = isObj(req.args) ? req.args : {};
  req.opts = isObj(req.opts) ? req.opts : {};
  req.url = String(req.url || "").trim();
  req.sourcePolicy = String(req.sourcePolicy || "").trim();
  return req;
}

async function loadFlowFromPath(flowPath) {
  const p = String(flowPath || "").trim();
  if (!p) throw new Error("empty flowPath");
  const candidates = [];
  if (pathLib.isAbsolute(p)) {
    candidates.push(p);
  } else {
    candidates.push(pathLib.resolve(process.cwd(), p));
    candidates.push(pathLib.join(rpaflowsDir, "flows", p));
  }

  let full = "";
  for (const one of candidates) {
    try {
      await fsp.access(one);
      full = one;
      break;
    } catch (_) {
    }
  }
  if (!full) {
    throw new Error(`flow file not found: ${p}`);
  }

  if (full.endsWith(".json")) {
    const loaded = JSON.parse(await fsp.readFile(full, "utf8"));
    if (loaded && loaded.flow && loaded.flow.steps && loaded.flow.start) return loaded.flow;
    return loaded;
  }

  const mod = await import(pathToFileURL(full).href);
  const loaded = mod.default || mod.flow || mod;
  if (loaded && loaded.flow && loaded.flow.steps && loaded.flow.start) return loaded.flow;
  return loaded;
}

function isFlowLike(flow) {
  return !!(flow && typeof flow === "object" && Array.isArray(flow.steps) && flow.start);
}

function isCompatibleWebRpa(webRpa) {
  return !!(
    webRpa &&
    typeof webRpa.openBrowser === "function" &&
    typeof webRpa.openPage === "function" &&
    typeof webRpa.setCurrentPage === "function"
  );
}

async function ensureRuntime(context, session, req) {
  const stackTag = "rpaflows";

  let webRpa = null;
  if (isCompatibleWebRpa(context.webRpa) && context.webRpa.__rpaFlowStackTag === stackTag) {
    webRpa = context.webRpa;
  } else if (isCompatibleWebRpa(session.webRpa) && session.webRpa.__rpaFlowStackTag === stackTag) {
    webRpa = session.webRpa;
  } else if (isCompatibleWebRpa(session.webRpa) && !session.webRpa.__rpaFlowStackTag) {
    webRpa = session.webRpa;
    webRpa.__rpaFlowStackTag = stackTag;
  } else {
    webRpa = new WebRpa(session, { webDriveMode: session?.options?.webDriveMode || "hub" });
    webRpa.__rpaFlowStackTag = stackTag;
  }

  context.webRpa = webRpa;
  if (!session.webRpa) session.webRpa = webRpa;

  const headless = toBool(req.headless, false);
  const devtools = toBool(req.devtools, false);
  const autoDataDir = toBool(req.autoDataDir, false);

  if (!context.browser || context.browserAlias !== req.alias) {
    context.browser = await webRpa.openBrowser(req.alias, {
      headless,
      devtools,
      autoDataDir,
      launchMode: process.env.WEBRPA_WEBDRIVE_MODE || "direct",
      pathToFireFox: process.env.WEBDRIVE_APP,
    });
    context.browserAlias = req.alias;
  }

  let page = webRpa.currentPage || context.page || null;
  if (!page) {
    page = await webRpa.openPage(context.browser);
    context.page = page;
  }
  if (webRpa.currentPage !== page) webRpa.setCurrentPage(page);

  if (req.url) {
    await page.goto(req.url, {});
  }

  return { webRpa, page };
}

async function runFlowByRequest({ req, webRpa, page, session, logger }) {
  await ensureFlowRegistry({ logger });

  let flow = null;
  if (req.flowPath) {
    flow = await loadFlowFromPath(req.flowPath);
  } else if (req.flowId) {
    const entry = await resolveFlowEntryById(req.flowId, {
      sourcePolicy: req.sourcePolicy,
      logger,
    });
    if (!entry?.flow) {
      return { status: "failed", reason: `flow not found: ${req.flowId}` };
    }
    flow = entry.flow;
  } else {
    return { status: "failed", reason: "run_flow requires flowId or flowPath" };
  }

  if (!isFlowLike(flow)) {
    return { status: "failed", reason: "invalid flow object: missing start/steps" };
  }

  return await runFlow({
    flow,
    webRpa,
    page,
    session,
    args: req.args,
    opts: req.opts,
    maxSteps: Number(req.maxSteps || 200),
    logger,
  });
}

async function runGoalByRequest({ req, webRpa, page, session, logger }) {
  const goal = String(req.goal || "").trim();
  if (!goal) return { status: "failed", reason: "goal_loop requires goal" };

  return await runGoalDrivenLoop({
    goal,
    notes: String(req.notes || ""),
    webRpa,
    page,
    session,
    args: req.args,
    opts: req.opts,
    actionScope: req.actionScope || "all",
    invokeScope: req.invokeScope || "all",
    maxSteps: Number(req.maxSteps || 20),
    maxConsecutiveFails: Number(req.maxConsecutiveFails || 3),
    aiModel: String(req.aiModel || "advanced"),
    aiTimeoutMs: Number(req.aiTimeoutMs || 60000),
    logger,
  });
}

async function listFlowsByRequest({ req, logger }) {
  await ensureFlowRegistry({ logger });
  const all = listFlowEntries();
  const q = String(req.q || "").trim().toLowerCase();
  const rows = all
    .filter((e) => {
      if (!q) return true;
      const id = String(e?.id || "").toLowerCase();
      const src = String(e?.source || "").toLowerCase();
      return id.includes(q) || src.includes(q);
    })
    .slice(0, Number(req.limit || 80))
    .map((e) => ({
      id: e.id,
      entryId: e.entryId,
      source: e.source,
      capabilities: Array.isArray(e.capKeys) ? e.capKeys.slice(0, 24) : [],
      filters: e.filters || [],
    }));
  return { status: "done", value: { total: all.length, items: rows } };
}

let agent = async function (session) {
  const context = {};

  async function Start(input) {
    const rawReq = parseInput(input);
    const req = normalizeRequest(rawReq);

    const logger = await createFlowLogger({
      logDir: process.env.FLOW_LOG_DIR || pathLib.join(rpaflowsDir, "flow-logs"),
      flowId: req.flowId || req.mode || "rpa_flow_agent",
      runId: String(req.runId || "").trim(),
      echoConsole: process.env.FLOW_LOG_CONSOLE !== "0",
    });

    let result;
    try {
      await logger.info("rpa_flow_agent.start", {
        mode: req.mode,
        alias: req.alias,
        flowId: req.flowId || null,
        hasFlowPath: !!req.flowPath,
        hasGoal: !!req.goal,
      });

      if (req.mode === "list_flows") {
        result = await listFlowsByRequest({ req, logger });
      } else {
        const { webRpa, page } = await ensureRuntime(context, session, req);
        if (req.mode === "run_flow") {
          result = await runFlowByRequest({ req, webRpa, page, session, logger });
        } else if (req.mode === "goal_loop") {
          result = await runGoalByRequest({ req, webRpa, page, session, logger });
        } else {
          result = { status: "failed", reason: `unsupported mode: ${req.mode}` };
        }
      }

      await logger.info("rpa_flow_agent.end", {
        mode: req.mode,
        status: result?.status || "failed",
        reason: result?.reason || "",
      });

      const brief = {
        mode: req.mode,
        status: result?.status || "failed",
        reason: result?.reason || "",
        logFile: logger.filePath,
      };
      await session.addChatText("assistant", JSON.stringify(brief, null, 2), {
        channel: "Process",
        txtHeader: "RPAFlowAgent",
      });

      return { result: { ...(result || {}), meta: { ...(result?.meta || {}), logFile: logger.filePath } } };
    } catch (err) {
      const fail = {
        status: "failed",
        reason: String(err?.message || err || "unknown error"),
      };
      await logger.error("rpa_flow_agent.error", { reason: fail.reason });
      await session.addChatText("assistant", JSON.stringify(fail, null, 2), {
        channel: "Process",
        txtHeader: "RPAFlowAgent",
      });
      return { result: { ...fail, meta: { logFile: logger.filePath } } };
    } finally {
      await logger.close();
    }
  }

  const self = {
    isAIAgent: true,
    session,
    name: "agent",
    url: agentURL,
    autoStart: true,
    context,
    execChat: async function (input) {
      return { seg: Start, input };
    },
  };

  return self;
};

export default agent;
export { agent };
