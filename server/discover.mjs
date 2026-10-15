// AgentHub 밖에서 만든 Claude Code·Codex 세션을 디스크 기록에서 찾아 가져온다.
// Claude: ~/.claude/projects/<인코딩된 경로>/<세션 ID>.jsonl
// Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (첫 줄 session_meta에 작업 폴더가 있다)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as claude from "./agents/claude.mjs";
import { CHAT_DIR } from "./config.mjs";

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(HOME, ".claude");
const CODEX_DIR = process.env.CODEX_HOME ?? path.join(HOME, ".codex");
const MAX_EVENTS = 400;

// 세션의 작업 폴더를 프로젝트 폴더(가능하면 git 저장소 루트)로 바꾼다.
// AgentHub 작업 폴더(<저장소>.agenthub/<ID>)와 Claude Code 작업 트리(<저장소>/.claude/worktrees/<이름>)는 원래 저장소로 묶는다.
const rootCache = new Map();
export function projectRoot(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(cwd);
  if (rootCache.has(dir)) return rootCache.get(dir);
  let base = dir;
  const agenthub = base.match(/^(.*)\.agenthub[\\/][^\\/]+/i);
  if (agenthub) base = agenthub[1];
  const claudeTree = base.match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/]/i);
  if (claudeTree) base = claudeTree[1];
  let root = base;
  for (let cur = base; ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, ".git"))) {
      root = cur;
      break;
    }
    if (path.dirname(cur) === cur) break;
  }
  rootCache.set(dir, root);
  return root;
}

const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isInside = (child, parent) => path.resolve(child).toLowerCase().startsWith(path.resolve(parent).toLowerCase() + path.sep);

// 임시 폴더나 CLI 자체 폴더에서 연 세션은 프로젝트로 보지 않는다.
function isProjectDir(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (samePath(dir, HOME) || samePath(dir, path.parse(dir).root)) return false;
  return ![os.tmpdir(), CLAUDE_DIR, CODEX_DIR].some((skip) => samePath(dir, skip) || isInside(dir, skip));
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// 첫 줄만 필요하므로 줄바꿈이 나올 때까지 조금씩 읽는다(최대 4MB).
function firstLine(file, max = 4 << 20) {
  const fd = fs.openSync(file, "r");
  try {
    const chunks = [];
    let total = 0;
    const chunk = Buffer.alloc(64 * 1024);
    while (total < max) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (!n) break;
      const end = chunk.subarray(0, n).indexOf(10); // "\n"
      if (end >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, end)));
        break;
      }
      chunks.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

const oneLine = (text, max = 80) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

// CLI가 프롬프트 앞뒤에 붙이는 시스템 텍스트는 사용자 입력으로 보지 않는다.
const isInjected = (text) => /^\s*<[\w-]+[\s>]/.test(text) || /^# AGENTS\.md/.test(text);

// ── Claude ──────────────────────────────────────────────────────
function claudeUserText(msg) {
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return "";
}

// 기록 파일 요약은 파일이 바뀌지 않았으면 다시 읽지 않는다.
const summaryCache = new Map(); // 파일 경로 → { mtimeMs, size, value }
function cached(file, summarize) {
  const stat = fs.statSync(file);
  const hit = summaryCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  const value = summarize(file, stat);
  summaryCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function summarizeClaude(file, stat) {
  let cwd = null;
  let title = null;
  let firstPrompt = null;
  let turns = 0;
  for (const line of readLines(file)) {
    const msg = parseJson(line);
    if (!msg) continue;
    if (msg.type === "custom-title" && msg.customTitle) title = msg.customTitle;
    if (msg.type !== "user" || msg.isSidechain || msg.isMeta) continue;
    cwd ??= msg.cwd;
    const text = claudeUserText(msg);
    if (!text || isInjected(text)) continue;
    turns++;
    firstPrompt ??= text;
  }
  if (!turns) return null;
  return {
    agent: "claude",
    agentSessionId: path.basename(file, ".jsonl"),
    title: oneLine(title ?? firstPrompt),
    cwd,
    turns,
    updatedAt: stat.mtime.toISOString(),
    file,
  };
}

function allClaude() {
  const base = path.join(CLAUDE_DIR, "projects");
  if (!fs.existsSync(base)) return [];
  const found = [];
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        const entry = cached(path.join(dir, file), summarizeClaude);
        if (entry) found.push(entry);
      } catch {
        // 쓰는 중이거나 읽을 수 없는 파일은 건너뛴다.
      }
    }
  }
  return found;
}

