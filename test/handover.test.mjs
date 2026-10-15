import test from "node:test";
import assert from "node:assert/strict";
import { handoverText, mapPermission } from "../server/handover.mjs";

const session = (events, extra = {}) => ({ agent: "claude", model: "opus", cwd: "C:/w/a", worktree: { branch: "agenthub/a" }, events, ...extra });

test("handover: 요청·답변·도구·오류를 정리하고 상태·로그·생각은 뺀다", () => {
  const text = handoverText(session([
    { kind: "user", text: "정렬 버튼을 만들어" },
    { kind: "status", text: "세션 시작" },
    { kind: "thinking", text: "음…" },
    { kind: "tool", text: "Read: src/bag.ts" },
    { kind: "tool_result", text: "파일 내용" },
    { kind: "tool", text: "Bash: npm test" },
    { kind: "tool_result", text: "1 failed", isError: true },
    { kind: "text", text: "버튼을 넣었고 테스트 하나가 깨졌다." },
    { kind: "user", text: "리뷰해 줘", from: "r", fromTitle: "리뷰", message: true },
    { kind: "log", text: "stderr" },
  ]), " M src/bag.ts");
  assert.match(text, /^\[이전 AI에서 이어받은 작업\]/);
  assert.match(text, /지금까지 Claude \(opus\)로 진행했다/);
  assert.match(text, /작업 폴더: C:\/w\/a \(브랜치 agenthub\/a\)/);
  assert.match(text, /바뀐 파일:\n\n M src\/bag\.ts/);
  assert.match(text, /\[사용자\]\n정렬 버튼을 만들어/);
  assert.match(text, /\[도구\] Read: src\/bag\.ts/);
  assert.match(text, /\[도구 오류\] 1 failed/);
  assert.match(text, /\[AI\]\n버튼을 넣었고/);
  assert.match(text, /\[메시지 · 리뷰\]\n리뷰해 줘/);
  assert.doesNotMatch(text, /세션 시작|음…|stderr|파일 내용/);
});

test("handover: 길면 첫 요청은 남기고 가운데 기록을 줄인다", () => {
  const events = [{ kind: "user", text: "처음 목표" }];
  for (let i = 0; i < 40; i++) events.push({ kind: "text", text: `답 ${i} ${"x".repeat(2000)}` });
  const text = handoverText(session(events));
  assert.match(text, /처음 목표/);
  assert.match(text, /중간 기록 \d+건 생략/);
  assert.match(text, /답 39 /); // 가장 최근 기록은 남는다.
  assert.doesNotMatch(text, /답 0 /);
  assert.ok(text.length < 30000);
});

test("handover: 권한은 비슷한 것으로 옮긴다", () => {
  assert.equal(mapPermission("acceptEdits", "codex"), "workspace-write");
  assert.equal(mapPermission("plan", "codex"), "read-only");
  assert.equal(mapPermission("read-only", "claude"), "plan");
  assert.equal(mapPermission("workspace-write", "claude"), "acceptEdits");
  assert.equal(mapPermission("read-only", "claude", { orchestrator: true }), "default");
  assert.equal(mapPermission("default", "codex", { orchestrator: true }), "read-only");
});
