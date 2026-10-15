import test from "node:test";
import assert from "node:assert/strict";
import { composerAction, completionTrigger, applyCompletion, filterCommands, builtinCommand, BUILTIN_COMMANDS } from "../public/composer.js";

test("요청 버튼은 빈 입력의 실행·일시중지 상태에서 제어 동작을 고른다", () => {
  assert.equal(composerAction({ state: "running" }, " \n").action, "pause");
  assert.equal(composerAction({ state: "paused" }).action, "resume");
  assert.equal(composerAction({ state: "idle" }).disabled, true);
  assert.equal(composerAction(null).disabled, true);
});

test("입력한 요청은 실행 중에는 대기열로, 일시중지 중에는 재개하며 보낸다", () => {
  for (const state of ["idle", "paused", "error", "interrupted"]) {
    const action = composerAction({ state }, "새 요청");
    assert.equal(action.action, "send");
    assert.equal(action.disabled, false);
  }
  assert.equal(composerAction({ state: "running" }, "새 요청").action, "queue");
  assert.equal(composerAction(null, "새 채팅").action, "send");
});

test("일시중지 종료 대기 중 빈 버튼은 잠기고 새 요청은 대기열에 넣을 수 있다", () => {
  const stopping = { state: "running", paused: true };
  assert.equal(composerAction(stopping).action, "pausing");
  assert.equal(composerAction(stopping).disabled, true);
  assert.equal(composerAction(stopping, "추가 요청").action, "queue");
  assert.equal(composerAction(stopping, "추가 요청").disabled, false);
});

test("자동 완성은 요청 맨 앞의 /와 공백 뒤의 @에서만 열린다", () => {
  assert.deepEqual(completionTrigger("/co"), { type: "command", query: "co", start: 0, end: 3 });
  assert.equal(completionTrigger("요청 /co"), null);
  assert.deepEqual(completionTrigger("봐 @src/a"), { type: "file", query: "src/a", start: 2, end: 8 });
  assert.equal(completionTrigger("me@mail.com"), null);
  assert.equal(completionTrigger("@src/a 다음", 6).query, "src/a");
});

test("고른 항목으로 커서의 낱말을 바꾸고 폴더는 이어서 고를 수 있게 둔다", () => {
  assert.deepEqual(applyCompletion("/co", completionTrigger("/co"), "code-review"), { text: "/code-review ", caret: 13 });
  assert.deepEqual(applyCompletion("@sr 다음", completionTrigger("@sr", 3), "src/"), { text: "@src/ 다음", caret: 5 });
  assert.equal(applyCompletion("@my", completionTrigger("@my"), "my notes.md").text, '@"my notes.md" ');
  assert.deepEqual(filterCommands([{ name: "issue-fix", description: "" }, { name: "fix-all", description: "" }], "fix").map((c) => c.name), ["fix-all", "issue-fix"]);
  assert.equal(builtinCommand(" /clear "), "clear");
  assert.equal(builtinCommand("/clear 지금"), null);
  assert.equal(builtinCommand("/code-review"), null);
  assert.deepEqual(BUILTIN_COMMANDS.map((c) => c.name), ["clear", "export", "import"]);
});
