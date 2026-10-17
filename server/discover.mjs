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

// AgentHub가 첫 요청 앞에 붙이는 안내(공통 지침, 역할, 스킬, 질문 규칙 등). 제목은 그 뒤의 실제 요청으로 정한다.
const AGENTHUB_BLOCK = /^\s*\[(AgentHub [^\]\n]+|이 세션의 역할[^\]\n]*|이 세션에 이은 스킬[^\]\n]*|일반 대화|현재 세션|역할 템플릿)\]/;
export function userPrompt(text) {
  if (!AGENTHUB_BLOCK.test(text)) return text;
  // 역할을 붙인 요청은 "[요청]" 뒤가 실제 요청이다.
  const marker = text.lastIndexOf("[요청]\n");
  if (marker >= 0) return text.slice(marker + "[요청]\n".length);
  // 그 밖에는 안내 블록을 빈 줄 단위로 걷어낸다.
  let rest = text;
  while (AGENTHUB_BLOCK.test(rest) && rest.includes("\n\n")) rest = rest.slice(rest.indexOf("\n\n") + 2);
  return AGENTHUB_BLOCK.test(rest) ? "" : rest;
}

// ── Claude ──────────────────────────────────────────────────────
function claudeUserText(msg) {
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return "";
}

// 기록 파일 요약. 기록은 뒤에 줄을 덧붙이며 자라므로 읽은 위치와 중간 결과를 기억해 늘어난 부분만 읽는다.
// 앞부분이 바뀌었거나 파일이 줄었으면 처음부터 다시 읽는다. 수십 MB 파일을 바뀔 때마다 통째로 읽지 않는다.
// summarizer: { kind, init() → 상태, step(상태, 줄), finish(상태, 파일, stat) → 요약 또는 null }
const summaryCache = new Map(); // 파일 경로 → { kind, mtimeMs, size, offset, head, state, value }
const HEAD_BYTES = 64;
const READ_CHUNK = 8 << 20;

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const n = fs.readSync(fd, buffer, filled, length - filled, position + filled);
    if (!n) break;
    filled += n;
  }
  return buffer.subarray(0, filled);
}

function cached(file, summarizer) {
  const stat = fs.statSync(file);
  const hit = summaryCache.get(file);
  const same = hit?.kind === summarizer.kind;
  if (same && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  const fd = fs.openSync(file, "r");
  try {
    const head = readAt(fd, 0, Math.min(HEAD_BYTES, stat.size));
    const previousHead = same ? Buffer.from(hit.head, "base64") : null;
    const grown = same && stat.size > hit.size && head.subarray(0, previousHead.length).equals(previousHead);
    const entry = grown ? { ...hit, state: { ...hit.state } } : { kind: summarizer.kind, offset: 0, state: summarizer.init() };
    // 완성된 줄(줄바꿈까지)만 상태에 넣고, 쓰는 중일 수 있는 마지막 조각은 이번 결과에만 반영한다.
    let start = entry.offset;
    let pending = Buffer.alloc(0);
    for (let position = entry.offset; position < stat.size;) {
      const chunk = readAt(fd, position, Math.min(READ_CHUNK, stat.size - position));
      if (!chunk.length) break;
      position += chunk.length;
      const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const end = data.lastIndexOf(10); // "\n"
      if (end < 0) { pending = data; continue; }
      for (const line of data.subarray(0, end).toString("utf8").split("\n")) if (line) summarizer.step(entry.state, line);
      start += end + 1;
      pending = data.subarray(end + 1);
    }
    let state = entry.state;
    const tail = pending.toString("utf8");
    if (tail) { state = { ...state }; summarizer.step(state, tail); }
    Object.assign(entry, { mtimeMs: stat.mtimeMs, size: stat.size, offset: start, head: head.toString("base64"), value: summarizer.finish(state, file, stat) });
    summaryCache.set(file, entry);
    cacheChanged();
    return entry.value;
  } finally {
    fs.closeSync(fd);
  }
}

// 요약은 데이터 폴더에 저장해 서버를 다시 켜도 기록을 처음부터 읽지 않는다. 읽을 수 없으면 버리고 다시 만든다.
const CACHE_VERSION = 1;
let cacheFile = null;
let cacheDirty = false;
let cacheTimer = null;
let cacheWrite = Promise.resolve();

export function useDiscoverCache(file) {
  cacheFile = file;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data?.version !== CACHE_VERSION) return;
    for (const [name, entry] of Object.entries(data.summaries ?? {})) {
      if (typeof entry?.kind === "string" && Number.isFinite(entry.size) && Number.isFinite(entry.offset) && typeof entry.head === "string" && entry.state && typeof entry.state === "object")
        summaryCache.set(name, entry);
    }
    for (const [name, meta] of Object.entries(data.codexMeta ?? {})) codexMetaCache.set(name, meta);
  } catch {}
}

function cacheChanged() {
  cacheDirty = true;
  if (!cacheFile || cacheTimer) return;
  cacheTimer = setTimeout(() => { cacheTimer = null; flushDiscoverCache(); }, 2000);
  cacheTimer.unref?.();
}

