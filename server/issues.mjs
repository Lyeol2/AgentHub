// 팀 작업 전달. GitHub Issues를 받은 작업함으로 쓴다. 서버·DB 없이 gh 인증과 저장소 권한만 쓴다.
// 원격 판별·인증·REST 호출은 Pull Request 기능(GitHubPulls)과 같은 경로를 쓴다.
import { randomBytes } from "node:crypto";
import { GitHubError, githubPulls, parseGitHubRemote } from "./github.mjs";
import { MAX_ISSUE_ATTACHMENT_BYTES, safeAttachmentName } from "./attachments.mjs";

// 작업 첨부 파일을 보관하는 브랜치
export const ATTACHMENT_BRANCH = "agenthub-attachments";
// 저장소 경로와 Markdown 주소에 그대로 쓸 수 있게 공백·특수 문자를 -로 바꾼다.
export function attachmentFileName(value) {
  const name = safeAttachmentName(value).normalize("NFC").replace(/[\s#%?&+;=@[\]()'`!$,{}^~]+/g, "-").replace(/-{2,}/g, "-").replace(/-*\.-*/g, ".").replace(/^-+|-+$/g, "").slice(0, 120);
  return name && !/^\.+$/.test(name) ? name : "file";
}

export const ISSUE_LABEL = "agenthub";
const LABEL_COLOR = "6f42c1";
const META = /\n*<!--\s*agenthub:\s*(\{[\s\S]*?\})\s*-->\s*$/;
// Enterprise Managed User 계정은 이름 뒤에 _회사코드가 붙는다.
const LOGIN = /^[a-z0-9][a-z0-9-]{0,38}(?:_[a-z0-9]{1,20})?$/i;
const TITLE_MAX = 256;
const BODY_MAX = 60_000;
const COMMENT_MAX = 60_000;
const PAGE = 50;
const PROFILE_TTL = 60 * 60_000;
const PROFILE_WORKERS = 6;
const NAME_MAX = 40;
const ASSIGNEES_MAX = 10; // GitHub 이슈 담당자 최대 수

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
  id: Number(raw.id), author: login(raw.user), association: String(raw.author_association ?? ""), body: String(raw.body ?? ""),
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
    this.profiles = new Map(); // login → { name, at }
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

  // 팀원 GitHub 프로필의 이름(예: 한국어 이름). 못 읽으면 빈 이름으로 두고 잠깐 기억한다.
  async profileNames(target, logins) {
    const names = new Map();
    const queue = [...logins];
    const worker = async () => {
      for (let user = queue.shift(); user; user = queue.shift()) {
        const cached = this.profiles.get(user.toLowerCase());
        if (cached && Date.now() - cached.at < PROFILE_TTL) { names.set(user, cached.name); continue; }
        let name = "";
        try { name = String((await this.api(target, "GET", "users/" + user))?.name ?? "").trim().slice(0, NAME_MAX); } catch {}
        this.profiles.set(user.toLowerCase(), { name, at: Date.now() });
        names.set(user, name);
      }
    };
    await Promise.all(Array.from({ length: PROFILE_WORKERS }, worker));
    return names;
  }

  async context(dir, { remote } = {}) {
    const target = await this.target(dir, remote);
    const [viewer, info, assignees, local] = await Promise.all([
      this.viewer(target),
      this.api(target, "GET", "repos/" + target.repo),
      this.api(target, "GET", "repos/" + target.repo + "/assignees?per_page=100"),
      this.pulls.local(dir),
    ]);
    const people = assignees.map((user) => ({ login: login(user), avatarUrl: String(user.avatar_url ?? "") })).filter((user) => LOGIN.test(user.login));
    const names = await this.profileNames(target, people.map((user) => user.login));
    return {
      repo: target.repo, repositoryUrl: target.url, remote: target.name, viewer,
      private: info.private === true, hasIssues: info.has_issues !== false,
      assignees: people.map((user) => ({ ...user, name: names.get(user.login) ?? "" })),
      branch: local.branch, headSha: local.headSha,
    };
  }

  // box: inbox(나에게 지정된 작업) | shared(아직 아무도 맡지 않은 팀 공용 작업) | sent(내가 보낸 작업)
  async list(dir, { box = "inbox", state = "open", remote } = {}) {
    if (!["inbox", "shared", "sent"].includes(box)) throw new GitHubError("작업함 종류가 올바르지 않습니다.");
    if (!["open", "closed", "all"].includes(state)) throw new GitHubError("작업 상태 필터가 올바르지 않습니다.");
    const target = await this.target(dir, remote);
    const viewer = await this.viewer(target);
    const query = new URLSearchParams({ labels: ISSUE_LABEL, state, sort: "updated", direction: "desc", per_page: String(PAGE) });
    // 공용 작업함은 팀 작업 전체다. 맡을 사람이 필요한 작업과 누가 진행 중인 작업을 함께 보이고, 화면에서 담당자·진행 여부로 거른다.
    if (box !== "shared") query.set(box === "inbox" ? "assignee" : "creator", viewer);
    const raw = await this.api(target, "GET", "repos/" + target.repo + "/issues?" + query);
    const issues = raw.filter((item) => !item.pull_request).map((item) => normalizeIssue(item, target.repo));
    return { repo: target.repo, viewer, box, issues, limited: raw.length >= PAGE };
  }

  // 팀원 탭: 작업을 받을 수 있는 팀원과 각자 맡은 열린 작업 수(최근 100개 기준).
  async members(dir, { remote } = {}) {
    const context = await this.context(dir, { remote });
    const target = await this.target(dir, remote);
    const query = new URLSearchParams({ labels: ISSUE_LABEL, state: "open", per_page: "100" });
    const raw = await this.api(target, "GET", "repos/" + target.repo + "/issues?" + query);
    const open = new Map();
    for (const item of raw.filter((entry) => !entry.pull_request)) {
      for (const user of normalizeIssue(item, target.repo).assignees) open.set(user.toLowerCase(), (open.get(user.toLowerCase()) ?? 0) + 1);
    }
    return { ...context, assignees: context.assignees.map((user) => ({ ...user, openTasks: open.get(user.login.toLowerCase()) ?? 0 })), limited: raw.length >= 100 };
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

  // 작업 첨부 파일. GitHub에는 이슈 첨부 업로드 API가 없으므로 저장소의 첨부 전용 브랜치에 커밋하고
  // 이슈 본문에 넣을 주소를 돌려준다. 코드 브랜치와 섞이지 않게 부모 없는 브랜치를 쓴다.
  async attach(dir, body = {}) {
    const name = attachmentFileName(body.name);
    const data = typeof body.data === "string" ? body.data : "";
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new GitHubError("첨부 파일 내용을 읽지 못했습니다. 다시 골라 주세요.");
    const size = Buffer.byteLength(data, "base64");
    if (!size) throw new GitHubError("빈 파일은 첨부할 수 없습니다.");
    if (size > MAX_ISSUE_ATTACHMENT_BYTES) throw new GitHubError("첨부 파일은 10MB까지 올릴 수 있습니다.");
    const target = await this.target(dir, body.remote);
    if (typeof body.repo === "string" && body.repo.toLowerCase() !== target.repo.toLowerCase()) throw new GitHubError("원격 저장소가 바뀌었습니다. 다시 열어 주세요.", "stale-head", 409);
    await this.ensureAttachmentBranch(target);
    const month = new Date().toISOString().slice(0, 7);
    const file = `issues/${month}/${randomBytes(4).toString("hex")}-${name}`;
    const encoded = file.split("/").map(encodeURIComponent).join("/");
    await this.api(target, "PUT", "repos/" + target.repo + "/contents/" + encoded,
      { message: "AgentHub 작업 첨부: " + name, content: data, branch: ATTACHMENT_BRANCH }, { write: true });
    const url = "https://github.com/" + target.repo + "/raw/" + ATTACHMENT_BRANCH + "/" + encoded;
    const image = /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(String(body.mimeType ?? "")) || /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
    const label = name.replace(/[[\]]/g, "");
    return { ok: true, name, size, url, branch: ATTACHMENT_BRANCH, path: file, markdown: image ? `![${label}](${url})` : `[${label}](${url})` };
  }

  async ensureAttachmentBranch(target) {
    try { await this.api(target, "GET", "repos/" + target.repo + "/branches/" + ATTACHMENT_BRANCH); return; }
    catch (error) { if (!/\bHTTP 404\b/.test(error.message)) throw error; }
    const tree = await this.api(target, "POST", "repos/" + target.repo + "/git/trees",
      { tree: [{ path: "README.md", mode: "100644", type: "blob", content: "# AgentHub 첨부 파일\n\nAgentHub 팀 작업(GitHub 이슈)에 붙인 파일을 보관하는 브랜치입니다. 코드 브랜치와 병합하지 마세요.\n" }] }, { write: true });
    const commit = await this.api(target, "POST", "repos/" + target.repo + "/git/commits",
      { message: "AgentHub 첨부 파일 브랜치", tree: tree.sha, parents: [] }, { write: true });
    try {
      await this.api(target, "POST", "repos/" + target.repo + "/git/refs", { ref: "refs/heads/" + ATTACHMENT_BRANCH, sha: commit.sha }, { write: true });
    } catch (error) {
      if (!/\bHTTP 422\b/.test(error.message)) throw error; // 동시에 만든 경우
    }
  }

  async create(dir, body = {}) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.body === "string" ? body.body : "";
    // 받는 사람은 여러 명 고를 수 있고, 고르지 않으면 누구나 맡을 수 있는 팀 공용 작업이 된다.
    const picked = Array.isArray(body.assignees) ? body.assignees : typeof body.assignee === "string" && body.assignee.trim() ? [body.assignee] : [];
    const assignees = [];
    for (const value of picked) {
      const name = typeof value === "string" ? value.trim() : "";
      if (!LOGIN.test(name)) throw new GitHubError("받을 팀원을 다시 고르세요.");
      if (!assignees.some((item) => item.toLowerCase() === name.toLowerCase())) assignees.push(name);
    }
    if (!title || title.length > TITLE_MAX) throw new GitHubError("작업 제목을 1~256자로 입력하세요.");
    if (text.length > BODY_MAX) throw new GitHubError("작업 내용은 60000자까지 입력할 수 있습니다.");
    if (assignees.length > ASSIGNEES_MAX) throw new GitHubError(`받을 팀원은 ${ASSIGNEES_MAX}명까지 고를 수 있습니다.`);
    const target = await this.target(dir, body.remote);
    if (typeof body.repo === "string" && body.repo.toLowerCase() !== target.repo.toLowerCase()) throw new GitHubError("원격 저장소가 바뀌었습니다. 다시 열어 주세요.", "stale-head", 409);
    const [viewer, local] = await Promise.all([this.viewer(target), this.pulls.local(dir)]);
    // GitHub는 지정할 수 없는 담당자를 조용히 빼므로 이슈를 만들기 전에 모두 확인한다.
    await Promise.all(assignees.map(async (assignee) => {
      try {
        await this.api(target, "GET", "repos/" + target.repo + "/assignees/" + assignee, undefined, { raw: true });
      } catch (error) {
        if (/\bHTTP 404\b/.test(error.message)) throw new GitHubError(assignee + "에게는 이 저장소의 작업을 지정할 수 없습니다. 저장소 협업자인지 확인하세요.");
        throw error;
      }
    }));
    await this.ensureLabel(target);
    const meta = { from: viewer, branch: local.branch ?? null, commit: local.headSha ?? null, ...(assignees.length ? {} : { shared: true }) };
    const raw = await this.api(target, "POST", "repos/" + target.repo + "/issues",
      { title, body: formatIssueBody(maskSecrets(text), meta), assignees, labels: [ISSUE_LABEL] }, { write: true });
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

  // 팀 공용 작업을 내가 맡는다. 이미 누가 맡았으면 맡지 않는다.
  async claim(dir, number, { remote } = {}) {
    number = this.number(number);
    const target = await this.target(dir, remote);
    const endpoint = "repos/" + target.repo + "/issues/" + number;
    const [raw, viewer] = await Promise.all([this.api(target, "GET", endpoint), this.viewer(target)]);
    if (raw.pull_request) throw new GitHubError("Pull Request는 작업으로 맡을 수 없습니다.");
    const issue = normalizeIssue(raw, target.repo);
    if (issue.state !== "open") throw new GitHubError("열린 작업만 맡을 수 있습니다.", "issue-state", 409);
    const others = (list) => list.filter((user) => user.toLowerCase() !== viewer.toLowerCase());
    if (others(issue.assignees).length) throw new GitHubError("이미 @" + others(issue.assignees).join(", @") + "님이 맡은 작업입니다. 목록을 새로고침하세요.", "issue-claimed", 409);
    if (issue.assignees.length) return { ok: true, issue };
    // 담당자 추가는 기존 담당자를 지우지 않는다. 동시에 맡은 사람이 있으면 내 지정만 되돌린다.
    const added = normalizeIssue(await this.api(target, "POST", endpoint + "/assignees", { assignees: [viewer] }, { write: true }), target.repo);
    if (!added.assignees.some((user) => user.toLowerCase() === viewer.toLowerCase()))
      throw new GitHubError("이 저장소의 작업을 맡을 권한이 없습니다. 저장소 협업자인지 확인하세요.", "gh-permission", 403);
    if (others(added.assignees).length) {
      await this.api(target, "DELETE", endpoint + "/assignees", { assignees: [viewer] }, { write: true });
      throw new GitHubError("방금 @" + others(added.assignees).join(", @") + "님이 먼저 맡았습니다. 목록을 새로고침하세요.", "issue-claimed", 409);
    }
    // 맡았다는 알림 댓글은 실패해도 맡기 결과를 바꾸지 않는다.
    await this.api(target, "POST", endpoint + "/comments", { body: "🙋 @" + viewer + "님이 이 작업을 맡았습니다." }, { write: true }).catch(() => {});
    return { ok: true, issue: added };
  }

  // 받은 작업을 되돌린다. 함께 맡은 사람이 있으면 나만 빠지고, 팀 공용 작업은 공용으로, 아니면 보낸 사람에게 돌아간다. 사유는 댓글로 남긴다.
  async giveBack(dir, number, { reason, remote } = {}) {
    number = this.number(number);
    const target = await this.target(dir, remote);
    const endpoint = "repos/" + target.repo + "/issues/" + number;
    const [raw, viewer] = await Promise.all([this.api(target, "GET", endpoint), this.viewer(target)]);
    const issue = normalizeIssue(raw, target.repo);
    if (issue.state !== "open") throw new GitHubError("열린 작업만 되돌려 보낼 수 있습니다.", "issue-state", 409);
    const mine = issue.assignees.filter((user) => user.toLowerCase() === viewer.toLowerCase());
    const others = issue.assignees.length - mine.length;
    const shared = issue.meta?.shared === true;
    const sender = LOGIN.test(String(issue.meta?.from ?? "")) ? issue.meta.from : issue.author;
    if (!others && !shared && !LOGIN.test(sender)) throw new GitHubError("보낸 사람을 확인하지 못했습니다.");
    const note = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 4000) : "사유 없음";
    const action = others ? "작업에서 빠졌습니다." : shared ? "작업을 팀 공용으로 되돌렸습니다." : "작업을 되돌려 보냈습니다.";
    await this.api(target, "POST", endpoint + "/comments", { body: maskSecrets("↩️ @" + viewer + "님이 " + action + "\n\n" + note) }, { write: true });
    const updated = others
      ? await this.api(target, "DELETE", endpoint + "/assignees", { assignees: mine }, { write: true })
      : await this.api(target, "PATCH", endpoint, { assignees: shared ? [] : [sender] }, { write: true });
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
