// GitHub.com Pull Requests. gh handles authentication; writes are explicit REST calls.
// Never use gh pr create: it may publish local branches implicitly.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { locateCli } from "./cli.mjs";
import { parseStatus } from "./gitpanel.mjs";

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const NUMBER = /^[1-9][0-9]{0,8}$/;
const DIFF_MAX = 1_500_000;
const API_VERSION = "2022-11-28";

export class GitHubError extends Error {
  constructor(message, reason = "github-error", status = 400, outcomeUnknown = false) {
    super(message);
    Object.assign(this, { reason, status, outcomeUnknown });
  }
}

const cleanError = (text) => String(text ?? "")
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
  .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[token]")
  .replace(/https?:\/\/[^/\s@]+@/g, "https://[credentials]@")
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim().slice(0, 1600);

// 백그라운드 Git 명령은 로그인 창을 띄울 수 없다. 인증 실패를 사용자가 해결할 수 있는 안내로 바꾼다.
const SSH_AUTH = /Permission denied \(publickey\)|Host key verification failed/i;
const HTTPS_AUTH = /could not read (?:Username|Password) for|Authentication failed for|Invalid username or (?:password|token)|user interactivity has been disabled|terminal prompts disabled|Repository not found|requested URL returned error: 40[13]/i;
export function gitAuthFailure(text) {
  const value = String(text ?? "");
  if (SSH_AUTH.test(value)) return new GitHubError("SSH 키로 GitHub에 접속하지 못했습니다. 이 PC의 SSH 키를 GitHub 계정에 등록하거나, 원격 주소를 https://github.com/<소유자>/<저장소>.git 형식으로 바꾼 뒤 GitHub에 로그인하세요.", "git-auth-ssh", 401);
  if (HTTPS_AUTH.test(value)) return new GitHubError("GitHub 로그인이 필요합니다. GitHub CLI로 로그인하면 AgentHub의 최신 확인·푸시도 그 계정을 씁니다. 이미 로그인했다면 그 계정에 이 저장소 접근 권한이 있는지 확인하세요.", "git-auth", 401);
  return null;
}

// 저장된 자격 증명이 없거나 만료됐을 때 GitHub CLI 로그인으로 이어 받는다.
// 기존 자격 증명 도우미가 먼저 시도되고, 사용자의 전역 Git 설정은 바꾸지 않는다.
export function githubCredentialArgs(gh = locateCli("gh", "")) {
  const file = String(gh ?? "").replace(/\\/g, "/");
  if (!file || /["$`\r\n]/.test(file)) return [];
  return ["-c", `credential.https://github.com.helper=!"${file}" auth git-credential`];
}

// Structured arguments and stdin only; no shell, prompts, pager, or debug token output.
export function runGitHubCommand(file, args, { cwd, input, timeout = 30_000, maxBuffer = 5_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GH_HOST: "github.com", GH_REPO: "", GH_DEBUG: "", DEBUG: "", GH_FORCE_TTY: "",
      GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0, timedOut = false, overflow = false;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", shell: false })
          .on("error", () => child.kill()).on("close", (code) => { if (code !== 0) child.kill(); });
      } else child.kill();
    };
    const abort = () => {
      stop();
      const error = new Error(timedOut ? "명령 응답 시간이 초과되었습니다." : "명령 출력이 너무 큽니다.");
      Object.assign(error, { timedOut, overflow, stderr, stdout });
      reject(error);
      // Helpers may retain inherited pipes after a failed tree termination.
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref();
    };
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
    const add = (name, data) => {
      size += Buffer.byteLength(data);
      if (size > maxBuffer) { overflow = true; clearTimeout(timer); abort(); return; }
      if (name === "stdout") stdout += data;
      else stderr += data;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => add("stdout", data));
    child.stderr.on("data", (data) => add("stderr", data));
    child.stdin.on("error", () => {});
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut && !overflow) return resolve(stdout);
      const error = new Error(cleanError(stderr || stdout) || "명령 실행에 실패했습니다.");
      Object.assign(error, { exitCode: code, timedOut, overflow, stderr, stdout });
      reject(error);
    });
    child.stdin.end(input ?? "");
  });
}

