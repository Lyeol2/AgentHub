// 팀 작업 전달. GitHub Issues를 받은 작업함으로 쓴다. 서버·DB 없이 gh 인증과 저장소 권한만 쓴다.
// 원격 판별·인증·REST 호출은 Pull Request 기능(GitHubPulls)과 같은 경로를 쓴다.
import { GitHubError, githubPulls, parseGitHubRemote } from "./github.mjs";

export const ISSUE_LABEL = "agenthub";
const LABEL_COLOR = "6f42c1";
const META = /\n*<!--\s*agenthub:\s*(\{[\s\S]*?\})\s*-->\s*$/;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const TITLE_MAX = 256;
const BODY_MAX = 60_000;
const COMMENT_MAX = 60_000;
const PAGE = 50;

// 본문 끝의 숨김 주석에 보낸 사람·기준 브랜치·추천 흐름을 남긴다. 주석이 끝나지 않게 <, >는 JSON 이스케이프로 쓴다.
export function formatIssueBody(text, meta) {
  const json = JSON.stringify({ v: 1, ...meta }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return String(text ?? "").trimEnd() + "\n\n<!-- agenthub: " + json + " -->";
}

export function parseIssueMeta(body) {
  const raw = String(body ?? "");
  const found = raw.match(META);
  if (!found) return { text: raw, meta: null };
  let meta = null;
  try {
    const value = JSON.parse(found[1]);
    if (value && typeof value === "object" && !Array.isArray(value)) meta = value;
  } catch {}
  return { text: raw.slice(0, found.index), meta };
}

// 이슈에 올리기 전에 토큰처럼 보이는 값을 가린다.
export function maskSecrets(text) {
  return String(text ?? "")
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, "[token]")
    .replace(/sk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, "[token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[token]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[token]")
    .replace(/https?:\/\/[^/\s@]+@/g, "https://[credentials]@");
}

