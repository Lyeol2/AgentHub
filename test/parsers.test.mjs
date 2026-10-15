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

test("codex: app-server를 띄우고 샌드박스와 사용자 승인 설정을 넘긴다", () => {
  const args = codex.buildArgs({ agentSessionId: "t1", permission: "read-only", cwd: "C:/x" });
  assert.deepEqual(args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.ok(args.includes('approval_policy="on-request"'));
  assert.ok(args.includes('approvals_reviewer="user"'));
});

test("codex: 권한별 샌드박스·승인·검토자 설정을 CLI에 함께 넘긴다", () => {
  const cases = [
    [undefined, "workspace-write", "on-request", "user"],
    ["read-only", "read-only", "on-request", "user"],
    ["workspace-write", "workspace-write", "on-request", "user"],
    ["auto-review", "workspace-write", "on-request", "auto_review"],
    ["danger-full-access", "danger-full-access", "never", "user"],
  ];
  for (const [permission, sandbox, policy, reviewer] of cases) {
    const args = codex.buildArgs({ permission }, { resolved: {} });
    assert.ok(args.includes(`sandbox_mode="${sandbox}"`), String(permission));
    assert.ok(args.includes(`approval_policy="${policy}"`), String(permission));
    assert.ok(args.includes(`approvals_reviewer="${reviewer}"`), String(permission));
    if (permission) assert.ok(codex.PERMISSION_MODES.includes(permission));
  }
  for (const permission of ["auto-review", "danger-full-access"]) {
    const args = codex.buildArgs({ permission, chat: true }, { resolved: {} });
    assert.ok(args.includes('sandbox_mode="read-only"'));
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes('approvals_reviewer="user"'));
  }
});

test("claude: 추론 강도와 일반 채팅(도구 없음) 인자를 넘긴다", () => {
  const args = claude.buildArgs({ permission: "acceptEdits", model: "opus", effort: "high", chat: true });
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(args.includes("--system-prompt"));
  assert.ok(!claude.buildArgs({ permission: "plan" }).includes("--tools"));
});

test("codex: 추론 강도는 설정 덮어쓰기로, 일반 채팅은 승인을 요청하지 않는다", () => {
  const args = codex.buildArgs({ agentSessionId: "t1", permission: "read-only", effort: "low", chat: true });
  assert.equal(args[args.indexOf('model_reasoning_effort="low"') - 1], "-c");
  assert.ok(args.includes('approval_policy="never"'));
  assert.equal(codex.transport, "app-server");
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
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { projectRoot } = await import("../server/discover.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-project-root-"));
  try {
    const repo = path.join(dir, "repo");
    const gitDir = path.join(repo, ".git");
    const source = path.join(repo, "server", "agents");
    const agenthubTree = path.join(`${repo}.agenthub`, "abc123");
    const claudeTree = path.join(repo, ".claude", "worktrees", "feature-x");
    const linkedTree = path.join(dir, "linked-worktree");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(source, { recursive: true });
    for (const [tree, name] of [[agenthubTree, "abc123"], [claudeTree, "feature-x"], [linkedTree, "linked"]]) {
      const worktreeGitDir = path.join(gitDir, "worktrees", name);
      fs.mkdirSync(worktreeGitDir, { recursive: true });
      fs.mkdirSync(path.join(tree, "src"), { recursive: true });
      fs.writeFileSync(path.join(tree, ".git"), `gitdir: ${worktreeGitDir}\n`);
      fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
      fs.writeFileSync(path.join(worktreeGitDir, "gitdir"), `${path.join(tree, ".git")}\n`);
    }
    assert.equal(projectRoot(agenthubTree), repo);
    assert.equal(projectRoot(path.join(agenthubTree, "src")), repo);
    assert.equal(projectRoot(source), repo);
    assert.equal(projectRoot(claudeTree), repo);
    assert.equal(projectRoot(path.join(claudeTree, "src")), repo);
    // 별도 작업 트리의 .git 파일도 하위 폴더에서 저장소 경계로 찾는다.
    assert.equal(projectRoot(path.join(linkedTree, "src")), linkedTree);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discover: AgentHub가 붙인 안내를 걷어내고 실제 요청으로 제목을 정한다", async () => {
  const { userPrompt } = await import("../server/discover.mjs");
  assert.equal(userPrompt("[이 세션의 역할]\n릴리스 담당\n\n규칙\n\n[요청]\n릴리스 준비해 줘"), "릴리스 준비해 줘");
  assert.equal(userPrompt("[이 세션에 이은 스킬]\n아래 작업을…\n- a: b\n\n테스트 고쳐"), "테스트 고쳐");
  assert.equal(userPrompt("[AgentHub 질문 규칙]\n규칙\n\n[이 세션에 이은 스킬]\n- a\n\n빌드해"), "빌드해");
  assert.equal(userPrompt("[중요] 사용자가 쓴 대괄호"), "[중요] 사용자가 쓴 대괄호");
  assert.equal(userPrompt("그냥 요청"), "그냥 요청");
});

