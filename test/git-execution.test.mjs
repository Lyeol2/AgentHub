import test from "node:test";
import assert from "node:assert/strict";
import { createReadQueue, isGitRead, shareGitRead, invalidateGitReads, scheduleGit } from "../server/git-execution.mjs";
import { readCommitSummaries, containsAnyCommit } from "../server/git-history.mjs";
import { runCommand } from "../server/command-process.mjs";

test("Git reads respect the shared concurrency budget and a failure releases its slot", async () => {
  const schedule = createReadQueue(3), releases = [];
  let active = 0, peak = 0;
  const requests = Array.from({ length: 12 }, (_, index) => schedule(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => releases.push(resolve));
    active--;
    if (index === 0) throw Error("failed read");
    return index;
  }));
  const settled = Promise.allSettled(requests);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 3);
  while (releases.length) {
    releases.splice(0).forEach(release => release());
    await new Promise(resolve => setImmediate(resolve));
  }
  const result = await settled;
  assert.equal(peak, 3); assert.equal(active, 0);
  assert.equal(result.filter(item => item.status === "fulfilled").length, 11);
});

test("a write invalidates shared reads without letting an older completion clear a newer read", async () => {
  invalidateGitReads();
  let finishOld, finishNew;
  const old = shareGitRead("fixture", () => new Promise(resolve => { finishOld = resolve; }));
  assert.equal(shareGitRead("fixture", () => assert.fail("duplicate read")), old);
  await Promise.resolve();
  await scheduleGit("git", ["-C", "repo", "reset", "--hard", "new-head"], () => {});
  const current = shareGitRead("fixture", () => new Promise(resolve => { finishNew = resolve; }));
  await Promise.resolve();
  finishOld("old"); await old;
  assert.equal(shareGitRead("fixture", () => assert.fail("newer read lost")), current);
  finishNew("new"); assert.equal(await current, "new");
  assert.equal(await shareGitRead("fixture", () => "fresh"), "fresh");
});

test("read classification does not route Git mutations into the read queue", () => {
  for (const args of [["status", "--porcelain"], ["-C", "repo", "-c", "x=y", "log"], ["worktree", "list"], ["remote", "get-url", "origin"], ["symbolic-ref", "--short", "HEAD"]]) assert.equal(isGitRead(args), true, String(args));
  for (const args of [["merge", "branch"], ["worktree", "add", "folder"], ["remote", "set-url", "origin", "url"], ["symbolic-ref", "HEAD", "refs/heads/other"], ["config", "branch.main.remote", "origin"], ["fetch", "origin"]]) assert.equal(isGitRead(args), false, String(args));
});

test("commit previews read hashes and subjects in one bounded query", async () => {
  let calls = 0;
  const hash = "a".repeat(40), other = "b".repeat(40);
  const commits = await readCommitSummaries("repo", "base..tip", { run: async (_, args) => {
    calls++; assert.ok(args.includes("--max-count=501")); assert.equal(args.at(-1), "base..tip");
    return `${hash}\0한글 subject with separators | ;\0${other}\0next\0`;
  } });
  assert.equal(calls, 1);
  assert.deepEqual(commits.map(commit => [commit.hash, commit.subject]), [[hash, "한글 subject with separators | ;"], [other, "next"]]);
});

test("published-history checks stream one traversal and preserve failures from unknown remote tips", async () => {
  const target = "a".repeat(40), tip = "b".repeat(40);
  let calls = 0;
  const found = await containsAnyCommit("repo", new Set([tip]), new Set([target]), { run: async (file, args, options) => {
    calls++; assert.equal(file, "git"); assert.ok(args.includes("--stdin")); assert.equal(options.input, tip + "\n");
    assert.equal(options.collectOutput, false);
    options.onStdout(tip + "\n" + target.slice(0, 17)); options.onStdout(target.slice(17) + "\n");
  } });
  assert.equal(calls, 1); assert.equal(found, true);
  await assert.rejects(containsAnyCommit("repo", new Set([tip]), new Set([target]), { run: async () => { throw Error("unknown object"); } }), /unknown object/);
});

test("streamed Git output does not consume the captured-output budget", async () => {
  let bytes = 0;
  const output = await runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], {
    maxBuffer: 32, collectOutput: false, onStdout: chunk => { bytes += chunk.length; },
  });
  assert.equal(bytes, 100000); assert.equal(output, "");
});

test("command failures retain stdout conflicts together with stderr warnings", async () => {
  await assert.rejects(runCommand(process.execPath, ["-e", "process.stdout.write('CONFLICT (content): Merge conflict in file'); process.stderr.write('warning: unrelated config permission'); process.exitCode = 1"]), error => {
    assert.match(error.message, /CONFLICT/); assert.match(error.message, /warning:/); return true;
  });
});
