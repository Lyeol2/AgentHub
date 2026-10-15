import test from "node:test";
import assert from "node:assert/strict";
import * as claude from "../server/agents/claude.mjs";
import * as codex from "../server/agents/codex.mjs";

test("claude: init 이벤트에서 세션 ID를 꺼낸다", () => {
  const [ev] = claude.parseLine(JSON.stringify({ type: "system", subtype: "init", session_id: "abc", model: "opus" }));
  assert.equal(ev.kind, "status");
  assert.equal(ev.agentSessionId, "abc");
});

test("claude: 텍스트와 도구 호출, 도구 결과를 구분한다", () => {
  const assistant = claude.parseLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "안녕" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] },
  }));
  assert.deepEqual(assistant.map((e) => e.kind), ["text", "tool"]);
  assert.equal(assistant[1].text, "Bash: ls");

  const [result] = claude.parseLine(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: [{ type: "text", text: "a.txt" }], is_error: true }] },
  }));
  assert.equal(result.kind, "tool_result");
  assert.equal(result.isError, true);
});

test("claude: 로그인 실패 결과를 오류로 표시한다", () => {
  const [ev] = claude.parseLine(JSON.stringify({ type: "result", is_error: false, result: "x", duration_ms: 1200 }));
  assert.equal(ev.kind, "result");
  const events = claude.parseLine(JSON.stringify({
    type: "assistant", error: "authentication_failed",
    message: { content: [{ type: "text", text: "Not logged in" }] },
  }));
  assert.deepEqual(events, [{ kind: "error", text: "Not logged in" }]);
});

test("claude: 재개할 때는 --resume, 처음에는 --session-id를 쓴다", () => {
  const first = claude.buildArgs({ permission: "plan" });
  assert.ok(first.includes("--session-id"));
  assert.ok(!first.includes("--resume"));
  const next = claude.buildArgs({ agentSessionId: "abc", permission: "plan" });
  assert.deepEqual(next.slice(next.indexOf("--resume"), next.indexOf("--resume") + 2), ["--resume", "abc"]);
});

test("codex: thread.started와 명령 실행 이벤트를 변환한다", () => {
  const [start] = codex.parseLine(JSON.stringify({ type: "thread.started", thread_id: "t1" }));
  assert.equal(start.agentSessionId, "t1");

  const [cmd] = codex.parseLine(JSON.stringify({
    type: "item.started", item: { id: "i", type: "command_execution", command: "git status" },
  }));
  assert.equal(cmd.text, "$ git status");

  const [done] = codex.parseLine(JSON.stringify({
    type: "item.completed",
    item: { id: "i", type: "command_execution", aggregated_output: "ok", exit_code: 1 },
  }));
  assert.equal(done.isError, true);
});

test("codex: 사용 한도 같은 실패를 오류로 표시한다", () => {
  const [ev] = codex.parseLine(JSON.stringify({ type: "turn.failed", error: { message: "usage limit" } }));
  assert.equal(ev.kind, "error");
  assert.equal(ev.text, "usage limit");
});

test("codex: 재개 인자에는 resume과 샌드박스 설정이 들어간다", () => {
  const args = codex.buildArgs({ agentSessionId: "t1", permission: "read-only", cwd: "C:/x" });
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "t1"]);
  assert.ok(args.includes("sandbox_mode=read-only"));
  assert.equal(args.at(-1), "-");
});

test("claude: 추론 강도와 일반 채팅(도구 없음) 인자를 넘긴다", () => {
  const args = claude.buildArgs({ permission: "acceptEdits", model: "opus", effort: "high", chat: true });
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(args.includes("--system-prompt"));
  assert.ok(!claude.buildArgs({ permission: "plan" }).includes("--tools"));
});

test("codex: 추론 강도는 설정 덮어쓰기로, 일반 채팅은 git 확인 없이 실행한다", () => {
  const args = codex.buildArgs({ agentSessionId: "t1", permission: "read-only", effort: "low", chat: true });
  assert.equal(args[args.indexOf("model_reasoning_effort=low") - 1], "-c");
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.equal(args.at(-1), "-");
});