export function parseGitHubRemote(value) {
  const raw = String(value ?? "").trim();
  let owner, repo;
  const scp = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+)$/i);
  if (scp) [, owner, repo] = scp;
  else {
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase()) || url.search || url.hash || url.password) return null;
    if (url.protocol === "https:" || url.protocol === "http:") {
      // git이 https로 넘겨 주는 http 주소는 받되, 토큰이 섞일 수 있는 사용자 정보는 받지 않는다.
      if (url.username) return null;
      if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) return null;
    } else if (url.protocol === "ssh:") {
      if (url.username !== "git" || (url.port && url.port !== "22")) return null;
    } else return null;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (!match) return null;
    [, owner, repo] = match;
  }
  repo = repo.replace(/\.git$/i, "");
  // Enterprise Managed User 계정은 이름 뒤에 _회사코드가 붙는다.
  if (!/^[a-z0-9][a-z0-9-]{0,38}(?:_[a-z0-9]{1,20})?$/i.test(owner) || !/^[a-z0-9_.-]{1,100}$/i.test(repo) || repo === "." || repo === "..") return null;
  return { repo: owner + "/" + repo, url: "https://github.com/" + owner + "/" + repo };
}

export function summarizeChecks(checks = []) {
  const result = { total: 0, pending: 0, passed: 0, failed: 0 };
  for (const check of checks ?? []) {
    result.total++;
    const status = String(check.status ?? check.state ?? "").toUpperCase();
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion || status)) result.passed++;
    else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(conclusion || status)) result.failed++;
    else result.pending++;
  }
  return result;
}

export function normalizePull(raw, repo) {
  const number = Number(raw.number);
  if (!Number.isSafeInteger(number) || !NUMBER.test(String(number))) throw new GitHubError("GitHub가 올바르지 않은 PR 번호를 반환했습니다.");
  const merged = !!(raw.merged || raw.merged_at || raw.mergedAt || raw.state === "MERGED");
  const mergeable = typeof raw.mergeable === "boolean" ? raw.mergeable : raw.mergeable === "MERGEABLE" ? true : raw.mergeable === "CONFLICTING" ? false : null;
  return {
    number, title: String(raw.title ?? ""), body: String(raw.body ?? ""),
    url: "https://github.com/" + repo + "/pull/" + number,
    state: merged ? "MERGED" : String(raw.state).toLowerCase() === "closed" ? "CLOSED" : "OPEN",
    isDraft: !!(raw.draft ?? raw.isDraft), author: { login: String(raw.user?.login ?? raw.author?.login ?? "") },
    headRefName: String(raw.head?.ref ?? raw.headRefName ?? ""),
    baseRefName: String(raw.base?.ref ?? raw.baseRefName ?? ""),
    headRefOid: String(raw.head?.sha ?? raw.headRefOid ?? ""),
    createdAt: raw.created_at ?? raw.createdAt ?? null, updatedAt: raw.updated_at ?? raw.updatedAt ?? null,
    additions: raw.additions ?? null, deletions: raw.deletions ?? null, changedFiles: raw.changed_files ?? raw.changedFiles ?? null,
    mergeable, mergeStateStatus: String(raw.mergeStateStatus ?? raw.mergeable_state ?? "UNKNOWN").toUpperCase(),
    reviewDecision: String(raw.reviewDecision ?? ""), checks: summarizeChecks(raw.statusCheckRollup),
    files: (raw.files ?? []).map((file) => ({ path: file.filename ?? file.path, status: file.status ?? "", additions: file.additions ?? 0, deletions: file.deletions ?? 0 })),
    labels: normalizeLabels(raw.labels),
  };
}

// PR·이슈 라벨. 색은 GitHub의 6자리 16진수만 받는다.
export function normalizeLabels(labels) {
  return (Array.isArray(labels) ? labels : []).map((label) => typeof label === "string" ? { name: label, color: "" }
    : { name: String(label?.name ?? ""), color: /^[0-9a-f]{6}$/i.test(String(label?.color ?? "")) ? String(label.color) : "" }).filter((label) => label.name);
}

