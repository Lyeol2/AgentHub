// 작업 노드: 작업 탭의 새 작업·작업 마무리를 흐름에서 실행한다.
// 새 작업은 세션 없이 브랜치·작업 폴더·작업 기록만 만들고, 성공 출력에 연결한 세션을 그 작업으로 옮긴다.
import { verifyGitContext } from "./git-context.mjs";
import { renderTemplate } from "./flow-nodes.mjs";

const TYPE_LABEL = { feature: "기능 개발", hotfix: "긴급 수정", release: "배포 준비" };
const failure = (reason, message) => Object.assign(new Error(message), { reason });

// flow.tasks: 이 실행에서 새 작업 노드가 만든 작업(노드 ID → 작업 ID). 반복 노드로 다시 불려도 작업을 새로 만들지 않는다.
// flow.taskId: 이 실행에서 마지막으로 만든 작업. 앞 세션이 작업에 속하지 않을 때 작업 마무리가 쓴다.
export async function runTaskNode({ command, tasks, origin = null, input = "", flow }) {
  if (!tasks) throw failure("task-unavailable", "작업 기능을 사용할 수 없습니다.");
  const variables = { ...flow.variables, input, output: input };
  if (command.taskAction === "finish") {
    const taskId = origin?.taskId ?? flow.taskId;
    if (!taskId) throw failure("task-missing", "마무리할 작업을 찾지 못했습니다. 작업에 연결된 세션이나 새 작업 노드 뒤에 연결하세요.");
    const message = renderTemplate(command.commitMessage ?? "", variables).trim();
    const { task, pull } = await tasks.finish(taskId, { ...(message ? { message } : {}),
      description: renderTemplate(command.description ?? "{{input}}", variables).slice(0, 40_000),
      verification: renderTemplate(command.verification ?? "", variables).slice(0, 10_000) });
    return { ok: true, action: "finish", taskId: task.id, title: task.title, branch: task.branch, targetBranch: task.targetBranch, cwd: task.cwd,
      pull: pull ? { number: pull.number, url: pull.url, state: pull.state } : null };
  }
  flow.tasks ??= {};
  let task = flow.tasks[command.id] ? tasks.get(flow.tasks[command.id]) : null;
  const reused = !!task;
  if (!task) {
    const title = renderTemplate(command.titleTemplate ?? "{{input}}", variables).split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 160);
    if (!title) throw failure("task-title", "작업 제목이 비었습니다. 제목 템플릿이나 앞 노드의 결과를 확인하세요.");
    ({ task } = await tasks.create({ projectPath: command.projectPath, title, type: command.taskType ?? "feature",
      ...(command.taskType === "release" ? { version: renderTemplate(command.version ?? "", variables).trim() } : {}),
      ...(command.inPlace ? { worktree: false } : {}), session: false }));
    flow.tasks[command.id] = task.id;
  }
  flow.taskId = task.id;
  const context = verifyGitContext({ repoCommonDir: task.gitCommonDir, branch: task.branch, cwd: task.cwd }, command.projectPath);
  return { ok: true, action: "start", reused, taskId: task.id, title: task.title, type: task.type, branch: task.branch,
    baseBranch: task.baseBranch, targetBranch: task.targetBranch, cwd: task.cwd, context };
}

// 다음 노드에 넘길 결과 글
export function taskResultText(result, input = "") {
  const request = input.trim() ? "\n\n원래 요청:\n" + input.trim() : "";
  if (!result.ok) return [result.action === "finish" ? "[작업 마무리 실패]" : "[새 작업 실패]", result.message,
    result.outcomeUnknown ? "원격 요청의 완료 여부를 알 수 없습니다. 작업 탭에서 상태 확인을 먼저 하세요." : null].filter(Boolean).join("\n") + request;
  if (result.action === "finish") return ["[작업 마무리]", "작업: " + result.title,
    result.pull ? `PR #${result.pull.number}${result.pull.state === "MERGED" ? " (이미 병합됨)" : ""}: ${result.pull.url}` : null,
    `브랜치: ${result.branch} → ${result.targetBranch}`].filter(Boolean).join("\n") + request;
  return [result.reused ? "[새 작업 · 이번 실행에서 만든 작업 사용]" : "[새 작업]", "작업: " + result.title,
    "유형: " + (TYPE_LABEL[result.type] ?? result.type), `브랜치: ${result.branch} (기준 ${result.baseBranch}, PR 대상 ${result.targetBranch})`,
    "작업 폴더: " + result.cwd].join("\n") + request;
}
