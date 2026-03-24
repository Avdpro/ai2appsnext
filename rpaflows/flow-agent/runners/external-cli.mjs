import { spawn } from "child_process";

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

async function runExternalCliJson({ command, payload, timeoutMs = 600000 }) {
  const cmd = asText(command);
  if (!cmd) return { ok: false, reason: "external command is empty" };
  const parts = cmd.split(/\s+/).filter(Boolean);
  if (!parts.length) return { ok: false, reason: "invalid external command" };
  const bin = parts[0];
  const args = parts.slice(1);
  return await new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (ret) => {
      if (done) return;
      done = true;
      resolve(ret);
    };
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
      const parsed = firstJsonObject(stdout);
      if (Number(code) !== 0) {
        return finish({ ok: false, reason: `external command exit=${code}`, code, stdout, stderr, parsed });
      }
      if (!parsed || typeof parsed !== "object") {
        return finish({ ok: false, reason: "external command returned non-json stdout", code, stdout, stderr });
      }
      finish({ ok: true, code, stdout, stderr, parsed });
    });

    try {
      child.stdin.write(`${JSON.stringify(payload || {}, null, 2)}\n`);
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      finish({ ok: false, reason: asText(err?.message || err || "stdin write failed"), stdout, stderr });
    }
  });
}

export { runExternalCliJson };
