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

// 앱 화면은 자기 출처의 스크립트만 실행하고, 다른 사이트가 iframe으로 덮어씌우지 못하게 한다.
// GitHub 프로필 사진은 https 이미지로 받는다.
const PAGE_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

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
    ...PAGE_HEADERS,
    "Content-Type": `${MIME[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8`,
  });
  fs.createReadStream(file).pipe(res);
}

// Browsers label cross-site requests with Sec-Fetch-Site and Origin. API calls must come
// from the app page itself (or be typed into the address bar); CLI clients send neither.
function fromApp(req, port) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function createHttpServer({ getPort, publicDir, handleApi, handleMcp }) {
  return http.createServer(async (req, res) => {
    const port = getPort();
    const trusted = [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host);
    const forbid = () => res.writeHead(403).end("Forbidden");
    if (!trusted) return forbid();
    try {
      // Decide on the normalized path so "/mcp/../api/..." cannot borrow the MCP exemption.
      const url = new URL(req.url, `http://${req.headers.host}`);
      const mcp = url.pathname.match(/^\/mcp\/([0-9a-f]{48})$/);
      const api = url.pathname.startsWith("/api/");
      // Local Host validation prevents DNS rebinding. Every API call must come from the app
      // page, and writes also need the custom header; CLI MCP requests instead use a secret
      // URL and reject browser Origins.
      const authorized = mcp ? !req.headers.origin
        : (!api || fromApp(req, port)) && (req.method === "GET" || req.headers["x-agenthub"] === "1");
      if (!authorized) return forbid();
      if (mcp) return await handleMcp(req, res, mcp[1]);
      if (!api) return serveStatic(req, res, publicDir);
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

