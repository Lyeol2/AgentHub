import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitHubPulls, parseGitHubRemote, normalizePull, summarizeChecks, runGitHubCommand, gitAuthFailure, githubCredentialArgs } from "../server/github.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-pulls-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let sequence = 0;
let seed;
function seedRepository() {
  const dir = path.join(tmp, "seed");
  fs.mkdirSync(dir);
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  git("init", "-q", "-b", "feature");
  git("config", "user.name", "t"); git("config", "user.email", "t@t"); git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "file.txt"), "base\n");
  git("add", "."); git("commit", "-qm", "기능 제목\n\n본문");
  git("remote", "add", "origin", "https://github.com/acme/widget.git");
  return { dir, sha: git("rev-parse", "HEAD").trim() };
}
function fixture() {
  seed ??= seedRepository();
  const dir = path.join(tmp, String(++sequence));
  // Copy the working tree and .git, including independent index/config/refs files.
  // Only repository preparation is reused; all tested Git commands still run for real.
  fs.cpSync(seed.dir, dir, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  const sha = seed.sha;
  const state = { sha, remoteSha: sha, existing: [], calls: [], auth: true, fail: null, push: null, readiness: "CLEAN",
    info: { default_branch: "main", permissions: { push: true }, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false },
    pull: { number: 7, title: "기능", body: "내용", state: "open", draft: false, user: { login: "coder" }, head: { ref: "feature", sha }, base: { ref: "main" },
      additions: 2, deletions: 1, changed_files: 1, mergeable: true, mergeable_state: "clean", html_url: "javascript:alert(1)" } };
  const client = new GitHubPulls({ locate: () => "fake-gh", run: async (file, args, options) => {
    state.calls.push({ file, args, options });
    if (file === "git") {
      if (args.includes("push")) return state.push ? state.push(args, options) : "published"; // No test can send a real push.
      return runGitHubCommand(file, args, options);
    }
    if (args[0] === "auth") { if (!state.auth) throw new Error("bad token"); return "logged in"; }
    if (args[0] === "pr") return JSON.stringify({ headRefOid: sha, mergeStateStatus: state.readiness, reviewDecision: "APPROVED",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "PENDING" }, { status: "COMPLETED", conclusion: "FAILURE" }] });
    const endpoint = args.find((arg) => arg.startsWith("repos/"));
    const method = args[args.indexOf("--method") + 1];
    const data = options.input === undefined ? undefined : JSON.parse(options.input);
    if (state.fail) await state.fail({ endpoint, method, data, args });
    if (endpoint === "repos/acme/widget") return JSON.stringify(state.info);
    if (endpoint === "repos/acme/widget/branches?per_page=100") return JSON.stringify([{ name: "feature" }]); // default branch outside first page.
    if (endpoint?.startsWith("repos/acme/widget/branches/")) {
      const branch = decodeURIComponent(endpoint.slice("repos/acme/widget/branches/".length));
      const branchSha = branch === "main" ? "b".repeat(40) : state.remoteSha;
      if (!branchSha) throw new Error("gh: Branch not found (HTTP 404)");
      return JSON.stringify({ commit: { sha: branchSha } });
    }
    if (endpoint?.includes("/pulls?state=open&head=")) return JSON.stringify(state.existing);
    if (endpoint?.includes("/pulls?")) return JSON.stringify([state.pull]);
    if (endpoint === "repos/acme/widget/pulls" && method === "POST") {
      state.pull = { ...state.pull, ...data, head: { ref: data.head, sha }, base: { ref: data.base } }; state.existing = [state.pull];
      return JSON.stringify(state.pull);
    }
    if (endpoint === "repos/acme/widget/pulls/7/merge") return JSON.stringify({ merged: true, message: "merged" });
    if (endpoint === "repos/acme/widget/pulls/7/files?per_page=100") return JSON.stringify([{ filename: "file.txt", status: "modified", additions: 2, deletions: 1 }]);
    if (endpoint === "repos/acme/widget/pulls/7") {
      if (method === "PATCH") state.pull = { ...state.pull, ...data };
      if (args.includes("Accept: application/vnd.github.diff")) return "diff --git a/file.txt b/file.txt\n+new\n";
      return JSON.stringify(state.pull);
    }
    throw new Error("Unexpected mock command " + JSON.stringify(args));
  } });
  const body = { repo: "acme/widget", remote: "origin", expectedHead: sha, branch: "feature", head: "feature", base: "main", title: "새 PR", body: "본문", draft: false };
  return { dir, git, sha, state, client, body };
}
const writes = (state) => state.calls.filter((call) => call.file === "fake-gh" && ["POST", "PUT", "PATCH"].includes(call.args[call.args.indexOf("--method") + 1]));

