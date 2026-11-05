// 세션 지침: 세션마다 AGENTS.md처럼 더하는 지침 파일(.agenthub/sessions/<이름>.md). 예전 "역할"을 대신한다.
// 세션은 파일 경로(guideFile, 작업 폴더 기준)를 기억하고, 요청에는 내용을 그대로 붙인다.
// 붙이는 때: 새 대화 첫 요청 / 파일이 바뀐 뒤 첫 요청 / 대화 요약 뒤 첫 요청. 파일이 없으면 붙이지 않고 알린다.
// 세션 지침이 없는 세션은 예전 역할 글을 그대로 붙인다(호환 모드, role.mjs).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { withRole } from "./role.mjs";

export const SESSION_GUIDE_DIR = ".agenthub/sessions";
export const SESSION_GUIDE_MAX = 4000; // 넘으면 경고(새 대화마다 문맥을 차지한다)
const RULE = "이 지침을 대화 내내 지킨다. 지침 범위 밖의 수정이 필요하면 직접 고치지 말고 알린다.";
export const GUIDE_SECTIONS_SESSION = ["맡는 일", "고쳐도 되는 범위", "하지 않는 것", "완료 기준", "마지막 줄 판정"];

const hash = (text) => createHash("sha1").update(String(text ?? "")).digest("hex").slice(0, 16);
export const sessionGuideHash = hash;

export function guideFileName(name) {
  const base = String(name ?? "").trim().replace(/[\\/:*?"<>|#%]+/g, " ").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${base || "세션"}.md`;
}

export function parseSessionGuide(text) {
  const value = String(text ?? "");
  const match = value.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  if (match) for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].replace(/^(["'])([\s\S]*)\1$/, "$2").replace(/\\"/g, '"').trim();
  }
  const body = (match ? match[2] : value).trim();
  return { name: meta.name ?? "", summary: meta.summary ?? "", body, verdicts: verdictWords(body) };
}

export function formatSessionGuide({ name, summary, body }) {
  return `---\nname: ${String(name ?? "").replace(/\n/g, " ").trim()}\nsummary: ${JSON.stringify(String(summary ?? "").replace(/\s+/g, " ").trim())}\n---\n\n${String(body ?? "").trim()}\n`;
}

// "마지막 줄 판정" 섹션(없으면 "마지막 줄" 문장)에서 따옴표로 감싼 판정어를 꺼낸다.
export function verdictWords(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,3}\s*마지막\s*줄\s*판정/.test(l));
  let pool;
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && /^#{2,3}\s/.test(l));
    pool = lines.slice(start + 1, end < 0 ? undefined : end);
  } else pool = lines.filter((l) => /마지막\s*줄|판정|last line/i.test(l));
  const words = pool.flatMap((l) => [...l.matchAll(/["“'‘]([^"”'’]{1,40})["”'’]/g)].map((m) => m[1].trim()));
  return [...new Set(words.filter(Boolean))];
}

// 예전 역할 글을 세션 지침 본문으로 옮긴다. "마지막 줄에 '…'" 줄은 판정 섹션으로 보낸다.
export function guideFromRole(role, { name, title } = {}) {
  const lines = String(role ?? "").split(/\r?\n/);
  const verdict = lines.filter((l) => /마지막\s*줄|판정/.test(l));
  const rest = lines.filter((l) => !verdict.includes(l));
  const first = rest.find((l) => l.trim())?.replace(/^[-*]\s*/, "").trim() ?? "";
  const body = [`## 맡는 일`, ...rest, "", `## 마지막 줄 판정`, ...(verdict.length ? verdict : ["- (연결로 넘길 때 마지막 줄에 쓸 말을 적는다)"])].join("\n").replace(/\n{3,}/g, "\n\n");
  return { name: name || title || "세션", summary: first.slice(0, 160), body };
}

export function blankSessionGuide(name) {
  return { name, summary: "", body: GUIDE_SECTIONS_SESSION.map((s) => `## ${s}\n`).join("\n") };
}

// 세션 지침 파일 위치: 세션의 작업 폴더(워크트리면 그 폴더) 기준
export const guideRoot = (session) => session.cwd || session.projectPath;
export function guidePath(session) {
  if (!session.guideFile) return null;
  const root = guideRoot(session);
  const full = path.resolve(root, session.guideFile);
  const rel = path.relative(root, full);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : full;
}

export function readSessionGuide(session) {
  const full = guidePath(session);
  if (!full) return null;
  let text;
  try { text = fs.readFileSync(full, "utf8"); } catch { return { file: session.guideFile, full, missing: true }; }
  return { file: session.guideFile, full, missing: false, text, hash: hash(text), ...parseSessionGuide(text) };
}

