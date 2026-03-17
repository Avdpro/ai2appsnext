import pathLib from "path";
import fsp from "fs/promises";

function urlToJsonName(url) {
	const maxLen = 200;
	let s = String(url)
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!s) s = "url";
	if (s.length > maxLen) s = s.slice(0, maxLen);
	return s + ".json";
}

async function readJson(filePath) {
	try {
		return JSON.parse(await fsp.readFile(filePath, "utf8"));
	} catch (_) {
		return null;
	}
}

async function saveJson(filePath, data) {
	const dir = pathLib.dirname(filePath);
	if (dir && dir !== ".") {
		await fsp.mkdir(dir, { recursive: true });
	}
	await fsp.writeFile(filePath, JSON.stringify(data, null, "\t"), "utf8");
}

function deepEq(a, b) {
	if (Object.is(a, b)) {
		return true;
	}
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch (_) {
		return false;
	}
}

function getLan() {
	const htmlLang = document.documentElement && document.documentElement.lang;
	if (htmlLang && htmlLang.trim()) return htmlLang.trim();
	const metaHttp = document.querySelector('meta[http-equiv="content-language" i]');
	const metaHttpLang = metaHttp && metaHttp.getAttribute("content");
	if (metaHttpLang && metaHttpLang.trim()) return metaHttpLang.trim();
	const metaName = document.querySelector('meta[name="language" i]');
	const metaNameLang = metaName && metaName.getAttribute("content");
	if (metaNameLang && metaNameLang.trim()) return metaNameLang.trim();
	return "web";
}

export { urlToJsonName, readJson, saveJson, deepEq, getLan };
