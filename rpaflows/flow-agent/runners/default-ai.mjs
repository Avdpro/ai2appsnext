import { skillToFlow, reviseFlowDocumentByPrompt } from "../../SkillToFlow.mjs";

function asText(v) {
  return String(v == null ? "" : v).trim();
}

async function runDefaultGenerate({ input, options = {}, logger = null }) {
  const skillText = asText(input?.skillText || input?.text);
  if (!skillText) return { ok: false, reason: "skillText is required" };
  const ret = await skillToFlow({
    skillText,
    model: asText(options.model || "advanced") || "advanced",
    maxRepair: Number.isFinite(Number(options.maxRepair)) ? Number(options.maxRepair) : 1,
    maxRegenerate: Number.isFinite(Number(options.maxRegenerate)) ? Number(options.maxRegenerate) : 1,
    timeoutMs: Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 600000,
    logger,
  });
  if (!ret?.ok) return { ok: false, reason: asText(ret?.reason || "generate failed"), raw: ret };
  const doc = ret?.result && typeof ret.result === "object" ? ret.result : { flow: ret.flow };
  return { ok: true, document: doc, flow: doc.flow || ret.flow, meta: ret };
}

async function runDefaultRevise({ input, options = {}, logger = null }) {
  const flowDocument = input?.flowDocument;
  const userInstruction = asText(input?.userInstruction || input?.instruction || input?.prompt);
  if (!flowDocument || typeof flowDocument !== "object") return { ok: false, reason: "flowDocument is required" };
  if (!userInstruction) return { ok: false, reason: "userInstruction is required" };
  const ret = await reviseFlowDocumentByPrompt({
    flowDocument,
    userInstruction,
    contextText: asText(input?.contextText || ""),
    model: asText(options.model || "advanced") || "advanced",
    maxRepair: Number.isFinite(Number(options.maxRepair)) ? Number(options.maxRepair) : 1,
    maxRegenerate: Number.isFinite(Number(options.maxRegenerate)) ? Number(options.maxRegenerate) : 1,
    timeoutMs: Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 600000,
    logger,
  });
  if (!ret?.ok) return { ok: false, reason: asText(ret?.reason || "revise failed"), raw: ret };
  const doc = ret.document || flowDocument;
  const flow = (doc && typeof doc === "object" && doc.flow && typeof doc.flow === "object") ? doc.flow : doc;
  return { ok: true, document: doc, flow, meta: ret };
}

export { runDefaultGenerate, runDefaultRevise };