export function flushDiscoverCache() {
  clearTimeout(cacheTimer);
  cacheTimer = null;
  if (!cacheFile || !cacheDirty) return cacheWrite;
  cacheDirty = false;
  const file = cacheFile;
  const text = JSON.stringify({ version: CACHE_VERSION, summaries: Object.fromEntries(summaryCache), codexMeta: Object.fromEntries(codexMetaCache) });
  const temp = `${file}.${process.pid}.tmp`;
  // 데이터 폴더를 새로 만들지 않는다. 폴더가 없으면(지운 테스트 폴더 등) 저장하지 않는다.
  cacheWrite = cacheWrite.then(async () => {
    await fs.promises.writeFile(temp, text);
    await fs.promises.rename(temp, file);
  }).catch(() => fs.promises.rm(temp, { force: true }).catch(() => {}));
  return cacheWrite;
}

// 지워진 기록 파일의 요약은 저장 파일에 남기지 않는다.
function forgetMissing(seen) {
  for (const cache of [summaryCache, codexMetaCache]) {
    for (const name of cache.keys()) {
      if (!seen.has(name)) { cache.delete(name); cacheDirty = true; }
    }
  }
}

const claudeSummary = {
  kind: "claude",
  init: () => ({ cwd: null, title: null, firstPrompt: null, turns: 0 }),
  step(state, line) {
    const msg = parseJson(line);
    if (!msg) return;
    if (msg.type === "custom-title" && msg.customTitle) state.title = msg.customTitle;
    if (msg.type !== "user" || msg.isSidechain || msg.isMeta) return;
    state.cwd ??= msg.cwd;
    const text = claudeUserText(msg);
    if (!text || isInjected(text)) return;
    state.turns++;
    state.firstPrompt ??= userPrompt(text) || null;
  },
  finish(state, file, stat) {
    if (!state.turns) return null;
    return {
      agent: "claude",
      agentSessionId: path.basename(file, ".jsonl"),
      title: oneLine(state.title ?? state.firstPrompt),
      cwd: state.cwd,
      turns: state.turns,
      updatedAt: stat.mtime.toISOString(),
      file,
    };
  },
};

function allClaude(seen) {
  const base = path.join(CLAUDE_DIR, "projects");
  if (!fs.existsSync(base)) return [];
  const found = [];
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    // 훑는 사이에 지워졌거나 잠긴 폴더 하나 때문에 목록 전체가 사라지지 않게 건너뛴다.
    let files;
    try { files = fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : []; } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      seen.add(path.join(dir, file));
      try {
        const entry = cached(path.join(dir, file), claudeSummary);
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
      if (text && !isInjected(text)) events.push({ kind: "user", text: userPrompt(text) || text, ts: msg.timestamp });
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
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
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
    cacheChanged();
  }
  return codexMetaCache.get(file);
}

// 스레드 이름 목록은 바뀌었을 때만 다시 읽는다.
let threadNames = null; // { mtimeMs, size, names }
function codexThreadNames() {
  const file = path.join(CODEX_DIR, "session_index.jsonl");
  let stat;
  try { stat = fs.statSync(file); } catch { return new Map(); }
  if (threadNames?.mtimeMs === stat.mtimeMs && threadNames.size === stat.size) return threadNames.names;
  const names = new Map();
  for (const line of readLines(file)) {
    const entry = parseJson(line);
    if (entry?.id && entry.thread_name) names.set(entry.id, entry.thread_name);
  }
  threadNames = { mtimeMs: stat.mtimeMs, size: stat.size, names };
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
      if (text && !isInjected(text)) events.push({ kind: "user", text: userPrompt(text) || text, ts });
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
const codexSummary = (meta) => ({
  kind: "codex",
  init: () => ({ turns: 0, first: null }),
  step(state, line) {
    if (!line.includes('"role":"user"') || !line.includes('"response_item"')) return;
    const p = parseJson(line)?.payload;
    if (p?.type !== "message" || p.role !== "user") return;
    const text = codexText(p.content);
    if (!text || isInjected(text)) return;
    state.turns++;
    state.first ??= text;
  },
  finish(state, file, stat) {
    if (!state.turns) return null;
    return {
      agent: "codex",
      agentSessionId: meta.id,
      firstPrompt: userPrompt(state.first) || state.first,
      cwd: meta.cwd,
      turns: state.turns,
      updatedAt: stat.mtime.toISOString(),
      file,
    };
  },
});

function allCodex(seen) {
  const names = codexThreadNames();
  const found = [];
  for (const file of walk(path.join(CODEX_DIR, "sessions"))) {
    seen.add(file);
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
      entry = cached(file, codexSummary(meta));
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
  const seen = new Set();
  let complete = true;
  for (const scan of [allClaude, allCodex]) {
    try {
      all.push(...scan(seen));
    } catch (err) {
      complete = false;
      console.error(`세션 검색 실패: ${err.message}`);
    }
  }
  if (complete) forgetMissing(seen);
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

