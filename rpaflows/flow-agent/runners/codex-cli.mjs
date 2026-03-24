import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { runExternalCliJson } from "./external-cli.mjs";
import { validateFlowOutput } from "../validators/validate-flow.mjs";

function asText(v) {
  return String(v == null ? "" : v).trim();
}

function firstJsonObject(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  try { return JSON.parse(s); } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

function splitCommand(raw) {
  return asText(raw).split(/\s+/).filter(Boolean);
}

function isBareCodexCommand(raw) {
  const parts = splitCommand(raw);
  if (parts.length !== 1) return false;
  const bin = parts[0].toLowerCase();
  return bin === "codex" || bin.endsWith("/codex");
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

function buildCodexValidationFixInstruction(userInstruction, errors = []) {
  const lines = [];
  lines.push("请修复你上一轮输出中的 Flow 校验错误，并返回完整 flow JSON。");
  lines.push("必须保持用户意图不变，尽量最小改动。");
  if (userInstruction) lines.push(`原用户指令：${String(userInstruction)}`);
  if (errors.length) {
    lines.push("校验错误列表：");
    errors.slice(0, 12).forEach((e, i) => lines.push(`${i + 1}. ${String(e || "")}`));
  }
  lines.push("再次强调：仅输出严格 JSON，不要输出解释文本。");
  return lines.join("\n");
}

function buildCodexPrompt(payload) {
  const specDir = asText(payload?.context?.specDir || "");
  const specPath = asText(payload?.context?.specPath || "");
  const kindPath = asText(payload?.context?.kindPath || "");
  return [
    "You are a flow-agent adapter.",
    "Return STRICT JSON only. No markdown, no prose, no code fences.",
    "Output must be one of:",
    "{\"flow\":{...}} or {\"document\":{\"flow\":{...}}}",
    "Before editing/generating flow, read local spec files from these absolute paths:",
    `- specDir: ${specDir || "(missing)"}`,
    `- specPath: ${specPath || "(missing)"}`,
    `- kindPath: ${kindPath || "(missing)"}`,
    "Treat those files as authoritative for action schema and invoke capability keys.",
    "If specPath is missing/unreadable, find latest matching file in specDir by pattern rpa-flow-spec-v*.md.",
    "Hard constraints you MUST follow:",
    "- For action.type='click'/'hover'/'input': use query (+ optional by). Never emit action.selector.",
    "- If action.by is present, it MUST start with \"css:\" or \"xpath:\".",
    "- For action.type='done': action.reason is required and action.conclusion must be {status:'done', value:any}.",
    "- Keep step ids stable unless the user explicitly asks to rename.",
    "- Prefer declaring flow.vars shell entries for intermediate values used by saveAs / ${vars.*}.",
    "- Nested dotted args/vars are supported and encouraged for clarity (e.g., flow.args['ctx.size'], flow.vars['login.ensure'], ${args.ctx.size}, ${vars.login.ensure}).",
    "- Preserve overall flow intent and routing unless user instruction says otherwise.",
    "- If uncertain, keep existing step shape and make minimal compliant edits.",
    "Input payload:",
    JSON.stringify(payload || {}, null, 2),
  ].join("\n\n");
}

function extractSessionId(text) {
  const s = String(text || "");
  const m = s.match(/session id:\s*([0-9a-f-]{36})/i);
  return m ? String(m[1] || "").trim() : "";
}

async function runCodexNativeExecJson({ command, payload, timeoutMs = 600000, resumeSessionId = "" }) {
  const parts = splitCommand(command);
  const bin = parts[0] || "codex";
  const baseArgs = parts.slice(1);
  const outFile = path.join(os.tmpdir(), `flow-agent-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const sid = asText(resumeSessionId || "");
  const prompt = `${buildCodexPrompt(payload)}\n`;
  const execOnce = async (withColorFlag = true) => await new Promise((resolve) => {
    const args = sid
      ? [
          ...baseArgs,
          "exec",
          "resume",
          "--skip-git-repo-check",
          ...(withColorFlag ? ["--color", "never"] : []),
          "--output-last-message",
          outFile,
          sid,
          "-",
        ]
      : [
          ...baseArgs,
          "exec",
          "--skip-git-repo-check",
          ...(withColorFlag ? ["--color", "never"] : []),
          "--output-last-message",
          outFile,
          "-",
        ];
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (ret) => {
      if (done) return;
      done = true;
      try { fs.unlinkSync(outFile); } catch (_) {}
      resolve(ret);
    };
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
      finish({ ok: false, reason: `external command timeout (${timeoutMs}ms)`, stdout, stderr });
    }, Math.max(5000, Number(timeoutMs || 600000)));
    child.stdout.on("data", (d) => { stdout += String(d || ""); });
    child.stderr.on("data", (d) => { stderr += String(d || ""); });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, reason: asText(err?.message || err || "spawn failed"), stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let text = "";
      try { text = asText(fs.readFileSync(outFile, "utf8")); } catch (_) {}
      const parsed = firstJsonObject(text || stdout);
      const sessionId = extractSessionId(`${stdout}\n${stderr}`);
      if (Number(code) !== 0) {
        return finish({ ok: false, reason: `external command exit=${code}`, code, stdout, stderr, parsed, sessionId });
      }
      if (!parsed || typeof parsed !== "object") {
        return finish({
          ok: false,
          reason: "external command returned non-json output",
          code,
          stdout: text || stdout,
          stderr,
          parsed: null,
          sessionId,
        });
      }
      finish({ ok: true, code, stdout: text || stdout, stderr, parsed, sessionId });
    });
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      finish({ ok: false, reason: asText(err?.message || err || "stdin write failed"), stdout, stderr });
    }
  });
  let ret = await execOnce(true);
  const errText = `${asText(ret?.reason)}\n${asText(ret?.stderr)}`.toLowerCase();
  if (!ret?.ok && errText.includes("unexpected argument '--color'")) {
    ret = await execOnce(false);
  }
  return ret;
}

async function runCodexCommandJson({ command, payload, timeoutMs }) {
  const cmd = asText(command || "codex");
  if (isBareCodexCommand(cmd)) {
    return await runCodexNativeExecJson({ command: cmd, payload, timeoutMs });
  }
  return await runExternalCliJson({ command: cmd, payload, timeoutMs });
}

async function runCodexGenerate({ input, options = {} }) {
  const command = asText(options.command || process.env.FLOW_AGENT_CODEX_CMD || "codex");
  const payload = {
    mode: "generate",
    skillText: asText(input?.skillText || input?.text || ""),
    context: input?.context || {},
    constraints: {
      output: "strict json only",
      needCompleteFlow: true,
      preferFlowVarsShell: true,
      allowNestedArgsVars: true,
    },
  };
  const ret = await runCodexCommandJson({
    command,
    timeoutMs: Number(options.timeoutMs || 600000),
    payload,
  });
  if (!ret.ok) return ret;
  const out = pickFlowAndDocument(ret.parsed);
  return {
    ok: true,
    document: out.document,
    flow: out.flow,
    raw: ret.parsed,
    meta: {
      cli: {
        command,
        code: Number(ret.code || 0),
        payloadPreview: asText(JSON.stringify(payload)),
        stdoutPreview: asText(ret.stdout || ""),
        stderrPreview: asText(ret.stderr || ""),
      },
    },
  };
}

async function runCodexRevise({ input, options = {} }) {
  const command = asText(options.command || process.env.FLOW_AGENT_CODEX_CMD || "codex");
  const basePayload = {
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
  };
  const timeoutMs = Number(options.timeoutMs || 600000);
  const maxRoundsRaw = Number(options.maxRepair);
  const maxRounds = Number.isFinite(maxRoundsRaw) ? Math.max(1, Math.min(4, 1 + Math.floor(maxRoundsRaw))) : 2;
  let currentPayload = basePayload;
  let sessionId = asText(options.codexThreadSessionId || "");
  let lastRet = null;
  const attempts = [];
  for (let round = 1; round <= maxRounds; round += 1) {
    const ret = await runCodexNativeExecJson({
      command,
      timeoutMs,
      payload: currentPayload,
      resumeSessionId: sessionId,
    });
    lastRet = ret;
    if (ret?.sessionId) sessionId = asText(ret.sessionId);
    attempts.push({
      round,
      sessionId: sessionId || "",
      code: Number(ret?.code || 0),
      ok: ret?.ok === true,
      payloadPreview: asText(JSON.stringify(currentPayload)),
      stdoutPreview: asText(ret?.stdout || ""),
      stderrPreview: asText(ret?.stderr || ""),
      reason: asText(ret?.reason || ""),
    });
    if (!ret?.ok) return ret;
    const out = pickFlowAndDocument(ret.parsed);
    const checked = validateFlowOutput(out.document || out.flow);
    if (checked?.ok) {
      return {
        ok: true,
        document: out.document,
        flow: out.flow,
        raw: ret.parsed,
        meta: {
          cli: {
            command,
            code: Number(ret.code || 0),
            sessionId,
            payloadPreview: asText(JSON.stringify(currentPayload)),
            stdoutPreview: asText(ret.stdout || ""),
            stderrPreview: asText(ret.stderr || ""),
          },
          cliAttempts: attempts,
          codexThreadSessionId: sessionId || "",
          codexValidationRounds: round,
        },
      };
    }
    if (round >= maxRounds) {
      // Return last candidate; upper layer will run its own validation and decide fallback policy.
      return {
        ok: true,
        document: out.document,
        flow: out.flow,
        raw: ret.parsed,
        meta: {
          cli: {
            command,
            code: Number(ret.code || 0),
            sessionId,
            payloadPreview: asText(JSON.stringify(currentPayload)),
            stdoutPreview: asText(ret.stdout || ""),
            stderrPreview: asText(ret.stderr || ""),
          },
          cliAttempts: attempts,
          codexThreadSessionId: sessionId || "",
          codexValidationRounds: round,
          codexValidationFailedErrors: Array.isArray(checked?.errors) ? checked.errors.slice(0, 20) : [],
        },
      };
    }
    const errs = Array.isArray(checked?.errors) ? checked.errors.map((x) => asText(x)).filter(Boolean) : [];
    currentPayload = {
      ...basePayload,
      flowDocument: out.document || out.flow || basePayload.flowDocument,
      userInstruction: buildCodexValidationFixInstruction(basePayload.userInstruction, errs),
      validationFeedback: { errors: errs.slice(0, 20), round },
    };
  }
  return lastRet || { ok: false, reason: "codex revise failed" };
}

export { runCodexGenerate, runCodexRevise };
