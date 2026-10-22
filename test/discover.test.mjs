// CLI 기록 검색: 임시 Claude·Codex 기록 폴더에서 세션 요약과 갱신을 확인한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-discover-"));
test.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }));
const claudeDir = path.join(temp, "claude");
const codexDir = path.join(temp, "codex");
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.CODEX_HOME = codexDir;

const project = path.join(temp, "repo");
fs.mkdirSync(path.join(project, ".git"), { recursive: true });
const claudeFolder = path.join(claudeDir, "projects", "E--repo");
const codexFolder = path.join(codexDir, "sessions", "2026", "10", "17");
fs.mkdirSync(claudeFolder, { recursive: true });
fs.mkdirSync(codexFolder, { recursive: true });

const line = (value) => JSON.stringify(value) + "\n";
const claudeUser = (text, extra = {}) => line({ type: "user", cwd: project, message: { role: "user", content: text }, ...extra });
const codexUser = (text) => line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const codexMeta = (id, source = "cli") => line({ type: "session_meta", payload: { id, cwd: project, source } });
const load = (tag) => import(`../server/discover.mjs?${tag}`);
const brief = (list) => list.map(({ agent, agentSessionId, title, turns, cwd }) => ({ agent, agentSessionId, title, turns, cwd }))
  .sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId));

const claudeFile = path.join(claudeFolder, "c1.jsonl");
const codexFile = path.join(codexFolder, "rollout-x1.jsonl");
fs.writeFileSync(claudeFile, claudeUser("<system-reminder>무시</system-reminder>") + claudeUser("첫 요청") + claudeUser("곁가지", { isSidechain: true }));
fs.writeFileSync(path.join(claudeFolder, "empty.jsonl"), line({ type: "summary" }));
fs.writeFileSync(codexFile, codexMeta("x1") + codexUser("코덱스 요청") + line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "답" }] } }));
fs.writeFileSync(path.join(codexFolder, "rollout-sub.jsonl"), codexMeta("sub", { subagent: "review" }) + codexUser("하위 에이전트"));
fs.writeFileSync(path.join(codexDir, "session_index.jsonl"), line({ id: "x1", thread_name: "이름 붙인 스레드" }));

test("discover: Claude·Codex 기록을 요약하고, 덧붙인 줄과 다시 쓴 파일을 반영한다", async () => {
  const discover = await load("a");
  assert.deepEqual(brief(await discover.discoverSessions(project, { fresh: true })), [
    { agent: "claude", agentSessionId: "c1", title: "첫 요청", turns: 1, cwd: project },
    { agent: "codex", agentSessionId: "x1", title: "이름 붙인 스레드", turns: 1, cwd: project },
  ]);

  // 기록이 자라면 늘어난 요청과 나중에 붙은 제목을 반영한다. 줄바꿈 없이 끝난 마지막 줄도 센다.
  fs.appendFileSync(claudeFile, claudeUser("두 번째 요청") + line({ type: "custom-title", customTitle: "새 제목" }));
  fs.appendFileSync(codexFile, codexUser("코덱스 두 번째") + codexUser("세 번째").trimEnd());
  assert.deepEqual(brief(await discover.discoverSessions(project, { fresh: true })).map((s) => [s.title, s.turns]), [["새 제목", 2], ["이름 붙인 스레드", 3]]);

  // 줄바꿈이 붙어 마지막 줄이 완성돼도 같은 요청을 두 번 세지 않는다.
  fs.appendFileSync(codexFile, "\n");
  assert.equal(brief(await discover.discoverSessions(project, { fresh: true }))[1].turns, 3);

  // 앞부분부터 다시 쓴 파일은 처음부터 다시 읽는다.
  fs.writeFileSync(claudeFile, claudeUser("완전히 다른 첫 요청이며 더 길게 씁니다") + claudeUser("둘") + claudeUser("셋") + claudeUser("넷"));
  assert.deepEqual(brief(await discover.discoverSessions(project, { fresh: true }))[0], { agent: "claude", agentSessionId: "c1", title: "완전히 다른 첫 요청이며 더 길게 씁니다", turns: 4, cwd: project });

  // 줄어든 파일도 처음부터 다시 읽는다.
  fs.writeFileSync(claudeFile, claudeUser("짧게"));
  assert.deepEqual(brief(await discover.discoverSessions(project, { fresh: true }))[0].turns, 1);
  assert.equal(brief(await discover.discoverSessions(project, { fresh: true }))[0].title, "짧게");
});

