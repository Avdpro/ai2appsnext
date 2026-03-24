import pathLib from "path";
import { promises as fsp } from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
const ROOT = pathLib.resolve(__dirname, "..");
const RPAFLOWS_ROOT = pathLib.resolve(ROOT, "..");

function asText(v) {
  return String(v == null ? "" : v);
}

function truncate(text, n = 16000) {
  const s = asText(text);
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 18))}\n...(truncated)...`;
}

async function readIfExists(absPath) {
  try {
    return await fsp.readFile(absPath, "utf8");
  } catch (_) {
    return "";
  }
}

function parseSpecVersion(name) {
  const m = String(name || "").match(/rpa-flow-spec-v(\d+)(?:\.(\d+))?(?:\.(\d+))?\.md$/i);
  if (!m) return null;
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

function compareVersionTuple(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const av = Number(a?.[i] || 0);
    const bv = Number(b?.[i] || 0);
    if (av !== bv) return av - bv;
  }
  return 0;
}

async function resolveBestSpecPath(rootDir) {
  const primary = pathLib.join(rootDir, "rpa-flow-spec-v0.55.md");
  try {
    await fsp.access(primary);
  } catch (_) {
    // ignore and continue to dynamic discovery
  }
  try {
    const names = await fsp.readdir(rootDir);
    const cand = [];
    for (const name of names) {
      const n = String(name || "");
      if (!/rpa-flow-spec-v[\d.]+\.md$/i.test(n)) continue;
      const abs = pathLib.join(rootDir, n);
      let mtimeMs = 0;
      try {
        const st = await fsp.stat(abs);
        mtimeMs = Number(st?.mtimeMs || 0);
      } catch (_) {}
      cand.push({ name: n, abs, ver: parseSpecVersion(n), mtimeMs });
    }
    if (cand.length) {
      cand.sort((a, b) => {
        const av = a.ver || [0, 0, 0];
        const bv = b.ver || [0, 0, 0];
        const cmp = compareVersionTuple(av, bv);
        if (cmp !== 0) return -cmp;
        return Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0);
      });
      return cand[0].abs;
    }
  } catch (_) {}
  const fallback = pathLib.join(rootDir, "flow-management-spec.md");
  try {
    await fsp.access(fallback);
    return fallback;
  } catch (_) {}
  return primary;
}

async function buildCoreContext({ maxSpecChars = 14000, maxKindChars = 12000 } = {}) {
  const specPath = await resolveBestSpecPath(RPAFLOWS_ROOT);
  const kindPath = pathLib.join(RPAFLOWS_ROOT, "rpa.mjs");
  const specRaw = await readIfExists(specPath);
  const kindRaw = await readIfExists(kindPath);
  return {
    files: {
      specDir: RPAFLOWS_ROOT,
      specPath,
      kindPath,
    },
    specText: truncate(specRaw, maxSpecChars),
    kindText: truncate(kindRaw, maxKindChars),
  };
}

export { buildCoreContext };
