import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitHubPulls, GitHubError, parseGitHubRemote, normalizePull, normalizeLabels, labelNames, summarizeChecks, runGitHubCommand, gitAuthFailure, githubCredentialArgs, gitflowPullBases } from "../server/github.mjs";
import { DEFAULT_GITFLOW_SETTINGS, normalizeGitflowSettings } from "../server/gitflow-settings.mjs";

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
  const state = { sha, remoteSha: sha, existing: [], calls: [], auth: true, fail: null, push: null, readiness: "CLEAN", review: "APPROVED", waits: [],
    info: { default_branch: "main", permissions: { push: true }, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false },
    pull: { number: 7, title: "기능", body: "내용", state: "open", draft: false, user: { login: "coder" }, head: { ref: "feature", sha }, base: { ref: "main" },
      additions: 2, deletions: 1, changed_files: 1, mergeable: true, mergeable_state: "clean", html_url: "javascript:alert(1)" } };
  const client = new GitHubPulls({ locate: () => "fake-gh", wait: async (ms) => { state.waits.push(ms); }, run: async (file, args, options) => {
    state.calls.push({ file, args, options });
    if (file === "git") {
      if (args.includes("push")) return state.push ? state.push(args, options) : "published"; // No test can send a real push.
      return runGitHubCommand(file, args, options);
    }
    if (args[0] === "auth") { if (!state.auth) throw new Error("bad token"); return "logged in"; }
    if (args[0] === "pr") return JSON.stringify({ headRefOid: sha, mergeStateStatus: Array.isArray(state.readiness) ? state.readiness.shift() ?? "CLEAN" : state.readiness, reviewDecision: state.review,
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "PENDING" }, { status: "COMPLETED", conclusion: "FAILURE" }] });
    const endpoint = args.find((arg) => arg.startsWith("repos/"));
    const method = args[args.indexOf("--method") + 1];
    const data = options.input === undefined ? undefined : JSON.parse(options.input);
    if (state.fail) await state.fail({ endpoint, method, data, args });
    if (endpoint === "repos/acme/widget") return JSON.stringify(state.info);
    if (endpoint === "repos/acme/widget/branches?per_page=100") return JSON.stringify([{ name: "feature" }]); // default branch outside first page.
    if (endpoint?.startsWith("repos/acme/widget/branches/")) {
      const branch = decodeURIComponent(endpoint.slice("repos/acme/widget/branches/".length));
      const branchSha = state.missingBranches?.includes(branch) ? null : branch === "main" ? "b".repeat(40) : state.remoteSha;
      if (!branchSha) throw new Error("gh: Branch not found (HTTP 404)");
      return JSON.stringify({ commit: { sha: branchSha } });
    }
    if (endpoint?.includes("/pulls?state=open&head=")) return JSON.stringify(state.existing);
    if (endpoint?.includes("/pulls?")) return JSON.stringify([state.pull]);
    if (endpoint === "repos/acme/widget/pulls" && method === "POST") {
      state.pull = { ...state.pull, ...data, head: { ref: data.head, sha }, base: { ref: data.base } }; state.existing = [state.pull];
      return JSON.stringify(state.pull);
    }
    if (endpoint === "repos/acme/widget/issues/7/labels" && method === "POST") return JSON.stringify(data.labels.map((name) => ({ name, color: "ededed" })));
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

test("github: gh 미설치·미로그인·권한 오류를 해결 방법이 담긴 사유로 바꾼다", () => {
  const client = new GitHubPulls({ locate: () => "gh" });
  const fail = (extra) => client.failure(Object.assign(new Error(extra.stderr ?? "failed"), extra));
  assert.equal(fail({ code: "ENOENT" }).reason, "gh-missing");
  assert.equal(fail({ stderr: "To get started with GitHub CLI, please run:  gh auth login" }).reason, "gh-auth");
  assert.equal(fail({ stderr: "gh: Bad credentials (HTTP 401)" }).reason, "gh-auth");
  const denied = fail({ stderr: "gh: Resource not accessible by integration (HTTP 403)" });
  assert.deepEqual([denied.reason, denied.status, denied.outcomeUnknown], ["gh-permission", 403, false]);
  assert.match(denied.message, /권한.*\n.*HTTP 403/s);
  assert.equal(fail({ stderr: "gh: API rate limit exceeded for user (HTTP 403)" }).reason, "github-rate-limit");
  assert.equal(fail({ stderr: "gh: Issues are disabled for this repo (HTTP 410)" }).reason, "github-issues-disabled");
  // 이슈·라벨 확인은 404 응답 문구로 없음을 판별한다.
  assert.match(fail({ stderr: "gh: Not Found (HTTP 404)" }).message, /\bHTTP 404\b/);
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

test("github: 병합 가능 여부를 계산 중(UNKNOWN)이면 잠깐 기다려 다시 묻고, 막힌 이유는 상태별로 알린다", async () => {
  const f = fixture();
  f.state.readiness = ["UNKNOWN", "UNKNOWN", "CLEAN"];
  assert.equal((await f.client.merge(f.dir, 7, { ...f.body, method: "squash", sha: f.sha })).pull.state, "MERGED");
  assert.equal(f.state.waits.length, 2);
  const g = fixture();
  g.state.readiness = "UNKNOWN";
  await assert.rejects(g.client.merge(g.dir, 7, { ...g.body, method: "squash", sha: g.sha }), (error) => error.reason === "pull-blocked" && /계산하고 있습니다/.test(error.message));
  assert.equal(g.state.waits.length, 3, "UNKNOWN은 정해진 횟수만 다시 묻는다");
  for (const [status, text] of [["BEHIND", /뒤처져/], ["DIRTY", /충돌/], ["BLOCKED", /보호 규칙/], ["UNSTABLE", /검사/], ["DRAFT", /초안/]]) {
    g.state.readiness = status;
    await assert.rejects(g.client.merge(g.dir, 7, { ...g.body, method: "squash", sha: g.sha }), (error) => error.reason === "pull-blocked" && text.test(error.message), status);
  }
  g.state.readiness = "CLEAN";
  for (const [review, text] of [["REVIEW_REQUIRED", /승인 리뷰가 필요/], ["CHANGES_REQUESTED", /변경을 요청/]]) {
    g.state.review = review;
    await assert.rejects(g.client.merge(g.dir, 7, { ...g.body, method: "squash", sha: g.sha }), (error) => text.test(error.message), review);
  }
  assert.equal(writes(g.state).length, 0);
});

test("github: 원격에 받지 않은 커밋이 있어 거절된 푸시는 결과 불확실로 남기지 않는다", async () => {
  const f = fixture();
  f.state.push = () => { throw Object.assign(Error("push failed"), { stderr: " ! [rejected]        feature -> feature (fetch first)\nerror: failed to push some refs" }); };
  await assert.rejects(f.client.push(f.dir, f.body), (error) => error.reason === "git-push-rejected" && !error.outcomeUnknown && error.status === 409);
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

test("github: GitFlow 브랜치별 PR 대상 브랜치를 정한다", () => {
  const flow = DEFAULT_GITFLOW_SETTINGS;
  assert.deepEqual(gitflowPullBases(flow, "feature/login").allowed, ["develop"]);
  assert.deepEqual([gitflowPullBases(flow, "hotfix/1.0.1").suggested, gitflowPullBases(flow, "hotfix/1.0.1").allowed], ["main", ["main", "develop"]]);
  assert.deepEqual(gitflowPullBases(flow, "release/1.1.0").allowed, ["main", "develop"]);
  assert.deepEqual(gitflowPullBases(flow, "main").allowed, ["develop"]);
  assert.deepEqual(gitflowPullBases(flow, "develop").allowed, []);
  assert.deepEqual([gitflowPullBases(flow, "agenthub/review").suggested, gitflowPullBases(flow, "agenthub/review").allowed], ["develop", null]);
  // 사용자 지정 이름과 접두어를 따른다.
  const custom = normalizeGitflowSettings({ main: "master", develop: "dev", featurePrefix: "feat" });
  assert.deepEqual(gitflowPullBases(custom, "feat/x").allowed, ["dev"]);
  assert.equal(gitflowPullBases(custom, "feature/x").allowed, null);
  assert.equal(gitflowPullBases(undefined, "feature/x").allowed, null);
});

test("github: PR 목록은 GitFlow 대상 브랜치만 고르게 하고 기본값을 develop으로 둔다", async () => {
  const f = fixture(); f.git("branch", "-m", "work"); f.git("checkout", "-qb", "feature/login");
  const { context } = await f.client.list(f.dir, { gitflow: DEFAULT_GITFLOW_SETTINGS });
  assert.deepEqual([context.allowedBases, context.suggestedBase, context.canCreate], [["develop"], "develop", true]);
  assert.ok(context.baseBranches.includes("develop"), "첫 페이지 밖의 develop도 대상 후보에 넣는다");
  f.state.missingBranches = ["develop"];
  const missing = (await f.client.list(f.dir, { gitflow: DEFAULT_GITFLOW_SETTINGS })).context;
  assert.deepEqual([missing.allowedBases, missing.canCreate], [[], false]);
  assert.match(missing.createReason, /develop 브랜치가 없습니다/);
  f.state.missingBranches = [];
  f.git("checkout", "-qb", "develop");
  const develop = (await f.client.list(f.dir, { gitflow: DEFAULT_GITFLOW_SETTINGS })).context;
  assert.equal(develop.canCreate, false); assert.match(develop.createReason, /release\//);
  f.git("checkout", "-qb", "hotfix/1.0.1");
  const hotfix = (await f.client.list(f.dir, { gitflow: DEFAULT_GITFLOW_SETTINGS })).context;
  assert.deepEqual([hotfix.allowedBases, hotfix.suggestedBase], [["main", "develop"], "main"]);
});

test("github: GitFlow를 어기는 대상 브랜치로는 PR을 만들지 않는다", async () => {
  const f = fixture(); f.git("branch", "-m", "work"); f.git("checkout", "-qb", "feature/login");
  const body = { ...f.body, branch: "feature/login", head: "feature/login", base: "main" };
  await assert.rejects(f.client.create(f.dir, body, { gitflow: DEFAULT_GITFLOW_SETTINGS }), (error) => error.reason === "gitflow-base" && error.status === 409);
  assert.equal(writes(f.state).length, 0);
  const result = await f.client.create(f.dir, { ...body, base: "develop" }, { gitflow: DEFAULT_GITFLOW_SETTINGS });
  assert.equal(result.pull.baseRefName, "develop");
  assert.deepEqual(JSON.parse(writes(f.state)[0].options.input).base, "develop");
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

test("github: PR 라벨을 정리해 보여 주고, 붙이고 떼며, PR을 만들 때 함께 붙인다", async () => {
  assert.deepEqual(normalizeLabels([{ name: "bug", color: "d73a4a" }, { name: "ui", color: "javascript:" }, "docs", { name: "" }]),
    [{ name: "bug", color: "d73a4a" }, { name: "ui", color: "" }, { name: "docs", color: "" }]);
  assert.deepEqual(normalizePull({ number: 3, state: "open", labels: [{ name: "bug", color: "d73a4a" }] }, "acme/widget").labels, [{ name: "bug", color: "d73a4a" }]);
  assert.deepEqual(labelNames(" bug, ui ,bug,, "), ["bug", "ui"]);
  assert.throws(() => labelNames(["x".repeat(51)]), /50자/);
  assert.throws(() => labelNames(["a\nb"]), /줄바꿈/);

  const calls = [];
  const client = new GitHubPulls({ locate: () => "gh" });
  client.target = async (dir) => ({ repo: "acme/widget", name: "origin", dir, file: "gh" });
  client.api = async (target, method, endpoint, data, options = {}) => {
    calls.push({ method, endpoint, data, options });
    if (method === "POST" && endpoint === "repos/acme/widget/issues/7/labels") return [{ name: "bug", color: "d73a4a" }, ...data.labels.map((name) => ({ name, color: "ededed" }))];
    if (method === "DELETE" && endpoint === "repos/acme/widget/issues/7/labels/needs%20review") return [{ name: "bug", color: "d73a4a" }];
    if (method === "DELETE" && endpoint === "repos/acme/widget/issues/7/labels/gone") throw new GitHubError("gh: Label does not exist (HTTP 404)");
    throw new Error("Unexpected endpoint " + method + " " + endpoint);
  };
  const added = await client.labels(tmp, 7, { add: ["ui"], repo: "acme/widget" });
  assert.deepEqual(added.labels.map((label) => label.name), ["bug", "ui"]);
  assert.equal(calls[0].options.write, true);
  const removed = await client.labels(tmp, 7, { remove: ["needs review", "gone"], repo: "acme/widget" });
  assert.deepEqual(removed.labels.map((label) => label.name), ["bug"], "이미 없는 라벨을 떼도 실패하지 않는다");
  await assert.rejects(client.labels(tmp, 7, { repo: "acme/widget" }), /라벨을 고르세요/);
  await assert.rejects(client.labels(tmp, 7, { add: ["ui"], repo: "other/repo" }), /원격 저장소/);
});

test("github: PR을 만들 때 고른 라벨을 붙이고, 라벨만 실패하면 PR은 남기고 알린다", async () => {
  const f = fixture();
  const result = await f.client.create(f.dir, { ...f.body, labels: ["bug", " ui "] });
  assert.equal(result.pull.number, 7);
  assert.deepEqual(result.pull.labels.map((label) => label.name), ["bug", "ui"]);
  const label = f.state.calls.find((call) => call.args.includes("repos/acme/widget/issues/7/labels"));
  assert.deepEqual(JSON.parse(label.options.input), { labels: ["bug", "ui"] });

  const g = fixture();
  g.state.fail = ({ endpoint }) => { if (endpoint === "repos/acme/widget/issues/7/labels") throw new Error("gh: Validation Failed (HTTP 422)"); };
  const partial = await g.client.create(g.dir, { ...g.body, labels: ["bug"] });
  assert.equal(partial.ok, true);
  assert.match(partial.warning, /라벨을 붙이지 못했습니다/);
  await assert.rejects(fixture().client.create(f.dir, { ...f.body, labels: ["x".repeat(51)] }), /50자/);
});
