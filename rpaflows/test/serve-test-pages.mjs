import http from "http";
import pathLib from "path";
import { fileURLToPath } from "url";
import { promises as fsp } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathLib.dirname(__filename);
const rootDir = pathLib.join(__dirname, "test-pages");
const port = Number(process.env.TEST_PAGES_PORT || 8787);

const mimeMap = new Map([
	[".html", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".ico", "image/x-icon"],
]);

function mimeOf(filePath) {
	return mimeMap.get(pathLib.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function safeResolve(urlPath) {
	const p = decodeURIComponent(String(urlPath || "/").split("?")[0]);
	const rel = p === "/" ? "/index.html" : p;
	const full = pathLib.resolve(rootDir, "." + rel);
	if (!full.startsWith(rootDir + pathLib.sep) && full !== rootDir) return null;
	return full;
}

const server = http.createServer(async (req, res) => {
	const filePath = safeResolve(req.url || "/");
	if (!filePath) {
		res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Bad path");
		return;
	}
	try {
		let st = await fsp.stat(filePath);
		let finalPath = filePath;
		if (st.isDirectory()) {
			finalPath = pathLib.join(filePath, "index.html");
			st = await fsp.stat(finalPath);
		}
		if (!st.isFile()) throw new Error("not file");
		const data = await fsp.readFile(finalPath);
		const headers = { "Content-Type": mimeOf(finalPath), "Cache-Control": "no-store" };
		const relPath = finalPath.slice(rootDir.length).replace(/\\/g, "/");
		if (/^\/download\/files\/.+/i.test(relPath)) {
			headers["Content-Disposition"] = `attachment; filename="${pathLib.basename(finalPath)}"`;
		}
		res.writeHead(200, headers);
		res.end(data);
	} catch (_) {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not found");
	}
});

server.listen(port, "127.0.0.1", () => {
	console.log(`[serve-test-pages] http://127.0.0.1:${port}`);
	console.log(`[serve-test-pages] root=${rootDir}`);
});
