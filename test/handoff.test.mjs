// handoff MCP 도구: 판정어와 전달할 내용을 알리고, 턴이 끝나면 연결이 그 판정으로 고른다(마지막 줄 판정은 쓰지 않는다).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHandoffTool, handleRpc } from "../server/mcp.mjs";
import { turnHandoff, canonicalVerdict, handoffKeywords, pickLinks } from "../server/policies/workflows.mjs";
import { createHub } from "../server/bootstrap.mjs";

const link = (to, when, keyword = "", extra = {}) => ({ id: `${to}-${when}`, from: "a", to, when, keyword, enabled: true, ...extra });

function toolFor(links) {
  const session = { id: "a", events: [{ kind: "user", text: "일해" }] };
  const tool = createHandoffTool({
    outgoing: () => links, direct: () => links,
    title: (id) => id.toUpperCase(),
    record: (s, event) => s.events.push(event),
  });
  return { tool, session };
}

test("handoff: 판정어 목록을 세션마다 설명에 보이고, 목록에 없는 판정은 거절한다", async () => {
  const { tool, session } = toolFor([link("b", "keyword", "검토 요청"), link("c", "keyword", "수정 필요, 막힘"), link("d", "always")]);
  const listed = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, session, [tool]);
  const description = listed.result.tools[0].description;
  assert.match(description, /"검토 요청"\(→ B\)/);
  assert.match(description, /"수정 필요"\(→ C\), "막힘"\(→ C\)/);
  assert.throws(() => tool.run(session, { verdict: "검토" }), /판정어가 아니다[\s\S]*"검토 요청"/);
  assert.equal(session.events.length, 1, "거절하면 기록하지 않는다");
  const reply = tool.run(session, { verdict: " 검토 요청 ", content: "a.mjs를 고쳤다." });
  assert.match(reply, /판정 "검토 요청" 전달할 내용과 함께 기록했다[\s\S]*"B", "D"/);
  assert.deepEqual(turnHandoff(session), { verdict: "검토 요청", content: "a.mjs를 고쳤다." });
  tool.run(session, { verdict: "막힘" });
  assert.deepEqual(turnHandoff(session), { verdict: "막힘", content: null }, "여러 번 부르면 마지막 것");
  // 판정 없이 부르면 키워드 연결로는 넘어가지 않는다고 알린다.
  assert.match(tool.run(session, { content: "그냥 넘김" }), /판정이 없어 키워드 연결/);
});

test("handoff: 판정 연결이 없으면 내용만 받고, 나가는 연결이 없으면 부르지 말라고 한다", () => {
  const plain = toolFor([link("b", "success")]);
  assert.match(plain.tool.describe(plain.session), /verdict 없이 content만/);
  assert.throws(() => plain.tool.run(plain.session, { verdict: "통과" }), /판정으로 가르는 연결이 없다/);
  assert.match(plain.tool.run(plain.session, { content: "요약" }), /판정 없이 전달할 내용과 함께 기록했다[\s\S]*"B"/);
  const none = toolFor([link("b", "call"), link("c", "keyword", "x", { enabled: false })]);
  assert.match(none.tool.describe(none.session), /부르지 않는다/);
  assert.throws(() => none.tool.run(none.session, {}), /자동으로 넘기는 연결이 없다/);
});

test("handoff: 판정어 비교와 턴 경계", () => {
  assert.deepEqual(handoffKeywords([link("b", "keyword", "통과, 수정 필요"), link("c", "keyword", "통과"), link("d", "success")]), ["통과", "수정 필요"]);
  assert.equal(canonicalVerdict("PASS", ["pass"]), "pass");
  assert.equal(canonicalVerdict("통과함", ["통과"]), null);
  assert.deepEqual(pickLinks([link("b", "keyword", "검토 요청"), link("c", "keyword", "검토")], true, "검토", true).map((l) => l.to), ["c"], "판정어는 키워드와 같아야 맞는다");
  const session = { events: [{ kind: "user", text: "1" }, { kind: "handoff", verdict: "통과" }, { kind: "user", text: "메시지", injected: true }, { kind: "text", text: "끝" }] };
  assert.equal(turnHandoff(session).verdict, "통과", "작업 중에 끼어든 메시지는 턴을 나누지 않는다");
  session.events.push({ kind: "user", text: "다음" });
  assert.equal(turnHandoff(session), null);
});

test("handoff api: MCP로 판정을 알리면 턴이 끝날 때 그 연결로 전달 내용을 넘기고, 요청에 판정어를 안내한다", { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hub = createHub({ port: 0, dataDir: path.join(root, ".data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "demo", path: root }] },
    deps: { cliPaths: () => ({ claude: "claude", codex: "codex" }), discoverProjects: () => [], logger: { log() {} } } });
  await hub.start();
  t.after(() => hub.shutdown());
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/${route}`, { method, headers: { "x-agenthub": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  const a = await api("POST", "sessions", { projectPath: root, agent: "claude", title: "구현" });
  const b = await api("POST", "sessions", { projectPath: root, agent: "claude", title: "리뷰" });
  const c = await api("POST", "sessions", { projectPath: root, agent: "claude", title: "기록" });
  await api("POST", "links", { from: a.id, to: b.id, when: "keyword", keyword: "검토 요청" });
  await api("POST", "links", { from: a.id, to: c.id, when: "keyword", keyword: "막힘" });
  const session = hub.store.get(a.id);
  const input = hub.services.sessions.composeInput(session, "일해");
  assert.match(input, /\[연결로 넘기기\][\s\S]*handoff[\s\S]*"검토 요청"\(→ 리뷰\), "막힘"\(→ 기록\)/);
  assert.doesNotMatch(hub.services.sessions.composeInput(hub.store.get(c.id), "일해"), /\[연결로 넘기기\]/, "나가는 연결이 없으면 붙이지 않는다");

  const rpc = async (body) => (await fetch(`http://127.0.0.1:${hub.port}/mcp/${hub.mcpTokens.token(a.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) })).json();
  const tools = (await rpc({ method: "tools/list" })).result.tools;
  assert.match(tools.find((tool) => tool.name === "handoff").description, /"검토 요청"\(→ 리뷰\)/);
  session.events.push({ kind: "user", text: "일해" }, { kind: "text", text: "작업 과정이 길다.\n\n막힘" });
  const called = await rpc({ method: "tools/call", params: { name: "handoff", arguments: { verdict: "검토 요청", content: "server/x.mjs를 고쳤다. 리뷰해 줘." } } });
  assert.equal(called.result.isError, undefined, called.result.content[0].text);
  assert.equal(session.events.at(-1).kind, "handoff");
  const sent = [];
  hub.runner.send = (target, prompt) => { sent.push([target.id, prompt]); };
  hub.runner.isRunning = () => false;
  await hub.chain.onTurnEnd(session, true);
  assert.deepEqual(sent.map(([id]) => id), [b.id], "답변 끝 줄의 '막힘'이 아니라 handoff 판정으로 고른다");
  assert.match(sent[0][1], /판정: 검토 요청\n\n전달 내용:\nserver\/x\.mjs를 고쳤다/);
  const bad = await rpc({ method: "tools/call", params: { name: "handoff", arguments: { verdict: "끝" } } });
  assert.equal(bad.result.isError, true);
});