const LABEL_MAX = 50;
// 라벨 이름은 GitHub 제한(50자) 안에서 줄바꿈 없는 글자만 받는다. 쉼표로 여러 개를 적을 수 있다.
export function labelNames(value) {
  const list = (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []).map((name) => String(name ?? "").trim()).filter(Boolean);
  for (const name of list) if (name.length > LABEL_MAX || /[\u0000-\u001f]/.test(name)) throw new GitHubError("라벨 이름은 줄바꿈 없이 50자까지 입력하세요.");
  if (list.length > 20) throw new GitHubError("라벨은 한 번에 20개까지 붙일 수 있습니다.");
  return [...new Set(list)];
}

// GitFlow에서 브랜치가 PR로 들어갈 수 있는 대상. allowed가 null이면 GitFlow 브랜치가 아니어서 제한하지 않는다.
export function gitflowPullBases(flow, head) {
  const branch = String(head ?? "");
  if (!flow || !branch) return { suggested: null, allowed: null, reason: null };
  if (branch.startsWith(flow.featurePrefix))
    return { suggested: flow.develop, allowed: [flow.develop], reason: `${flow.featurePrefix} 브랜치는 ${flow.develop}으로만 PR을 만듭니다.` };
  if (branch.startsWith(flow.hotfixPrefix) || branch.startsWith(flow.releasePrefix))
    return { suggested: flow.main, allowed: [flow.main, flow.develop], reason: `${branch.startsWith(flow.hotfixPrefix) ? flow.hotfixPrefix : flow.releasePrefix} 브랜치는 ${flow.main} 또는 ${flow.develop}으로만 PR을 만듭니다.` };
  if (branch === flow.main) return { suggested: flow.develop, allowed: [flow.develop], reason: `${flow.main}은 ${flow.develop}에 반영하는 PR만 만듭니다.` };
  if (branch === flow.develop) return { suggested: null, allowed: [], reason: `${flow.develop}은 ${flow.main}으로 바로 PR을 만들지 않습니다. ${flow.releasePrefix} 브랜치를 만들어 배포를 준비하세요.` };
  return { suggested: flow.develop, allowed: null, reason: null };
}

const queue = new Map();
async function exclusive(dir, git, action) {
  const gitDir = (await git(dir, ["rev-parse", "--absolute-git-dir"])).trim();
  const real = fs.realpathSync(gitDir);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  const previous = queue.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  queue.set(key, current);
  try { return await current; }
  finally { if (queue.get(key) === current) queue.delete(key); }
}

export class GitHubPulls {
  constructor({ locate = () => locateCli("gh", ""), run = runGitHubCommand } = {}) {
    this.locate = locate;
    this.run = run;
  }

