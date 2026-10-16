import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createHub } from "../server/bootstrap.mjs";

// AI 대신 정해 둔 답을 돌려준다. 받은 프롬프트는 asked에 남긴다.
async function hub(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthub-assistant-"));
  const projectPath = path.join(root, "project");
  await mkdir(projectPath);
  const asked = [];
  let answer = "{}";
  const instance = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false,
    deps: { ask: async ({ prompt }) => { asked.push(prompt); return typeof answer === "function" ? answer() : answer; } } });
  if (instance.runner) instance.runner.send = () => { throw new Error("Assistant fixture must not run an agent"); };
  await instance.start();
  t.after(async () => { await instance.shutdown(); await rm(root, { recursive: true, force: true }); });
  async function request(method, pathname, body) {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api${pathname}`, { method,
      headers: { "Content-Type": "application/json", "X-AgentHub": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  async function api(method, pathname, body) {
    const response = await request(method, pathname, body);
    assert.ok(response.status < 300, `${method} ${pathname}: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  }
  const graph = async () => ({
    sessions: (await api("GET", "/sessions")).filter((s) => s.projectPath && path.resolve(s.projectPath) === path.resolve(projectPath)),
    commands: (await api("GET", `/commands?path=${encodeURIComponent(projectPath)}`)).commands,
    links: await api("GET", "/links"),
  });
  return { projectPath, asked, request, api, graph, answer: (value) => { answer = typeof value === "string" || typeof value === "function" ? value : JSON.stringify(value); } };
}

test("flow assistant: previews AI actions against the graph and applies them through the normal services", async (t) => {
  const h = await hub(t);
  const impl = await h.api("POST", "/sessions", { projectPath: h.projectPath, agent: "claude", title: "구현" });
  h.answer(`설명 문장은 무시한다.\n${JSON.stringify({ summary: "리뷰와 테스트를 붙입니다.", actions: [
    { type: "set_role", target: impl.id, roleName: "구현", role: "기능을 구현한다. 끝나면 마지막 줄에 '검토 요청'만 쓴다." },
    { type: "create_session", key: "rev", title: "리뷰", agent: "codex", permission: "read-only", role: "코드를 고치지 않고 검토한다." },
    { type: "create_node", key: "test", kind: "command", title: "테스트", command: "npm test" },
    { type: "link", from: impl.id, to: "rev", when: "keyword", keyword: "검토 요청" },
    { type: "link", from: "rev", to: "test" },
  ] })}`);

  const planned = await h.api("POST", "/flow-assistant/plan", { projectPath: h.projectPath, prompt: "구현 뒤에 리뷰랑 테스트 붙여 줘", selected: [impl.id] });
  assert.equal(planned.summary, "리뷰와 테스트를 붙입니다.");
  assert.deepEqual(planned.actions.map((a) => a.type), ["set_role", "create_session", "create_node", "link", "link"]);
  assert.match(planned.actions[1].text, /새 세션 "리뷰".*Codex.*read-only/);
  assert.match(planned.actions[3].text, /"구현" → "리뷰" 연결 \(키워드가 있으면: 검토 요청\)/);
  // AI는 지금 그래프와 선택한 노드를 보고, 사용자 요청을 받는다.
  assert.match(h.asked[0], new RegExp(`${impl.id} · 세션 "구현"`));
  assert.match(h.asked[0], new RegExp(`\\[사용자가 선택한 노드\\]\\n${impl.id}`));
  assert.match(h.asked[0], /사용자 요청: 구현 뒤에 리뷰랑 테스트 붙여 줘/);
  assert.equal((await h.graph()).sessions.length, 1, "planning alone changes nothing");

  const applied = await h.api("POST", "/flow-assistant/apply", { projectPath: h.projectPath, actions: planned.actions });
  assert.equal(applied.done.length, 5);
  assert.equal(applied.created.length, 2);
  const after = await h.graph();
  const review = after.sessions.find((s) => s.title === "리뷰");
  const updated = after.sessions.find((s) => s.id === impl.id);
  const testNode = after.commands.find((c) => c.title === "테스트");
  assert.equal(review.agent, "codex");
  assert.equal(review.permission, "read-only");
  assert.equal(updated.roleName, "구현");
  assert.match(updated.role, /검토 요청/);
  assert.equal(testNode.command, "npm test");
  assert.ok(after.links.some((l) => l.from === impl.id && l.to === review.id && l.when === "keyword" && l.keyword === "검토 요청"));
  assert.ok(after.links.some((l) => l.from === review.id && l.to === testNode.id && l.when === "success"));

  // 이미 이어진 두 노드를 다시 이으면 새로 만들지 않고 조건을 고친다.
  await h.api("POST", "/flow-assistant/apply", { projectPath: h.projectPath, actions: [{ type: "link", from: impl.id, to: review.id, when: "always" }] });
  const relinked = (await h.graph()).links.filter((l) => l.from === impl.id && l.to === review.id);
  assert.equal(relinked.length, 1);
  assert.equal(relinked[0].when, "always");
});

