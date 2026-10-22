// AgentHub 밖에서 만든 Claude Code·Codex 세션을 디스크 기록에서 찾아 가져온다.
// Claude: ~/.claude/projects/<인코딩된 경로>/<세션 ID>.jsonl
// Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (첫 줄 session_meta에 작업 폴더가 있다)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as claude from "./agents/claude.mjs";
import { CHAT_DIR } from "./config.mjs";
import { jsonLines } from "./infrastructure/persistence/json-lines.mjs";

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(HOME, ".claude");
const CODEX_DIR = process.env.CODEX_HOME ?? path.join(HOME, ".codex");
const MAX_EVENTS = 400;
const HISTORY_BYTES = 8 << 20;
const HISTORY_TEXT = 200_000;
export const DISCOVERY_TTL_MS = 5000;

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
const pathKey = (value) => path.resolve(value).toLowerCase();

async function asyncProjectRoot(cwd) {
  const dir = path.resolve(cwd);
  if (rootCache.has(dir)) return rootCache.get(dir);
  let base = dir.replace(/^(.*)\.agenthub[\\/][^\\/]+.*/i, "$1").replace(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/].*/i, "$1");
  let root = base;
  for (let current = base; ; current = path.dirname(current)) {
    try { await fs.promises.access(path.join(current, ".git")); root = current; break; } catch {}
    if (path.dirname(current) === current) break;
  }
  rootCache.set(dir, root);
  return root;
}

// 임시 폴더나 CLI 자체 폴더에서 연 세션은 프로젝트로 보지 않는다.
async function isProjectDir(dir) {
  if (!dir) return false;
  if (samePath(dir, HOME) || samePath(dir, path.parse(dir).root)) return false;
  if ([os.tmpdir(), CLAUDE_DIR, CODEX_DIR].some((skip) => samePath(dir, skip) || isInside(dir, skip))) return false;
  try { return (await fs.promises.stat(dir)).isDirectory(); } catch { return false; }
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// 첫 줄만 필요하므로 줄바꿈이 나올 때까지 조금씩 읽는다(최대 4MB).
async function firstLine(file, max = 4 << 20) {
  for await (const record of jsonLines(file, { end: max, maxLineBytes: max, chunkBytes: 4096 })) return record.line ?? "";
  return "";
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
async function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead: n } = await fd.read(buffer, filled, length - filled, position + filled);
    if (!n) break;
    filled += n;
  }
  return buffer.subarray(0, filled);
}

