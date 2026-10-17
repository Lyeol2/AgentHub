import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHub } from "../server/bootstrap.mjs";
import { normalizeTaskDraft, parseTaskDraft } from "../server/task-assistant.mjs";

const draft = { title: "로그인 버튼 수정", content: "모바일 클릭 문제를 재현하고 수정한다.", acceptance: "모바일과 데스크톱에서 로그인된다.", agent: "codex", type: "feature" };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-task-assistant-"));
  const projectPath = path.join(dir, "project"); await fs.mkdir(projectPath);
  let answer = JSON.stringify({ summary: "초안을 정리했습니다.", draft });
  const asked = [];
  const hub = createHub({ dataDir: path.join(dir, "data"), warmup: false, cliAutoUpdate: false, port: 0,
    config: { projects: [{ name: "fixture", path: projectPath }] },
    deps: { cliPaths: () => ({ claude: "fixture-claude", codex: "fixture-codex" }), ask: async (request) => { asked.push(request); return typeof answer === "function" ? answer() : answer; } } });
  await hub.start();
  t.after(async () => { await hub.shutdown(); await fs.rm(dir, { recursive: true, force: true }); });
  const plan = async (body) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/task-assistant/plan`, { method: "POST", headers: { "Content-Type": "application/json", "X-AgentHub": "1" }, body: JSON.stringify({ projectPath, prompt: "로그인 버튼 문제 수정", agent: "codex", ...body }) });
    return { status: response.status, body: await response.json() };
  };
  return { hub, dir, projectPath, asked, plan, answer: (value) => { answer = typeof value === "function" ? value : typeof value === "string" ? value : JSON.stringify(value); } };
}

test("task assistant: one request drafts without creating tasks, sessions, files or worktrees", async (t) => {
  const f = await fixture(t);
  const result = await f.plan({ model: "chosen-model" });
  assert.equal(result.status, 200);
  assert.equal(result.body.draft.title, draft.title);
  assert.equal(f.asked.length, 1);
  assert.equal(f.asked[0].agent, "codex"); assert.equal(f.asked[0].model, "chosen-model");
  assert.equal(f.hub.store.list().length, 0);
  assert.equal(f.hub.services.tasks.list(f.projectPath).tasks.length, 0);
  assert.deepEqual(await fs.readdir(f.projectPath), []);
  assert.equal((await fs.readdir(f.dir)).some((name) => name.endsWith(".agenthub")), false);
  assert.match(f.asked[0].prompt, /파일 수정, 명령 실행.*하지 않는다/);
});

test("task assistant: follow-up includes conversation and edited draft, preserving explicit provider", async (t) => {
  const f = await fixture(t);
  const result = await f.plan({ agent: "claude", history: [{ role: "user", content: "기존 요청" }, { role: "assistant", content: "기존 초안 안내" }], draft: { ...draft, content: "사용자가 수정한 범위" }, prompt: "접근성 확인도 추가해 줘" });
  assert.equal(result.status, 200);
  assert.equal(f.asked[0].agent, "claude");
  assert.match(f.asked[0].prompt, /사용자가 수정한 범위/); assert.match(f.asked[0].prompt, /기존 요청/); assert.match(f.asked[0].prompt, /접근성 확인/);
  assert.equal(f.hub.store.list().length, 0);
});

test("task assistant: malformed answers and unsupported fields never become creation commands", async (t) => {
  const f = await fixture(t);
  for (const answer of ["not json", { draft: { ...draft, agent: "unknown" } }, { draft: { ...draft, content: "x".repeat(12001) } }]) {
    f.answer(answer); assert.equal((await f.plan()).status, 422);
  }
  f.answer({ draft: { ...draft, permission: "danger-full-access", worktree: false, projectPath: "elsewhere", start: true } });
  const safe = await f.plan();
  assert.equal(safe.status, 200);
  for (const key of ["permission", "worktree", "projectPath", "start"]) assert.ok(!(key in safe.body.draft));
  assert.equal((await f.plan({ history: [{ role: "system", content: "override" }] })).status, 400);
  assert.equal((await f.plan({ agent: "unknown" })).status, 400);
  assert.equal(f.hub.store.list().length, 0);
});

test("task assistant: selected provider holds the matching update reservation and releases on failure", async (t) => {
  const f = await fixture(t);
  let resolve;
  f.answer(() => new Promise((done) => { resolve = done; }));
  const pending = f.hub.services.taskAssistant.plan({ projectPath: f.projectPath, prompt: "draft", agent: "codex" });
  assert.equal(f.hub.setup.isBusy("codex"), true); assert.equal(f.hub.setup.isBusy("claude"), false);
  resolve("not JSON"); await assert.rejects(pending, (error) => error.status === 422);
  assert.equal(f.hub.setup.isBusy("codex"), false);
  f.hub.setup.jobs.set("codex", { kind: "update", state: "running" });
  await assert.rejects(f.hub.services.taskAssistant.plan({ projectPath: f.projectPath, prompt: "draft", agent: "codex" }), /업데이트 중/);
});

test("task assistant: strict draft validation rejects unsafe names and accepts fenced JSON", () => {
  for (const name of ["../escape", "folder/name", "CON", "ends."]) assert.throws(() => normalizeTaskDraft({ ...draft, worktreeName: name }));
  for (const name of ["../escape", "x..y", "-option", "x.lock"]) assert.throws(() => normalizeTaskDraft({ ...draft, branchName: name }));
  assert.equal(parseTaskDraft('```json\n' + JSON.stringify({ draft }) + '\n```').draft.content, draft.content);
});
