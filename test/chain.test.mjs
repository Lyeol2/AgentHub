import test from "node:test";
import assert from "node:assert/strict";
import { matches, lastAnswer, handoffText } from "../server/chain.mjs";
import { withRole } from "../server/role.mjs";

const link = (when, extra = {}) => ({ when, enabled: true, keyword: "", ...extra });

test("chain: 조건에 따라 넘길지 정한다", () => {
  assert.equal(matches(link("success"), true, ""), true);
  assert.equal(matches(link("success"), false, ""), false);
  assert.equal(matches(link("error"), false, ""), true);
  assert.equal(matches(link("always"), false, ""), true);
  assert.equal(matches(link("manual"), true, ""), false);
  assert.equal(matches(link("keyword", { keyword: "검토 요청" }), true, "끝. 검토 요청"), true);
  assert.equal(matches(link("keyword", { keyword: "검토 요청" }), true, "끝"), false);
  assert.equal(matches(link("success", { enabled: false }), true, ""), false);
  // 사용자가 멈춘 턴은 넘기지 않는다.
  assert.equal(matches(link("always"), null, ""), false);
});

test("chain: 마지막 요청 이후의 답변만 모은다", () => {
  const session = { events: [
    { kind: "user", text: "1" }, { kind: "text", text: "옛 답" },
    { kind: "user", text: "2" }, { kind: "tool", text: "Bash" }, { kind: "text", text: "가" }, { kind: "text", text: "나" },
  ] };
  assert.equal(lastAnswer(session), "가\n\n나");
});

test("chain: 넘기는 내용에 폴더·파일·답변·지시가 들어간다", () => {
  const text = handoffText(
    { title: "A", agent: "claude", role: "프론트\n자세히", cwd: "C:/w/a", worktree: { branch: "agenthub/a" } },
    { note: "리뷰해" }, "답", "M\tx.js");
  assert.match(text, /보낸 세션: A \(claude\)\n보낸 세션의 역할: 프론트\n/);
  assert.match(text, /작업 폴더: C:\/w\/a \(브랜치 agenthub\/a\)/);
  assert.match(text, /M\tx\.js/);
  assert.ok(text.endsWith("리뷰해"));
});

test("role: 새 대화와 역할을 바꾼 직후에만 붙인다", () => {
  const s = { role: "테스트 담당", agentSessionId: null };
  assert.match(withRole(s, "해"), /^\[이 세션의 역할\]\n테스트 담당/);
  s.agentSessionId = "x";
  assert.equal(withRole(s, "해"), "해");
  s.roleChanged = true;
  assert.match(withRole(s, "해"), /역할이 바뀌었다/);
  assert.equal(withRole(s, "해"), "해");
});
