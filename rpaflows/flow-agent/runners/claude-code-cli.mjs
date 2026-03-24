import { runExternalCliJson } from "./external-cli.mjs";

function asText(v) {
  return String(v == null ? "" : v).trim();
}

function pickFlowAndDocument(parsed) {
  const obj = (parsed && typeof parsed === "object") ? parsed : {};
  if (obj.document && typeof obj.document === "object") {
    const flow = (obj.document.flow && typeof obj.document.flow === "object") ? obj.document.flow : obj.document;
    return { document: obj.document, flow };
  }
  if (obj.flow && typeof obj.flow === "object") return { document: { flow: obj.flow }, flow: obj.flow };
  return { document: obj, flow: obj };
}

async function runClaudeCodeGenerate({ input, options = {} }) {
  const command = asText(options.command || process.env.FLOW_AGENT_CC_CMD || "claude");
  const ret = await runExternalCliJson({
    command,
    timeoutMs: Number(options.timeoutMs || 600000),
    payload: {
      mode: "generate",
      skillText: asText(input?.skillText || input?.text || ""),
      context: input?.context || {},
      constraints: {
        output: "strict json only",
        needCompleteFlow: true,
        preferFlowVarsShell: true,
        allowNestedArgsVars: true,
      },
    },
  });
  if (!ret.ok) return ret;
  const out = pickFlowAndDocument(ret.parsed);
  return { ok: true, document: out.document, flow: out.flow, raw: ret.parsed };
}

async function runClaudeCodeRevise({ input, options = {} }) {
  const command = asText(options.command || process.env.FLOW_AGENT_CC_CMD || "claude");
  const ret = await runExternalCliJson({
    command,
    timeoutMs: Number(options.timeoutMs || 600000),
    payload: {
      mode: "revise",
      flowDocument: input?.flowDocument || null,
      userInstruction: asText(input?.userInstruction || input?.instruction || ""),
      contextText: asText(input?.contextText || ""),
      history: Array.isArray(input?.history) ? input.history : [],
      constraints: {
        output: "strict json only",
        needCompleteFlow: true,
        preferFlowVarsShell: true,
        allowNestedArgsVars: true,
      },
    },
  });
  if (!ret.ok) return ret;
  const out = pickFlowAndDocument(ret.parsed);
  return { ok: true, document: out.document, flow: out.flow, raw: ret.parsed };
}

export { runClaudeCodeGenerate, runClaudeCodeRevise };
