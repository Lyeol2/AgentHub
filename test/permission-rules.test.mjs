import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Runner } from "../server/runner.mjs";
import * as claude from "../server/agents/claude.mjs";
import * as codex from "../server/agents/codex.mjs";
import { checkProjectSettings, projectSettings, projectUnityMode } from "../server/project-settings.mjs";
import { claudeMcpServers, claudeUnityRules, codexUnityServers, codexUnitySettings, isUnityCommand, unityControl } from "../server/unity-control.mjs";

const flag = (args, name) => args[args.indexOf(name) + 1];

test("프로젝트 설정: 쓸 수 없는 값은 버리고 유니티 사용 기본값은 실행 전 확인이다", () => {
  assert.deepEqual(projectSettings({}, "C:/repo"), { defaults: { agent: null, permission: {}, isolate: null }, unity: "ask" });
  const config = { projectSettings: { "c:\\repo": { defaults: { agent: "codex", permission: { claude: "nope", codex: "read-only" }, isolate: true }, unity: "off" } } };
  if (process.platform === "win32") {
    assert.deepEqual(projectSettings(config, "C:/Repo"), { defaults: { agent: "codex", permission: { codex: "read-only" }, isolate: true }, unity: "off" });
    assert.equal(projectUnityMode(config, "C:/Repo"), "off");
  }
  assert.equal(projectUnityMode(config, null), "ask");
  assert.throws(() => checkProjectSettings({ unity: "maybe" }), /유니티/);
  assert.throws(() => checkProjectSettings({ defaults: { permission: { codex: "acceptEdits" } } }), /권한/);
  assert.deepEqual(checkProjectSettings({ defaults: { agent: "claude", permission: { claude: "default" }, isolate: false }, unity: "allow" }).defaults, { agent: "claude", permission: { claude: "default" }, isolate: false });
});

test("유니티 통제: Claude는 명령·MCP·스킬 규칙을, Codex는 Unity MCP 서버 설정을 만든다", () => {
  assert.deepEqual(claudeUnityRules("allow"), { ask: [], deny: [] });
  const ask = claudeUnityRules("ask", ["unityBridge", "github"]);
  assert.ok(ask.ask.includes("Bash(unity:*)") && ask.ask.includes("Bash(unity open:*)") && ask.ask.includes("PowerShell(unity:*)"));
  assert.ok(ask.ask.includes("mcp__unityBridge") && !ask.ask.includes("mcp__github"));
  assert.ok(!ask.ask.includes("Skill(unity-cli)"));
  const off = claudeUnityRules("off", []);
  assert.deepEqual(off.ask, []);
  assert.ok(off.deny.includes("Skill(unity-cli)") && off.deny.includes("mcp__unityMCP"));

  const toml = ["[mcp_servers.unityMCP]", 'url = "http://127.0.0.1:8080/mcp"', "[mcp_servers.unityMCP.tools.manage_scene]", 'approval_mode = "approve"', "[mcp_servers.blender]", 'command = "x"'].join("\n");
  const servers = codexUnityServers(toml);
  assert.deepEqual(servers, [{ name: "unityMCP", tools: ["manage_scene"] }]);
  assert.deepEqual(codexUnitySettings("off", servers), { "mcp_servers.unityMCP.enabled": false });
  assert.deepEqual(codexUnitySettings("ask", servers), {
    "mcp_servers.unityMCP.default_tools_approval_mode": "prompt",
    "mcp_servers.unityMCP.tools.manage_scene.approval_mode": "prompt",
  });
  assert.equal(unityControl("allow", { agent: "claude" }), null);
  assert.equal(unityControl("off", { agent: "claude", chat: true }), null);
  assert.deepEqual(unityControl("ask", { agent: "codex" }, { codexServers: () => servers }).settings["mcp_servers.unityMCP.default_tools_approval_mode"], "prompt");

  const user = { mcpServers: { unity: {} }, projects: { "C:/repo": { mcpServers: { "unity-local": {} } } } };
  assert.deepEqual(claudeMcpServers(["C:/repo"], { user, project: () => ({ mcpServers: { shared: {} } }) }), ["unity", "unity-local", "shared"]);

  for (const command of ["unity open .", "cd x && unity build", '"C:\\WINDOWS\\powershell.exe" -Command "unity open ."', "& 'C:\\Program Files\\Unity\\Editor\\Unity.exe' -projectPath x"]) assert.equal(isUnityCommand(command), true, command);
  for (const command of ["npm test", "cat unity.txt", "ls unity", "unityhub", undefined]) assert.equal(isUnityCommand(command), false, String(command));
});

