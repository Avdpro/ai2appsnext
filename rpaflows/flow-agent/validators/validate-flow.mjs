import { validateFlow } from "../../SkillToFlow.mjs";

function normalizeFlowFromDocument(documentOrFlow) {
  const src = (documentOrFlow && typeof documentOrFlow === "object") ? documentOrFlow : null;
  if (!src) return null;
  if (src.flow && typeof src.flow === "object" && !Array.isArray(src.flow)) return src.flow;
  return src;
}

function validateFlowOutput(documentOrFlow) {
  const flow = normalizeFlowFromDocument(documentOrFlow);
  if (!flow) return { ok: false, errors: ["flow is required"] };
  const errors = validateFlow(flow, {});
  return { ok: !errors.length, errors, flow };
}

export { normalizeFlowFromDocument, validateFlowOutput };