test("github: 복사한 저장소의 작업 파일·index·설정·HEAD는 다른 검사와 분리된다", () => {
  const first = fixture();
  const second = fixture();
  fs.writeFileSync(path.join(first.dir, "file.txt"), "first only\n");
  first.git("add", "file.txt");
  first.git("remote", "set-url", "origin", "https://github.com/other/repo.git");
  assert.equal(second.git("status", "--porcelain").trim(), "");
  assert.equal(second.git("show", ":file.txt").trim(), "base");
  assert.equal(fs.readFileSync(path.join(second.dir, "file.txt"), "utf8"), "base\n");
  assert.equal(second.git("remote", "get-url", "origin").trim(), "https://github.com/acme/widget.git");
  first.git("commit", "-qm", "first only");
  assert.notEqual(first.git("rev-parse", "HEAD").trim(), second.sha);
  assert.equal(second.git("rev-parse", "HEAD").trim(), second.sha);
  const third = fixture(); // The seed also stays unchanged for later tests.
  assert.equal(third.git("rev-parse", "HEAD").trim(), second.sha);
  assert.equal(third.git("status", "--porcelain").trim(), "");
  assert.equal(third.git("remote", "get-url", "origin").trim(), "https://github.com/acme/widget.git");
});

test("github: GitHub.com 원격만 허용하고 외부 응답 URL은 쓰지 않는다", () => {
  for (const value of ["https://github.com/acme/widget.git", "git@github.com:acme/widget.git", "ssh://git@github.com/acme/widget.git"])
    assert.deepEqual(parseGitHubRemote(value), { repo: "acme/widget", url: "https://github.com/acme/widget" });
  for (const value of ["https://github.com.evil/acme/widget", "https://token@github.com/acme/widget", "file:///acme/widget", "https://gitlab.com/acme/widget",
    "https://github.com/acme/widget?token=x", "ssh://evil@github.com/acme/widget", "https://github.com/acme/widget/extra", "git@github.com:acme/..",
    "https://ghp_abc123@github.com/acme/widget", "https://user:secret@github.com/acme/widget", "https://www.github.com.evil/acme/widget"])
    assert.equal(parseGitHubRemote(value), null);
  // git이 그대로 fetch하는 주소는 같은 저장소로 본다.
  for (const value of ["http://github.com/acme/widget.git", "https://www.github.com/acme/widget"])
    assert.deepEqual(parseGitHubRemote(value), { repo: "acme/widget", url: "https://github.com/acme/widget" });
  assert.equal(parseGitHubRemote("https://github.com/sinji_corp/widget.git")?.repo, "sinji_corp/widget");
  assert.equal(normalizePull({ number: 7, html_url: "javascript:alert(1)" }, "acme/widget").url, "https://github.com/acme/widget/pull/7");
  assert.throws(() => normalizePull({ number: "../evil" }, "acme/widget"), /PR 번호/);
  assert.deepEqual(summarizeChecks([{ state: "SUCCESS" }, { conclusion: "SKIPPED" }, { state: "PENDING" }, { conclusion: "TIMED_OUT" }, { state: "ERROR" }]),
    { total: 5, passed: 2, pending: 1, failed: 2 });
});

test("github: Git 인증 실패를 로그인 안내로 바꾸고 GitHub CLI 자격 증명을 이어 붙인다", () => {
  for (const text of ["fatal: Cannot prompt because user interactivity has been disabled.\nfatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/acme/widget.git/'", "remote: Repository not found."])
    assert.equal(gitAuthFailure(text)?.reason, "git-auth");
  assert.equal(gitAuthFailure("git@github.com: Permission denied (publickey).")?.reason, "git-auth-ssh");
  assert.equal(gitAuthFailure("fatal: couldn't find remote ref main"), null);
  assert.deepEqual(githubCredentialArgs("C:\\Program Files\\GitHub CLI\\gh.exe"),
    ["-c", 'credential.https://github.com.helper=!"C:/Program Files/GitHub CLI/gh.exe" auth git-credential']);
  assert.deepEqual(githubCredentialArgs(null), []);
  assert.deepEqual(githubCredentialArgs('/tmp/$(evil)/gh'), []);
});