test("claude: rate_limit_event는 화면 이벤트가 아니라 한도 정보로 넘긴다", () => {
  const info = { status: "allowed", resetsAt: 1792000000, rateLimitType: "five_hour" };
  const [ev] = claude.parseLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: info, session_id: "s" }));
  assert.equal(ev.kind, "limit");
  assert.deepEqual(ev.rateLimit, info);
});

test("claude: 컨텍스트 압축과 컨텍스트 크기를 세션 수명 정보로 넘긴다", () => {
  const [compact] = claude.parseLine(JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150000 } }));
  assert.equal(compact.kind, "status");
  assert.equal(compact.compact, true);

  const events = claude.parseLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 900 } },
  }));
  assert.deepEqual(events.at(-1), { kind: "usage", context: { used: 1000 } });
  // 하위 에이전트 호출은 주 대화의 컨텍스트가 아니다.
  const sub = claude.parseLine(JSON.stringify({ type: "assistant", parent_tool_use_id: "t", message: { content: [], usage: { input_tokens: 5 } } }));
  assert.equal(sub.length, 0);

  const [result] = claude.parseLine(JSON.stringify({
    type: "result", is_error: false, modelUsage: { haiku: { contextWindow: 200000 }, opus: { contextWindow: 1000000 } },
  }));
  assert.deepEqual(result.context, { window: 1000000 });
});

test("claude: 실행 중 권한 요청과 질문을 control 프로토콜로 주고받는다", () => {
  const args = claude.buildArgs({ permission: "default" });
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], "stdio");
  assert.equal(JSON.parse(claude.userLine("안녕")).message.content[0].text, "안녕");

  const questions = [{ question: "어디에?", header: "저장", options: [{ label: "로컬" }, { label: "서버" }], multiSelect: false }];
  const ask = claude.parseControl({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions } } });
  assert.equal(ask.kind, "question");
  const answered = claude.questionResponse(ask.input, [{ selected: ["서버"], text: "" }]);
  assert.deepEqual(answered, { behavior: "allow", updatedInput: { questions, answers: { "어디에?": "서버" } } });

  const perm = claude.parseControl({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm a" }, permission_suggestions: [{ type: "addRules" }] } });
  assert.equal(perm.kind, "permission");
  assert.equal(perm.text, "Bash: rm a");
  assert.deepEqual(claude.permissionResponse(perm, "always").updatedPermissions, [{ type: "addRules" }]);
  assert.equal(claude.permissionResponse(perm, "deny").behavior, "deny");

  const line = JSON.parse(claude.controlResponse("r2", { behavior: "allow", updatedInput: {} }));
  assert.equal(line.response.request_id, "r2");
  assert.equal(claude.parseControl({ type: "control_request", request_id: "x", request: { subtype: "other" } }), null);
});

test("discover: AgentHub 작업 폴더와 하위 폴더는 원래 저장소로 묶는다", async () => {
  const path = await import("node:path");
  const { projectRoot } = await import("../server/discover.mjs");
  const repo = path.resolve(import.meta.dirname, "..");
  assert.equal(projectRoot(`${repo}.agenthub${path.sep}abc123`), repo);
  assert.equal(projectRoot(path.join(repo, "server", "agents")), repo);
  assert.equal(projectRoot(path.join(repo, ".claude", "worktrees", "feature-x")), repo);
});

test("discover: AgentHub가 붙인 안내를 걷어내고 실제 요청으로 제목을 정한다", async () => {
  const { userPrompt } = await import("../server/discover.mjs");
  assert.equal(userPrompt("[이 세션의 역할]\n릴리스 담당\n\n규칙\n\n[요청]\n릴리스 준비해 줘"), "릴리스 준비해 줘");
  assert.equal(userPrompt("[이 세션에 이은 스킬]\n아래 작업을…\n- a: b\n\n테스트 고쳐"), "테스트 고쳐");
  assert.equal(userPrompt("[AgentHub 질문 규칙]\n규칙\n\n[이 세션에 이은 스킬]\n- a\n\n빌드해"), "빌드해");
  assert.equal(userPrompt("[중요] 사용자가 쓴 대괄호"), "[중요] 사용자가 쓴 대괄호");
  assert.equal(userPrompt("그냥 요청"), "그냥 요청");
});
