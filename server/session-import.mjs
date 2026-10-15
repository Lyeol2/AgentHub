// 기록 가져오기: session-export.mjs가 만든 Markdown을 다시 세션 기록(events)으로 읽는다.
// 내보낸 문서는 보이는 내용만 담으므로, 대화 흐름(요청·답변·도구·오류 등)을 화면용으로 되살린다.
import fs from "node:fs/promises";
import path from "node:path";

export const RECORD_MAX_BYTES = 5 * 1024 * 1024;
const BACKTICK = String.fromCharCode(96);
const AGENT = { Claude: "claude", Codex: "codex" };
const SECTION = ["사용자", "AI", "오류", "상태", "결과", "질문", "계획", "권한 요청"];
const DETAILS = { "도구 결과": "tool_result", "도구": "tool", "로그": "log", "생각": "thinking", "보낸 메시지": "message" };
const NOTE_KIND = { "질문": "질문", "계획": "계획", "권한 요청": "권한 요청" };
const TS = / · (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)$/;
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

// session-export의 inline()·html()을 되돌린다.
export const unescapeInline = (text) => String(text ?? "")
  .replace(/\\([\\*_[\]{}#|`])/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const fenceOpen = (line) => line.match(/^[ ]{0,3}([~`]{3,})/)?.[1] ?? null;

// 펜스 코드 블록 하나의 내용. 펜스가 없으면 그대로 돌려준다.
function unfence(body) {
  const lines = body.split("\n");
  const open = fenceOpen(lines[0] ?? "");
  if (!open) return body.trim();
  let end = lines.length - 1;
  while (end > 0 && lines[end].trim() !== open) end--;
  return lines.slice(1, end > 0 ? end : lines.length).join("\n");
}

// AI 답변은 Markdown 그대로 내보내고 코드 밖의 <만 &lt;로 바꿨다.
function unescapeMarkdown(text) {
  let opening = null;
  return text.split("\n").map((line) => {
    const marker = fenceOpen(line);
    if (opening) {
      if (marker && marker[0] === opening[0] && marker.length >= opening.length && !line.trim().slice(marker.length).trim()) opening = null;
      return line;
    }
    if (marker) { opening = marker; return line; }
    let out = "", cursor = 0;
    while (cursor < line.length) {
      const start = line.indexOf(BACKTICK, cursor);
      if (start < 0) { out += line.slice(cursor).replace(/&lt;/g, "<"); break; }
      out += line.slice(cursor, start).replace(/&lt;/g, "<");
      let run = start;
      while (line[run] === BACKTICK) run++;
      const close = line.indexOf(line.slice(start, run), run);
      if (close < 0) { out += line.slice(start).replace(/&lt;/g, "<"); break; }
      out += line.slice(start, close + run - start);
      cursor = close + run - start;
    }
    return out;
  }).join("\n");
}

// 블록 끝의 첨부 이미지 줄(![이름](경로) 또는 "첨부 이미지: 이름 (…)")을 떼어 낸다.
function takeImages(body) {
  const images = [];
  const parts = body.split(/\n\n/);
  while (parts.length) {
    const last = parts.at(-1).trim();
    const link = last.match(/^!\[(.*)\]\(([^()\s]+)\)$/);
    const note = last.match(/^첨부 이미지: (.*) \(별도 이미지 파일\)$/);
    if (!link && !note) break;
    parts.pop();
    images.unshift(link ? { name: unescapeInline(link[1]), href: link[2] } : { name: unescapeInline(note[1]), href: null });
  }
  return { body: parts.join("\n\n"), images };
}

// 블록 안의 중첩 <details>(자세히)를 떼어 detail로 돌려준다.
function takeDetail(body) {
  const found = body.match(/\n*<details>\n<summary>자세히<\/summary>\n\n([\s\S]*?)\n\n<\/details>/);
  if (!found) return { body, detail: null };
  return { body: body.slice(0, found.index) + body.slice(found.index + found[0].length), detail: unfence(found[1].trim()) };
}

function splitLabel(raw) {
  const label = unescapeInline(raw).trim();
  const ts = label.match(TS);
  return { label: ts ? label.slice(0, ts.index) : label, ts: ts?.[1] ?? null };
}

function sectionKind(label) {
  return SECTION.find((name) => label === name || label.startsWith(name + " · ")) ?? null;
}

function detailsKind(label) {
  for (const [name, kind] of Object.entries(DETAILS)) {
    if (label === name || label.startsWith(name + " ") || label.startsWith(name + " · ")) return kind;
  }
  return null;
}

/** 문서를 { title, meta, events }로 읽는다. 형식이 다르면 code가 있는 오류를 던진다. */
export function parseSessionMarkdown(markdown) {
  const text = String(markdown ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const titleLine = lines.findIndex((line) => line.trim());
  if (titleLine < 0 || !lines[titleLine].startsWith("# ")) throw failure("IMPORT_FORMAT", "AgentHub에서 내보낸 기록 문서가 아닙니다. 첫 줄이 \"# 제목\"이어야 합니다.");
  const title = unescapeInline(lines[titleLine].slice(2)).trim();
  const meta = {};
  let i = titleLine + 1;
  while (i < lines.length && !lines[i].trim()) i++;
  while (i < lines.length && lines[i].startsWith("- ")) {
    const found = lines[i].slice(2).match(/^([^:]+): (.*)$/);
    if (found) meta[found[1].trim()] = unescapeInline(found[2]);
    i++;
  }
  if (!meta["세션"] && !meta["AI"]) throw failure("IMPORT_FORMAT", "AgentHub에서 내보낸 기록 문서가 아닙니다. 세션 정보 목록이 없습니다.");

  // 헤더에 시각이 붙은 문서면 시각 없는 "## …" 줄은 답변 안의 제목으로 본다.
  const timed = lines.some((line) => /^## /.test(line) && TS.test(unescapeInline(line.slice(3))));
  const blocks = [];
  let current = null, opening = null, depth = 0;
  const push = () => { if (current) blocks.push(current); current = null; };
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (depth === 0 && !opening) {
      const heading = line.match(/^## (.+)$/);
      if (heading) {
        const { label, ts } = splitLabel(heading[1]);
        if (sectionKind(label) && (ts || !timed)) {
          push();
          current = { type: "section", label, ts, lines: [] };
          continue;
        }
      }
      if (line === "<details>" && /^<summary>.*<\/summary>$/.test(lines[i + 1] ?? "")) {
        const { label, ts } = splitLabel(lines[i + 1].slice(9, -10));
        if (detailsKind(label)) {
          push();
          current = { type: "details", label, ts, lines: [] };
          depth = 1;
          i++;
          continue;
        }
      }
    }
    if (current?.type === "details" && !opening) {
      if (line === "<details>") depth++;
      else if (line === "</details>" && --depth === 0) { push(); continue; }
    }
    // 펜스 안의 "## …"이나 <details>는 내용이다.
    const marker = fenceOpen(line);
    if (opening) {
      if (marker && marker[0] === opening[0] && marker.length >= opening.length && !line.trim().slice(marker.length).trim()) opening = null;
    } else if (marker && current) opening = marker;
    current?.lines.push(line);
  }
  push();

  const events = [];
  for (const block of blocks) {
    const raw = block.lines.join("\n").trim();
    const base = block.ts ? { ts: block.ts } : {};
    if (block.type === "details") {
      const kind = detailsKind(block.label);
      const { body, detail } = takeDetail(raw);
      const event = { kind, text: unfence(body.trim()), ...base };
      if (detail) event.detail = detail;
      if (kind === "tool_result" && block.label.endsWith(" · 오류")) event.isError = true;
      if (kind === "message") event.toTitle = block.label.replace(/^보낸 메시지(?: → )?/, "");
      events.push(event);
      continue;
    }
    const name = sectionKind(block.label);
    if (NOTE_KIND[name]) {
      events.push({ kind: "status", text: "[" + NOTE_KIND[name] + " 기록]\n" + unescapeInline(raw), ...base });
      continue;
    }
    const { body: withoutImages, images } = takeImages(raw);
    const { body, detail } = takeDetail(withoutImages);
    const kind = { "사용자": "user", "AI": "text", "오류": "error", "상태": "status", "결과": "result" }[name];
    const event = { kind, text: kind === "text" ? unescapeMarkdown(body.trim()) : unfence(body.trim()), ...base };
    if (detail) event.detail = detail;
    if (images.length) event.images = images;
    if (kind === "user") {
      const extra = block.label.slice("사용자".length).replace(/^ · /, "");
      if (extra.endsWith(" · 작업 중 추가") || extra === "작업 중 추가") event.injected = true;
      const from = extra.replace(/(?:^| · )작업 중 추가$/, "").match(/^(.*?)(에게서 온 답|에게서 온 메시지|에서 넘어온 작업)$/);
      if (from) {
        event.fromTitle = from[1];
        if (from[2] === "에게서 온 답") event.reply = true;
        if (from[2] === "에게서 온 메시지") event.message = true;
      }
    }
    events.push(event);
  }
  if (!events.length && !text.includes("(기록 없음)")) throw failure("IMPORT_EMPTY", "가져올 기록을 찾지 못했습니다.");
  return {
    title, events,
    meta: { sessionId: meta["세션"] ?? null, agent: AGENT[meta["AI"]] ?? null, model: meta["모델"] && meta["모델"] !== "기본값" ? meta["모델"] : null,
      project: meta["프로젝트"] ?? null, branch: meta["브랜치"] ?? null, exportedAt: meta["내보낸 날짜"] ?? null, createdAt: meta["시작"] ?? null },
  };
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

// 폴더의 docs/agenthub에 있는 내보낸 기록 목록. 심볼릭 링크와 폴더 밖 파일은 건너뛴다.
export async function listRecords(dir) {
  const folder = path.join(dir, "docs", "agenthub");
  let entries;
  try { entries = await fs.readdir(folder, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    const file = path.join(folder, entry.name);
    try {
      const stat = await fs.stat(file);
      if (stat.size > RECORD_MAX_BYTES) continue;
      const head = (await fs.readFile(file, "utf8")).slice(0, 4000);
      const { title, meta } = parseHead(head);
      if (!title) continue;
      records.push({ fileName: entry.name, title, agent: meta.agent, exportedAt: meta.exportedAt, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    } catch {}
  }
  return records.sort((a, b) => String(b.exportedAt ?? b.modifiedAt).localeCompare(String(a.exportedAt ?? a.modifiedAt)));
}

function parseHead(head) {
  try {
    const lines = head.replace(/\r\n?/g, "\n").split("\n");
    if (!lines[0]?.startsWith("# ")) return {};
    const meta = Object.fromEntries(lines.slice(1).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).match(/^([^:]+): (.*)$/)).filter(Boolean).map(([, k, v]) => [k.trim(), unescapeInline(v)]));
    if (!meta["세션"] && !meta["AI"]) return {};
    return { title: unescapeInline(lines[0].slice(2)).trim(), meta: { agent: AGENT[meta["AI"]] ?? null, exportedAt: meta["내보낸 날짜"] ?? null } };
  } catch { return {}; }
}

// 목록에서 고른 기록 파일을 읽는다. 이름만 받고 docs/agenthub 밖은 열지 않는다.
export async function readRecord(dir, fileName) {
  if (typeof fileName !== "string" || !/^[^\\/:*?"<>|\x00-\x1f]+\.md$/i.test(fileName) || fileName.startsWith(".")) throw failure("IMPORT_PATH", "기록 파일 이름이 올바르지 않습니다.");
  const folder = path.join(dir, "docs", "agenthub");
  const file = path.join(folder, fileName);
  const [realFolder, realFile] = await Promise.all([fs.realpath(folder), fs.realpath(file)]).catch(() => { throw failure("IMPORT_MISSING", "기록 파일을 찾지 못했습니다."); });
  if (!within(realFolder, realFile)) throw failure("IMPORT_PATH", "docs/agenthub 안의 기록만 가져올 수 있습니다.");
  const stat = await fs.stat(realFile);
  if (!stat.isFile()) throw failure("IMPORT_PATH", "기록 파일이 아닙니다.");
  if (stat.size > RECORD_MAX_BYTES) throw failure("IMPORT_TOO_LARGE", "기록 문서는 5MB까지 가져올 수 있습니다.");
  return { markdown: await fs.readFile(realFile, "utf8"), folder: realFolder, file: realFile };
}

// 문서 옆 .assets 폴더의 이미지를 읽는다. 문서 폴더 밖이나 지원하지 않는 형식은 null.
export async function readRecordImage(folder, href) {
  if (!href || /^[a-z]+:/i.test(href) || href.startsWith("/")) return null;
  let relative;
  try { relative = href.split("/").map(decodeURIComponent).join(path.sep); } catch { return null; }
  const mimeType = MIME[path.extname(relative).toLowerCase()];
  if (!mimeType) return null;
  const target = path.resolve(folder, relative);
  try {
    const real = await fs.realpath(target);
    if (!within(folder, real)) return null;
    const stat = await fs.stat(real);
    if (!stat.isFile()) return null;
    return { mimeType, bytes: await fs.readFile(real) };
  } catch { return null; }
}