async function cached(file, summarizer, stat = null) {
  stat ??= await fs.promises.stat(file);
  const hit = summaryCache.get(file);
  const same = hit?.kind === summarizer.kind;
  if (same && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  const fd = await fs.promises.open(file, "r");
  try {
    const head = await readAt(fd, 0, Math.min(HEAD_BYTES, stat.size));
    const previousHead = same ? Buffer.from(hit.head, "base64") : null;
    const grown = same && stat.size > hit.size && head.subarray(0, previousHead.length).equals(previousHead);
    const entry = grown ? { ...hit, state: { ...hit.state } } : { kind: summarizer.kind, offset: 0, state: summarizer.init() };
    // 완성된 줄(줄바꿈까지)만 상태에 넣고, 쓰는 중일 수 있는 마지막 조각은 이번 결과에만 반영한다.
    let state = entry.state;
    for await (const record of jsonLines(file, { start: entry.offset, end: stat.size })) {
      if (record.complete) { if (record.line) summarizer.step(entry.state, record.line); entry.offset = record.end; }
      else if (record.line) { state = { ...entry.state }; summarizer.step(state, record.line); }
    }
    Object.assign(entry, { mtimeMs: stat.mtimeMs, size: stat.size, head: head.toString("base64"), value: summarizer.finish(state, file, stat) });
    summaryCache.set(file, entry);
    cacheChanged();
    return entry.value;
  } finally {
    await fd.close();
  }
}

// 요약은 데이터 폴더에 저장해 서버를 다시 켜도 기록을 처음부터 읽지 않는다. 읽을 수 없으면 버리고 다시 만든다.
const CACHE_VERSION = 1;
let cacheFile = null;
let cacheDirty = false;
let cacheTimer = null;
let cacheWrite = Promise.resolve();
let cacheLoad = Promise.resolve();

export function useDiscoverCache(file) {
  cacheFile = file;
  cacheLoad = fs.promises.readFile(file, "utf8").then((text) => {
    if (cacheFile !== file) return;
    const data = JSON.parse(text);
    if (data?.version !== CACHE_VERSION) return;
    for (const [name, entry] of Object.entries(data.summaries ?? {})) {
      if (typeof entry?.kind === "string" && Number.isFinite(entry.size) && Number.isFinite(entry.offset) && typeof entry.head === "string" && entry.state && typeof entry.state === "object")
        summaryCache.set(name, entry);
    }
    for (const [name, meta] of Object.entries(data.codexMeta ?? {})) codexMetaCache.set(name, meta);
  }).catch(() => {});
  return cacheLoad;
}

function cacheChanged() {
  cacheDirty = true;
  if (!cacheFile || cacheTimer) return;
  cacheTimer = setTimeout(() => { cacheTimer = null; flushDiscoverCache(); }, 2000);
  cacheTimer.unref?.();
}

export async function flushDiscoverCache() {
  await scanFlight?.catch(() => {});
  await cacheLoad;
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
    state.firstPrompt ??= oneLine(userPrompt(text)) || null;
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

async function allClaude(seen) {
  const base = path.join(CLAUDE_DIR, "projects");
  const found = [];
  let directories;
  try { directories = await fs.promises.readdir(base, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  for (const folder of directories) {
    if (!folder.isDirectory()) continue;
    const dir = path.join(base, folder.name);
    // 훑는 사이에 지워졌거나 잠긴 폴더 하나 때문에 목록 전체가 사라지지 않게 건너뛴다.
    let files;
    try { files = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      seen.add(path.join(dir, file.name));
      try {
        const entry = await cached(path.join(dir, file.name), claudeSummary);
        if (entry) found.push(entry);
      } catch {
        // 쓰는 중이거나 읽을 수 없는 파일은 건너뛴다.
      }
    }
  }
  return found;
}

async function* claudeHistory(file) {
  for await (const { line } of jsonLines(file)) {
    if (line === null) { yield { oversized: true }; continue; }
    const msg = parseJson(line);
    if (!msg || msg.isSidechain || msg.isMeta) continue;
    if (msg.type === "user") {
      const text = claudeUserText(msg);
      if (text && !isInjected(text)) yield { kind: "user", text: userPrompt(text) || text, ts: msg.timestamp };
      else for (const event of claude.parseLine(line)) yield { ...event, ts: msg.timestamp };
    } else if (msg.type === "assistant" || (msg.type === "system" && msg.subtype === "compact_boundary")) {
      for (const event of claude.parseLine(line)) yield { ...event, ts: msg.timestamp };
    }
  }
}

// ── Codex ───────────────────────────────────────────────────────
const codexMetaCache = new Map(); // 파일 경로 → session_meta(바뀌지 않는다)

async function* walk(dir) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
  }
}

async function codexMeta(file, stat) {
  const hit = codexMetaCache.get(file);
  if (!hit || hit.size !== stat.size || hit.mtimeMs !== stat.mtimeMs) {
    const meta = parseJson(await firstLine(file))?.payload ?? null;
    codexMetaCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, meta: meta && { id: meta.id ?? meta.session_id, cwd: meta.cwd, source: meta.source } });
    cacheChanged();
  }
  return codexMetaCache.get(file).meta;
}

