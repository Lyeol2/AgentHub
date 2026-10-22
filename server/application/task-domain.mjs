import fs from "node:fs";
import { createHash } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { hintFor } from "./error-hints.mjs";

export const isGitflowBase = (flow, branch) => branch === flow.main || branch === flow.develop;

export const clone = (value) => structuredClone(value);
export const now = () => new Date().toISOString();
export const remoteFingerprint = (value) => createHash("sha256").update(value).digest("hex");
// 사용자가 접두어까지 적은 브랜치 이름(feature/login)에 접두어를 한 번 더 붙이지 않는다.
// 다른 유형의 접두어로 시작하면 기준·대상 브랜치가 어긋나므로 받지 않는다.
export function taskBranchName(flow, type, value = "") {
  const prefix = flow[`${type}Prefix`];
  if (!value) return "";
  if (value.startsWith(prefix)) {
    const rest = value.slice(prefix.length);
    if (!rest) throw new HttpError(400, `브랜치 이름에 ${prefix} 뒤의 이름을 입력하세요.`, "task-branch-name");
    return rest;
  }
  const other = ["featurePrefix", "hotfixPrefix", "releasePrefix"].map((key) => flow[key]).find((item) => item !== prefix && value.startsWith(item));
  if (other) throw new HttpError(400, `브랜치 이름이 다른 작업 유형의 접두어(${other})로 시작합니다. 작업 유형을 바꾸거나 접두어를 빼고 입력하세요.`, "task-branch-name");
  return value;
}
export const failure = (error) => error instanceof HttpError ? error : new HttpError(error.status ?? 409, error.message, error.reason ?? "task-error", { outcomeUnknown: !!error.outcomeUnknown, hint: error.hint, raw: error.raw });
// 카드에 남기는 오류. 해결 방법(hint)이 있으면 함께 보관한다.
export const recordError = (task, error) => {
  task.error = error.message; task.errorReason = error.reason;
  const hint = typeof error.hint === "string" && error.hint ? error.hint : hintFor(error.reason);
  if (hint) task.errorHint = hint; else delete task.errorHint;
};

export const emptyDir = (dir) => { try { return fs.statSync(dir).isDirectory() && !fs.readdirSync(dir).length; } catch { return false; } };
// git worktree add가 실패한 원인을 사용자가 알 수 있는 문장으로 바꾼다. 원문은 raw로 남긴다.
export const WORKTREE_FAILURES = [
  [/invalid path|Filename too long|cannot create directory|unable to create file/i, "저장소에 이 컴퓨터에서 만들 수 없는 파일 이름이나 너무 긴 경로가 있어 작업 폴더를 만들지 못했습니다.",
    "파일 이름에 : * ? \" < > | 같은 문자가 있는지, 경로가 너무 길지 않은지 확인하세요. 원본 폴더에서 작업하는 방법도 있습니다."],
  [/already registered worktree|already checked out|is already used by worktree/i, "같은 경로나 브랜치가 다른 워크트리에 등록되어 있어 작업 폴더를 만들지 못했습니다.",
    "Git 패널의 워크트리 목록에서 남은 항목을 정리한 뒤 다시 시도하세요."],
  [/Permission denied|Access is denied|EPERM|EACCES/i, "작업 폴더를 만들 권한이 없습니다.", "<프로젝트>.agenthub 폴더의 권한과 다른 프로그램이 폴더를 잡고 있는지 확인하세요."],
];
export function worktreeFailure(error) {
  if (error.outcomeUnknown || error.reason !== "git-error") return failure(error);
  const raw = String(error.raw ?? error.message);
  const [, message, hint] = WORKTREE_FAILURES.find(([test]) => test.test(raw)) ?? [null, "작업 폴더를 만들지 못했습니다.", ""];
  const cause = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(fatal|error):/i.test(line)).at(0);
  return new HttpError(409, cause ? `${message} (${cause})` : message, "task-worktree-create", { hint, raw: raw.slice(0, 1600) });
}

// 배포 준비·긴급 수정은 main에 반영한 뒤 develop에도 반영해야 끝난다.
export const needsDevelop = (task) => ["hotfix", "release"].includes(task.type);
// 이보다 오래된 최신 확인 결과는 카드가 열릴 때 다시 확인한다.
export const FRESHNESS_MAX_AGE = 10 * 60_000;
export const ISSUE_NUMBER = /^[1-9][0-9]{0,8}$/;
export const issueSummary = (issue) => ({ repo: issue.repo, number: issue.number, title: issue.title, url: issue.url, state: issue.state,
  stateReason: issue.stateReason ?? null, checkedAt: new Date().toISOString() });

