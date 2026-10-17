import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitFixtures, run } from "../test-support/git-fixture.mjs";
import { createHub } from "../server/bootstrap.mjs";

const repoFactory = gitFixtures(test, "agenthub-git-client-api-");
test("Git API: selected worktree, preview execution, recovery and standalone lifecycle round trip", { timeout: 60_000 }, async t => {
  const repo = repoFactory("repo"), foreign = repoFactory("foreign");
  run(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n"); run(repo, "add", "."); run(repo, "commit", "-qm", "root");
  fs.writeFileSync(path.join(foreign, "README.md"), "foreign\n"); run(foreign, "add", "."); run(foreign, "commit", "-qm", "foreign");
  const initial = run(repo, "rev-parse", "HEAD").trim();
  const hub = createHub({ dataDir: path.join(path.dirname(repo), "data"), port: 0, warmup: false });
  hub.runner.send = () => { throw new Error("The Git fixture must never launch an agent"); };
  await hub.start(); t.after(() => hub.shutdown());
  const request = async (method, route, body, expected = 200) => {
    const res = await fetch(`http://127.0.0.1:${hub.port}/api/git${route}`, {
      method, headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
    const value = await res.json(); assert.equal(res.status, expected, JSON.stringify(value)); return value;
  };
  const query = cwd => "?" + new URLSearchParams({ path: repo, ...(cwd ? { cwd } : {}) });
  assert.equal((await request("GET", "/worktrees" + query())).worktrees.length, 1);
  await request("GET", query(foreign), undefined, 400);
  const { worktree } = await request("POST", "/worktrees", { path: repo, name: "isolated", branch: "feature/api" });
  const cwd = worktree.cwd;
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feature\n");
  await request("POST", "/stage", { path: repo, cwd, files: ["feature.txt"] });
  await request("POST", "/commit", { path: repo, cwd, message: "feature", staged: true });
  const overview = await request("GET", query(cwd));
  const tip = overview.commits[0].hash;
  assert.equal(overview.branch, "feature/api"); assert.equal(run(repo, "rev-parse", "HEAD").trim(), initial);
  const preview = await request("POST", "/preview", { path: repo, cwd, action: "uncommit", commit: tip });
  assert.equal(preview.action, "uncommit"); assert.equal(typeof preview.diff, "string");
  const undone = await request("POST", "/execute", { path: repo, cwd, previewId: preview.previewId });
  assert.equal(run(cwd, "rev-parse", "HEAD").trim(), initial);
  const recoveries = await request("GET", "/recovery" + query(cwd));
  assert.ok(recoveries.recoveries.some(item => item.id === undone.recoveryId));
  await request("POST", "/restore", { path: repo, cwd, recoveryId: undone.recoveryId, expectedHead: initial });
  const merge = await request("POST", "/preview", { path: repo, action: "merge", branch: "feature/api" });
  await request("POST", "/execute", { path: repo, previewId: merge.previewId });
  assert.ok(fs.existsSync(path.join(repo, "feature.txt")));
  await request("POST", "/worktrees/remove", { path: repo, cwd, removeFolder: true, deleteBranch: true, expectedHead: tip, expectedBranch: "feature/api" });
  assert.ok(!fs.existsSync(cwd)); assert.ok(!run(repo, "branch", "--list", "feature/api").trim());
  assert.equal((await request("GET", "/worktrees" + query())).worktrees.length, 1);
});
