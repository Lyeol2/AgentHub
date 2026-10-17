// git-client*.test.mjs가 함께 쓰는 저장소 픽스처. counter는 테스트가 임시 경로 이름에 쓰는 일련번호다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitFixtures, run } from "./git-fixture.mjs";
import { createGitClient } from "../server/git-client.mjs";

const repoFactory = gitFixtures(test, "agenthub-git-client-");
export let counter = 0;
export function fixture() {
  const repo = repoFactory("repo-" + ++counter);
  run(repo, "config", "core.autocrlf", "false");
  const add = (name, value, message = name) => {
    fs.writeFileSync(path.join(repo, name), value);
    run(repo, "add", "--", name); run(repo, "commit", "-qm", message);
    return run(repo, "rev-parse", "HEAD").trim();
  };
  const root = add("base.txt", "base\n", "root");
  const client = createGitClient();
  const ctx = () => client.context(repo);
  const execute = async (action, commit, extra = {}) => {
    const context = await ctx();
    const preview = await client.preview(context, { action, commit, ...extra });
    assert.ok(!preview.blockedReason, preview.blockedReason);
    return client.execute(context, { previewId: preview.previewId });
  };
  return { repo, root, client, add, ctx, execute, head: () => run(repo, "rev-parse", "HEAD").trim(), status: () => run(repo, "status", "--porcelain").trim() };
}

export function remoteFixture() {
  const f = fixture();
  const origin = f.repo + "-origin.git";
  run(path.dirname(f.repo), "init", "-q", "--bare", origin);
  run(f.repo, "remote", "add", "origin", origin);
  run(f.repo, "push", "-q", "-u", "origin", "main");
  const other = f.repo + "-other";
  run(path.dirname(f.repo), "clone", "-q", "-b", "main", origin, other);
  const push = (name, value) => {
    fs.writeFileSync(path.join(other, name), value);
    run(other, "add", "--", name); run(other, "commit", "-qm", name); run(other, "push", "-q", "origin", "main");
    return run(other, "rev-parse", "HEAD").trim();
  };
  return { ...f, origin, other, push };
}