// 세션 목록에 보일 캐시(이름·요약·판정어). 파일을 다시 읽을 때마다 맞춘다.
export function cacheGuide(session, guide = readSessionGuide(session)) {
  if (!guide) { delete session.guideName; delete session.guideSummary; delete session.guideVerdicts; delete session.guideMissing; return; }
  if (guide.missing) { session.guideMissing = true; return; }
  delete session.guideMissing;
  session.guideName = guide.name || path.basename(guide.file, ".md");
  session.guideSummary = guide.summary;
  session.guideVerdicts = guide.verdicts;
}

// 요청에 세션 지침을 붙인다. 세션 지침이 없으면 예전 역할을 붙인다(호환 모드).
export function withSessionGuide(session, prompt) {
  if (!session.guideFile) return withRole(session, prompt);
  const guide = readSessionGuide(session);
  cacheGuide(session, guide);
  const compacted = session.guideCompacted;
  delete session.guideCompacted;
  delete session.roleChanged;
  if (!guide || guide.missing) {
    session.guideState = "missing";
    return prompt;
  }
  const changed = session.guideSentHash && session.guideSentHash !== guide.hash;
  const fresh = !session.agentSessionId;
  if (!fresh && !changed && !compacted) return prompt;
  const reason = fresh ? "" : compacted ? " (대화가 요약되어 다시 알린다)" : " (지침이 바뀌었다. 지금부터 아래 지침을 따른다)";
  session.guideSentHash = guide.hash;
  session.guideSentAt = new Date().toISOString();
  session.guideState = fresh ? "sent" : compacted ? "resent-compact" : "resent-change";
  const title = guide.name ? `: ${guide.name}` : "";
  return `[이 세션의 지침${title}]${reason}\n${guide.body}\n\n${RULE}\n\n[요청]\n${prompt}`;
}

// 대화 요약 직후 진행 중인 턴에 끼워 넣을 짧은 알림
export const guideCompactNotice = (name) => `[대화가 요약되었다] 이 세션의 지침${name ? `(${name})` : ""}을 다시 따른다. 다음 요청에 지침 전체를 다시 붙인다.`;

// 세션 지침 검사: 판정어와 그 지침을 쓰는 세션들의 나가는 키워드 연결이 서로 맞는지, 길이.
// users: 이 지침을 쓰는 세션들 / links: 전체 연결
export function sessionGuideChecks(text, { users = [], links = [], keywordList = (k) => String(k ?? "").split(/[,，]/).map((x) => x.trim()).filter(Boolean) } = {}) {
  const guide = parseSessionGuide(text);
  const warnings = [];
  const lines = String(text ?? "").split(/\r?\n/);
  const verdictLine = Math.max(1, lines.findIndex((l) => /^#{2,3}\s*마지막\s*줄\s*판정/.test(l)) + 1);
  const ids = new Set(users.map((s) => s.id));
  const keywords = [...new Set(links.filter((l) => ids.has(l.from) && l.enabled !== false && l.when === "keyword").flatMap((l) => keywordList(l.keyword)))];
  const has = (word) => guide.verdicts.some((v) => v.toLowerCase().includes(word.toLowerCase()) || word.toLowerCase().includes(v.toLowerCase()));
  for (const word of keywords) if (!has(word)) warnings.push({ id: `verdict-missing:${word}`, kind: "verdict-missing", level: "error", title: `연결 키워드 '${word}'가 지침에 없습니다`, detail: "이 지침을 쓰는 세션의 키워드 연결이 이 말을 기다립니다. \"## 마지막 줄 판정\"에 '" + word + "'를 쓰는 때를 적으세요.", line: verdictLine, quote: "" });
  if (keywords.length) for (const v of guide.verdicts) if (!keywords.some((k) => k.toLowerCase().includes(v.toLowerCase()) || v.toLowerCase().includes(k.toLowerCase()))) warnings.push({ id: `verdict-unlinked:${v}`, kind: "verdict-unlinked", level: "info", title: `판정 '${v}'로 가는 연결이 없습니다`, detail: "이 말로 끝나면 연결로 넘어가지 않습니다. 의도한 것이면 그대로 두세요.", line: verdictLine, quote: v });
  if (String(text ?? "").length > SESSION_GUIDE_MAX) warnings.push({ id: "session-guide-long", kind: "session-guide-long", level: "info", title: `세션 지침이 ${String(text).length.toLocaleString()}자입니다`, detail: `새 대화마다 문맥을 차지합니다. ${SESSION_GUIDE_MAX.toLocaleString()}자 이하를 권하고, 자세한 절차는 연결 문서로 옮기세요.`, line: 0, quote: "" });
  return warnings;
}
