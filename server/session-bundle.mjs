// .agenthub 파일: 세션 하나의 기록을 다른 세션·다른 PC로 옮기는 JSON 묶음.
// Markdown 내보내기와 같이 화면에 보이는 내용만 담고, 첨부 파일은 base64로 함께 넣는다.
// 새 세션으로 되살리거나, 이미 있는 세션에 "읽히기"로 다음 요청에 붙여 넘긴다.
import fs from "node:fs/promises";
import path from "node:path";
import { visible, exportDate, safeName, checkedDirectory } from "./session-export.mjs";
import { recordDigest } from "./handover.mjs";

export const BUNDLE_EXT = ".agenthub";
export const BUNDLE_FORMAT = "agenthub-session";
export const BUNDLE_VERSION = 1;
export const BUNDLE_MAX_BYTES = 30 * 1024 * 1024;
const ATTACHMENTS_MAX_BYTES = 20 * 1024 * 1024; // 넘치면 나머지 첨부는 이름만 남긴다.
const KINDS = new Set(["user", "text", "tool", "tool_result", "error", "status", "log", "thinking", "result", "message", "question", "plan", "permission"]);
const STRING_KEYS = ["text", "detail", "ts", "fromTitle", "toTitle", "status", "error", "result", "decision", "reason", "message"];
const FLAG_KEYS = ["injected", "reply", "isError"];
// 가져온 기록의 카드는 다시 처리할 수 없으므로 기다리던 것은 끝난 상태로 둔다.
const SETTLED = { question: "skipped", plan: "rejected", permission: "denied" };

export const isBundleName = (name) => typeof name === "string" && name.toLowerCase().endsWith(BUNDLE_EXT);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

const text = (value) => visible(value);
const list = (value) => Array.isArray(value) ? value : [];

// 보이는 필드만 골라 담는다. CLI 입력·설정·사용량·실행 중 상태는 넣지 않는다.
export function bundleEvent(event) {
  if (!event || typeof event !== "object" || !KINDS.has(event.kind)) return null;
  const out = { kind: event.kind };
  for (const key of STRING_KEYS) {
    if (typeof event[key] === "string" && event[key]) out[key] = key === "ts" ? event[key] : text(event[key]);
  }
  // 메시지 이벤트의 message는 글이고, 사용자 이벤트의 message는 "메시지로 받은 요청" 표시다.
  if (event.kind === "user" && event.message) out.message = true;
  for (const key of FLAG_KEYS) if (event[key]) out[key] = true;
  if (event.kind === "question") {
    out.questions = list(event.questions).map((q) => ({
      header: text(q?.header), question: text(q?.question), multiSelect: !!q?.multiSelect,
      options: list(q?.options).map((o) => typeof o === "string" ? { label: text(o) } : { label: text(o?.label), description: text(o?.description) }),
    }));
    if (Array.isArray(event.answers)) out.answers = event.answers.map((a) => ({ selected: list(a?.selected).map(text), text: text(a?.text) }));
  }
  if (event.kind === "plan" && event.plan && typeof event.plan === "object") out.plan = JSON.parse(JSON.stringify(event.plan));
  if (SETTLED[event.kind] && (!out.status || out.status === "pending")) out.status = SETTLED[event.kind];
  const attachments = list(event.attachments).filter((a) => typeof a?.id === "string")
    .map((a) => ({ id: a.id, name: text(a.name) || "file", mimeType: String(a.mimeType ?? "application/octet-stream"), size: Number(a.size) || 0 }));
  if (attachments.length) out.attachments = attachments;
  const references = list(event.references).slice(0, 40)
    .filter((reference) => typeof reference?.label === "string" && reference.label.trim() && reference.label.length <= 200 && typeof reference.path === "string" && reference.path.trim() && reference.path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(reference.label + reference.path))
    .map((reference) => ({ label: text(reference.label), path: text(reference.path) }));
  if (references.length) out.references = references;
  return out;
}

/** 저장할 JSON 객체. readAttachment(attachment) → Buffer */
export async function buildBundle(session, { readAttachment, now = new Date() } = {}) {
  const events = list(session.events).map(bundleEvent).filter(Boolean);
  const attachments = [];
  let used = 0;
  let omitted = 0;
  const seen = new Set();
  for (const event of events) for (const attachment of event.attachments ?? []) {
    if (seen.has(attachment.id)) continue;
    seen.add(attachment.id);
    let bytes = null;
    try { bytes = readAttachment ? await readAttachment(attachment) : null; } catch { bytes = null; }
    if (!bytes || used + bytes.length > ATTACHMENTS_MAX_BYTES) {
      omitted++;
      continue;
    }
    used += bytes.length;
    attachments.push({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, data: bytes.toString("base64") });
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: exportDate(now),
    session: {
      id: session.id, title: text(session.title) || "세션 작업 기록", agent: session.agent, model: session.model || "",
      effort: session.effort || "", permission: session.permission || "", role: text(session.role), roleName: text(session.roleName),
      skills: list(session.skills).map(String), projectName: text(session.projectName),
      branch: session.worktree?.branch || session.branch || "", createdAt: session.createdAt ?? null, updatedAt: session.updatedAt ?? null,
    },
    events,
    attachments,
    ...(omitted ? { omittedAttachments: omitted } : {}),
  };
}

