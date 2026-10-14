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

test("claude: rate_limit_event는 화면 이벤트가 아니라 한도 정보로 넘긴다", () => {
  const info = { status: "allowed", resetsAt: 1792000000, rateLimitType: "five_hour" };
  const [ev] = claude.parseLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: info, session_id: "s" }));
  assert.equal(ev.kind, "limit");
  assert.deepEqual(ev.rateLimit, info);
});

test("discover: AgentHub 작업 폴더와 하위 폴더는 원래 저장소로 묶는다", async () => {
  const path = await import("node:path");
  const { projectRoot } = await import("../server/discover.mjs");
  const repo = path.resolve(import.meta.dirname, "..");
  assert.equal(projectRoot(`${repo}.agenthub${path.sep}abc123`), repo);
  assert.equal(projectRoot(path.join(repo, "server", "agents")), repo);
  assert.equal(projectRoot(path.join(repo, ".claude", "worktrees", "feature-x")), repo);
});
