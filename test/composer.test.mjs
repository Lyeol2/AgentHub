import test from "node:test";
import assert from "node:assert/strict";
import { composerAction, completionTrigger, applyCompletion, filterCommands, builtinCommand, refToken, refMatches, expandRefs, BUILTIN_COMMANDS } from "../public/composer.js";

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

test("@ 검색어는 띄어쓰기를 넣어도 이어지고 줄이 바뀌거나 80자를 넘으면 끝난다", () => {
  assert.deepEqual(completionTrigger("봐 @my notes"), { type: "file", query: "my notes", start: 2, end: 11 });
  assert.equal(completionTrigger("@my ").query, "my");
  assert.deepEqual(completionTrigger('@"작업/시각 개'), { type: "file", query: "작업/시각 개", start: 0, end: 9 });
  assert.equal(completionTrigger("@ "), null);
  assert.equal(completionTrigger('@"done" 다음'), null);
  assert.equal(completionTrigger("@src\n다음"), null);
  assert.equal(completionTrigger(`@${"a".repeat(80)}`).query.length, 80);
  assert.equal(completionTrigger(`@${"a".repeat(81)}`), null);
  const spaced = completionTrigger("@my no");
  assert.equal(applyCompletion("@my no", spaced, "my notes.md").text, '@"my notes.md" ');
});

test("고른 항목으로 커서의 낱말을 바꾸고 폴더는 이어서 고를 수 있게 둔다", () => {
  assert.deepEqual(applyCompletion("/co", completionTrigger("/co"), "code-review"), { text: "/code-review ", caret: 13 });
  assert.deepEqual(applyCompletion("@sr 다음", completionTrigger("@sr", 3), "src/"), { text: "@src/ 다음", caret: 5 });
  assert.equal(applyCompletion("@my", completionTrigger("@my"), "my notes.md").text, '@"my notes.md" ');
  assert.deepEqual(filterCommands([{ name: "issue-fix", description: "" }, { name: "fix-all", description: "" }], "fix").map((c) => c.name), ["fix-all", "issue-fix"]);
  assert.equal(builtinCommand(" /clear "), "clear");
  assert.equal(builtinCommand("/clear 지금"), null);
  assert.equal(builtinCommand("/code-review"), null);
  assert.equal(builtinCommand("/plan"), null, "/plan은 요청과 함께 보내는 명령이다");
  assert.deepEqual(BUILTIN_COMMANDS.map((c) => c.name), ["plan", "mcp", "clear", "export", "import"]);
});

test("/mcp는 단독 입력일 때만 직접 실행하고 자동 완성에서도 기본 명령으로 찾는다", () => {
  assert.equal(builtinCommand("/mcp"), "mcp");
  assert.equal(builtinCommand(" \n/mcp \n"), "mcp");
  for (const text of ["/mcp 설정 설명", "설명 /mcp", "/mcp-server", "/mcp\n다음 요청"]) assert.equal(builtinCommand(text), null);
  const commands = filterCommands(BUILTIN_COMMANDS, "mc");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "mcp");
  assert.equal(commands[0].builtin, true);
  assert.ok(!commands[0].prompt);
});

test("고른 파일은 파일 이름으로 줄여 보이고 보낼 때 전체 경로로 되돌린다", () => {
  const refs = new Map();
  assert.equal(refToken("public/features/git/view.js", refs), "view.js");
  refs.set("view.js", "public/features/git/view.js");
  assert.equal(refToken("public/features/git/view.js", refs), "view.js");
  assert.equal(refToken("public/features/graph/view.js", refs), "graph/view.js");
  refs.set("graph/view.js", "public/features/graph/view.js");
  refs.set("my notes.md", "docs/my notes.md");
  const text = '@view.js 와 @graph/view.js, @"my notes.md" 그리고 메일@view.js @view.jsx';
  assert.deepEqual(refMatches(text, refs).map((m) => m.token), ["view.js", "graph/view.js", "my notes.md"]);
  assert.equal(expandRefs("@view.js 고치고 @graph/view.js 보기\n@\"my notes.md\"", refs),
    '@public/features/git/view.js 고치고 @public/features/graph/view.js 보기\n@"docs/my notes.md"');
  assert.equal(expandRefs("참조 없음", new Map()), "참조 없음");
});

test("고른 참조 뒤에 조사를 붙여도 참조로 남고, 공백 있는 이름은 따옴표 없이 보인다", () => {
  const refs = new Map();
  const token = refToken("Assets/UI/Tutorial Canvas.prefab", refs);
  assert.equal(token, "Tutorial Canvas.prefab");
  refs.set(token, "Assets/UI/Tutorial Canvas.prefab");
  refs.set("app.js", "src/app.js");
  const text = `@${token}에 @app.js를 연결, @app.jsx 와 @app.js.map은 아님`;
  assert.deepEqual(refMatches(text, refs).map((m) => m.token), [token, "app.js"]);
  assert.equal(expandRefs(text, refs), '@"Assets/UI/Tutorial Canvas.prefab"에 @"src/app.js"를 연결, @app.jsx 와 @app.js.map은 아님');
  assert.equal(expandRefs("@app.js 보기", refs), "@src/app.js 보기");
});

test("파일을 고르면 커서 뒤에 쓴 글을 지우지 않는다", () => {
  const before = "@Tut", text = `${before}에 넣기`;
  assert.deepEqual(applyCompletion(text, completionTrigger(text, before.length), "Tutorial Canvas.prefab"),
    { text: "@Tutorial Canvas.prefab에 넣기", caret: 23 });
  const word = "@ap", glued = `${word}pending 메모`;
  assert.equal(applyCompletion(glued, completionTrigger(glued, word.length), "app.js").text, "@app.js pending 메모");
  const quoted = '@"my no"';
  assert.equal(applyCompletion(quoted, completionTrigger(quoted, 7), "my notes.md").text, '@"my notes.md" ');
});