test("flow assistant: rejects unusable answers and actions without changing the graph", async (t) => {
  const h = await hub(t);
  const button = await h.api("POST", "/commands", { projectPath: h.projectPath, kind: "button", prompt: "시작" });
  const session = await h.api("POST", "/sessions", { projectPath: h.projectPath, agent: "claude", title: "작업" });
  const plan = (prompt = "해 줘") => h.request("POST", "/flow-assistant/plan", { projectPath: h.projectPath, prompt });

  h.answer("JSON이 아닌 답");
  assert.equal((await plan()).status, 422);
  h.answer({ actions: [{ type: "link", from: session.id, to: button.id }] });
  const sourceOnly = await plan();
  assert.equal(sourceOnly.status, 422);
  assert.match(sourceOnly.body.error, /시작점/);
  h.answer({ actions: [{ type: "create_node", key: "g", kind: "git", branch: "main" }] });
  assert.equal((await plan()).status, 422);
  h.answer({ actions: [{ type: "set_role", target: button.id, role: "x" }] });
  assert.equal((await plan()).status, 422);
  h.answer({ actions: [{ type: "delete", target: session.id }] });
  assert.equal((await plan()).status, 422);
  assert.equal((await plan("   ")).status, 400);

  for (const actions of [[{ type: "link", from: session.id, to: "missing" }], [{ type: "create_session", key: "x", agent: "gpt" }], [{ type: "create_node", key: "c", kind: "command" }]]) {
    assert.equal((await h.request("POST", "/flow-assistant/apply", { projectPath: h.projectPath, actions })).status, 400);
  }
  const after = await h.graph();
  assert.equal(after.sessions.length, 1);
  assert.equal(after.commands.length, 1);
  assert.equal(after.links.length, 0);
});

test("flow assistant: creates disabled schedules with validated timing and source-only links", async (t) => {
  const h = await hub(t);
  const session = await h.api("POST", "/sessions", { projectPath: h.projectPath, agent: "claude", title: "예약 작업" });
  h.answer({ summary: "시간 예약을 연결합니다.", actions: [
    { type: "create_node", key: "daily", kind: "schedule", title: "매일 검사", scheduleMode: "daily", timeOfDay: "09:30", prompt: "검사를 시작하세요." },
    { type: "create_node", key: "once", kind: "schedule", title: "한 번 검사", scheduleMode: "once", runAt: "2099-01-01T00:00:00.000Z" },
    { type: "create_node", key: "interval", kind: "schedule", title: "정기 검사", scheduleMode: "interval", intervalMinutes: 30 },
    { type: "link", from: "daily", to: session.id },
  ] });
  const planned = await h.api("POST", "/flow-assistant/plan", { projectPath: h.projectPath, prompt: "매일 오전 9시 반에 검사를 시작해 줘" });
  assert.match(planned.actions[0].text, /새 시간 예약/);
  assert.equal((await h.graph()).commands.length, 0);
  for (const pattern of [/현재 서버 시각:.*서버 시간대/, /scheduleMode/, /once\|daily\|interval/, /timeOfDay/, /intervalMinutes/, /scheduleEnabled·nextRunAt은 지정하지 않는다/]) assert.match(h.asked[0], pattern);
  await h.api("POST", "/flow-assistant/apply", { projectPath: h.projectPath, actions: planned.actions });
  const graph = await h.graph();
  assert.equal(graph.commands.length, 3);
  for (const command of graph.commands) {
    assert.equal(command.kind, "schedule");
    assert.equal(command.scheduleEnabled, false);
    assert.equal(command.nextRunAt, null);
  }
  const daily = graph.commands.find(item => item.title === "매일 검사");
  assert.equal(daily.timeOfDay, "09:30");
  assert.equal(daily.prompt, "검사를 시작하세요.");
  assert.ok(graph.links.some(item => item.from === daily.id && item.to === session.id));
  h.answer({ actions: [{ type: "link", from: session.id, to: daily.id }] });
  const incoming = await h.request("POST", "/flow-assistant/plan", { projectPath: h.projectPath, prompt: "작업에서 예약으로 연결" });
  assert.equal(incoming.status, 422);
  assert.match(incoming.body.error, /시작점/);
  assert.match(h.asked.at(-1), /시간 예약 "매일 검사"/);
  h.answer({ actions: [{ type: "create_node", key: "bad", kind: "schedule", scheduleMode: "daily", timeOfDay: "25:00" }] });
  assert.equal((await h.request("POST", "/flow-assistant/plan", { projectPath: h.projectPath, prompt: "잘못된 시간" })).status, 422);
  assert.equal((await h.graph()).commands.length, 3);
});