test("Claude 실행 인자: 계속 허용한 규칙과 유니티 통제를 이 실행의 설정으로 넘긴다", () => {
  const session = { agent: "claude", permission: "bypassPermissions", allowRules: [
    { agent: "claude", kind: "rule", rule: "Bash(npm test:*)", key: "rule:Bash(npm test:*)" },
    { agent: "claude", kind: "dir", dir: "C:/shared", key: "dir:C:/shared" },
    { agent: "codex", kind: "command", command: "ls", key: "command:ls" },
  ] };
  const args = claude.buildArgs(session, { unity: { mode: "off", ...claudeUnityRules("off") } });
  const settings = JSON.parse(flag(args, "--settings"));
  assert.deepEqual(settings.permissions.allow, ["Bash(npm test:*)"]);
  assert.ok(settings.permissions.deny.includes("Bash(unity:*)"));
  assert.match(flag(args, "--disallowedTools"), /Bash\(unity open:\*\)/);
  assert.equal(flag(args, "--add-dir"), "C:/shared");
  const ask = claude.buildArgs({ agent: "claude" }, { unity: { mode: "ask", ...claudeUnityRules("ask") } });
  assert.ok(JSON.parse(flag(ask, "--settings")).permissions.ask.includes("Bash(unity:*)"));
  assert.equal(ask.includes("--disallowedTools"), false);
  // 일반 채팅과 통제가 없는 세션은 그대로 둔다.
  assert.equal(claude.buildArgs({ agent: "claude" }).includes("--settings"), false);
  assert.equal(claude.buildArgs({ ...session, chat: true }).includes("--settings"), false);
});

test("Claude 계속 허용: 제안을 세션 규칙으로 바꾸고 이번 실행에는 세션 범위로만 적용한다", () => {
  const control = claude.parseControl({ request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "mkdir a && touch a/b" }, permission_suggestions: [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "mkdir a *" }, { toolName: "Read" }], behavior: "allow", destination: "localSettings" },
    { type: "addDirectories", directories: ["C:/other"], destination: "localSettings" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ] } });
  assert.equal(control.rememberLabel, "이 세션에서 계속 허용");
  assert.deepEqual(claude.permissionResponse(control, "always").updatedPermissions.map((s) => s.destination), ["session", "session", "session"]);
  const { rules, mode } = claude.rememberedRules(control);
  assert.deepEqual(rules.map((rule) => rule.key), ["rule:Bash(mkdir a *)", "rule:Read", "dir:C:/other"]);
  assert.equal(mode, "acceptEdits");
  assert.deepEqual(JSON.parse(claude.permissionModeLine("plan")).request, { subtype: "set_permission_mode", mode: "plan" });
});

test("Codex 계속 허용: 같은 명령·저장한 파일·같은 MCP 도구만 다시 허용한다", () => {
  const command = { method: "item/commandExecution/requestApproval", input: { command: "npm test" } };
  const [rule] = codex.rememberedRules(command).rules;
  assert.equal(codex.ruleMatches(rule, command), true);
  assert.equal(codex.ruleMatches(rule, { ...command, input: { command: "npm test -- --watch" } }), false);
  const files = { method: "item/fileChange/requestApproval", input: { changes: [{ path: "a.js" }, { path: "b.js" }] } };
  const [fileRule] = codex.rememberedRules(files).rules;
  assert.equal(codex.ruleMatches(fileRule, { ...files, input: { changes: [{ path: "a.js" }] } }), true);
  assert.equal(codex.ruleMatches(fileRule, { ...files, input: { changes: [{ path: "c.js" }] } }), false);
  const mcp = codex.parseControl({ request: { method: "mcpServer/elicitation/request", params: { serverName: "unityMCP", threadId: "t", message: "Allow?", mode: "form", requestedSchema: {}, _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "manage_scene", persist: ["session", "always"] } } } });
  assert.equal(mcp.kind, "permission");
  assert.deepEqual(codex.permissionResponse(mcp, "always"), { action: "accept", content: {}, _meta: { persist: "session" } });
  assert.deepEqual(codex.permissionResponse(mcp, "deny"), { action: "decline", content: null });
  const [mcpRule] = codex.rememberedRules(mcp).rules;
  assert.equal(codex.ruleMatches(mcpRule, mcp), true);
  assert.equal(codex.parseControl({ request: { method: "mcpServer/elicitation/request", params: { _meta: {} } } }), null);
  const args = codex.buildArgs({ agent: "codex", permission: "danger-full-access" }, { resolved: {}, unity: { mode: "off", settings: { "mcp_servers.unityMCP.enabled": false } } });
  assert.ok(args.includes("mcp_servers.unityMCP.enabled=false"));
});

