// tasks*.test.mjs가 함께 쓰는 작업 서비스 픽스처. 테스트마다 임시 저장소·원격·데이터 폴더를 따로 만든다.
// test/ 밖에 두어 node --test가 테스트 파일로 모으지 않게 한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTaskService } from "../server/application/tasks.mjs";
import { GitHubError, normalizePull } from "../server/github.mjs";
import { normalizeIssue } from "../server/issues.mjs";
import { gitflowSettingsKey } from "../server/gitflow-settings.mjs";

export function fixture(t, { develop = true, main = "main", developBranch = "develop", settings } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-tasks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repo = path.join(root, "repo"), remote = path.join(root, "origin.git"), dataDir = path.join(root, "data");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "--bare", "-q", remote);
  git(repo, "init", "-q", "-b", main);
  git(repo, "config", "user.name", "Task Test"); git(repo, "config", "user.email", "task@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  git(repo, "remote", "add", "origin", remote); git(repo, "push", "-q", "origin", main);
  if (develop) { git(repo, "branch", developBranch); git(repo, "push", "-q", "origin", developBranch); }
  const state = { pulls: [], issues: [], writes: [], refs: [], sends: [], running: new Set(), timeout: null, saves: 0, saveError: null, sendError: null, issueError: null };
  const config = settings ? { gitflow: { [gitflowSettingsKey(repo)]: settings } } : {};
  const stored = new Map(); let serial = 0;
  const store = { list: () => [...stored.values()], get: (id) => stored.get(id) };
  const sessions = { checkSessionOptions() {}, async createSession(body, internal) {
    if (state.createSessionError) throw state.createSessionError;
    const session = { id: `session-${++serial}`, title: body.title, projectPath: body.project.path, cwd: internal.worktree.dir,
      taskId: internal.taskId, worktree: internal.worktree, state: "idle", events: [] };
    stored.set(session.id, session); return session;
  }, sendMessage(id, body) { state.sends.push({ id, ...body }); if (state.sendError) throw state.sendError; return { ok: true }; } };
  const remoteSha = (branch) => git(repo, "ls-remote", remote, `refs/heads/${branch}`).split(/\s+/)[0] || null;
  const github = {
    async target(dir, selected) { return { dir, repo: "acme/widget", name: selected, pushMatches: true }; },
    async api(target, method, endpoint, body) {
      if (method === "GET" && endpoint.includes("/pulls?")) return state.pulls.filter((pull) =>
        (endpoint.includes("state=all") || pull.state === "open") && endpoint.includes(encodeURIComponent(`acme:${pull.head.ref}`))
        && endpoint.includes(`base=${encodeURIComponent(pull.base.ref)}`));
      if (method === "POST" && endpoint.endsWith("/git/refs")) {
        state.writes.push("develop");
        state.refs.push(body.ref);
        if (remoteSha(body.ref.replace(/^refs\/heads\//, ""))) throw new GitHubError("HTTP 422 exists");
        git(repo, "push", "-q", remote, `${body.sha}:${body.ref}`); return { ref: body.ref };
      }
      if (method === "GET" && /\/issues\/\d+$/.test(endpoint)) {
        if (state.issueError) throw state.issueError;
        const issue = state.issues.find((item) => item.number === Number(endpoint.split("/").at(-1)));
        if (!issue) throw new GitHubError("gh: Not Found (HTTP 404)");
        return issue;
      }
      if (method === "GET" && /\/pulls\/\d+$/.test(endpoint)) return state.pulls.find((item) => item.number === Number(endpoint.split("/").at(-1)));
      if (method === "POST" && endpoint.endsWith("/pulls")) {
        state.writes.push("develop-pull");
        const raw = { number: state.pulls.length + 1, title: body.title, body: body.body, state: "open", head: { ref: body.head, sha: remoteSha(body.head) }, base: { ref: body.base } };
        state.pulls.push(raw); return raw;
      }
      if (method === "PATCH" && /\/pulls\/\d+$/.test(endpoint)) {
        state.writes.push("pull-update");
        const pull = state.pulls.find((item) => item.number === Number(endpoint.split("/").at(-1)));
        pull.body = body.body; return pull;
      }
      throw Error(`Unexpected GitHub call: ${method} ${endpoint}`);
    },
    async push(dir, body) {
      state.writes.push("push");
      assert.equal(git(dir, "rev-parse", "HEAD"), body.expectedHead);
      git(dir, "push", "-q", remote, `${body.expectedHead}:refs/heads/${body.branch}`);
      state.afterPush?.(body);
      for (const pull of state.pulls.filter((pull) => pull.head.ref === body.branch && pull.state === "open")) pull.head.sha = body.expectedHead;
      if (state.timeout === "push") throw new GitHubError("timeout", "github-timeout", 504, true);
      return { ok: true };
    },
    async create(dir, body) {
      state.writes.push("pull");
      const raw = { number: state.pulls.length + 1, title: body.title, body: body.body, state: "open",
        head: { ref: body.head, sha: body.expectedHead }, base: { ref: body.base } };
      state.pulls.push(raw);
      if (state.timeout === "pull") throw new GitHubError("timeout", "github-timeout", 504, true);
      return { pull: normalizePull(raw, "acme/widget") };
    },
    async detail(dir, number) { return { pull: normalizePull(state.pulls.find((pull) => pull.number === number), "acme/widget") }; },
    async merge(dir, number, body) {
      const pull = state.pulls.find((item) => item.number === number);
      assert.equal(body.sha, pull.head.sha);
      git(repo, "switch", "-q", pull.base.ref); git(repo, "merge", "--no-ff", "--no-edit", body.sha); git(repo, "push", "-q", "origin", pull.base.ref);
      state.writes.push("merge"); pull.merged = true; pull.state = "closed";
      return { pull: normalizePull(pull, "acme/widget") };
    },
    async remoteHead(target, branch) { return remoteSha(branch); },
  };
  const issues = {
    async viewer() { return "me"; },
    async create(dir, body) {
      state.writes.push("issue");
      const raw = { number: 100 + state.issues.length, title: body.title, body: body.body, state: "open", user: { login: "me" }, assignees: [{ login: body.assignee }] };
      state.issues.push(raw); return { ok: true, issue: normalizeIssue(raw, "acme/widget") };
    },
  };
  const options = { dataDir, store, config, saveConfig: (value) => { assert.equal(value, config); state.saves++; if (state.saveError) throw state.saveError; }, runner: { isRunning: (id) => state.running.has(id) }, sessions,
    projects: { ensureProject: (projectPath) => ({ name: "repo", path: projectPath }) }, github, issues };
  let service = createTaskService(options);
  const create = (type = "feature", extra = {}) => service.create({ projectPath: repo, title: "새 작업", type, agent: "codex", ...extra });
  function change(dir, filename = "change.txt", text = "change\n") { fs.writeFileSync(path.join(dir, filename), text); }
  function commit(dir, filename = "remote-change.txt") { change(dir, filename); git(dir, "add", "."); git(dir, "commit", "-qm", filename); }
  return { repo, remote, dataDir, config, state, git, create, change, commit, stored, get service() { return service; }, restart() { service = createTaskService(options); return service; } };
}

export const customGitflow = { main: "Main", develop: "Develop", featurePrefix: "Feature/", hotfixPrefix: "Fix/", releasePrefix: "Release/" };

// 병합한 PR을 GitHub에서 확인한 것처럼 develop에 실제로 병합하고 원격에 올린다.
export function mergePullOnRemote(f, task) {
  const raw = f.state.pulls[0]; raw.merged = true; raw.state = "closed";
  f.git(f.repo, "switch", "-q", "develop");
  f.git(f.repo, "merge", "--no-ff", "--no-edit", task.branch);
  f.git(f.repo, "push", "-q", "origin", "develop");
}