test("github: shell 없이 stdin을 보내고 명령 시간을 제한한다", async () => {
  const input = "@secret\n$(command) " + String.fromCharCode(96) + "literal 한글";
  assert.equal(await runGitHubCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input }), input);
  const start = Date.now();
  await assert.rejects(runGitHubCommand(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { timeout: 30 }), (error) => error.timedOut);
  assert.ok(Date.now() - start < 2000, "timeout must return before the command finishes");
});

test("github: CLI·로그인·GitHub 원격이 없으면 해결 가능한 사유를 반환한다", async () => {
  const f = fixture(); f.client.locate = () => null;
  await assert.rejects(f.client.list(f.dir), (error) => error.reason === "gh-missing");
  f.client.locate = () => "fake-gh"; f.state.auth = false;
  await assert.rejects(f.client.list(f.dir), (error) => error.reason === "gh-auth");
  f.git("remote", "set-url", "origin", "https://gitlab.com/acme/widget");
  await assert.rejects(f.client.list(f.dir), (error) => error.reason === "github-unsupported" && error.message.includes("origin: https://gitlab.com/acme/widget"));
  f.git("remote", "remove", "origin");
  await assert.rejects(f.client.list(f.dir), (error) => error.reason === "github-remote");
});

test("github: 목록에 브랜치 게시 상태·기본 브랜치·허용 병합 방식을 담는다", async () => {
  const f = fixture(); const result = await f.client.list(f.dir, { state: "closed" });
  assert.deepEqual([result.context.repo, result.context.remote, result.context.branch, result.context.headSha], ["acme/widget", "origin", "feature", f.sha]);
  assert.deepEqual([result.context.needsPush, result.context.canPush, result.context.canCreate], [false, true, true]);
  assert.deepEqual(result.context.mergeMethods, ["merge", "squash"]);
  assert.deepEqual(result.context.baseBranches, ["main", "feature"]);
  assert.equal(result.context.lastCommit.subject, "기능 제목");
  assert.ok(f.state.calls.some((call) => call.args.includes("repos/acme/widget/pulls?state=closed&sort=updated&direction=desc&per_page=50")));
  f.state.remoteSha = "c".repeat(40);
  const unpushed = await f.client.list(f.dir);
  assert.deepEqual([unpushed.context.needsPush, unpushed.context.canCreate], [true, false]);
});

test("github: 상세 검사·파일·diff를 읽고 diff 실패도 본문을 보존한다", async () => {
  const f = fixture(); const result = await f.client.detail(f.dir, "7");
  assert.deepEqual(result.pull.checks, { total: 3, passed: 1, pending: 1, failed: 1 });
  assert.equal(result.pull.reviewDecision, "APPROVED"); assert.equal(result.pull.files[0].path, "file.txt"); assert.match(result.diff, /\+new/);
  f.state.fail = async ({ args }) => { if (args.includes("Accept: application/vnd.github.diff")) throw new Error("HTTP 403 diff restricted"); };
  const restricted = await f.client.detail(f.dir, 7);
  assert.equal(restricted.pull.title, "기능"); assert.match(restricted.diffError, /403/);
  await assert.rejects(f.client.detail(f.dir, "--help"), /PR 번호/);
});

test("github: PR 생성은 게시된 현재 브랜치만 쓰고 JSON stdin으로 본문을 보낸다", async () => {
  const f = fixture(); f.body.title = "@C:/secret"; f.body.body = "true\n$(no shell)\n한글"; f.body.draft = true;
  const result = await f.client.create(f.dir, f.body);
  assert.equal(result.pull.isDraft, true);
  const [call] = writes(f.state);
  assert.equal(writes(f.state).length, 1); assert.ok(call.args.includes("--input")); assert.ok(!call.args.includes("-F"));
  assert.deepEqual(JSON.parse(call.options.input), { title: f.body.title, body: f.body.body, head: "feature", base: "main", draft: true });
  assert.equal(f.state.calls.some((call) => call.args.includes("push")), false);
  await assert.rejects(f.client.create(f.dir, f.body), (error) => error.reason === "pull-exists");
  assert.equal(writes(f.state).length, 1);
});

test("github: 게시되지 않거나 화면 이후 바뀐 브랜치로 PR을 만들지 않는다", async () => {
  const f = fixture(); f.state.remoteSha = null;
  await assert.rejects(f.client.create(f.dir, f.body), (error) => error.reason === "branch-unpublished");
  f.state.remoteSha = f.sha;
  for (const body of [{ ...f.body, expectedHead: "d".repeat(40) }, { ...f.body, repo: "other/repo" }, { ...f.body, head: "other", branch: "other" }])
    await assert.rejects(f.client.create(f.dir, body), (error) => error.reason === "stale-head");
  assert.equal(writes(f.state).length, 0);
});

