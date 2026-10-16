import test from "node:test";
import assert from "node:assert/strict";
import { extractPlan, normalizePlan, orchestratorInput } from "../server/orchestrator.mjs";

const sessions = [
  { id: "orc", title: "지휘", agent: "claude", state: "idle" },
  { id: "old", title: "기존 구현", agent: "claude", roleName: "구현", state: "idle" },
];
const ctx = { sessions, orchestratorId: "orc" };

test("orchestrator: 마지막 계획 블록을 꺼낸다", () => {
  assert.equal(extractPlan("계획 없음"), null);
  const text = "초안\n```agenthub-plan\n{\"send\":[]}\n```\n수정\n```agenthub-plan\n{\"links\":[1]}\n```";
  assert.deepEqual(extractPlan(text).plan, { links: [1] });
  assert.match(extractPlan("```agenthub-plan\n{틀림}\n```").error, /JSON/);
});

test("orchestrator: 새 세션 설정과 key·id·orchestrator를 풀어 쓴다", () => {
  const plan = normalizePlan({
    sessions: [
      { key: "ui", title: "정렬 UI", roleText: "구현한다", prompt: "만들어" },
      { key: "rev", agent: "codex", permission: "read-only" },
      { key: "doc", agent: "codex", roleText: "문서만", isolate: false },
    ],
    links: [
      { from: "ui", to: "rev", when: "keyword", keyword: "검토 요청" },
      { from: "rev", to: "orchestrator", when: "always" },
    ],
    send: [{ to: "old", prompt: "이어서" }],
  }, ctx);
  const [ui, rev, doc] = plan.sessions;
  assert.deepEqual([ui.agent, ui.permission, ui.isolate, ui.roleText, ui.title], ["claude", "acceptEdits", false, "구현한다", "정렬 UI"]);
  assert.deepEqual([rev.agent, rev.permission, rev.isolate, rev.title], ["codex", "read-only", false, "rev"]);
  assert.deepEqual([doc.agent, doc.permission, doc.roleText, doc.isolate], ["codex", "workspace-write", "문서만", false]);
  assert.deepEqual(plan.links.map((l) => `${l.from}>${l.to}`), ["ui>rev", "rev>orc"]);
  assert.deepEqual(plan.send, [{ to: "old", prompt: "이어서" }, { to: "ui", prompt: "만들어" }]);
});

test("orchestrator: 워크트리는 명시 선택과 필수 이름을 요구한다", () => {
  const raw = { sessions: [
    { key: "plain" },
    { key: "explicit", agent: "codex", isolate: true, worktreeName: " bag-ui " },
    { key: "override", isolate: false, worktreeName: "ignored" },
    { key: "string", isolate: "true", worktreeName: "ignored" },
  ] };
  const plan = normalizePlan(raw, ctx);
  assert.deepEqual(plan.sessions.map((session) => [session.isolate, session.worktreeName]), [[false, ""], [true, "bag-ui"], [false, ""], [false, ""]]);
  assert.equal(raw.sessions[1].worktreeName, " bag-ui ");
  for (const worktreeName of [undefined, "", " ", "../x"]) {
    assert.throws(() => normalizePlan({ sessions: [{ key: "a", isolate: true, worktreeName }] }, ctx), /워크트리 이름/);
  }
  assert.throws(() => normalizePlan({ sessions: [
    { key: "a", isolate: true, worktreeName: "Feature" },
    { key: "b", isolate: true, worktreeName: "feature" },
  ] }, ctx), /이름이 겹칩니다/);
  const input = orchestratorInput({ id: "orc" }, "목표", { sessions });
  assert.match(input, /새 세션의 기본은 프로젝트 원본 폴더/);
  assert.match(input, /worktreeName.*필수 이름/);
});

test("orchestrator: 잘못된 계획을 막는다", () => {
  const bad = (raw, re) => assert.throws(() => normalizePlan(raw, ctx), re);
  bad({ sessions: [{ key: "a" }, { key: "a" }] }, /겹칩니다/);
  bad({ sessions: [{ key: "a", agent: "codex", permission: "plan" }] }, /권한/);
  bad({ links: [{ from: "old", to: "nope" }] }, /"nope"/);
  bad({ links: [{ from: "old", to: "orchestrator", when: "keyword" }] }, /keyword/);
  bad({ send: [{ to: "orchestrator", prompt: "x" }] }, /자신/);
  bad({ sessions: [{ key: "x", id: "ghost" }] }, /없습니다/);
  bad({}, /할 일이 없습니다/);
});

test("orchestrator: 첫 요청에만 지휘 규칙을 붙이고, 매번 세션 상태를 붙인다", () => {
  const first = orchestratorInput({ id: "orc", role: "" }, "목표", { sessions });
  assert.match(first, /^\[AgentHub 오케스트레이터\]/);
  assert.match(first, /- old · 기존 구현 · claude · 역할 구현 · 대기/);
  assert.doesNotMatch(first, /- orc ·/);
  assert.ok(first.endsWith("\n\n목표"));
  const next = orchestratorInput({ id: "orc", agentSessionId: "x" }, "결과", { sessions });
  assert.match(next, /^\[현재 세션\]\n- old/);
  assert.doesNotMatch(next, /오케스트레이터\]/);
  assert.ok(next.endsWith("결과"));
});

test("orchestrator: 새 세션의 prompt는 요청으로 한 번만 들어간다", () => {
  const raw = { sessions: [{ key: "ui", prompt: "만들어" }] };
  assert.equal(normalizePlan(raw, ctx).send.length, 1);
  assert.equal(normalizePlan(raw, ctx).send.length, 1); // 원본을 바꾸지 않는다.
});