  // PR 조회도 다른 Git 화면과 동시에 실행되므로 선택적 index 갱신을 하지 않는다.
  git = (dir, args, options = {}) => this.run("git", ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false", "-C", dir, ...args], { cwd: dir, timeout: 15_000, ...options });

  failure(error, write = false) {
    if (error instanceof GitHubError) return error;
    // 찾아 둔 gh 파일이 지워졌거나 실행할 수 없으면 설치부터 다시 하게 안내한다.
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return new GitHubError("GitHub CLI를 실행하지 못했습니다. 설정에서 GitHub CLI를 다시 설치하고 로그인하세요.", "gh-missing");
    if (error.timedOut) return new GitHubError(write
      ? "요청 시간이 초과되어 완료 여부를 알 수 없습니다. GitHub에서 완료 여부를 확인한 뒤 다시 시도하세요."
      : "GitHub 응답 시간이 초과되었습니다. 연결을 확인하고 다시 조회하세요.", "github-timeout", 504, write);
    // 인증 거부는 쓰기 전에 끝나므로 완료 여부가 불확실하지 않다.
    const auth = gitAuthFailure(error.stderr || error.message);
    if (auth) return auth;
    const message = cleanError(error.stderr || error.stdout || error.message);
    const http = Number(message.match(/HTTP\s+(\d{3})/i)?.[1]);
    // 로그인하지 않은 gh는 HTTP 응답 없이 로그인 방법만 알린다.
    if (http === 401 || (!http && /gh auth login|not logged in/i.test(message))) return new GitHubError("GitHub 인증이 만료되었습니다. 설정에서 GitHub CLI에 다시 로그인하세요.", "gh-auth", 401);
    // 권한 오류는 쓰기 전에 거절되므로 완료 여부가 불확실하지 않다. 원래 응답은 뒤에 붙여 원인을 볼 수 있게 한다.
    if (http === 403) return /rate limit/i.test(message)
      ? new GitHubError("GitHub API 사용 한도를 넘었습니다. 잠시 후 다시 시도하세요.\n" + message, "github-rate-limit", 429)
      : new GitHubError("GitHub 권한이 부족합니다. 로그인한 계정에 이 저장소의 쓰기 권한이 있는지, 조직이 GitHub CLI 접근을 허용했는지 확인하세요.\n" + message, "gh-permission", 403);
    if (http === 410) return new GitHubError("이 저장소는 GitHub Issues를 꺼 두었습니다. 저장소 설정에서 Issues를 켜세요.\n" + message, "github-issues-disabled", 409);
    const unknown = write && (!http || http >= 500);
    return new GitHubError((unknown ? "완료 여부를 확인한 뒤 다시 시도하세요.\n" : "") + (message || "GitHub 요청에 실패했습니다."),
      "github-error", http === 409 ? 409 : http >= 500 || unknown ? 502 : 400, unknown);
  }

  async api(target, method, endpoint, data, { accept = "application/vnd.github+json", raw = false, write = false } = {}) {
    const args = ["api", "--hostname", "github.com", "--method", method,
      "--header", "Accept: " + accept, "--header", "X-GitHub-Api-Version: " + API_VERSION, endpoint];
    if (data !== undefined) args.push("--input", "-");
    try {
      const output = await this.run(target.file, args, { cwd: target.dir, input: data === undefined ? undefined : JSON.stringify(data) });
      return raw ? output : JSON.parse(output);
    } catch (error) { throw this.failure(error, write); }
  }

  async target(dir, selected) {
    const names = (await this.git(dir, ["remote"])).trim().split(/\r?\n/).filter(Boolean);
    const found = await Promise.all(names.map(async (name) => {
      const url = (await this.git(dir, ["remote", "get-url", "--all", name])).trim().split(/\r?\n/)[0];
      const identity = parseGitHubRemote(url);
      return identity ? { name, ...identity } : { name, url: cleanError(url).slice(0, 200), unsupported: true };
    }));
    const remotes = found.filter((item) => !item.unsupported);
    if (!remotes.length) throw new GitHubError(names.length
      ? "현재 원격 저장소는 지원하지 않습니다(" + found.map((item) => item.name + ": " + item.url).join(", ") + "). "
        + "https://github.com/<소유자>/<저장소>.git 또는 git@github.com:<소유자>/<저장소>.git 형식의 GitHub.com 원격 저장소를 추가하세요."
      : "GitHub 원격 저장소가 없습니다. git remote add origin <GitHub 저장소 주소>로 연결하세요.", names.length ? "github-unsupported" : "github-remote");
    const remote = selected ? remotes.find((item) => item.name === selected) : remotes.find((item) => item.name === "origin") ?? remotes[0];
    if (!remote) throw new GitHubError("고른 GitHub 원격 저장소가 없습니다. 목록을 새로고침하세요.", "github-remote");
    const file = this.locate();
    if (!file) throw new GitHubError("GitHub CLI가 없습니다. 설정에서 GitHub CLI를 설치하고 로그인하세요.", "gh-missing");
    try { await this.run(file, ["auth", "status", "--active", "--hostname", "github.com"], { cwd: dir, timeout: 15_000 }); }
    catch (error) {
      if (error.timedOut || error.code) throw this.failure(error);
      throw new GitHubError("GitHub CLI 인증이 필요합니다. 설정에서 GitHub CLI에 로그인하세요.", "gh-auth", 401);
    }
    const pushes = (await this.git(dir, ["remote", "get-url", "--push", "--all", remote.name])).trim().split(/\r?\n/).filter(Boolean);
    const pushTarget = pushes.length === 1 ? parseGitHubRemote(pushes[0]) : null;
    return { ...remote, dir, file, remotes, pushMatches: !!pushTarget && pushTarget.repo.toLowerCase() === remote.repo.toLowerCase() };
  }

  async local(dir) {
    const [branch, headSha, status, log] = await Promise.all([
      this.git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((out) => out.trim(), () => null),
      this.git(dir, ["rev-parse", "--verify", "HEAD"]).then((out) => out.trim(), () => null),
      this.git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.git(dir, ["log", "-1", "--pretty=format:%s%x00%b"]).catch(() => ""),
    ]);
    const [subject = "", body = ""] = log.split("\0");
    return { branch, headSha, dirtyCount: parseStatus(status).length, lastCommit: { subject: subject.trim(), body: body.trim() } };
  }

  async remoteHead(target, branch) {
    if (!branch) return null;
    try { return (await this.api(target, "GET", "repos/" + target.repo + "/branches/" + encodeURIComponent(branch))).commit?.sha ?? null; }
    catch (error) { if (/\bHTTP 404\b/.test(error.message)) return null; throw error; }
  }

  async context(target, gitflow) {
    const [local, info, branches] = await Promise.all([
      this.local(target.dir),
      this.api(target, "GET", "repos/" + target.repo),
      this.api(target, "GET", "repos/" + target.repo + "/branches?per_page=100"),
    ]);
    const flowBases = gitflowPullBases(gitflow, local.branch);
    const names = new Set([info.default_branch, ...branches.map((item) => item.name)].filter(Boolean));
    // GitFlow 대상 브랜치가 첫 페이지 밖에 있을 수 있어 따로 확인한다.
    const wanted = [...new Set([flowBases.suggested, ...(flowBases.allowed ?? [])].filter((name) => name && !names.has(name)))];
    const [remoteHeadSha, ...found] = await Promise.all([this.remoteHead(target, local.branch), ...wanted.map((name) => this.remoteHead(target, name))]);
    const extra = wanted.filter((_, index) => found[index]);
    const baseBranches = [...new Set([info.default_branch, ...extra, ...names].filter(Boolean))];
    const allowedBases = flowBases.allowed ? flowBases.allowed.filter((name) => baseBranches.includes(name) && name !== local.branch) : null;
    const suggestedBase = (allowedBases ?? baseBranches).includes(flowBases.suggested) ? flowBases.suggested
      : allowedBases ? allowedBases[0] ?? null : info.default_branch;
    const published = !!local.headSha && remoteHeadSha === local.headSha;
    const flowBlocked = !!allowedBases && !allowedBases.length;
    const canCreate = !!local.branch && published && !flowBlocked;
    const mergeMethods = ["merge", "squash", "rebase"].filter((method) => info["allow_" + (method === "merge" ? "merge_commit" : method + "_merge")] !== false);
    return {
      repo: target.repo, repositoryUrl: target.url, remote: target.name, remotes: target.remotes,
      ...local, remoteHeadSha, defaultBranch: info.default_branch, baseBranches, suggestedBase, allowedBases,
      baseReason: flowBases.reason,
      needsPush: !!local.branch && !!local.headSha && !published,
      canPush: !!local.branch && !!local.headSha && target.pushMatches && info.permissions?.push === true,
      canCreate, createReason: !local.branch ? "브랜치를 체크아웃한 뒤 PR을 만드세요." : !local.headSha ? "먼저 변경을 커밋하세요."
        : !published ? "현재 브랜치의 커밋을 GitHub에 푸시한 뒤 PR을 만드세요."
        : flowBlocked ? (flowBases.allowed.length ? `GitHub에 ${flowBases.allowed.join(", ")} 브랜치가 없습니다. GitFlow 설정의 브랜치 이름을 확인하세요.` : flowBases.reason) : null,
      mergeMethods,
    };
  }

  async list(dir, { remote, state = "open", gitflow } = {}) {
    if (!["open", "closed", "all"].includes(state)) throw new GitHubError("PR 상태 필터가 올바르지 않습니다.");
    const target = await this.target(dir, remote);
    const [context, pulls] = await Promise.all([
      this.context(target, gitflow),
      this.api(target, "GET", "repos/" + target.repo + "/pulls?state=" + state + "&sort=updated&direction=desc&per_page=50"),
    ]);
    return { context, pulls: pulls.map((pull) => normalizePull(pull, target.repo)), limited: pulls.length >= 50 };
  }

  number(value) {
    if (!NUMBER.test(String(value))) throw new GitHubError("PR 번호가 올바르지 않습니다.");
    return String(value);
  }

  async detail(dir, number, { remote } = {}) {
    number = this.number(number);
    const target = await this.target(dir, remote);
    const endpoint = "repos/" + target.repo + "/pulls/" + number;
    const raw = await this.api(target, "GET", endpoint);
    const [extra, files, diff, repoLabels] = await Promise.allSettled([
      this.run(target.file, ["pr", "view", number, "--repo", "github.com/" + target.repo, "--json", "statusCheckRollup,mergeStateStatus,reviewDecision"], { cwd: dir }).then(JSON.parse),
      this.api(target, "GET", endpoint + "/files?per_page=100"),
      this.api(target, "GET", endpoint, undefined, { accept: "application/vnd.github.diff", raw: true }),
      this.api(target, "GET", "repos/" + target.repo + "/labels?per_page=100"),
    ]);
    const pull = normalizePull({ ...raw, ...(extra.status === "fulfilled" ? extra.value : {}), files: files.status === "fulfilled" ? files.value : [] }, target.repo);
    pull.filesTruncated = (pull.changedFiles ?? 0) > pull.files.length;
    pull.checksError = extra.status === "rejected" ? this.failure(extra.reason).message : null;
    pull.filesError = files.status === "rejected" ? files.reason.message : null;
    // 저장소에 있는 라벨은 라벨 추가 목록에 쓴다. 읽지 못해도 이름을 직접 적어 붙일 수 있다.
    pull.repoLabels = repoLabels.status === "fulfilled" ? normalizeLabels(repoLabels.value) : [];
    return { pull, diff: diff.status === "fulfilled" ? diff.value.slice(0, DIFF_MAX) + (diff.value.length > DIFF_MAX ? "\n… (긴 diff 일부 생략)" : "") : "",
      diffError: diff.status === "rejected" ? diff.reason.message : null };
  }

  assertRepo(target, expected) {
    if (typeof expected !== "string" || expected.toLowerCase() !== target.repo.toLowerCase()) throw new GitHubError("원격 저장소가 바뀌었습니다. 목록을 새로고침하세요.", "stale-head", 409);
  }

  async assertHead(target, body) {
    this.assertRepo(target, body.repo);
    const local = await this.local(target.dir);
    if (!local.branch || !local.headSha || !SHA.test(String(body.expectedHead)) || local.headSha !== body.expectedHead || local.branch !== (body.branch ?? body.head)) {
      throw new GitHubError("현재 브랜치나 커밋이 바뀌었습니다. 목록을 새로고침하세요.", "stale-head", 409);
    }
    return local;
  }

  async create(dir, body, { gitflow } = {}) {
    return exclusive(dir, this.git, async () => {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const text = typeof body.body === "string" ? body.body : "";
      if (!title || title.length > 256) throw new GitHubError("PR 제목을 1~256자로 입력하세요.");
      if (text.length > 65_536) throw new GitHubError("PR 본문은 65536자까지 입력할 수 있습니다.");
      if (typeof body.base !== "string" || !body.base || body.base.startsWith("-") || body.base === body.head) throw new GitHubError("현재 브랜치와 다른 대상 브랜치를 고르세요.");
      await this.git(dir, ["check-ref-format", "--branch", body.base]).catch(() => { throw new GitHubError("대상 브랜치 이름이 올바르지 않습니다."); });
      const target = await this.target(dir, body.remote);
      const local = await this.assertHead(target, body);
      const flowBases = gitflowPullBases(gitflow, local.branch);
      if (flowBases.allowed && !flowBases.allowed.includes(body.base)) throw new GitHubError(flowBases.reason, "gitflow-base", 409);
      const remoteHead = await this.remoteHead(target, local.branch);
      if (remoteHead !== local.headSha) throw new GitHubError("현재 브랜치의 커밋이 GitHub에 없습니다. 먼저 브랜치를 푸시한 뒤 PR을 만드세요.", "branch-unpublished", 409);
      const baseHead = await this.remoteHead(target, body.base);
      if (!baseHead) throw new GitHubError("GitHub에 대상 브랜치가 없습니다. 목록을 새로고침하세요.");
      const [owner] = target.repo.split("/");
      const existing = await this.api(target, "GET", "repos/" + target.repo + "/pulls?state=open&head=" + encodeURIComponent(owner + ":" + local.branch) + "&base=" + encodeURIComponent(body.base) + "&per_page=1");
      if (existing.length) throw new GitHubError("이 브랜치의 열린 PR #" + existing[0].number + "이 이미 있습니다. PR 목록을 새로고침하세요.", "pull-exists", 409);
      await this.assertHead(target, body);
      const labels = labelNames(body.labels);
      const pull = await this.api(target, "POST", "repos/" + target.repo + "/pulls",
        { title, body: text, base: body.base, head: local.branch, draft: body.draft === true }, { write: true });
      // PR은 이미 만들어졌으므로 라벨을 붙이지 못해도 실패로 돌려주지 않고 알린다.
      if (labels.length) {
        try { pull.labels = await this.api(target, "POST", "repos/" + target.repo + "/issues/" + pull.number + "/labels", { labels }, { write: true }); }
        catch (error) { return { ok: true, pull: normalizePull(pull, target.repo), warning: "PR은 만들었지만 라벨을 붙이지 못했습니다: " + error.message }; }
      }
      return { ok: true, pull: normalizePull(pull, target.repo) };
    });
  }

  async merge(dir, number, body) {
    number = this.number(number);
    if (!["merge", "squash", "rebase"].includes(body.method) || !SHA.test(String(body.sha))) throw new GitHubError("병합 방식과 확인한 PR 커밋을 다시 선택하세요.");
    return exclusive(dir, this.git, async () => {
      const target = await this.target(dir, body.remote);
      this.assertRepo(target, body.repo);
      const [info, raw] = await Promise.all([this.api(target, "GET", "repos/" + target.repo), this.api(target, "GET", "repos/" + target.repo + "/pulls/" + number)]);
      if (raw.state !== "open" || raw.draft) throw new GitHubError("열린 일반 PR만 병합할 수 있습니다.", "pull-state", 409);
      if (raw.head?.sha !== body.sha) throw new GitHubError("PR에 새 커밋이 있습니다. 내용을 다시 확인하세요.", "stale-head", 409);
      const key = "allow_" + (body.method === "merge" ? "merge_commit" : body.method + "_merge");
      if (info[key] === false) throw new GitHubError("이 저장소에서 허용하지 않는 병합 방식입니다.");
      // REST may let repository admins bypass protection. Fail closed when GitHub
      // reports blocked, behind, unknown, conflicts, or unavailable merge readiness.
      let readiness;
      try {
        readiness = JSON.parse(await this.run(target.file, ["pr", "view", number, "--repo", "github.com/" + target.repo, "--json", "headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup"], { cwd: dir }));
      } catch (error) { throw this.failure(error); }
      if (readiness.headRefOid !== body.sha) throw new GitHubError("PR에 새 커밋이 있습니다. 내용을 다시 확인하세요.", "stale-head", 409);
      if (!["CLEAN", "HAS_HOOKS"].includes(readiness.mergeStateStatus) || readiness.reviewDecision === "REVIEW_REQUIRED" || readiness.reviewDecision === "CHANGES_REQUESTED") {
        throw new GitHubError("검사·리뷰·최신 브랜치 반영 등 병합 조건을 먼저 충족하세요. GitHub의 보호 규칙을 우회하지 않습니다.", "pull-blocked", 409);
      }
      const result = await this.api(target, "PUT", "repos/" + target.repo + "/pulls/" + number + "/merge", { merge_method: body.method, sha: body.sha }, { write: true });
      if (!result.merged) throw new GitHubError(cleanError(result.message) || "PR을 병합하지 못했습니다.", "pull-state", 409);
      return { ok: true, pull: normalizePull({ ...raw, merged: true, state: "closed" }, target.repo), result: cleanError(result.message) };
    });
  }

  async close(dir, number, body) {
    number = this.number(number);
    return exclusive(dir, this.git, async () => {
      const target = await this.target(dir, body.remote);
      this.assertRepo(target, body.repo);
      const endpoint = "repos/" + target.repo + "/pulls/" + number;
      const raw = await this.api(target, "GET", endpoint);
      if (raw.merged || raw.merged_at) throw new GitHubError("이미 병합된 PR입니다.", "pull-state", 409);
      const updated = raw.state === "closed" ? raw : await this.api(target, "PATCH", endpoint, { state: "closed" }, { write: true });
      return { ok: true, pull: normalizePull(updated, target.repo) };
    });
  }

  // PR 라벨 추가·제거. GitHub에 없는 이름을 붙이면 GitHub가 새 라벨을 만든다.
  async labels(dir, number, body = {}) {
    number = this.number(number);
    const add = labelNames(body.add), remove = labelNames(body.remove);
    if (!add.length && !remove.length) throw new GitHubError("붙이거나 뗄 라벨을 고르세요.");
    const target = await this.target(dir, body.remote);
    this.assertRepo(target, body.repo);
    const endpoint = "repos/" + target.repo + "/issues/" + number + "/labels";
    let labels = null;
    if (add.length) labels = await this.api(target, "POST", endpoint, { labels: add }, { write: true });
    for (const name of remove) {
      try { labels = await this.api(target, "DELETE", endpoint + "/" + encodeURIComponent(name), undefined, { write: true }); }
      catch (error) { if (!/\bHTTP 404\b/.test(error.message)) throw error; }
    }
    labels ??= await this.api(target, "GET", endpoint);
    return { ok: true, labels: normalizeLabels(labels) };
  }

  async push(dir, body) {
    return exclusive(dir, this.git, async () => {
      const target = await this.target(dir, body.remote);
      const local = await this.assertHead(target, body);
      const info = await this.api(target, "GET", "repos/" + target.repo);
      if (!target.pushMatches) throw new GitHubError("푸시 주소가 선택한 GitHub 저장소와 다르거나 여러 개입니다. git remote get-url --push --all " + target.name + " 설정을 확인하세요.", "github-remote");
      if (info.permissions?.push !== true) throw new GitHubError("이 GitHub 저장소에 푸시할 권한이 없습니다. 권한이나 원격 저장소를 확인하세요.");
      // Re-read expanded push URLs immediately before writing: no alternate/multiple destinations.
      const pushes = (await this.git(dir, ["remote", "get-url", "--push", "--all", target.name])).trim().split(/\r?\n/).filter(Boolean);
      const identity = pushes.length === 1 ? parseGitHubRemote(pushes[0]) : null;
      if (!identity || identity.repo.toLowerCase() !== target.repo.toLowerCase()) throw new GitHubError("푸시 주소가 바뀌었습니다. 목록을 새로고침하세요.", "github-remote", 409);
      await this.assertHead(target, body);
      try {
        const result = await this.git(dir, [...githubCredentialArgs(), "-c", "remote." + target.name + ".mirror=false", "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no",
          "--", pushes[0], local.headSha + ":refs/heads/" + local.branch], { timeout: 60_000 });
        return { ok: true, result: cleanError(result) || "현재 브랜치를 GitHub에 푸시했습니다." };
      } catch (error) { throw this.failure(error, true); }
    });
  }
}

export const githubPulls = new GitHubPulls();
