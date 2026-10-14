import test from "node:test";
import assert from "node:assert/strict";
import { extractPlan, normalizePlan, orchestratorInput } from "../server/orchestrator.mjs";
import { parseHubFile, HUB_TEMPLATE } from "../server/hubfile.mjs";

const hub = parseHubFile(HUB_TEMPLATE);
const sessions = [
  { id: "orc", title: "지휘", agent: "claude", state: "idle" },
  { id: "old", title: "기존 구현", agent: "claude", roleName: "구현", state: "idle" },
];
const ctx = { hub, sessions, orchestratorId: "orc" };

test("orchestrator: 마지막 계획 블록을 꺼낸다", () => {
  assert.equal(extractPlan("계획 없음"), null);
  const text = "초안\n```agenthub-plan\n{\"send\":[]}\n```\n수정\n```agenthub-plan\n{\"links\":[1]}\n```";
  assert.deepEqual(extractPlan(text).plan, { links: [1] });
  assert.match(extractPlan("```agenthub-plan\n{틀림}\n```").error, /JSON/);
});

test("orchestrator: 역할 템플릿과 key·id·orchestrator를 풀어 쓴다", () => {
  const plan = normalizePlan({
    sessions: [
      { key: "ui", role: "구현", title: "정렬 UI", prompt: "만들어" },
      { key: "rev", role: "리뷰" },
      { key: "doc", agent: "codex", roleText: "문서만", isolate: false },
    ],
    links: [
      { from: "ui", to: "rev", when: "keyword", keyword: "검토 요청" },
      { from: "rev", to: "orchestrator", when: "always" },
    ],
    send: [{ to: "old", prompt: "이어서" }],
  }, ctx);
  const [ui, rev, doc] = plan.sessions;
  assert.deepEqual([ui.agent, ui.permission, ui.isolate, ui.roleName, ui.title], ["claude", "acceptEdits", true, "구현", "정렬 UI"]);
  assert.deepEqual([rev.agent, rev.permission, rev.isolate, rev.title], ["codex", "read-only", false, "리뷰"]);
  assert.deepEqual([doc.agent, doc.permission, doc.roleText, doc.isolate], ["codex", "workspace-write", "문서만", false]);
  assert.deepEqual(plan.links.map((l) => `${l.from}>${l.to}`), ["ui>rev", "rev>orc"]);
  assert.deepEqual(plan.send, [{ to: "old", prompt: "이어서" }, { to: "ui", prompt: "만들어" }]);
});

test("orchestrator: 잘못된 계획을 막는다", () => {
  const bad = (raw, re) => assert.throws(() => normalizePlan(raw, ctx), re);
  bad({ sessions: [{ key: "a", role: "없는역할" }] }, /역할 "없는역할"/);
  bad({ sessions: [{ key: "a" }, { key: "a" }] }, /겹칩니다/);
  bad({ sessions: [{ key: "a", agent: "codex", permission: "plan" }] }, /권한/);
  bad({ links: [{ from: "old", to: "nope" }] }, /"nope"/);
  bad({ links: [{ from: "old", to: "orchestrator", when: "keyword" }] }, /keyword/);
  bad({ send: [{ to: "orchestrator", prompt: "x" }] }, /자신/);
  bad({ sessions: [{ key: "x", id: "ghost" }] }, /없습니다/);
  bad({}, /할 일이 없습니다/);
});

test("orchestrator: 첫 요청에만 지휘 규칙을 붙이고, 매번 세션 상태를 붙인다", () => {
  const first = orchestratorInput({ id: "orc", role: "" }, "목표", { hub, sessions });
  assert.match(first, /^\[AgentHub 오케스트레이터\]/);
  assert.match(first, /- 구현: claude · acceptEdits/);
  assert.match(first, /- old · 기존 구현 · claude · 역할 구현 · 대기/);
  assert.doesNotMatch(first, /- orc ·/);
  assert.ok(first.endsWith("[요청]\n목표"));
  const next = orchestratorInput({ id: "orc", agentSessionId: "x" }, "결과", { hub, sessions });
  assert.match(next, /^\[현재 세션\]\n- old/);
  assert.doesNotMatch(next, /오케스트레이터\]/);
  assert.ok(next.endsWith("결과"));
});

test("orchestrator: 새 세션의 prompt는 요청으로 한 번만 들어간다", () => {
  const raw = { sessions: [{ key: "ui", role: "구현", prompt: "만들어" }] };
  assert.equal(normalizePlan(raw, ctx).send.length, 1);
  assert.equal(normalizePlan(raw, ctx).send.length, 1); // 원본을 바꾸지 않는다.
});