function claudeHistory(file) {
  const events = [];
  for (const line of readLines(file)) {
    const msg = parseJson(line);
    if (!msg || msg.isSidechain || msg.isMeta) continue;
    if (msg.type === "user") {
      const text = claudeUserText(msg);
      if (text && !isInjected(text)) events.push({ kind: "user", text, ts: msg.timestamp });
      else events.push(...claude.parseLine(line).map((e) => ({ ...e, ts: msg.timestamp })));
    } else if (msg.type === "assistant" || (msg.type === "system" && msg.subtype === "compact_boundary")) {
      events.push(...claude.parseLine(line).map((e) => ({ ...e, ts: msg.timestamp })));
    }
  }
  return events;
}

// ── Codex ───────────────────────────────────────────────────────
const codexMetaCache = new Map(); // 파일 경로 → session_meta(바뀌지 않는다)

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function codexMeta(file) {
  if (!codexMetaCache.has(file)) {
    const meta = parseJson(firstLine(file))?.payload ?? null;
    codexMetaCache.set(file, meta && { id: meta.id ?? meta.session_id, cwd: meta.cwd, source: meta.source });
  }
  return codexMetaCache.get(file);
}

function codexThreadNames() {
  const names = new Map();
  const file = path.join(CODEX_DIR, "session_index.jsonl");
  if (!fs.existsSync(file)) return names;
  for (const line of readLines(file)) {
    const entry = parseJson(line);
    if (entry?.id && entry.thread_name) names.set(entry.id, entry.thread_name);
  }
  return names;
}

function codexText(content) {
  return (content ?? []).map((c) => c.text ?? "").filter(Boolean).join("\n");
}

