import fs from "node:fs";
import path from "node:path";
import { isGitRepo } from "../git.mjs";
import { gitOverview, fileDiff, showCommit, branchDiff, stage, unstage, commit, merge } from "../gitpanel.mjs";
import { githubPulls, GitHubError } from "../github.mjs";
import { samePath } from "./projects.mjs";
import { HttpError } from "./errors.mjs";

export function createGitService({ sessions, projects, runner, notify }) {
  const { getSession } = sessions;

  async function gitRepo(projectPath) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const directory = path.resolve(String(projectPath));
    if (!fs.existsSync(directory)) throw new HttpError(400, "프로젝트 폴더가 없습니다.");
    if (!(await isGitRepo(directory))) throw new HttpError(400, "git 저장소가 아닙니다.", "not-git");
    return directory;
  }

  // 세션의 분리한 작업 폴더. 이 프로젝트의 세션이어야 한다.
  function sessionWorktree(sessionId, repo) {
    const session = getSession(sessionId);
    if (!samePath(session.projectPath, repo)) throw new HttpError(400, "이 프로젝트의 세션이 아닙니다.");
    if (!session.worktree || !fs.existsSync(session.worktree.dir)) throw new HttpError(400, "작업 폴더를 분리한 세션이 아닙니다.");
    return session.worktree.dir;
  }

  async function execute(action, { projectPath, sessionId, file, area, hash, branch, remote, state, number, ...body } = {}) {
    const repo = await gitRepo(projectPath);
    const directory = sessionId ? sessionWorktree(sessionId, repo) : repo;
    try {
      if (action === "overview") return await gitOverview(repo, projects.projectSessions(repo));
      if (action === "diff") return { diff: await fileDiff(directory, file ?? "", area) };
      if (action === "show") return { diff: await showCommit(repo, hash) };
      if (action === "branch") return { diff: await branchDiff(repo, branch) };
      if (action === "pulls") return await githubPulls.list(directory, { remote, state: state ?? "open" });
      if (action === "pull") return await githubPulls.detail(directory, number, { remote });
      if (["push", "createPull", "mergePull", "closePull"].includes(action)) {
        if (sessionId && runner.isRunning(sessionId)) throw new HttpError(409, "세션이 실행 중입니다. 끝나거나 일시중지한 뒤 GitHub를 변경하세요.");
        const options = { ...body };
        if (remote !== undefined) options.remote = remote;
        if (branch !== undefined) options.branch = branch;
        if (state !== undefined) options.state = state;
        let result;
        if (action === "push") result = await githubPulls.push(directory, options);
        else if (action === "createPull") result = await githubPulls.create(directory, options);
        else if (action === "mergePull") result = await githubPulls.merge(directory, number, options);
        else result = await githubPulls.close(directory, number, options);
        notify("git", { projectPath: repo });
        return result;
      }
      if (action === "stage" || action === "unstage") {
        if (sessionId && runner.isRunning(sessionId)) throw new HttpError(409, "세션이 실행 중입니다. 끝나거나 일시중지한 뒤 변경하세요.");
        const count = await (action === "stage" ? stage : unstage)(directory, body.files);
        notify("git", { projectPath: repo });
        return { ok: true, count };
      }
      if (action === "commit") {
        if (sessionId && runner.isRunning(sessionId)) throw new HttpError(409, "세션이 실행 중입니다. 끝나거나 일시중지한 뒤 커밋하세요.");
        const files = Array.isArray(body.files) ? body.files : null;
        const result = await commit(directory, body.message, files, { staged: body.staged === true });
        notify("git", { projectPath: repo });
        return { ok: true, result };
      }
      if (action === "merge") {
        const result = await merge(repo, String(branch ?? ""));
        notify("git", { projectPath: repo });
        return { ok: true, result };
      }
      throw new HttpError(404, "없는 API입니다.");
    } catch (error) {
      if (error instanceof GitHubError) throw new HttpError(error.status, error.message, error.reason, { outcomeUnknown: error.outcomeUnknown });
      if (error instanceof HttpError) throw error;
      throw new HttpError(error.conflict ? 409 : 400, error.message, error.conflict ? "conflict" : undefined);
    }
  }

  return { execute };
}