test("args: AgentHub MCP 서버를 붙인다", () => {
  const mcp = { url: "http://127.0.0.1:4517/mcp/abc", configFile: "C:/d/mcp/s.json" };
  const c = claude.buildArgs({ permission: "acceptEdits" }, { mcp });
  assert.deepEqual(c.slice(c.indexOf("--mcp-config"), c.indexOf("--mcp-config") + 4), ["--mcp-config", "C:/d/mcp/s.json", "--allowedTools", "mcp__agenthub"]);
  assert.ok(!claude.buildArgs({ permission: "acceptEdits" }).includes("--mcp-config"));
  const x = codex.buildArgs({ agentSessionId: "t1", permission: "read-only", cwd: "C:/x" }, { mcp });
  assert.ok(x.includes('mcp_servers.agenthub.url="http://127.0.0.1:4517/mcp/abc"'));
  assert.ok(x.includes("mcp_servers.agenthub.tool_timeout_sec=660"));
  assert.ok(x.includes('mcp_servers.agenthub.default_tools_approval_mode="approve"')); // 프로젝트가 제공한 세션 소통 도구는 그대로 허용한다.
  assert.equal(codex.transport, "app-server"); // 요청과 승인은 JSON-RPC로 보낸다.
});

test("codex: MCP 도구 결과와 실패를 보인다", () => {
  const done = (extra) => JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "agenthub", tool: "board_post", ...extra } });
  assert.deepEqual(codex.parseLine(done({ result: { content: [{ type: "text", text: "남겼다" }] }, error: null })), [{ kind: "tool_result", text: "남겼다" }]);
  assert.deepEqual(codex.parseLine(done({ result: null, error: { message: "MCP tool call requires approval" } })),
    [{ kind: "tool_result", text: "MCP tool call requires approval", isError: true }]);
});

test("claude: 일시중지는 Esc처럼 interrupt 요청을 보낸다", () => {
  const msg = JSON.parse(claude.interruptLine());
  assert.equal(msg.type, "control_request");
  assert.equal(msg.request.subtype, "interrupt");
  assert.match(msg.request_id, /^interrupt-/);
  assert.equal(codex.interruptLine, undefined); // Codex는 프로세스를 멈추고 다음 턴에 같은 스레드로 이어 간다.
});

test("codex: 쓸 수 없는 모델(설정의 기본값이나 세션에 고른 것)은 목록의 첫 모델로 바꿔 실행한다", () => {
  const list = [
    { id: "gpt-6-astra", efforts: ["low", "medium", "ultra"], defaultEffort: "medium" },
    { id: "gpt-6-luna", efforts: ["low", "medium"], defaultEffort: "medium" },
  ];
  const known = ["gpt-6-astra", "gpt-6-luna", "gpt-reserve"]; // 목록에 안 보이는 숨은 모델도 Codex가 아는 모델이다.
  const config = { model: "gpt-6.1-sol", effort: "ultra" };

  // 모델을 고르지 않음 + 설정의 기본 모델을 쓸 수 없음 → 첫 모델, 강도는 지원하면 설정 것(CLI가 씀)
  const gone = codex.resolveModel({}, list, config, known);
  assert.deepEqual(gone, { model: "gpt-6-astra", effort: null, unavailable: true, configured: "gpt-6.1-sol", source: "config" });
  // 바꾼 모델이 설정의 강도를 지원하지 않으면 그 모델의 기본 강도를 넘긴다.
  assert.equal(codex.resolveModel({}, [list[1]], config, known).effort, "medium");
  // 세션에 저장한 모델을 쓸 수 없을 때도 바꾼다(예전 목록에서 고른 gpt-6.1-sol).
  const saved = codex.resolveModel({ model: "gpt-6.1-sol", effort: "ultra" }, list, { model: null, effort: null }, known);
  assert.deepEqual(saved, { model: "gpt-6-astra", effort: "ultra", unavailable: true, configured: "gpt-6.1-sol", source: "session" });
  assert.equal(codex.resolveModel({ model: "gone", effort: "ultra" }, [list[1]], config, known).effort, "medium");
  // 쓸 수 있는 모델(숨은 모델 포함), 설정 없음, 목록을 모름 → 그대로
  assert.deepEqual(codex.resolveModel({ model: "gpt-reserve", effort: "low" }, list, config, known), { model: "gpt-reserve", effort: "low", unavailable: false, configured: "gpt-reserve", source: "session" });
  assert.equal(codex.resolveModel({}, list, { model: "gpt-6-luna", effort: null }, known).model, null);
  assert.equal(codex.resolveModel({}, list, { model: null, effort: null }, known).model, null);
  assert.equal(codex.resolveModel({}, [], config, []).model, null);

  const args = codex.buildArgs({ permission: "read-only", cwd: "C:/x" }, { resolved: { model: "gpt-6-astra", effort: "medium" } });
  assert.ok(args.includes('model="gpt-6-astra"'));
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  const none = codex.buildArgs({ permission: "read-only", cwd: "C:/x" }, { resolved: { model: null, effort: null } });
  assert.ok(!none.some((arg) => arg.startsWith("model="))); // CLI 설정에 맡긴다.
  assert.match(codex.modelNote({}, gone), /Codex 설정의 기본 모델 gpt-6\.1-sol.*gpt-6-astra/);
  assert.match(codex.modelNote({ model: "gpt-6.1-sol" }, saved), /이 세션의 모델 gpt-6\.1-sol.*gpt-6-astra/);
  assert.equal(codex.modelNote({}, codex.resolveModel({}, list, { model: null, effort: null }, known)), null);
});