// 로컬 절대 경로를 프로젝트 기준 상대 경로로 바꾼다. 슬래시 방향과 대소문자는 가리지 않는다.
export function relativizePaths(text, roots = []) {
  let result = String(text ?? "");
  const sorted = [...new Set(roots.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const root of sorted) {
    const parts = String(root).replace(/[\\/]+$/, "").split(/[\\/]+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    result = result.replace(new RegExp(parts.join("[\\\\/]+") + "(?![A-Za-z0-9_.-])", "gi"), ".");
  }
  return result;
}

const login = (user) => String(user?.login ?? "");

export function normalizeIssue(raw, repo) {
  const number = Number(raw.number);
  if (!Number.isSafeInteger(number) || number < 1) throw new GitHubError("GitHub가 올바르지 않은 이슈 번호를 반환했습니다.");
  const { text, meta } = parseIssueMeta(raw.body);
  return {
    number, repo, title: String(raw.title ?? ""), body: text, meta,
    url: "https://github.com/" + repo + "/issues/" + number,
    state: String(raw.state).toLowerCase() === "closed" ? "closed" : "open",
    stateReason: raw.state_reason ?? null,
    author: login(raw.user),
    assignees: (raw.assignees ?? (raw.assignee ? [raw.assignee] : [])).map(login).filter(Boolean),
    labels: (raw.labels ?? []).map((label) => String(typeof label === "string" ? label : label?.name ?? "")).filter(Boolean),
    comments: Number(raw.comments ?? 0),
    createdAt: raw.created_at ?? null, updatedAt: raw.updated_at ?? null, closedAt: raw.closed_at ?? null,
  };
}

const normalizeComment = (raw) => ({
  id: Number(raw.id), author: login(raw.user), body: String(raw.body ?? ""),
  createdAt: raw.created_at ?? null, updatedAt: raw.updated_at ?? null,
});

const repoFromApiUrl = (value) => {
  const found = String(value ?? "").match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/);
  return found ? parseGitHubRemote("https://github.com/" + found[1] + "/" + found[2])?.repo ?? null : null;
};

export class GitHubIssues {
  constructor({ pulls = githubPulls } = {}) {
    this.pulls = pulls;
    this.viewers = new Map();
  }

  target(dir, remote) { return this.pulls.target(dir, remote); }
  api(target, method, endpoint, data, options) { return this.pulls.api(target, method, endpoint, data, options); }

  number(value) {
    if (!/^[1-9][0-9]{0,8}$/.test(String(value))) throw new GitHubError("이슈 번호가 올바르지 않습니다.");
    return String(value);
  }

  // 로그인한 GitHub 계정. 같은 gh 실행 파일이면 잠깐 기억한다.
  async viewer(target) {
    const cached = this.viewers.get(target.file);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.login;
    const user = await this.api(target, "GET", "user");
    const value = login(user);
    if (!LOGIN.test(value)) throw new GitHubError("GitHub 계정을 확인하지 못했습니다.", "gh-auth", 401);
    this.viewers.set(target.file, { login: value, at: Date.now() });
    return value;
  }

  async context(dir, { remote } = {}) {
    const target = await this.target(dir, remote);
    const [viewer, info, assignees, local] = await Promise.all([
      this.viewer(target),
      this.api(target, "GET", "repos/" + target.repo),
      this.api(target, "GET", "repos/" + target.repo + "/assignees?per_page=100"),
      this.pulls.local(dir),
    ]);
    return {
      repo: target.repo, repositoryUrl: target.url, remote: target.name, viewer,
      private: info.private === true, hasIssues: info.has_issues !== false,
      assignees: assignees.map((user) => ({ login: login(user), avatarUrl: String(user.avatar_url ?? "") })).filter((user) => LOGIN.test(user.login)),
      branch: local.branch, headSha: local.headSha,
    };
  }

  // box: inbox(나에게 지정된 작업) | sent(내가 보낸 작업)
  async list(dir, { box = "inbox", state = "open", remote } = {}) {
    if (!["inbox", "sent"].includes(box)) throw new GitHubError("작업함 종류가 올바르지 않습니다.");
    if (!["open", "closed", "all"].includes(state)) throw new GitHubError("작업 상태 필터가 올바르지 않습니다.");
    const target = await this.target(dir, remote);
    const viewer = await this.viewer(target);
    const query = new URLSearchParams({ labels: ISSUE_LABEL, state, sort: "updated", direction: "desc", per_page: String(PAGE) });
    query.set(box === "inbox" ? "assignee" : "creator", viewer);
    const raw = await this.api(target, "GET", "repos/" + target.repo + "/issues?" + query);
    const issues = raw.filter((item) => !item.pull_request).map((item) => normalizeIssue(item, target.repo));
    return { repo: target.repo, viewer, box, issues, limited: raw.length >= PAGE };
  }

  // 모든 저장소에서 나에게 지정된 열린 작업. 사이드바 배지와 알림에 쓴다.
  async inbox() {
    const file = this.pulls.locate();
    if (!file) throw new GitHubError("GitHub CLI가 없습니다. 설정에서 GitHub CLI를 설치하고 로그인하세요.", "gh-missing");
    const target = { file, dir: undefined };
    const q = "is:issue is:open assignee:@me label:" + ISSUE_LABEL;
    const result = await this.api(target, "GET", "search/issues?q=" + encodeURIComponent(q) + "&sort=updated&order=desc&per_page=" + PAGE);
    const issues = [];
    for (const item of result.items ?? []) {
      const repo = repoFromApiUrl(item.repository_url);
      if (repo && !item.pull_request) issues.push(normalizeIssue(item, repo));
    }
    return { issues, total: Number(result.total_count ?? issues.length) };
  }

  async detail(dir, number, { remote } = {}) {
    number = this.number(number);
    const target = await this.target(dir, remote);
    const endpoint = "repos/" + target.repo + "/issues/" + number;
    const [raw, comments, viewer] = await Promise.all([
      this.api(target, "GET", endpoint),
      this.api(target, "GET", endpoint + "/comments?per_page=100"),
      this.viewer(target),
    ]);
    if (raw.pull_request) throw new GitHubError("Pull Request는 작업으로 열 수 없습니다. Git 탭에서 확인하세요.");
    return { repo: target.repo, viewer, issue: normalizeIssue(raw, target.repo), comments: comments.map(normalizeComment), commentsLimited: comments.length >= 100 };
  }

  async ensureLabel(target) {
    try {
      await this.api(target, "GET", "repos/" + target.repo + "/labels/" + ISSUE_LABEL);
    } catch (error) {
      if (!/\bHTTP 404\b/.test(error.message)) throw error;
      try {
        await this.api(target, "POST", "repos/" + target.repo + "/labels",
          { name: ISSUE_LABEL, color: LABEL_COLOR, description: "AgentHub로 주고받은 작업" }, { write: true });
      } catch (created) {
        if (!/\bHTTP 422\b/.test(created.message)) throw created; // 동시에 만든 경우
      }
    }
  }

  async create(dir, body = {}) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.body === "string" ? body.body : "";
    const assignee = typeof body.assignee === "string" ? body.assignee.trim() : "";
    const flow = typeof body.flow === "string" ? body.flow.trim().slice(0, 100) : "";
    if (!title || title.length > TITLE_MAX) throw new GitHubError("작업 제목을 1~256자로 입력하세요.");
    if (text.length > BODY_MAX) throw new GitHubError("작업 내용은 60000자까지 입력할 수 있습니다.");
    if (!LOGIN.test(assignee)) throw new GitHubError("받을 팀원을 고르세요.");
    const target = await this.target(dir, body.remote);
    if (typeof body.repo === "string" && body.repo.toLowerCase() !== target.repo.toLowerCase()) throw new GitHubError("원격 저장소가 바뀌었습니다. 다시 열어 주세요.", "stale-head", 409);
    const [viewer, local] = await Promise.all([this.viewer(target), this.pulls.local(dir)]);
    try {
      await this.api(target, "GET", "repos/" + target.repo + "/assignees/" + assignee, undefined, { raw: true });
    } catch (error) {
      if (/\bHTTP 404\b/.test(error.message)) throw new GitHubError(assignee + "에게는 이 저장소의 작업을 지정할 수 없습니다. 저장소 협업자인지 확인하세요.");
      throw error;
    }
    await this.ensureLabel(target);
    const meta = { from: viewer, branch: local.branch ?? null, commit: local.headSha ?? null, ...(flow ? { flow } : {}) };
    const raw = await this.api(target, "POST", "repos/" + target.repo + "/issues",
      { title, body: formatIssueBody(maskSecrets(text), meta), assignees: [assignee], labels: [ISSUE_LABEL] }, { write: true });
    return { ok: true, issue: normalizeIssue(raw, target.repo) };
  }

  async comment(dir, number, text, { remote } = {}) {
    number = this.number(number);
    const value = typeof text === "string" ? text.trim() : "";
    if (!value) throw new GitHubError("댓글 내용을 입력하세요.");
    if (value.length > COMMENT_MAX) throw new GitHubError("댓글은 60000자까지 입력할 수 있습니다.");
    const target = await this.target(dir, remote);
    const raw = await this.api(target, "POST", "repos/" + target.repo + "/issues/" + number + "/comments", { body: maskSecrets(value) }, { write: true });
    return { ok: true, comment: normalizeComment(raw) };
  }

  // 받은 작업을 보낸 사람에게 되돌린다. 사유는 댓글로 남긴다.
  async giveBack(dir, number, { reason, remote } = {}) {
    number = this.number(number);
    const target = await this.target(dir, remote);
    const endpoint = "repos/" + target.repo + "/issues/" + number;
    const [raw, viewer] = await Promise.all([this.api(target, "GET", endpoint), this.viewer(target)]);
    const issue = normalizeIssue(raw, target.repo);
    if (issue.state !== "open") throw new GitHubError("열린 작업만 되돌려 보낼 수 있습니다.", "issue-state", 409);
    const sender = LOGIN.test(String(issue.meta?.from ?? "")) ? issue.meta.from : issue.author;
    if (!LOGIN.test(sender)) throw new GitHubError("보낸 사람을 확인하지 못했습니다.");
    const note = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 4000) : "사유 없음";
    await this.api(target, "POST", endpoint + "/comments", { body: maskSecrets("↩️ @" + viewer + "님이 작업을 되돌려 보냈습니다.\n\n" + note) }, { write: true });
    const updated = await this.api(target, "PATCH", endpoint, { assignees: [sender] }, { write: true });
    return { ok: true, issue: normalizeIssue(updated, target.repo) };
  }

  async close(dir, number, { reason = "completed", remote } = {}) {
    number = this.number(number);
    if (!["completed", "not_planned"].includes(reason)) throw new GitHubError("닫는 이유가 올바르지 않습니다.");
    const target = await this.target(dir, remote);
    const raw = await this.api(target, "PATCH", "repos/" + target.repo + "/issues/" + number, { state: "closed", state_reason: reason }, { write: true });
    return { ok: true, issue: normalizeIssue(raw, target.repo) };
  }

  async reopen(dir, number, { remote } = {}) {
    number = this.number(number);
    const target = await this.target(dir, remote);
    const raw = await this.api(target, "PATCH", "repos/" + target.repo + "/issues/" + number, { state: "open" }, { write: true });
    return { ok: true, issue: normalizeIssue(raw, target.repo) };
  }
}

export const githubIssues = new GitHubIssues();
