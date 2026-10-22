import fs from "node:fs";
import { normalizeIssue } from "../issues.mjs";
import { HttpError } from "./errors.mjs";
import { clone, now, failure, ISSUE_NUMBER, issueSummary } from "./task-domain.mjs";

/** Manage optional issue metadata without treating running sessions as Git mutations. */
export function createTaskIssueLinks({ busy, get, github, issues, locked, records, save }) {
  // 이슈 상태는 보조 정보다. 읽지 못해도 작업 최신 확인을 실패로 만들지 않는다.
  async function syncIssue(task, target) {
    if (!task.issue) return;
    try {
      target ??= await github.target(task.projectPath, task.remote);
      const raw = await github.api(target, "GET", `repos/${task.issue.repo}/issues/${task.issue.number}`);
      task.issue = issueSummary(normalizeIssue(raw, task.issue.repo));
    } catch (error) {
      task.issue = { ...task.issue, checkedAt: now(), error: error.message, errorReason: error.reason ?? "github-error" };
    }
  }
  // 작업에 이슈를 연결하거나 작업 내용으로 새 이슈를 만든다. 작업 기록만 바꾸므로 AI 세션이 실행 중이어도 막지 않는다.
  function annotate(id, action) {
    const task = get(id);
    return locked(task.gitCommonDir, async () => {
      if (records.get(id) !== task) throw new HttpError(404, "작업이 없습니다.", "task-missing");
      if (busy.has(id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
      if (task.state === "cleaned") throw new HttpError(409, "정리한 작업의 이슈 연결은 바꿀 수 없습니다.", "task-completed");
      busy.add(id);
      try { return await action(task); }
      catch (error) { throw failure(error); }
      finally { busy.delete(id); }
    });
  }
  const linkIssue = (id, body = {}) => annotate(id, async (task) => {
    const create = body.create === true;
    const number = String(body.number ?? "").trim().replace(/^#/, "");
    if (!create && !ISSUE_NUMBER.test(number)) throw new HttpError(400, "연결할 이슈 번호를 입력하세요.", "task-issue");
    const target = await github.target(task.projectPath, task.remote);
    if (target.name !== task.remote || (task.repo && task.repo.toLowerCase() !== target.repo.toLowerCase()))
      throw new HttpError(409, "작업에 연결된 GitHub 저장소가 바뀌었습니다.", "task-remote");
    let issue;
    if (create) {
      const title = String(body.title ?? task.title).trim();
      const text = [task.content, task.acceptance ? `## 완료 기준\n${task.acceptance}` : "", `AgentHub 작업 브랜치: ${task.branch} → ${task.targetBranch}`].filter(Boolean).join("\n\n");
      try {
        // 이슈 메타데이터에 작업 브랜치와 커밋이 남도록 작업 폴더에서 만든다.
        ({ issue } = await issues.create(fs.existsSync(task.cwd) ? task.cwd : task.projectPath, { title, body: text, assignee: await issues.viewer(target), remote: task.remote, repo: target.repo }));
      } catch (error) {
        // 같은 이슈를 두 번 만들지 않도록 자동으로 다시 시도하지 않는다.
        if (error.outcomeUnknown) throw new HttpError(504, "이슈를 만들었는지 확인하지 못했습니다. GitHub에서 이슈가 생겼는지 확인한 뒤 번호로 연결하세요.", "github-timeout");
        throw error;
      }
    } else {
      const other = [...records.values()].find((item) => item.id !== task.id && item.state !== "cleaned" && item.issue?.number === Number(number)
        && item.issue.repo.toLowerCase() === target.repo.toLowerCase());
      if (other) throw new HttpError(409, `이슈 #${number}은 이미 "${other.title}" 작업에 연결되어 있습니다.`, "task-issue-linked");
      let raw;
      try { raw = await github.api(target, "GET", `repos/${target.repo}/issues/${number}`); }
      catch (error) {
        if (/\bHTTP 404\b/.test(error.message)) throw new HttpError(404, `${target.repo}에 #${number} 이슈가 없습니다. 번호를 확인하세요.`, "task-issue");
        throw error;
      }
      if (raw.pull_request) throw new HttpError(400, `#${number}은 Pull Request입니다. 이슈 번호를 입력하세요.`, "task-issue");
      issue = normalizeIssue(raw, target.repo);
    }
    task.repo = target.repo;
    task.issue = issueSummary(issue);
    save(task);
    return { task: clone(task) };
  });
  const unlinkIssue = (id) => annotate(id, async (task) => {
    delete task.issue;
    save(task);
    return { task: clone(task) };
  });
  return { syncIssue, linkIssue, unlinkIssue };
}
