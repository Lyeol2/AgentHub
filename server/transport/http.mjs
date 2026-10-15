import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { HttpError } from "../application/errors.mjs";

export function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export async function readJson(req, { maxBytes = 1_000_000 } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) throw new HttpError(413, "요청이 너무 큽니다.");
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try {
    return bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw new HttpError(400, "JSON 형식이 아닙니다.");
  }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

export function serveStatic(req, res, publicDir) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.resolve(publicDir, "." + (urlPath === "/" ? "/index.html" : urlPath));
  const relative = path.relative(publicDir, file);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": `${MIME[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8`,
  });
  fs.createReadStream(file).pipe(res);
}

export function createHttpServer({ getPort, publicDir, handleApi, handleMcp }) {
  return http.createServer(async (req, res) => {
    const port = getPort();
    const trusted = [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
    // Local Host validation prevents DNS rebinding. Browser writes use the custom
    // header; CLI MCP requests instead use a secret URL and reject browser Origins.
    const authorized = req.url.startsWith("/mcp/")
      ? !req.headers.origin
      : req.method === "GET" || req.headers["x-agenthub"] === "1";
    if (!trusted || !authorized) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const mcp = url.pathname.match(/^\/mcp\/([0-9a-f]{48})$/);
      if (mcp) return await handleMcp(req, res, mcp[1]);
      if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, publicDir);
      await handleApi(req, res, url);
    } catch (err) {
      send(res, err.status ?? 500, {
        error: err.message,
        reason: err.reason,
        ...(err.outcomeUnknown !== undefined ? { outcomeUnknown: err.outcomeUnknown } : {}),
      });
    }
  });
}