/** 세션 작업 폴더의 docs/agenthub에 새 .agenthub 파일을 만든다. 기존 파일은 덮어쓰지 않는다. */
export async function exportBundle(session, { readAttachment, now = new Date() } = {}) {
  if (session.chat || !session.projectPath || !session.cwd) throw failure("EXPORT_PROJECT_REQUIRED", "일반 채팅은 내보내기를 지원하지 않습니다. 프로젝트 세션에서 사용하세요.");
  if (!path.isAbsolute(session.cwd)) throw failure("EXPORT_UNSAFE_PATH", "작업 폴더는 절대 경로여야 합니다.");
  const bundle = await buildBundle(session, { readAttachment, now });
  const root = await fs.realpath(path.resolve(session.cwd));
  const docs = path.join(root, "docs");
  const destination = path.join(docs, "agenthub");
  await checkedDirectory(root, docs, true);
  await checkedDirectory(root, destination, true);
  const base = safeName(session.title, "session") + "-" + safeName(session.id, "session", 40) + "-" + bundle.exportedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  for (let attempt = 1; attempt <= 1000; attempt++) {
    const fileName = base + (attempt === 1 ? "" : "-" + attempt) + BUNDLE_EXT;
    const filePath = path.join(destination, fileName);
    let handle;
    try { handle = await fs.open(filePath, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") continue; throw error; }
    try {
      await handle.writeFile(JSON.stringify(bundle, null, 1), "utf8");
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.unlink(filePath).catch(() => {});
      throw error;
    }
    await handle.close();
    return { path: filePath, relativePath: "docs/agenthub/" + fileName, fileName, omittedAttachments: bundle.omittedAttachments ?? 0 };
  }
  throw failure("EXPORT_NAME_CONFLICT", "내보내기 파일 이름을 만들지 못했습니다.");
}

/** .agenthub 내용을 { title, meta, events, attachments }로 읽는다. 형식이 다르면 code가 있는 오류를 던진다. */
export function parseBundle(content) {
  let data;
  try { data = JSON.parse(String(content ?? "").replace(/^﻿/, "")); }
  catch { throw failure("IMPORT_FORMAT", "AgentHub 세션 파일(.agenthub)이 아닙니다. JSON 형식이 아닙니다."); }
  if (data?.format !== BUNDLE_FORMAT || !Array.isArray(data.events)) throw failure("IMPORT_FORMAT", "AgentHub 세션 파일(.agenthub)이 아닙니다.");
  if (!Number.isInteger(data.version) || data.version > BUNDLE_VERSION) throw failure("IMPORT_VERSION", "이 AgentHub보다 새 버전에서 만든 세션 파일입니다. 앱을 업데이트한 뒤 가져오세요.");
  const files = new Map(list(data.attachments).filter((a) => typeof a?.id === "string" && typeof a.data === "string").map((a) => [a.id, a]));
  const events = data.events.map(bundleEvent).filter(Boolean).map(({ attachments, ...event }) => {
    if (!attachments?.length) return event;
    // 같은 형태로 다시 저장할 수 있게 원본 데이터를 붙여 둔다. 데이터가 빠진 첨부는 이름만 남는다.
    return { ...event, files: attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, data: files.get(a.id)?.data ?? null })) };
  });
  const session = data.session && typeof data.session === "object" ? data.session : {};
  return {
    title: text(session.title).trim() || "가져온 기록",
    events,
    meta: {
      sessionId: typeof session.id === "string" ? session.id : null,
      agent: ["claude", "codex"].includes(session.agent) ? session.agent : null,
      model: typeof session.model === "string" && session.model ? session.model : null,
      effort: typeof session.effort === "string" ? session.effort : "",
      permission: typeof session.permission === "string" ? session.permission : "",
      role: text(session.role), roleName: text(session.roleName),
      skills: list(session.skills).filter((s) => typeof s === "string"),
      project: text(session.projectName) || null, branch: text(session.branch) || null,
      exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : null,
      createdAt: typeof session.createdAt === "string" ? session.createdAt : null,
    },
  };
}

// 목록에 보일 머리 정보만 읽는다.
export function bundleHead(content) {
  try {
    const { title, meta } = parseBundle(content);
    return { title, meta: { agent: meta.agent, exportedAt: meta.exportedAt } };
  } catch {
    return {};
  }
}

// 다른 세션의 기록을 AI가 읽을 수 있는 글로. "읽히기"와 @파일 참조에 쓴다.
export function recordReadText(name, parsed, { budget } = {}) {
  const { meta } = parsed;
  const about = [
    meta.agent ? `AI ${meta.agent === "codex" ? "Codex" : "Claude"}${meta.model ? ` (${meta.model})` : ""}` : null,
    meta.project ? `프로젝트 ${meta.project}` : null,
    meta.branch ? `브랜치 ${meta.branch}` : null,
    meta.exportedAt ? `내보낸 날짜 ${meta.exportedAt}` : null,
  ].filter(Boolean).join(" · ");
  const digest = recordDigest(parsed.events, budget);
  return [
    `[다른 세션의 작업 기록: ${name}]`,
    `"${parsed.title}" 세션의 기록이다${about ? ` (${about})` : ""}. 다른 시점·다른 폴더에서 진행했을 수 있으므로 기록의 경로와 파일 상태는 지금 작업 폴더에서 직접 확인한다.`,
    meta.role ? `그 세션의 역할: ${meta.role.split(/\r?\n/)[0]}` : null,
    "--- 기록 ---",
    ...(digest.length ? digest : ["(기록 없음)"]),
    "--- 기록 끝 ---",
  ].filter((part) => part !== null).join("\n\n");
}