test("github: 병합 SHA·방식·보호 조건을 확인하고 관리자 우회를 하지 않는다", async () => {
  const f = fixture();
  await assert.rejects(f.client.merge(f.dir, 7, { ...f.body, method: "merge", sha: "d".repeat(40) }), (error) => error.reason === "stale-head");
  await assert.rejects(f.client.merge(f.dir, 7, { ...f.body, method: "rebase", sha: f.sha }), /허용하지 않는/);
  for (const status of ["BLOCKED", "BEHIND", "UNKNOWN", "DIRTY"]) {
    f.state.readiness = status;
    await assert.rejects(f.client.merge(f.dir, 7, { ...f.body, method: "squash", sha: f.sha }), (error) => error.reason === "pull-blocked");
  }
  assert.equal(writes(f.state).length, 0); f.state.readiness = "CLEAN";
  const result = await f.client.merge(f.dir, 7, { ...f.body, method: "squash", sha: f.sha });
  assert.equal(result.pull.state, "MERGED");
  assert.deepEqual(JSON.parse(writes(f.state)[0].options.input), { merge_method: "squash", sha: f.sha });
  assert.equal(f.state.calls.some((call) => call.args.includes("--admin") || call.args.includes("--auto") || call.args.includes("--delete-branch")), false);
});

test("github: 닫기는 PR 상태만 바꾸고 이미 닫힌 PR은 재요청하지 않는다", async () => {
  const f = fixture(); const result = await f.client.close(f.dir, 7, f.body);
  assert.equal(result.pull.state, "CLOSED"); assert.deepEqual(JSON.parse(writes(f.state)[0].options.input), { state: "closed" });
  await f.client.close(f.dir, 7, f.body); assert.equal(writes(f.state).length, 1);
  f.state.pull.merged = true; await assert.rejects(f.client.close(f.dir, 7, f.body), /이미 병합/);
});

test("github: push는 검증한 주소·SHA·전체 ref만 쓰고 force·tag·submodule을 보내지 않는다", async () => {
  const f = fixture(); assert.equal((await f.client.push(f.dir, f.body)).ok, true);
  const push = f.state.calls.find((call) => call.file === "git" && call.args.includes("push"));
  assert.ok(push.args.includes("https://github.com/acme/widget.git")); assert.ok(push.args.includes(f.sha + ":refs/heads/feature"));
  assert.ok(push.args.includes("--no-follow-tags")); assert.ok(push.args.includes("--recurse-submodules=no"));
  assert.equal(push.args.some((arg) => arg === "--force" || arg === "-f" || arg.startsWith("+")), false);
  f.git("remote", "set-url", "--add", "--push", "origin", "https://github.com/acme/widget.git");
  f.git("remote", "set-url", "--add", "--push", "origin", "https://github.com/other/repo.git");
  await assert.rejects(f.client.push(f.dir, f.body), /여러 개/);
  assert.equal(f.state.calls.filter((call) => call.file === "git" && call.args.includes("push")).length, 1);
});

test("github: 원격 변경 timeout·5xx는 완료 불명이며 자동 재시도하지 않는다", async () => {
  const f = fixture(); f.state.fail = async ({ method }) => { if (method === "POST") throw new Error("HTTP 502 gateway"); };
  await assert.rejects(f.client.create(f.dir, f.body), (error) => error.outcomeUnknown && error.status === 502);
  assert.equal(writes(f.state).length, 1);
  f.state.push = async () => { const error = new Error("timeout"); error.timedOut = true; throw error; };
  await assert.rejects(f.client.push(f.dir, f.body), (error) => error.reason === "github-timeout" && error.outcomeUnknown);
  assert.equal(f.state.calls.filter((call) => call.file === "git" && call.args.includes("push")).length, 1);
});

test("github: 연속 PR 생성은 직렬화하여 중복 원격 변경을 막는다", async () => {
  const f = fixture(); const result = await Promise.allSettled([f.client.create(f.dir, f.body), f.client.create(f.dir, f.body)]);
  assert.equal(result.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(result.filter((item) => item.status === "rejected" && item.reason.reason === "pull-exists").length, 1);
  assert.equal(writes(f.state).length, 1);
});
