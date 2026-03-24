import { buildCoreContext } from "./context/build-context.mjs";
import { validateFlowOutput } from "./validators/validate-flow.mjs";
import { runDefaultGenerate, runDefaultRevise } from "./runners/default-ai.mjs";
import { runCodexGenerate, runCodexRevise } from "./runners/codex-cli.mjs";
import { runClaudeCodeGenerate, runClaudeCodeRevise } from "./runners/claude-code-cli.mjs";

function asText(v) {
  return String(v == null ? "" : v).trim();
}

function normalizeEngine(raw) {
  const e = asText(raw || "default").toLowerCase();
  if (e === "codex") return "codex";
  if (e === "claude_code" || e === "cc" || e === "claude-code") return "claude_code";
  return "default";
}

function normalizeMode(raw) {
  const m = asText(raw || "generate").toLowerCase();
  if (m === "revise") return "revise";
  return "generate";
}

function pickRunner({ mode, engine }) {
  if (mode === "generate") {
    if (engine === "codex") return runCodexGenerate;
    if (engine === "claude_code") return runClaudeCodeGenerate;
    return runDefaultGenerate;
  }
  if (engine === "codex") return runCodexRevise;
  if (engine === "claude_code") return runClaudeCodeRevise;
  return runDefaultRevise;
}

async function runFlowAgent({ mode = "generate", engine = "default", input = {}, options = {}, logger = null } = {}) {
  const nm = normalizeMode(mode);
  const ne = normalizeEngine(engine);
  const ctx = await buildCoreContext({
    maxSpecChars: Number(options.maxSpecChars || 14000),
    maxKindChars: Number(options.maxKindChars || 12000),
  });
  const runner = pickRunner({ mode: nm, engine: ne });
  const externalEngine = ne === "codex" || ne === "claude_code";
  const context = externalEngine
    ? {
        // External CLIs can read local files; prefer path-based guidance.
        specDir: ctx.files.specDir,
        specPath: ctx.files.specPath,
        kindPath: ctx.files.kindPath,
      }
    : {
        // Default engine cannot read local files directly; keep embedded context.
        specDir: ctx.files.specDir,
        specPath: ctx.files.specPath,
        kindPath: ctx.files.kindPath,
        specText: ctx.specText,
        kindText: ctx.kindText,
      };
  const ret = await runner({
    input: {
      ...input,
      context,
    },
    options,
    logger,
  });
  if (!ret?.ok) return { ok: false, reason: asText(ret?.reason || "flow-agent failed"), engine: ne, mode: nm, raw: ret };
  const doc = ret.document || ret.flow;
  const checked = validateFlowOutput(doc);
  if (!checked.ok) {
    return {
      ok: false,
      reason: `flow validation failed: ${checked.errors.slice(0, 2).join(" | ")}`,
      errors: checked.errors,
      engine: ne,
      mode: nm,
      document: doc,
      flow: checked.flow || null,
    };
  }
  return {
    ok: true,
    engine: ne,
    mode: nm,
    document: doc,
    flow: checked.flow,
    meta: ret.meta || ret.raw || null,
  };
}

export { runFlowAgent, normalizeEngine, normalizeMode };