// 스레드 이름 목록은 바뀌었을 때만 다시 읽는다.
let threadNames = null; // { mtimeMs, size, names }
async function codexThreadNames() {
  const file = path.join(CODEX_DIR, "session_index.jsonl");
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return new Map(); }
  if (threadNames?.mtimeMs === stat.mtimeMs && threadNames.size === stat.size) return threadNames.names;
  const names = new Map();
  for await (const { line } of jsonLines(file)) {
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

async function* codexHistory(file) {
  for await (const { line } of jsonLines(file)) {
    if (line === null) { yield { oversized: true }; continue; }
    const msg = parseJson(line);
    if (msg?.type !== "response_item") continue;
    const p = msg.payload ?? {};
    const ts = msg.timestamp;
    if (p.type === "message" && p.role === "user") {
      const text = codexText(p.content);
      if (text && !isInjected(text)) yield { kind: "user", text: userPrompt(text) || text, ts };
    } else if (p.type === "message" && p.role === "assistant") {
      const text = codexText(p.content);
      if (text) yield { kind: "text", text, ts };
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const input = p.arguments ?? p.input ?? "";
      yield { kind: "tool", text: `${p.name}: ${oneLine(input, 160)}`, detail: truncate(input), ts };
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
      if (out) yield { kind: "tool_result", text: truncate(out), ts };
    }
  }
}

// 목록에는 사용자 요청만 필요하므로 해당 줄만 파싱한다(기록 파일이 수십 MB일 수 있다).
const codexSummary = (meta) => ({
  kind: "codex",
  init: () => ({ turns: 0, first: null }),
  step(state, line) {
    if (!/"role"\s*:\s*"user"/.test(line) || !line.includes('"response_item"')) return;
    const p = parseJson(line)?.payload;
    if (p?.type !== "message" || p.role !== "user") return;
    const text = codexText(p.content);
    if (!text || isInjected(text)) return;
    state.turns++;
    state.first ??= oneLine(userPrompt(text) || text);
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

async function allCodex(seen) {
  const names = await codexThreadNames();
  const found = [];
  for await (const file of walk(path.join(CODEX_DIR, "sessions"))) {
    seen.add(file);
    let meta;
    let stat;
    try {
      stat = await fs.promises.stat(file);
      meta = await codexMeta(file, stat);
    } catch {
      continue;
    }
    // 하위 에이전트·검토용 스레드(source가 객체)는 빼고 사용자가 연 세션만 본다.
    if (!meta?.id || typeof meta.source !== "string") continue;
    let entry;
    try {
      entry = await cached(file, codexSummary(meta), stat);
    } catch {
      continue;
    }
    if (!entry) continue;
    const { firstPrompt, ...rest } = entry;
    found.push({ ...rest, title: oneLine(names.get(meta.id) ?? firstPrompt) });
  }
  return found;
}

async function allSessions() {
  const all = [];
  const seen = new Set();
  let complete = true;
  for (const scan of [allClaude, allCodex]) {
    try {
      all.push(...await scan(seen));
    } catch (err) {
      complete = false;
      console.error(`세션 검색 실패: ${err.message}`);
    }
  }
  if (complete) forgetMissing(seen);
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// All callers share one scan and an immutable project index. Cold/expired reads
// await asynchronous I/O; warm reads are index-only. Background callers may
// explicitly accept a stale snapshot while revalidation runs.
let index = null;
let scanFlight = null;

async function buildIndex() {
  await cacheLoad;
  const all = await allSessions();
  const projects = new Map();
  const byProject = new Map();
  const roots = new Map();
  const valid = new Map();
  rootCache.clear();
  for (const session of all) {
    if (typeof session.cwd !== "string" || !session.cwd || samePath(session.cwd, CHAT_DIR) || isInside(session.cwd, CHAT_DIR)) continue;
    let root = roots.get(session.cwd);
    if (!root) { root = await asyncProjectRoot(session.cwd); roots.set(session.cwd, root); }
    const keys = new Set([pathKey(root)]);
    for (let parent = path.dirname(path.resolve(session.cwd)); ; parent = path.dirname(parent)) {
      keys.add(pathKey(parent));
      if (path.dirname(parent) === parent) break;
    }
    for (const key of keys) {
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(session);
    }
    if (!valid.has(root)) valid.set(root, await isProjectDir(root));
    if (!valid.get(root)) continue;
    const key = pathKey(root);
    if (!projects.has(key)) projects.set(key, { path: root, name: path.basename(root), claude: 0, codex: 0, lastActive: session.updatedAt });
    const project = projects.get(key);
    project[session.agent]++;
    if (session.updatedAt > project.lastActive) project.lastActive = session.updatedAt;
  }
  index = { all, byProject, projects: [...projects.values()].sort((a, b) => b.lastActive.localeCompare(a.lastActive)), checkedAt: Date.now() };
  return index;
}

function refreshIndex() {
  if (!scanFlight) scanFlight = buildIndex().finally(() => { scanFlight = null; });
  return scanFlight;
}

async function currentIndex({ fresh = false, stale = false } = {}) {
  if (!index || fresh) return refreshIndex();
  if (Date.now() - index.checkedAt >= DISCOVERY_TTL_MS) {
    if (!stale) return refreshIndex();
    void refreshIndex().catch((error) => console.error(`세션 검색 실패: ${error.message}`));
  }
  return index;
}

// ── 공개 함수 ───────────────────────────────────────────────────
export async function discoverSessions(projectPath, options) {
  return (await currentIndex(options)).byProject.get(pathKey(projectPath))?.slice() ?? [];
}

// Claude Code·Codex의 기록 파일을 지운다. Claude는 같은 이름의 폴더(하위 에이전트·도구 결과)도 함께 지운다.
// 지운 파일 수를 돌려준다. 못 지운 파일(다른 프로그램이 쓰는 중 등)은 errors에 모은다.
export async function deleteSessionRecords(ids) {
  const wanted = new Set(ids.filter(Boolean));
  const result = { deleted: 0, errors: [] };
  if (!wanted.size) return result;
  for (const s of (await currentIndex({ fresh: true })).all) {
    if (!wanted.has(s.agentSessionId)) continue;
    const targets = [s.file];
    if (s.agent === "claude") targets.push(path.join(path.dirname(s.file), s.agentSessionId));
    for (const target of targets) {
      try {
        try { await fs.promises.access(target); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3 });
        summaryCache.delete(target);
        codexMetaCache.delete(target);
        cacheChanged();
        if (target === s.file) result.deleted++;
      } catch (err) {
        result.errors.push(`${target}: ${err.message}`);
      }
    }
  }
  index = null;
  return result;
}

// 세션 기록에 나온 작업 폴더를 프로젝트 단위로 묶는다.
export async function discoverProjects(options) {
  return (await currentIndex(options)).projects.slice();
}

// 화면에 보일 기록과 세션 수명(압축 횟수, 마지막 컨텍스트 크기)
export async function loadHistory(found) {
  let compactions = 0;
  let context = null;
  let skipped = 0;
  let oversized = 0;
  let shortened = 0;
  let bytes = 0;
  const events = [];
  for await (const { compact, context: ctx, oversized: tooLarge, ...e } of found.agent === "claude" ? claudeHistory(found.file) : codexHistory(found.file)) {
    if (tooLarge) { oversized++; continue; }
    if (compact) compactions++;
    if (ctx) context = { ...context, ...ctx };
    if (e.kind === "usage") continue;
    for (const key of ["text", "detail"]) {
      if (typeof e[key] === "string" && e[key].length > HISTORY_TEXT) { e[key] = e[key].slice(0, HISTORY_TEXT) + "\n… (긴 항목 생략)"; shortened++; }
    }
    const size = Buffer.byteLength(JSON.stringify(e));
    events.push({ event: e, size });
    bytes += size;
    while (events.length > MAX_EVENTS || bytes > HISTORY_BYTES) { bytes -= events.shift().size; skipped++; }
  }
  const kept = events.map(({ event }) => event);
  const note = `${found.agent === "claude" ? "Claude Code" : "Codex"}에서 가져온 세션입니다.` +
    (skipped ? ` 앞부분 ${skipped}개 항목은 생략했습니다.` : "") +
    (oversized ? ` 크기 제한을 넘은 기록 줄 ${oversized}개는 생략했습니다.` : "") +
    (shortened ? ` 긴 항목 ${shortened}개는 일부만 가져왔습니다.` : "");
  return {
    events: [{ kind: "status", text: note }, ...kept].map((e, seq) => ({ ...e, seq, ts: e.ts ?? new Date().toISOString() })),
    compactions,
    context,
  };
}

