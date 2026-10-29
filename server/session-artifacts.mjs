import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { HttpError } from "./application/errors.mjs";
import { collectReportReferences } from "../public/report-references.js";

export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
// 영상은 통째로 읽지 않고 요청한 구간만 보내므로 크게 받는다.
export const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_ARTIFACT_TEXT_BYTES = 512 * 1024;
// HTML 미리보기 안의 영상·소리는 미리보기를 만들 때 발급한 임시 주소(/preview-media/<토큰>)로 받는다.
const PREVIEW_MEDIA_SOURCES = "http://127.0.0.1:* http://localhost:*";
export const ARTIFACT_PREVIEW_CSP = `sandbox allow-scripts; default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: ${PREVIEW_MEDIA_SOURCES}; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`;
const MAX_PREVIEW_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_TOTAL_BYTES = 24 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set("txt text csv tsv json jsonl ndjson xml svg css scss less js mjs cjs jsx ts tsx py rb go rs java kt swift c h cpp hpp cs sh bash zsh ps1 bat cmd sql yaml yml toml ini cfg conf log env gitignore gitattributes dockerfile makefile".split(" "));
const IMAGE_MIMES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon" };
const VIDEO_MIMES = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4", ".ogv": "video/ogg" };
const ASSET_MIMES = { ...IMAGE_MIMES, ...VIDEO_MIMES, ".svg": "image/svg+xml", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf" };
const comparePath = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const pathKey = (value) => comparePath(path.resolve(value).replace(/\\/g, "/"));
const within = (root, target) => {
  const rel = path.relative(root, target);
  return !rel || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
};
const fail = (status, message) => { throw new HttpError(status, message); };

function localPath(value, cwd) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail(400, "파일 경로가 올바르지 않습니다.");
  let input = value.trim();
  if (/^[A-Za-z]:(?![\\/])/.test(input)) fail(400, "드라이브의 전체 파일 경로를 입력하세요.");
  let line, column;
  const location = input.match(/(?::([1-9]\d{0,8})(?::([1-9]\d{0,8}))?|#L([1-9]\d{0,8}))$/);
  if (location) {
    line = Number(location[1] ?? location[3]);
    if (location[2]) column = Number(location[2]);
    input = input.slice(0, location.index);
  }
  // No URLs, network shares, device paths, NTFS streams, or drive-relative paths.
  if (/^[\\/]{2}/.test(input) || /^(?![A-Za-z]:[\\/])[A-Za-z][\w+.-]*:/.test(input) || /:/.test(input.replace(/^[A-Za-z]:/, ""))) fail(400, "로컬 파일 경로만 사용할 수 있습니다.");
  if (!cwd || typeof cwd !== "string") fail(400, "세션 작업 폴더가 없습니다.");
  return { target: path.resolve(cwd, input), absolute: path.isAbsolute(input), ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

function mentionedPath(session, target, resolveAttachment) {
  const key = pathKey(target);
  // Match the complete path, not a prefix of another file name. Both slash forms
  // occur in imported CLI transcripts and Markdown links.
  const needles = [target, target.replace(/\\/g, "/"), target.replace(/\//g, "\\")].map((v) => comparePath(v));
  for (const event of session.events ?? []) {
    for (const attachment of event.attachments ?? []) {
      try {
        const file = attachment.path || resolveAttachment?.(attachment)?.path;
        if (file && pathKey(file) === key) return true;
      } catch { /* A removed attachment does not grant access. */ }
    }
    if ((event.references ?? []).some((reference) => typeof reference?.path === "string" && path.isAbsolute(reference.path) && pathKey(reference.path) === key)) return true;
    // Use the same decoded destinations as the UI for file:// and escaped Markdown links.
    for (const ref of collectReportReferences(String(event.text ?? ""))) {
      if (!ref.path || !path.isAbsolute(ref.path)) continue;
      try {
        if (pathKey(localPath(ref.path, session.cwd || session.projectPath).target) === key) return true;
      } catch { /* Invalid references never grant file access. */ }
    }
    const text = comparePath(String(event.text ?? ""));
    for (const needle of needles) {
      let offset = 0;
      while ((offset = text.indexOf(needle, offset)) !== -1) {
        const before = offset ? text[offset - 1] : "";
        const after = text[offset + needle.length] ?? "";
        if ((!before || /[\s([<"'`=@]/.test(before)) && (!after || /[\s)\]>"'`,;!?]/.test(after) || /^(?::\d+(?::\d+)?|#L\d+)(?:$|[\s)\]>"'`,;!?])/i.test(text.slice(offset + needle.length)))) return true;
        offset += needle.length;
      }
    }
  }
  return false;
}

function classify(file) {
  const extension = path.extname(file).toLowerCase();
  if (IMAGE_MIMES[extension]) return { kind: "image", mimeType: IMAGE_MIMES[extension] };
  if (VIDEO_MIMES[extension]) return { kind: "video", mimeType: VIDEO_MIMES[extension] };
  if ([".md", ".markdown", ".mdown"].includes(extension)) return { kind: "markdown", mimeType: "text/markdown" };
  if ([".html", ".htm"].includes(extension)) return { kind: "html", mimeType: "text/html" };
  if (TEXT_EXTENSIONS.has(extension.slice(1)) || TEXT_EXTENSIONS.has(path.basename(file).replace(/^\./, "").toLowerCase())) return { kind: "text", mimeType: extension === ".svg" ? "image/svg+xml" : "text/plain" };
  return { kind: "file", mimeType: extension === ".pdf" ? "application/pdf" : "application/octet-stream" };
}

/** The same resolver is used by HTTP previews and desktop file actions. */
// within: 이미 열 수 있다고 확인한 HTML의 폴더. 그 HTML이 불러오는 파일은 이 폴더 안에서도 연다.
export function resolveSessionArtifact(session, value, { resolveAttachment, within: folder } = {}) {
  if (session.locked) fail(423, "잠긴 세션입니다. 좌물쇠를 눌러 잠금을 해제하세요.");
  const { target, absolute, ...location } = localPath(value, session.cwd || session.projectPath);
  const roots = [session.cwd, session.projectPath, folder].filter((v) => typeof v === "string" && v).map((v) => path.resolve(v));
  const containing = roots.filter((root) => within(root, target));
  const mentioned = !containing.length && absolute && mentionedPath(session, target, resolveAttachment);
  if (!containing.length && !mentioned) fail(403, "세션에서 참조한 파일이나 프로젝트 안의 파일만 열 수 있습니다.");
  try {
    const realPath = fs.realpathSync(target);
    if (containing.length) {
      if (!containing.some((root) => within(fs.realpathSync(root), realPath))) fail(403, "작업 폴더 밖으로 연결된 파일은 열 수 없습니다.");
    } else if (pathKey(realPath) !== pathKey(target)) fail(403, "외부 파일의 바로 가기 경로는 열 수 없습니다.");
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) fail(400, "일반 파일만 미리 볼 수 있습니다.");
    const type = classify(target);
    if (stat.size > (type.kind === "video" ? MAX_VIDEO_BYTES : MAX_ARTIFACT_BYTES)) fail(413, type.kind === "video" ? "영상 미리보기는 4 GiB까지 지원합니다." : "파일 미리보기와 다운로드는 32 MiB까지 지원합니다.");
    return { path: target, realPath, name: path.basename(target), ...type, size: stat.size, ...location };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (["ENOENT", "ENOTDIR"].includes(error.code)) fail(404, "파일을 찾지 못했습니다. 이동되었거나 다른 환경의 경로일 수 있습니다.");
    fail(403, "파일을 읽을 수 없습니다.");
  }
}

function readBytes(file, limit = MAX_ARTIFACT_BYTES) {
  const handle = fs.openSync(file.realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) fail(400, "일반 파일만 미리 볼 수 있습니다.");
    if (stat.size > MAX_ARTIFACT_BYTES) fail(413, "파일 미리보기와 다운로드는 32 MiB까지 지원합니다.");
    const bytes = Buffer.alloc(Math.min(stat.size, limit));
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(handle, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    return { bytes: bytes.subarray(0, length), truncated: stat.size > length };
  } finally { fs.closeSync(handle); }
}

const escapeAttribute = (value) => String(value).replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);
const attribute = (tag, name) => {
  const match = tag.match(new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
};

function htmlPreview(session, file, source, options) {
  const warnings = new Set();
  const scripts = [];
  let total = Buffer.byteLength(source), count = 0;
  const asset = (url, owner, expected, stream = false) => {
    if (!url || url.startsWith("#") || /^data:/i.test(url)) return null;
    try {
      if (++count > 80) throw Error("리소스 수 제한");
      if (/^[A-Za-z][\w+.-]*:/.test(url) || /^[\\/]{2}/.test(url)) throw Error("외부 URL");
      const decoded = decodeURIComponent(url.split(/[?#]/, 1)[0].replace(/&amp;/g, "&"));
      const target = path.resolve(path.dirname(owner), decoded);
      const resolved = resolveSessionArtifact(session, target, { ...options, within: path.dirname(file.path) });
      const mimeType = ASSET_MIMES[path.extname(target).toLowerCase()];
      if (!mimeType || (expected && !expected.test(mimeType))) throw Error("지원하지 않는 형식");
      // 영상·소리는 페이지에 넣지 않고 임시 주소로 필요한 구간만 받게 한다.
      if (stream && /^(?:video|audio)\//.test(mimeType)) return { ...resolved, mimeType, url: previewMediaUrl(resolved, mimeType) };
      if (resolved.size > MAX_PREVIEW_ASSET_BYTES || total + resolved.size > MAX_PREVIEW_TOTAL_BYTES) throw Error("크기 제한");
      total += resolved.size;
      return { ...resolved, mimeType, bytes: readBytes(resolved).bytes };
    } catch {
      warnings.add(`불러오지 못한 리소스: ${String(url).slice(0, 160)}`);
      return null;
    }
  };
  const dataUrl = (item) => `data:${item.mimeType};base64,${item.bytes.toString("base64")}`;
  function css(text, owner, depth = 0) {
    text = text.replace(/@import\s+(?:url\(\s*)?(["']?)([^"'\s;)]+)\1\s*\)?[^;]*;/gi, (_, quote, url) => {
      if (depth >= 4) { warnings.add("CSS 가져오기는 4단계까지 지원합니다."); return ""; }
      const item = asset(url, owner, /^text\/css$/);
      return item ? css(item.bytes.toString("utf8"), item.path, depth + 1) : "";
    });
    return text.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, quote, url) => {
      if (/^(?:data:|#)/i.test(url.trim())) return whole;
      const item = asset(url.trim(), owner, /^(?:image|font)\//);
      return `url("${item ? dataUrl(item) : "data:,"}")`;
    });
  }
  let html = source.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag, attrs, body) => {
    const src = attribute(`<script ${attrs}>`, "src");
    if (!src) {
      if (/\b(?:import|export)\s/.test(body)) warnings.add("JavaScript 모듈의 추가 import는 미리보기에서 지원하지 않을 수 있습니다.");
      return `\u0000SCRIPT${scripts.push(tag) - 1}\u0000`;
    }
    const item = asset(src, file.path, /^text\/javascript$/);
    if (!item) return "";
    const code = item.bytes.toString("utf8");
    if (/\b(?:import|export)\s/.test(code)) warnings.add("JavaScript 모듈의 추가 import는 미리보기에서 지원하지 않을 수 있습니다.");
    const module = attribute(`<script ${attrs}>`, "type") === "module";
    return `\u0000SCRIPT${scripts.push(`<script${module ? ' type="module"' : ""}>${code.replace(/<\/script/gi, "<\\/script")}</script>`) - 1}\u0000`;
  });
  html = html.replace(/<base\b[^>]*>/gi, "").replace(/<meta\b[^>]*>/gi, (tag) => attribute(tag, "http-equiv") ? "" : tag);
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\bstylesheet\b/i.test(attribute(tag, "rel") ?? "")) return "";
    const item = asset(attribute(tag, "href"), file.path, /^text\/css$/);
    return item ? `<style>${css(item.bytes.toString("utf8"), item.path).replace(/<\/style/gi, "<\\/style")}</style>` : "";
  });
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, (_, attrs, body) => `<style${attrs}>${css(body, file.path)}</style>`);
  html = html.replace(/<(?:img|source|video|audio|input)\b[^>]*>/gi, (tag) => tag
    .replace(/\s+srcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\b(src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (whole, name, double, single, bare) => {
      const url = double ?? single ?? bare;
      if (/^data:/i.test(url)) return whole;
      const media = name.toLowerCase() === "src" && /^<(?:video|source|audio)\b/i.test(tag);
      const item = asset(url, file.path, media ? /^(?:image|video|audio)\// : /^image\//, media);
      return `${name}="${item ? escapeAttribute(item.url ?? dataUrl(item)) : "data:,"}"`;
    }));
  html = html.replace(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (_, double, single) => `style="${escapeAttribute(css(double ?? single, file.path))}"`);
  const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data: ${PREVIEW_MEDIA_SOURCES}; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  // The caller MUST also set iframe sandbox="allow-scripts", without same-origin,
  // popups, forms, downloads, or top-navigation permissions.
  const policy = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`;
  html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (head) => head + policy) : policy + html;
  html = html.replace(/\u0000SCRIPT(\d+)\u0000/g, (_, index) => scripts[index]);
  return { previewHtml: html, ...(warnings.size ? { previewWarnings: [...warnings] } : {}) };
}

export function readSessionArtifact(session, value, options = {}) {
  const file = resolveSessionArtifact(session, value, options);
  const { realPath, ...result } = file;
  if (!["markdown", "text", "html"].includes(file.kind)) return result;
  const { bytes, truncated } = readBytes(file, MAX_ARTIFACT_TEXT_BYTES);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated }); }
  catch { return { ...result, kind: "file" }; }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return { ...result, kind: "file" };
  return { ...result, text, truncated, ...(file.kind === "html" && !truncated ? htmlPreview(session, file, text, options) : {}) };
}

// 영상은 bytes 대신 realPath를 돌려주고, 전송 쪽이 요청한 구간만 읽어 보낸다(sendFileRange).
export function readSessionArtifactContent(session, value, options = {}) {
  const file = resolveSessionArtifact(session, value, options);
  const { realPath, ...result } = file;
  if (file.kind === "video") return { ...result, realPath };
  return { ...result, bytes: readBytes(file).bytes };
}

// ── HTML 미리보기의 영상 임시 주소 ───────────────────────────────
// 미리보기는 출처가 없는 격리된 화면이라 /api를 부를 수 없다. 미리보기를 만들 때 파일마다 비밀 토큰을 발급한다.
const PREVIEW_MEDIA_TTL_MS = 60 * 60 * 1000;
const PREVIEW_MEDIA_MAX = 500;
const previewMedia = new Map(); // 토큰 → { realPath, mimeType, at }

function previewMediaUrl(file, mimeType) {
  const now = Date.now();
  for (const [token, item] of previewMedia) if (now - item.at > PREVIEW_MEDIA_TTL_MS) previewMedia.delete(token);
  while (previewMedia.size >= PREVIEW_MEDIA_MAX) previewMedia.delete(previewMedia.keys().next().value);
  const token = randomBytes(24).toString("hex");
  previewMedia.set(token, { realPath: file.realPath, mimeType, at: now });
  return `/preview-media/${token}`;
}

export function openPreviewMedia(token) {
  const item = previewMedia.get(token);
  if (!item || Date.now() - item.at > PREVIEW_MEDIA_TTL_MS) fail(404, "미리보기 영상 주소가 만료되었습니다. 미리보기를 다시 여세요.");
  return item;
}

// 파일에서 요청한 구간(Range)만 읽어 보낸다. 영상 재생기가 처음 정보와 탐색 위치를 구간으로 요청한다.
export function sendFileRange(req, res, realPath, headers) {
  let size;
  try { size = fs.statSync(realPath).size; } catch { fail(404, "파일을 찾을 수 없습니다."); }
  const base = { ...headers, "Accept-Ranges": "bytes" };
  const range = req?.headers?.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      res.writeHead(416, { ...base, "Content-Range": `bytes */${size}`, "Content-Length": 0 });
      return res.end();
    }
    res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return pipeFile(fs.createReadStream(realPath, { start, end }), res);
  }
  res.writeHead(200, { ...base, "Content-Length": size });
  return pipeFile(fs.createReadStream(realPath), res);
}

// 읽는 중에 파일이 지워지거나 잠기면 응답만 끊는다(서버는 계속 돈다).
function pipeFile(stream, res) {
  stream.on("error", () => res.destroy?.());
  stream.pipe(res);
}

export function validateArtifactReferences(session, value, prompt, options = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 40) fail(400, "파일 참조는 40개까지 보낼 수 있습니다.");
  const result = [], seen = new Set();
  for (const item of value) {
    if (!item || typeof item.label !== "string" || !item.label.trim() || item.label.length > 200 || /[\x00-\x1f\x7f]/.test(item.label)) fail(400, "파일 참조 이름이 올바르지 않습니다.");
    if (typeof item.path !== "string" || !item.path.trim() || item.path.length > 4096 || /[\x00-\x1f\x7f]/.test(item.path)) fail(400, "참조 경로가 올바르지 않습니다.");
    if (item.path.startsWith("agenthub:")) {
      const entity = item.path.match(/^agenthub:\/\/(session|task)\/([A-Za-z0-9_-]{1,100})$/);
      if (!entity || typeof options.validateEntityReference !== "function") fail(400, "세션이나 작업 참조가 올바르지 않습니다.");
      options.validateEntityReference(entity[1], entity[2]);
      if (!String(prompt).includes(item.path)) fail(400, "요청 본문에 없는 참조입니다.");
      if (!seen.has(item.path)) result.push({ label: item.label.trim(), path: item.path });
      seen.add(item.path);
      continue;
    }
    const file = resolveSessionArtifact(session, item.path, options);
    const sentPath = String(item.path);
    if (!String(prompt).includes(sentPath) && !String(prompt).includes(sentPath.replace(/\\/g, "/")) && !String(prompt).includes(file.path)) fail(400, "요청 본문에 없는 파일 참조입니다.");
    const key = pathKey(file.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ label: item.label.trim(), path: item.path });
  }
  return result;
}
