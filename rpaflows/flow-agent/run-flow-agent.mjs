import pathLib from "path";
import { fileURLToPath } from "url";
import { promises as fsp } from "fs";
import { runFlowAgent } from "./index.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);

function getArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((v) => v.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function asText(v) {
  return String(v == null ? "" : v).trim();
}

async function readJsonFileMaybe(p) {
  if (!p) return null;
  const abs = pathLib.isAbsolute(p) ? p : pathLib.join(process.cwd(), p);
  const raw = await fsp.readFile(abs, "utf8");
  return JSON.parse(raw);
}

async function main() {
  const mode = asText(getArg("mode", "generate")) || "generate";
  const engine = asText(getArg("engine", "default")) || "default";
  const outPathArg = asText(getArg("out", ""));

  let input = {};
  const inputJsonPath = asText(getArg("input", ""));
  if (inputJsonPath) {
    input = (await readJsonFileMaybe(inputJsonPath)) || {};
  }

  if (mode === "generate") {
    const text = asText(getArg("text", ""));
    if (text) input.skillText = text;
  } else {
    const instruction = asText(getArg("instruction", "")) || asText(getArg("prompt", ""));
    if (instruction) input.userInstruction = instruction;
    if (!input.flowDocument && input.document && typeof input.document === "object") {
      input.flowDocument = input.document;
    }
    if (!input.flowDocument && input.flow && typeof input.flow === "object") {
      input.flowDocument = input.flow;
    }
    const flowPath = asText(getArg("flow", ""));
    if (flowPath) {
      const absFlow = pathLib.isAbsolute(flowPath) ? flowPath : pathLib.join(process.cwd(), flowPath);
      const src = JSON.parse(await fsp.readFile(absFlow, "utf8"));
      input.flowDocument = src;
    }
    const contextText = asText(getArg("context", ""));
    if (contextText) input.contextText = contextText;
  }

  const options = {
    model: asText(getArg("model", "advanced")) || "advanced",
    timeoutMs: Number(getArg("timeout-ms", "600000") || 600000),
    maxRepair: Number(getArg("max-repair", "1") || 1),
    maxRegenerate: Number(getArg("max-regenerate", "1") || 1),
  };

  const ret = await runFlowAgent({ mode, engine, input, options });
  if (!ret?.ok) {
    console.error("[flow-agent] failed:", ret?.reason || "unknown");
    if (Array.isArray(ret?.errors) && ret.errors.length) {
      console.error("[flow-agent] validation errors:");
      for (const e of ret.errors) console.error("-", e);
    }
    process.exitCode = 2;
    return;
  }

  const outObj = ret.document && typeof ret.document === "object"
    ? ret.document
    : { flow: ret.flow };
  const outText = `${JSON.stringify(outObj, null, 2)}\n`;
  if (outPathArg) {
    const absOut = pathLib.isAbsolute(outPathArg) ? outPathArg : pathLib.join(process.cwd(), outPathArg);
    await fsp.writeFile(absOut, outText, "utf8");
    console.log("[flow-agent] wrote:", absOut);
  } else {
    process.stdout.write(outText);
  }
  console.log(`[flow-agent] ok mode=${ret.mode} engine=${ret.engine} flowId=${asText(ret.flow?.id || "-")}`);
}

main().catch((err) => {
  console.error("[flow-agent] fatal:", err?.message || err);
  process.exitCode = 1;
});
