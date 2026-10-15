import fs from "node:fs/promises";
import path from "node:path";
import { attachmentExtension, isImageAttachment } from "./attachments.mjs";

const AGENT = { claude: "Claude", codex: "Codex" };
const LABEL = { user: "사용자", text: "AI", tool: "도구", tool_result: "도구 결과", error: "오류", status: "상태", log: "로그", thinking: "생각", result: "결과", message: "보낸 메시지" };
const STATUS = { pending: "대기 중", answered: "답함", skipped: "지나감", invalid: "형식 오류", allowed: "허용함", denied: "거절함", applied: "실행함", rejected: "거절함" };
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const BACKTICK = String.fromCharCode(96);
const list = (value) => Array.isArray(value) ? value : [];

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

// Only visible fields are rendered. Never serialize settings, CLI input, raw events or usage objects.
function visible(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/\u0000/g, "")
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]{15,})\b/g, "[가림]")
    .replace(/(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:Bearer\s+|Basic\s+)?[^\s,;]+/gi, "$1[가림]")
    .replace(/(["']?\b(?:[A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1[가림]");
}
const html = (value) => visible(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (value) => html(value).replace(/[\r\n]+/g, " ").replace(/([\\*_[\]{}#|])/g, "\\$1").split(BACKTICK).join("\\" + BACKTICK);

function escapeInlineHtml(text) {
  let result = "", cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(BACKTICK, cursor);
    if (start < 0) return result + text.slice(cursor).replace(/</g, "&lt;");
    result += text.slice(cursor, start).replace(/</g, "&lt;");
    let endRun = start;
    while (text[endRun] === BACKTICK) endRun++;
    const delimiter = text.slice(start, endRun);
    let close = text.indexOf(delimiter, endRun);
    while (close >= 0 && (text[close - 1] === BACKTICK || text[close + delimiter.length] === BACKTICK)) close = text.indexOf(delimiter, close + delimiter.length);
    if (close < 0) return result + text.slice(start).replace(/</g, "&lt;");
    result += text.slice(start, close + delimiter.length);
    cursor = close + delimiter.length;
  }
  return result;
}
// Preserve code and Markdown syntax, escaping active HTML only outside code fences/spans.
function safeMarkdown(text) {
  let opening = null;
  const lines = text.split("\n").map((line) => {
    const marker = line.match(/^[ ]{0,3}([~\x60]{3,})(.*)$/);
    if (opening) {
      if (marker && marker[1][0] === opening[0] && marker[1].length >= opening.length && !marker[2].trim()) opening = null;
      return line;
    }
    if (marker && /^(~+|\x60+)$/.test(marker[1]) && !(marker[1][0] === BACKTICK && marker[2].includes(BACKTICK))) {
      opening = marker[1];
      return line;
    }
    return escapeInlineHtml(line);
  });
  // Each event must end its code fence so later exported events remain visible.
  if (opening) lines.push(opening);
  return lines.join("\n");
}

function fence(value) {
  const text = visible(value);
  const runs = text.match(new RegExp(BACKTICK + "+", "g")) || [];
  const delimiter = BACKTICK.repeat(runs.reduce((longest, run) => Math.max(longest, run.length + 1), 3));
  return delimiter + "text\n" + text + "\n" + delimiter;
}
function details(summary, body) {
  return "<details>\n<summary>" + inline(summary) + "</summary>\n\n" + body + "\n\n</details>";
}
function time(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : visible(value);
}
function exportDate(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw failure("EXPORT_DATE_INVALID", "내보내기 날짜가 올바르지 않습니다.");
  return date.toISOString();
}
// Caller strings can never become path components; names remain portable across Windows/POSIX.
function safeName(value, fallback, max = 60) {
  let name = String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "-").replace(/^-+|-+$/g, "").replace(/[. ]+$/g, "").slice(0, max).replace(/[. ]+$/g, "");
  if (!name || /^\.+$/.test(name)) name = fallback;
  if (RESERVED_NAME.test(name)) name = "_" + name;
  return name;
}
function attachmentsOf(session) {
  const found = new Map();
  for (const event of list(session.events)) for (const attachment of list(event?.attachments)) {
    if (attachment && typeof attachment.id === "string" && !found.has(attachment.id)) found.set(attachment.id, attachment);
  }
  return [...found.values()];
}
function attachmentMarkdown(attachment, links) {
  const image = isImageAttachment(attachment);
  const label = image ? "첨부 이미지" : "첨부 파일";
  const name = inline(attachment?.name || label);
  const relative = links instanceof Map ? links.get(attachment?.id) : undefined;
  // Downloads without copied assets expose neither local paths nor authenticated API URLs.
  if (!relative) return label + ": " + name + (image ? " (별도 이미지 파일)" : " (별도 파일)");
  const href = String(relative).split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase())).join("/");
  return (image ? "!" : "") + "[" + name + "](" + href + ")";
}
function questionBody(event) {
  const parts = ["상태: " + inline(STATUS[event.status] || event.status || "미정")];
  if (event.error) parts.push(fence(event.error));
  list(event.questions).forEach((question, i) => {
    parts.push("### " + inline(question.header || "질문 " + (i + 1)) + "\n\n" + html(question.question));
    if (question.multiSelect) parts.push("여러 개 선택 가능");
    for (const option of list(question.options)) parts.push("- " + inline(option?.label ?? option) + (option?.description ? " — " + inline(option.description) : ""));
    const answer = event.answers?.[i];
    const answerText = [...list(answer?.selected).map(visible), visible(answer?.text)].filter(Boolean).join(", ");
    parts.push("답: " + inline(answerText || "답하지 않음"));
  });
  return parts.join("\n\n");
}
function planBody(event) {
  const parts = ["상태: " + inline(STATUS[event.status] || event.status || "미정")];
  if (event.error) parts.push(fence(event.error));
  const plan = event.plan;
  if (plan) {
    const names = new Map(list(plan.sessions).map((s) => [s.key || s.id, s.title || s.key || s.id]));
    if (list(plan.sessions).length) parts.push("### 세션", ...plan.sessions.map((s) =>
      "- " + inline(s.title) + (s.agent ? " · " + inline(AGENT[s.agent] || s.agent) : "") + (s.roleName ? " · 역할 " + inline(s.roleName) : "") + (s.permission ? " · " + inline(s.permission) : "") + (s.isolate ? " · 워크트리 " + inline(s.worktreeName) : " · 원본 폴더") + (s.roleText ? "\n\n" + fence(s.roleText) : "")));
    if (list(plan.links).length) parts.push("### 연결", ...plan.links.map((l) => "- " + inline(names.get(l.from) || l.from) + " → " + inline(names.get(l.to) || l.to) + (l.mode ? " · " + inline(l.mode) : "")));
    if (list(plan.send).length) parts.push("### 요청", ...plan.send.map((s) => "받는 세션: " + inline(names.get(s.to) || s.to) + "\n\n" + fence(s.prompt)));
  }
  if (event.result) parts.push(fence(event.result));
  return parts.join("\n\n");
}
function eventMarkdown(event, attachmentLinks, kinds) {
  if (!event || typeof event !== "object") return "";
  const suffix = event.ts ? " · " + time(event.ts) : "";
  if (event.kind === "question") return "## 질문" + inline(suffix) + "\n\n" + questionBody(event);
  if (event.kind === "plan") return "## 계획" + inline(suffix) + "\n\n" + planBody(event);
  if (event.kind === "permission") {
    const status = event.decision === "always" ? "항상 허용함" : STATUS[event.status] || event.status || "미정";
    const body = ["상태: " + inline(status), event.text && fence(event.text), event.reason && html(event.reason), event.detail && details("자세히", fence(event.detail)), event.message && html(event.message)].filter(Boolean).join("\n\n");
    return "## 권한 요청" + inline(suffix) + "\n\n" + body;
  }
  if (!LABEL[event.kind]) return "";
  let text = visible(event.text);
  if (event.kind === "result") text = text.replace(/\s*·\s*입력\s+[\d,]+\s*\/\s*출력\s+[\d,]+\s*토큰/g, "");
  // Cards preserve structured questions/messages/plans, rather than exporting protocol JSON twice.
  if (event.kind === "text") for (const [kind, language] of [["question", "agenthub-question"], ["message", "agenthub-message"], ["plan", "agenthub-plan"]]) {
    if (kinds.has(kind)) text = text.replace(new RegExp(BACKTICK.repeat(3) + language + "\\s*\\n[\\s\\S]*?" + BACKTICK.repeat(3), "g"), "").trim();
  }
  const images = list(event.attachments).map((a) => attachmentMarkdown(a, attachmentLinks));
  if (!text && !event.detail && !images.length) return "";
  let label = LABEL[event.kind];
  if (event.kind === "user" && event.fromTitle) label += " · " + event.fromTitle + (event.reply ? "에게서 온 답" : event.message ? "에게서 온 메시지" : "에서 넘어온 작업");
  if (event.kind === "user" && event.injected) label += " · 작업 중 추가";
  if (event.kind === "message" && event.toTitle) label += " → " + event.toTitle;
  if (event.kind === "tool_result" && event.isError) label += " · 오류";
  const body = [event.kind === "text" ? safeMarkdown(text) : text && fence(text), event.detail && details("자세히", fence(event.detail)), ...images].filter(Boolean).join("\n\n");
  if (["tool", "tool_result", "log", "thinking", "message"].includes(event.kind)) return details(label + suffix, body);
  return "## " + inline(label + suffix) + "\n\n" + body;
}

/** Pure Markdown rendering, also usable for chat downloads. Includes visible event fields only. */
export function renderSessionMarkdown(session, { exportedAt = new Date(), attachmentLinks = new Map() } = {}) {
  const date = exportDate(exportedAt);
  const branch = session.worktree?.branch || session.branch;
  const metadata = [
    ["세션", session.id], ["AI", AGENT[session.agent] || session.agent], ["모델", session.model || "기본값"],
    ["프로젝트", session.projectName || (session.chat ? "일반 채팅" : session.projectPath)],
    ["프로젝트 폴더", session.chat ? "" : session.projectPath], ["작업 폴더", session.chat ? "" : session.cwd],
    ["브랜치", branch || "원본 폴더"], ["시작", time(session.createdAt)], ["마지막 변경", time(session.updatedAt)], ["내보낸 날짜", date],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "").map(([key, value]) => "- " + key + ": " + inline(value));
  const kinds = new Set(list(session.events).map((e) => e?.kind));
  const events = list(session.events).map((event) => eventMarkdown(event, attachmentLinks, kinds)).filter(Boolean);
  return ["# " + inline(session.title || "세션 작업 기록"), metadata.join("\n"), ...(events.length ? events : ["(기록 없음)"])].join("\n\n") + "\n";
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
async function checkedDirectory(root, directory, create = false) {
  if (!within(root, directory)) throw failure("EXPORT_UNSAFE_PATH", "프로젝트 밖으로 내보낼 수 없습니다.");
  if (create) await fs.mkdir(directory).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const stat = await fs.lstat(directory);
  const real = await fs.realpath(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !within(root, real) || path.relative(real, directory) !== "") {
    throw failure("EXPORT_UNSAFE_PATH", "내보내기 폴더는 프로젝트 안의 실제 폴더여야 합니다. 심볼릭 링크는 사용할 수 없습니다.");
  }
}
async function exists(target) {
  return fs.lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
}


async function removeCreated(root, docs, destination, files, directories) {
  // No recursive deletion: remove only files/directories this export created, after parent checks.
  await checkedDirectory(root, docs);
  await checkedDirectory(root, destination);
  for (const entry of [...files].reverse()) {
    const parent = path.dirname(entry.path);
    await checkedDirectory(root, parent);
    const stat = await fs.lstat(entry.path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (stat && stat.isFile() && !stat.isSymbolicLink() && stat.dev === entry.stat.dev && stat.ino === entry.stat.ino) await fs.unlink(entry.path);
  }
  for (const entry of [...directories].reverse()) {
    await checkedDirectory(root, entry.path);
    const stat = await fs.lstat(entry.path);
    if (stat.dev === entry.stat.dev && stat.ino === entry.stat.ino) await fs.rmdir(entry.path);
  }
}

/** Save a fresh project document and private copies of its attached files. */
export async function exportSession(session, { resolveAttachment, now = new Date() } = {}) {
  if (session.chat || !session.projectPath || !session.cwd) throw failure("EXPORT_PROJECT_REQUIRED", "일반 채팅은 프로젝트 문서 내보내기를 지원하지 않습니다. 프로젝트 세션에서 사용하세요.");
  if (!path.isAbsolute(session.cwd)) throw failure("EXPORT_UNSAFE_PATH", "작업 폴더는 절대 경로여야 합니다.");
  const exportedAt = exportDate(now);
  const cwd = path.resolve(session.cwd);
  const cwdStat = await fs.lstat(cwd);
  if (!cwdStat.isDirectory() || cwdStat.isSymbolicLink()) throw failure("EXPORT_UNSAFE_PATH", "작업 폴더는 실제 폴더여야 합니다.");
  const root = await fs.realpath(cwd);
  const docs = path.join(root, "docs");
  const destination = path.join(docs, "agenthub");
  await checkedDirectory(root, docs, true);
  await checkedDirectory(root, destination, true);

  // Resolve inputs first: absent files cannot silently produce an incomplete success.
  const sources = [];
  for (const attachment of attachmentsOf(session)) {
    if (typeof resolveAttachment !== "function") throw failure("EXPORT_ATTACHMENT_MISSING", "첨부 파일 저장소를 찾을 수 없습니다.");
    const resolved = await resolveAttachment(attachment, session);
    const source = typeof resolved === "string" ? resolved : resolved?.path;
    if (!source || !path.isAbsolute(source)) throw failure("EXPORT_ATTACHMENT_MISSING", "첨부 파일을 찾을 수 없습니다.");
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure("EXPORT_ATTACHMENT_INVALID", "첨부는 실제 파일이어야 합니다.");
    sources.push({ attachment, source });
  }

  const base = safeName(session.title, "session") + "-" + safeName(session.id, "session", 40) + "-" + exportedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  let handle, filePath, stem;
  for (let attempt = 1; attempt <= 1000; attempt++) {
    stem = base + (attempt === 1 ? "" : "-" + attempt);
    filePath = path.join(destination, stem + ".md");
    await checkedDirectory(root, docs);
    await checkedDirectory(root, destination);
    // An asset directory still belongs to an older export if its Markdown was removed.
    if (sources.length && await exists(path.join(destination, stem + ".assets"))) continue;
    try { handle = await fs.open(filePath, "wx", 0o600); break; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (!handle) throw failure("EXPORT_NAME_CONFLICT", "내보내기 파일 이름을 만들지 못했습니다.");

  const attachmentLinks = new Map();
  const copied = [];
  const createdFiles = [{ path: filePath, stat: await handle.stat() }];
  const createdDirectories = [];
  try {
    if (sources.length) {
      const assetDir = path.join(destination, stem + ".assets");
      await fs.mkdir(assetDir); // Exclusive: never reuse an existing directory.
      await checkedDirectory(root, assetDir);
      createdDirectories.push({ path: assetDir, stat: await fs.lstat(assetDir) });
      for (const [index, { attachment, source }] of sources.entries()) {
        await checkedDirectory(root, docs);
        await checkedDirectory(root, destination);
        await checkedDirectory(root, assetDir);
        const name = (index + 1) + "-" + safeName(path.parse(attachment.name || "file").name, "file", 40) + attachmentExtension(attachment);
        const target = path.join(assetDir, name);
        const targetHandle = await fs.open(target, "wx", 0o600);
        try {
          createdFiles.push({ path: target, stat: await targetHandle.stat() });
          await targetHandle.writeFile(await fs.readFile(source));
        } finally {
          await targetHandle.close();
        }
        const relativePath = stem + ".assets/" + name;
        attachmentLinks.set(attachment.id, relativePath);
        copied.push({ id: attachment.id, name: attachment.name, relativePath });
      }
    }
    const markdown = renderSessionMarkdown(session, { exportedAt, attachmentLinks });
    await checkedDirectory(root, docs);
    await checkedDirectory(root, destination);
    await handle.writeFile(markdown, "utf8");
    return { path: filePath, relativePath: "docs/agenthub/" + stem + ".md", fileName: stem + ".md", markdown, attachments: copied };
  } catch (error) {
    await handle.close().catch(() => {});
    handle = null;
    await removeCreated(root, docs, destination, createdFiles, createdDirectories).catch(() => {});
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

export { visible, exportDate, safeName, checkedDirectory, within };