function codexRunner(t, session) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), messages: [] });
  const emit = (message) => child.stdout.write(JSON.stringify(message) + "\n");
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const message = JSON.parse(line);
      child.messages.push(message);
      if (!message.method || !message.id) continue;
      queueMicrotask(() => {
        const result = message.method.startsWith("thread/") ? { thread: { id: "thread" } } : message.method === "turn/start" ? { turn: { id: "turn", status: "inProgress" } } : {};
        if (message.method === "turn/start") emit({ method: "turn/started", params: { threadId: "thread", turn: result.turn } });
        emit({ id: message.id, result });
      });
    }
  });
  const runner = new Runner({ touch() {}, get: () => session }, { spawn: () => child });
  t.after(() => { child.appServer?.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const approve = (id, command) => emit({ id, method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", itemId: id, command } });
  return { runner, child, approve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("러너: 계속 허용한 Codex 명령은 다음 실행에서 묻지 않고, 유니티를 끄면 유니티 명령을 거절한다", async (t) => {
  const session = { id: "s", agent: "codex", cwd: process.cwd(), permission: "workspace-write", projectPath: "C:/repo", state: "idle", events: [] };
  const f = codexRunner(t, session);
  f.runner.unityMode = () => "off";
  f.runner.send(session, "작업", "fake-codex"); await tick(); await tick();
  f.approve("r1", "npm test"); await tick();
  const card = session.events.at(-1);
  assert.equal(card.kind, "permission");
  f.runner.answer(card.requestId, { decision: "always" });
  assert.deepEqual(session.allowRules.map((rule) => [rule.agent, rule.key]), [["codex", "command:npm test"]]);
  f.approve("r2", "npm test"); await tick();
  assert.deepEqual(f.child.messages.at(-1), { id: "r2", result: { decision: "accept" } });
  assert.match(session.events.at(-1).text, /계속 허용한 요청/);
  f.approve("r3", "unity open ."); await tick();
  assert.deepEqual(f.child.messages.at(-1), { id: "r3", result: { decision: "decline" } });
  // 실행 전 확인이면 저장한 규칙이 있어도 유니티 명령은 카드로 묻는다.
  session.allowRules.push({ agent: "codex", kind: "command", command: "unity open .", key: "command:unity open ." });
  f.runner.unityMode = () => "ask";
  f.approve("r4", "unity open ."); await tick();
  assert.equal(session.events.at(-1).kind, "permission");
  assert.equal(session.events.at(-1).status, "pending");
});

test("러너: Claude 계속 허용의 setMode 제안은 세션 권한에 남고 실행 중 권한 변경은 CLI에 바로 보낸다", () => {
  const session = { id: "c", agent: "claude", permission: "default", events: [] };
  const runner = new Runner({ touch() {}, get: () => session }, { spawn: () => null });
  runner.remember(session, claude, { suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }, { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls *" }], behavior: "allow" }] });
  assert.equal(session.permission, "acceptEdits");
  assert.deepEqual(session.allowRules.map((rule) => rule.rule), ["Bash(ls *)"]);
  runner.remember(session, claude, { suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls *" }], behavior: "allow" }] });
  assert.equal(session.allowRules.length, 1);
  const stdin = new PassThrough();
  const written = [];
  stdin.on("data", (chunk) => written.push(JSON.parse(chunk.toString())));
  runner.running.set(session.id, { stdin });
  session.permission = "bypassPermissions";
  assert.equal(runner.setPermissionMode(session), true);
  runner.running.set(session.id, { stdin, appServer: {} });
  assert.equal(runner.setPermissionMode(session), false);
  return tick().then(() => assert.deepEqual(written[0].request, { subtype: "set_permission_mode", mode: "bypassPermissions" }));
});