function truncate(text, max = 4000) {
  if (typeof text !== "string") text = JSON.stringify(text);
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max}자 생략)` : text;
}

function codexHistory(file) {
  const events = [];
  for (const line of readLines(file)) {
    const msg = parseJson(line);
    if (msg?.type !== "response_item") continue;
    const p = msg.payload ?? {};
    const ts = msg.timestamp;
    if (p.type === "message" && p.role === "user") {
      const text = codexText(p.content);
      if (text && !isInjected(text)) events.push({ kind: "user", text, ts });
    } else if (p.type === "message" && p.role === "assistant") {
      const text = codexText(p.content);
      if (text) events.push({ kind: "text", text, ts });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const input = p.arguments ?? p.input ?? "";
      events.push({ kind: "tool", text: `${p.name}: ${oneLine(input, 160)}`, detail: truncate(input), ts });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
      if (out) events.push({ kind: "tool_result", text: truncate(out), ts });
    }
  }
  return events;
}

// 목록에는 사용자 요청만 필요하므로 해당 줄만 파싱한다(기록 파일이 수십 MB일 수 있다).
function codexPrompts(file) {
  const prompts = [];
  for (const line of readLines(file)) {
    if (!line.includes('"role":"user"') || !line.includes('"response_item"')) continue;
    const p = parseJson(line)?.payload;
    if (p?.type !== "message" || p.role !== "user") continue;
    const text = codexText(p.content);
    if (text && !isInjected(text)) prompts.push({ text });
  }
  return prompts;
}

function allCodex() {
  const names = codexThreadNames();
  const found = [];
  for (const file of walk(path.join(CODEX_DIR, "sessions"))) {
    let meta;
    try {
      meta = codexMeta(file);
    } catch {
      continue;
    }
    // 하위 에이전트·검토용 스레드(source가 객체)는 빼고 사용자가 연 세션만 본다.
    if (!meta?.id || typeof meta.source !== "string") continue;
    let entry;
    try {
      entry = cached(file, (f, stat) => {
        const prompts = codexPrompts(f);
        if (!prompts.length) return null;
        return {
          agent: "codex",
          agentSessionId: meta.id,
          firstPrompt: prompts[0].text,
          cwd: meta.cwd,
          turns: prompts.length,
          updatedAt: stat.mtime.toISOString(),
          file,
        };
      });
    } catch {
      continue;
    }
    if (!entry) continue;
    const { firstPrompt, ...rest } = entry;
    found.push({ ...rest, title: oneLine(names.get(meta.id) ?? firstPrompt) });
  }
  return found;
}

function allSessions() {
  const all = [];
  for (const scan of [allClaude, allCodex]) {
    try {
      all.push(...scan());
    } catch (err) {
      console.error(`세션 검색 실패: ${err.message}`);
    }
  }
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ── 공개 함수 ───────────────────────────────────────────────────
// AgentHub 일반 채팅으로 만든 기록은 프로젝트 세션이 아니다.
const projectSessions = () => allSessions().filter((s) => s.cwd && !samePath(s.cwd, CHAT_DIR) && !isInside(s.cwd, CHAT_DIR));

export function discoverSessions(projectPath) {
  return projectSessions().filter((s) => s.cwd && (samePath(projectRoot(s.cwd), projectPath) || isInside(s.cwd, projectPath)));
}

// Claude Code·Codex의 기록 파일을 지운다. Claude는 같은 이름의 폴더(하위 에이전트·도구 결과)도 함께 지운다.
// 지운 파일 수를 돌려준다. 못 지운 파일(다른 프로그램이 쓰는 중 등)은 errors에 모은다.
export function deleteSessionRecords(ids) {
  const wanted = new Set(ids.filter(Boolean));
  const result = { deleted: 0, errors: [] };
  if (!wanted.size) return result;
  for (const s of allSessions()) {
    if (!wanted.has(s.agentSessionId)) continue;
    const targets = [s.file];
    if (s.agent === "claude") targets.push(path.join(path.dirname(s.file), s.agentSessionId));
    for (const target of targets) {
      if (!fs.existsSync(target)) continue;
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
        summaryCache.delete(target);
        if (target === s.file) result.deleted++;
      } catch (err) {
        result.errors.push(`${target}: ${err.message}`);
      }
    }
  }
  return result;
}

// 세션 기록에 나온 작업 폴더를 프로젝트 단위로 묶는다.
export function discoverProjects() {
  const projects = new Map();
  for (const s of projectSessions()) {
    const root = projectRoot(s.cwd);
    if (!isProjectDir(root)) continue;
    const key = root.toLowerCase();
    if (!projects.has(key)) {
      projects.set(key, { path: root, name: path.basename(root), claude: 0, codex: 0, lastActive: s.updatedAt });
    }
    const p = projects.get(key);
    p[s.agent]++;
    if (s.updatedAt > p.lastActive) p.lastActive = s.updatedAt;
  }
  return [...projects.values()].sort((a, b) => b.lastActive.localeCompare(a.lastActive));
}

// 화면에 보일 기록과 세션 수명(압축 횟수, 마지막 컨텍스트 크기)
export function loadHistory(found) {
  let compactions = 0;
  let context = null;
  const events = [];
  for (const { compact, context: ctx, ...e } of found.agent === "claude" ? claudeHistory(found.file) : codexHistory(found.file)) {
    if (compact) compactions++;
    if (ctx) context = { ...context, ...ctx };
    if (e.kind !== "usage") events.push(e);
  }
  const skipped = Math.max(0, events.length - MAX_EVENTS);
  const kept = events.slice(skipped);
  const note = `${found.agent === "claude" ? "Claude Code" : "Codex"}에서 가져온 세션입니다.` +
    (skipped ? ` 앞부분 ${skipped}개 항목은 생략했습니다.` : "");
  return {
    events: [{ kind: "status", text: note }, ...kept].map((e, seq) => ({ ...e, seq, ts: e.ts ?? new Date().toISOString() })),
    compactions,
    context,
  };
}

