/**
 * briefJSON(val, opts) -> string
 * Compact/cycle-safe JSON-like preview for logs/debug payloads.
 */
function briefJSON(val, opts = {}) {
	const maxDepth = opts.maxDepth ?? 4;
	const maxString = opts.maxString ?? 200;
	const maxElements = opts.maxElements ?? 20;
	const maxKeys = opts.maxKeys ?? 50;
	const sortKeys = !!opts.sortKeys;
	const pretty = !!opts.pretty;
	const indent = opts.indent ?? 2;

	const seen = new WeakMap(); // obj -> path

	function truncStr(s) {
		const t = String(s ?? "");
		if (t.length <= maxString) return t;
		return t.slice(0, maxString) + "...more...";
	}

	function tag(s) {
		return `[${s}]`;
	}

	function isPlainObject(o) {
		if (o === null || typeof o !== "object") return false;
		const p = Object.getPrototypeOf(o);
		return p === Object.prototype || p === null;
	}

	function toJSONSafePrimitive(x) {
		const t = typeof x;
		if (x === undefined) return tag("Undefined");
		if (t === "function") return tag(`Function${x.name ? ":" + x.name : ""}`);
		if (t === "symbol") return tag(`Symbol${x.description ? ":" + x.description : ""}`);
		if (t === "bigint") return tag(`BigInt:${x.toString()}n`);
		if (t === "number") {
			if (Number.isNaN(x)) return tag("NaN");
			if (x === Infinity) return tag("Infinity");
			if (x === -Infinity) return tag("-Infinity");
			return x;
		}
		if (t === "string") return truncStr(x);
		return x;
	}

	function walk(x, depth, path) {
		if (x === null || typeof x !== "object") return toJSONSafePrimitive(x);

		const prevPath = seen.get(x);
		if (prevPath) return tag(`Circular~${prevPath}`);
		seen.set(x, path);

		if (depth >= maxDepth) {
			return Array.isArray(x) ? tag("...array...") : tag("...object...");
		}

		if (x instanceof Date) return tag(`Date:${Number.isNaN(x.getTime()) ? "Invalid" : x.toISOString()}`);
		if (x instanceof RegExp) return tag(`RegExp:${x.toString()}`);
		if (x instanceof Error) return tag(`Error:${x.name}:${truncStr(String(x.message || ""))}`);
		if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(x)) return tag(`Buffer:${x.length}b`);
		if (ArrayBuffer.isView(x) && !(x instanceof DataView)) return tag(`${x.constructor?.name || "TypedArray"}:${x.length}`);
		if (x instanceof ArrayBuffer) return tag(`ArrayBuffer:${x.byteLength}b`);

		if (x instanceof Map) {
			const arr = [];
			let i = 0;
			for (const [k, v] of x.entries()) {
				if (i >= maxElements) break;
				arr.push([walk(k, depth + 1, `${path}.mapKey${i}`), walk(v, depth + 1, `${path}.mapVal${i}`)]);
				i++;
			}
			return {
				$map: arr,
				$size: x.size,
				...(x.size > maxElements ? { $more: tag("...more...") } : null),
			};
		}

		if (x instanceof Set) {
			const arr = [];
			let i = 0;
			for (const v of x.values()) {
				if (i >= maxElements) break;
				arr.push(walk(v, depth + 1, `${path}.set${i}`));
				i++;
			}
			return {
				$set: arr,
				$size: x.size,
				...(x.size > maxElements ? { $more: tag("...more...") } : null),
			};
		}

		if (Array.isArray(x)) {
			const n = x.length;
			const take = Math.min(n, maxElements);
			const out = new Array(take);
			for (let i = 0; i < take; i++) out[i] = walk(x[i], depth + 1, `${path}[${i}]`);
			if (n > maxElements) out.push(tag("...more..."));
			return out;
		}

		if (!isPlainObject(x)) {
			const obj = { $type: x.constructor?.name || "Object" };
			const keys = Object.keys(x);
			if (sortKeys) keys.sort();
			const take = Math.min(keys.length, maxKeys);
			for (let i = 0; i < take; i++) {
				const k = keys[i];
				obj[k] = walk(x[k], depth + 1, `${path}.${k}`);
			}
			if (keys.length > maxKeys) obj.$more = tag("...more...");
			return obj;
		}

		const keys = Object.keys(x);
		if (sortKeys) keys.sort();
		const take = Math.min(keys.length, maxKeys);
		const out = {};
		for (let i = 0; i < take; i++) {
			const k = keys[i];
			out[k] = walk(x[k], depth + 1, `${path}.${k}`);
		}
		if (keys.length > maxKeys) out.$more = tag("...more...");
		return out;
	}

	return JSON.stringify(walk(val, 0, "$"), null, pretty ? indent : 0);
}

export { briefJSON };

