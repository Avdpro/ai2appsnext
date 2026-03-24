function parseFlowVal(val, args, opts, vars, result, _seen) {
	const seen = _seen || new WeakMap();

	if (Array.isArray(val)) {
		if (seen.has(val)) return seen.get(val);
		const out = [];
		seen.set(val, out);
		for (let i = 0; i < val.length; i++) out[i] = parseFlowVal(val[i], args, opts, vars, result, seen);
		return out;
	}

	if (val && typeof val === "object") {
		const proto = Object.getPrototypeOf(val);
		const isPlain = proto === Object.prototype || proto === null;
		if (!isPlain) return val;
		if (seen.has(val)) return seen.get(val);
		const out = proto === null ? Object.create(null) : {};
		seen.set(val, out);
		for (const k of Object.keys(val)) out[k] = parseFlowVal(val[k], args, opts, vars, result, seen);
		return out;
	}

	if (typeof val !== "string") return val;
	const s = val;

	const jsBlock = s.match(/^\$\{\{([\s\S]*)\}\}$/);
	if (jsBlock) {
		const js = String(jsBlock[1] || "").trim();
		if (!js) return "";
		const body = /\breturn\b/.test(js) ? js : `return (${js});`;
		try {
			const fn = new Function("args", "opts", "vars", "result", `"use strict";\n${body}`);
			const v = fn(args, opts, vars, result);
			return v == null ? "" : v;
		} catch (_) {
			return "";
		}
	}

	const isDangerKey = (k) => k === "__proto__" || k === "prototype" || k === "constructor";
	function resolvePath(rawPath) {
		let path = String(rawPath || "").trim();
		if (!path) return undefined;

		if (path === "args") return args;
		if (path === "opts") return opts;
		if (path === "vars") return vars;
		if (path === "result") return result;

		let src = args;
		const pickSource = (obj, cutLen) => {
			src = obj;
			path = path.slice(cutLen);
			if (path.startsWith(".")) path = path.slice(1);
		};
		if (path.startsWith("vars.") || path.startsWith("vars[")) pickSource(vars, 4);
		else if (path.startsWith("opts.") || path.startsWith("opts[")) pickSource(opts, 4);
		else if (path.startsWith("result.") || path.startsWith("result[")) pickSource(result, 6);
		else if (path.startsWith("args.") || path.startsWith("args[")) pickSource(args, 4);

		if (src == null) return undefined;
		if (!path) return src;

		const tokens = [];
		let i = 0;
		const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
		const isIdentChar = (c) => /[A-Za-z0-9_$]/.test(c);
		while (i < path.length) {
			const ch = path[i];
			if (ch === ".") {
				i += 1;
				continue;
			}
			if (ch === "[") {
				let j = i + 1;
				let numStr = "";
				while (j < path.length && /[0-9]/.test(path[j])) {
					numStr += path[j];
					j += 1;
				}
				if (!numStr || path[j] !== "]") return undefined;
				tokens.push(Number(numStr));
				i = j + 1;
				continue;
			}
			if (isIdentStart(ch)) {
				let j = i + 1;
				while (j < path.length && isIdentChar(path[j])) j += 1;
				const key = path.slice(i, j);
				if (isDangerKey(key)) return undefined;
				tokens.push(key);
				i = j;
				continue;
			}
			return undefined;
		}

		let cur = src;
		for (const t of tokens) {
			if (cur == null) return undefined;
			if (typeof t === "string") {
				if (isDangerKey(t)) return undefined;
			}
			cur = cur[t];
		}
		return cur;
	}

	const sole = s.match(/^\$\{([^}]+)\}$/);
	if (sole) {
		const v = resolvePath(sole[1]);
		return v == null ? "" : v;
	}

	const toStr = (v) => {
		if (v == null) return "";
		if (typeof v === "string") return v;
		if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
		try {
			return JSON.stringify(v);
		} catch (_) {
			return String(v);
		}
	};

	let out = "";
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "\\" && i + 1 < s.length && s[i + 1] === "$") {
			out += "$";
			i += 2;
			continue;
		}
		if (ch === "$" && i + 1 < s.length && s[i + 1] === "{") {
			const end = s.indexOf("}", i + 2);
			if (end === -1) {
				out += "$";
				i += 1;
				continue;
			}
			const expr = s.slice(i + 2, end);
			out += toStr(resolvePath(expr));
			i = end + 1;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

function runBranchAction(action, args, opts, vars, result) {
	if (!action || action.type !== "branch") {
		throw new Error("runBranchAction: action.type must be 'branch'");
	}
	const cases = Array.isArray(action.cases) ? action.cases : [];
	for (const c of cases) {
		if (!c || !c.when || typeof c.to !== "string") continue;
		if (evalCond(c.when)) return c.to;
	}
	return action.default;

	function readValue(cond) {
		const source = cond.source || "args";
		const path = cond.path || "";
		const base = source === "opts" ? opts : source === "vars" ? vars : source === "result" ? result : args;
		return parseFlowVal(`\${${source}.${path}}`, args, opts, vars, result);
	}

	function evalCond(cond) {
		if (!cond || typeof cond !== "object") return false;
		if (cond.op === "and") return Array.isArray(cond.items) && cond.items.every(evalCond);
		if (cond.op === "or") return Array.isArray(cond.items) && cond.items.some(evalCond);
		if (cond.op === "not") return !evalCond(cond.item);
		const v = readValue(cond);
		const asFiniteNumber = (x) => {
			const n = Number(x);
			return Number.isFinite(n) ? n : null;
		};
		switch (cond.op) {
			case "exists":
				return v !== null && v !== undefined;
			case "truthy":
				return !!v;
			case "eq":
				return v === cond.value;
			case "neq":
				return v !== cond.value;
			case "gt": {
				const a = asFiniteNumber(v);
				const b = asFiniteNumber(cond.value);
				return a !== null && b !== null && a > b;
			}
			case "gte": {
				const a = asFiniteNumber(v);
				const b = asFiniteNumber(cond.value);
				return a !== null && b !== null && a >= b;
			}
			case "lt": {
				const a = asFiniteNumber(v);
				const b = asFiniteNumber(cond.value);
				return a !== null && b !== null && a < b;
			}
			case "lte": {
				const a = asFiniteNumber(v);
				const b = asFiniteNumber(cond.value);
				return a !== null && b !== null && a <= b;
			}
			case "in":
				return Array.isArray(cond.values) && cond.values.includes(v);
			case "contains":
				if (typeof v === "string") return v.includes(String(cond.value ?? ""));
				if (Array.isArray(v)) return v.includes(cond.value);
				return false;
			case "match":
				try {
					const rx = String(cond.regex || cond.pattern || "");
					return new RegExp(rx, String(cond.flags || "")).test(String(v ?? ""));
				} catch (_) {
					return false;
				}
			default:
				return false;
		}
	}
}

async function execRunJsAction(action, ctx) {
	const t0 = Date.now();
	try {
		if (!action || action.type !== "run_js") {
			return { status: "failed", reason: "run_js: invalid action", meta: { durationMs: Date.now() - t0 } };
		}
		const scope = action.scope === "agent" ? "agent" : "page";
		const rawArgs = Array.isArray(action.args) ? action.args : [];
		const parsedArgs = rawArgs.map((v) => ctx.parseVal(v, ctx.args, ctx.opts, ctx.vars, ctx.result));
		const code = String(action.code || "");
		const compiled = compileSingleFunction(code);
		if (!compiled.ok) {
			return { status: "failed", reason: `run_js.code invalid: ${compiled.reason}`, meta: { scope, durationMs: Date.now() - t0 } };
		}
		let value;
		if (scope === "agent") {
			value = await compiled.fn(...parsedArgs);
		} else {
			if (typeof ctx.pageEval !== "function") {
				return { status: "failed", reason: 'run_js(scope:"page") requires pageEval', meta: { scope, durationMs: Date.now() - t0 } };
			}
			// Run function source directly via BiDi callFunction to avoid CSP issues with eval/new Function wrappers.
			try {
				value = await ctx.pageEval(code, parsedArgs);
			} catch (e) {
				return {
					status: "failed",
					reason: e?.message || "run_js(page) threw",
					error: { name: e?.name, message: e?.message },
					meta: { scope, durationMs: Date.now() - t0 },
				};
			}
		}
		return { status: "done", value, meta: { scope, durationMs: Date.now() - t0 } };
	} catch (e) {
		return { status: "failed", reason: "run_js threw an error", error: { name: e?.name, message: e?.message }, meta: { durationMs: Date.now() - t0 } };
	}
}

function compileSingleFunction(codeStr) {
	const src = String(codeStr || "").trim();
	if (!src) return { ok: false, reason: "empty code" };
	if (/\)\s*\(\s*\)\s*;?\s*$/.test(src) || /\}\s*\(\s*\)\s*;?\s*$/.test(src)) {
		return { ok: false, reason: "top-level invocation (IIFE) is not allowed" };
	}
	try {
		const fn = new Function('"use strict"; return (' + src + ");")();
		if (typeof fn !== "function") return { ok: false, reason: "code does not evaluate to a function" };
		return { ok: true, fn };
	} catch (_) {
		return { ok: false, reason: "cannot compile to a function" };
	}
}

export { parseFlowVal, runBranchAction, execRunJsAction };
