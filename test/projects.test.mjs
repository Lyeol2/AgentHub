// 프로젝트 서비스: 일반 채팅 세션(프로젝트 경로 없음)이 있어도 프로젝트 화면이 동작한다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitFixtures, run } from "../test-support/git-fixture.mjs";
import { createHub } from "../server/bootstrap.mjs";

const repo = gitFixtures(test, "agenthub-projects-")("repo");
fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
run(repo, "add", ".");
run(repo, "commit", "-qm", "init");

test("projects: 일반 채팅 세션은 어느 프로젝트에도 속하지 않고 Git 패널을 막지 않는다", async (t) => {
  const dataDir = path.join(path.dirname(repo), "data");
  const hub = createHub({ port: 0, dataDir, warmup: false, cliAutoUpdate: false,
    config: { projects: [{ name: "repo", path: repo }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {}, error() {} } } });
  t.after(() => hub.shutdown());
  const now = new Date().toISOString();
  const session = (fields) => ({ agent: "claude", model: "", state: "idle", worktree: null, events: [], createdAt: now, updatedAt: now, ...fields });
  hub.store.add(session({ id: "chat", title: "일반 채팅", chat: true, projectPath: null, projectName: "일반 채팅", cwd: path.join(dataDir, "chat") }));
  hub.store.add(session({ id: "work", title: "작업", projectPath: repo, projectName: "repo", cwd: repo }));

  assert.deepEqual(hub.services.projects.projectSessions(repo).map((s) => s.id), ["work"]);
  const overview = await hub.services.git.execute("overview", { projectPath: repo });
  assert.equal(overview.commits[0].subject, "init");
});

test("projects: 프로젝트 설정은 기본값과 유니티 사용을 따로 저장하고 세션 실행·생성에 쓴다", async (t) => {
  const dataDir = path.join(path.dirname(repo), "data-settings");
  const hub = createHub({ port: 0, dataDir, warmup: false, cliAutoUpdate: false,
    config: { projects: [{ name: "repo", path: repo }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {}, error() {} } } });
  t.after(() => hub.shutdown());
  const projects = hub.services.projects;
  assert.equal(projects.settings(repo).unity, "ask");
  assert.equal(hub.runner.unityMode({ projectPath: repo }), "ask");
  projects.updateSettings(repo, { unity: "off" });
  projects.updateSettings(repo, { defaults: { agent: "codex", permission: { codex: "read-only" }, isolate: false } });
  assert.deepEqual(projects.settings(repo), { defaults: { agent: "codex", permission: { codex: "read-only" }, isolate: false }, unity: "off" });
  assert.equal(hub.runner.unityMode({ projectPath: repo }), "off");
  assert.equal(projects.all().find((p) => p.path === repo).settings.unity, "off");
  assert.throws(() => projects.updateSettings(repo, { unity: "sometimes" }), /유니티/);
  // 권한 없이 만든 세션은 프로젝트 기본 권한을 쓴다.
  const session = await hub.services.sessions.createSession({ project: { name: "repo", path: repo }, agent: "codex" });
  assert.equal(session.permission, "read-only");
});
