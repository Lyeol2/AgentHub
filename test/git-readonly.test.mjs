import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { diffSince, changedFiles } from "../server/git.mjs";
import { gitOverview } from "../server/gitpanel.mjs";
import { GitHubPulls } from "../server/github.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-git-readonly-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("agenthub-git-readonly-"));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  run("init", "-q");
  for (const [key, value] of [["user.name", "test"], ["user.email", "test@test"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["core.fsmonitor", "false"], ["core.untrackedCache", "false"], ["diff.autoRefreshIndex", "true"]]) run("config", key, value);
  const tracked = path.join(dir, "tracked.txt");
  fs.writeFileSync(tracked, "unchanged contents\n");
  run("add", ".");
  run("commit", "-qm", "initial");
  const base = run("rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(dir, "brand-new.txt"), "새 파일의 내용\n");
  const index = path.join(dir, ".git", "index");
  const before = fs.readFileSync(index), stat = fs.statSync(index, { bigint: true });
  // Make cached stat data stale without changing content or manually altering the index.
  const changedTime = new Date(Date.now() + 60_000);
  fs.utimesSync(tracked, changedTime, changedTime);
  return { dir, base, index, before, stat };
}

for (const [name, read] of [
  ["변경 보기", async (f) => {
    const result = await diffSince(f.dir, f.base);
    assert.match(result.status, /\?\? brand-new\.txt/);
    assert.match(result.diff, /\+새 파일의 내용/);
  }],
  ["바뀐 파일 목록", async (f) => {
    assert.equal(await changedFiles(f.dir, f.base), "A\tbrand-new.txt");
  }],
  ["Git 패널", async (f) => {
    const result = await gitOverview(f.dir);
    assert.deepEqual(result.files.map((file) => file.path), ["brand-new.txt"]);
  }],
  ["PR 로컬 상태", async (f) => {
    const result = await new GitHubPulls().local(f.dir);
    assert.equal(result.dirtyCount, 1);
    assert.equal(result.headSha, f.base);
  }],
]) {
  test("git read-only: " + name + " 조회는 stat 캐시가 낡아도 index를 다시 쓰지 않는다", async (t) => {
    const f = fixture(t);
    await read(f);
    assert.deepEqual(fs.readFileSync(f.index), f.before);
    assert.equal(fs.statSync(f.index, { bigint: true }).mtimeNs, f.stat.mtimeNs);
  });
}

test("git read-only: 동일 저장소 병렬 조회도 새 파일 diff와 index를 보존한다", async (t) => {
  const f = fixture(t);
  const [diff, files, overview, local] = await Promise.all([
    diffSince(f.dir, f.base), changedFiles(f.dir, f.base), gitOverview(f.dir), new GitHubPulls().local(f.dir),
  ]);
  assert.match(diff.diff, /\+새 파일의 내용/);
  assert.equal(files, "A\tbrand-new.txt");
  assert.equal(overview.files[0].path, "brand-new.txt");
  assert.equal(local.dirtyCount, 1);
  assert.deepEqual(fs.readFileSync(f.index), f.before);
  assert.equal(fs.statSync(f.index, { bigint: true }).mtimeNs, f.stat.mtimeNs);
});

test("git read-only: 새 파일 조회 실패를 빈 diff로 숨기지 않는다", async (t) => {
  const mock = t.mock.method(childProcess, "execFile", (_file, args, _options, callback) => {
    queueMicrotask(() => args.includes("ls-files")
      ? callback(new Error("forced index read failure"), "", "fatal: forced index read failure")
      : callback(null, args.includes("status") ? "?? brand-new.txt\n" : "", ""));
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(diffSince("fixture", "HEAD"), /forced index read failure/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});


test("git read-only: stat-only 파일을 제외해도 커밋·스테이징·삭제·이름·바이너리·모드 변경은 보존한다", async (t) => {
  const f = fixture(t);
  const run = (...args) => execFileSync("git", args, { cwd: f.dir, encoding: "utf8", windowsHide: true });
  for (const [name, contents] of [["old name.txt", "rename me\n"], ["deleted.txt", "delete me\n"], ["blank.txt", "one\n"], ["mode.txt", "mode\n"]]) fs.writeFileSync(path.join(f.dir, name), contents);
  fs.writeFileSync(path.join(f.dir, "binary.bin"), Buffer.from([0, 1, 2]));
  run("add", "."); run("commit", "-qm", "fixtures");
  const base = run("rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(f.dir, "committed.txt"), "committed after base\n");
  run("add", "committed.txt"); run("commit", "-qm", "after base");
  run("mv", "old name.txt", "renamed 한글.txt");
  run("update-index", "--chmod=+x", "mode.txt");
  fs.rmSync(path.join(f.dir, "deleted.txt"));
  fs.writeFileSync(path.join(f.dir, "blank.txt"), "one\n\n");
  fs.writeFileSync(path.join(f.dir, "binary.bin"), Buffer.from([0, 3, 4]));
  fs.writeFileSync(path.join(f.dir, "staged.txt"), "staged\n"); run("add", "staged.txt");
  fs.writeFileSync(path.join(f.dir, "newer.txt"), "untracked\n");
  fs.utimesSync(path.join(f.dir, "tracked.txt"), new Date(), new Date(Date.now() + 120_000));
  const before = fs.readFileSync(f.index);
  const files = await changedFiles(f.dir, base);
  for (const line of ["A\tcommitted.txt", "A\tstaged.txt", "D\tdeleted.txt", "M\tblank.txt", "M\tbinary.bin", "M\tmode.txt", "R100\told name.txt\trenamed 한글.txt", "A\tnewer.txt"]) {
    assert.ok(files.split("\n").includes(line), line + " in " + files);
  }
  assert.doesNotMatch(files, /tracked\.txt/);
  assert.deepEqual(fs.readFileSync(f.index), before);
});