test("discover: 저장한 요약으로 다시 시작해도 같은 결과를 내고 늘어난 부분만 이어 읽는다", async (t) => {
  const first = await load("b");
  if (typeof first.useDiscoverCache !== "function") return t.skip("요약 저장을 지원하지 않는 버전");
  const cacheFile = path.join(temp, "data", "discover-cache.json");
  fs.mkdirSync(path.dirname(cacheFile)); // 서버는 시작할 때 데이터 폴더를 만든다.
  first.useDiscoverCache(cacheFile);
  fs.appendFileSync(codexFile, line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "x".repeat(100_000) }] } }));
  const before = brief(await first.discoverSessions(project, { fresh: true }));
  await first.flushDiscoverCache();
  assert.ok(fs.existsSync(cacheFile));

  // 새 모듈 인스턴스는 재시작한 서버와 같다. 저장한 요약을 쓰면 기록 파일을 처음부터 읽지 않는다.
  const second = await load("c");
  second.useDiscoverCache(cacheFile);
  const open = fs.promises.open;
  let bytes = 0;
  fs.promises.open = async function (...args) {
    const handle = await open.apply(this, args);
    const read = handle.read;
    handle.read = async function (...values) { const result = await read.apply(this, values); bytes += result.bytesRead; return result; };
    return handle;
  };
  try {
    assert.deepEqual(brief(await second.discoverSessions(project, { fresh: true })), before);
    fs.appendFileSync(codexFile, codexUser("재시작 뒤 요청"));
    assert.equal(brief(await second.discoverSessions(project, { fresh: true }))[1].turns, before[1].turns + 1);
  } finally { fs.promises.open = open; }
  assert.ok(bytes < fs.statSync(codexFile).size, `이어 읽은 바이트 ${bytes}`);

  // 깨진 요약 파일은 무시하고 기록에서 다시 만든다.
  fs.writeFileSync(cacheFile, "{깨짐");
  const third = await load("d");
  third.useDiscoverCache(cacheFile);
  assert.deepEqual(brief(await third.discoverSessions(project, { fresh: true })).map((s) => s.turns), [1, before[1].turns + 1]);
});

test("discover: concurrent cold requests share one async scan and warm project lookups do no I/O", async (t) => {
  const discover = await load("indexed");
  const counts = new Map();
  const readdir = fs.promises.readdir;
  t.mock.method(fs.promises, "readdir", async function (directory, ...options) {
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
    return readdir.call(this, directory, ...options);
  });
  for (const name of ["readdirSync", "statSync", "readFileSync", "openSync", "existsSync"]) {
    t.mock.method(fs, name, () => { throw new Error("synchronous discovery I/O: " + name); });
  }
  const [sessions, other] = await Promise.all([discover.discoverSessions(project), discover.discoverSessions(project), discover.discoverProjects()]);
  assert.deepEqual(sessions, other);
  assert.ok(sessions.length >= 2);
  assert.ok(counts.size > 0);
  assert.ok([...counts.values()].every(count => count === 1));
  const scanned = [...counts];
  await discover.discoverSessions(project);
  await discover.discoverSessions(path.join(project, "missing"));
  await discover.discoverProjects();
  assert.deepEqual([...counts], scanned);
});

test("discover: history streams keep the newest 400 events and earlier lifetime metadata", async (t) => {
  const discover = await load("bounded-history");
  const file = path.join(temp, "history.jsonl");
  const contents = [line({ type: "system", subtype: "compact_boundary" }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "before" }], usage: { input_tokens: 75 } } })];
  for (let i = 0; i < 1000; i++) contents.push(claudeUser("request " + i));
  fs.writeFileSync(file, contents.join(""));
  t.mock.method(fs, "readFileSync", () => { throw new Error("history must not load the whole file"); });
  const history = await discover.loadHistory({ agent: "claude", file });
  assert.equal(history.events.length, 401);
  assert.equal(history.events[1].text, "request 600");
  assert.equal(history.events.at(-1).text, "request 999");
  assert.equal(history.events.at(-1).seq, 400);
  assert.equal(history.compactions, 1);
  assert.equal(history.context.used, 75);
  assert.match(history.events[0].text, /602/);
});

test("discover: an expired lookup awaits refreshed records and deletion invalidates the index", async t => {
  const discover = await load("expiry");
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const file = path.join(claudeFolder, "expire.jsonl");
  fs.writeFileSync(file, claudeUser("first"));
  assert.equal((await discover.discoverSessions(project)).find(s => s.agentSessionId === "expire").turns, 1);
  fs.appendFileSync(file, claudeUser("second"));
  assert.equal((await discover.discoverSessions(project)).find(s => s.agentSessionId === "expire").turns, 1);
  clock += discover.DISCOVERY_TTL_MS + 1;
  assert.equal((await discover.discoverSessions(project)).find(s => s.agentSessionId === "expire").turns, 2);
  const deleted = await discover.deleteSessionRecords(["expire"]);
  assert.equal(deleted.deleted, 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await discover.discoverSessions(project)).some(s => s.agentSessionId === "expire"), false);
});

test("discover: history also bounds retained bytes and handles complete records without a final newline", async () => {
  const discover = await load("history-bytes");
  const file = path.join(temp, "large-history.jsonl");
  const records = Array.from({ length: 60 }, (_, i) => codexUser(String(i) + "x".repeat(200_000)));
  fs.writeFileSync(file, records.join("") + codexUser("last request").trimEnd());
  const history = await discover.loadHistory({ agent: "codex", file });
  assert.ok(history.events.length < 61);
  assert.ok(Buffer.byteLength(JSON.stringify(history.events)) < (8 << 20) + 100_000);
  assert.equal(history.events.at(-1).text, "last request");
  assert.match(history.events[0].text, /생략/);
});
