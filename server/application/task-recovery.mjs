import { normalizePull } from "../github.mjs";
import { listWorkbranches } from "../workbranches.mjs";
import { HttpError } from "./errors.mjs";
import { taskGit, taskRef, taskAncestor, assertTaskWorktree, assertTaskGitIdle } from "../tasks.mjs";
import { clone, now, needsDevelop } from "./task-domain.mjs";

/** Reconcile interrupted local and remote mutations from observed Git and pull-request state. */
export function createTaskRecovery({ backedUp, findBackMerge, findPull, freshness, github, githubTarget, hasFolder, mutate, offBranch, save, setPull, syncIssue, taskDir, taskSettings }) {
  async function refresh(id) {
    return mutate(id, async (task) => {
      if (task.state === "cleaned") return { task: clone(task) };
      // A local commit can be reconciled without any GitHub authentication/network.
      if (task.pendingAction?.action === "commit") {
        await assertTaskGitIdle(task);
        const head = await assertTaskWorktree(task), pending = task.pendingAction;
        const resolved = head !== pending.expectedHead;
        task.lastRecovery = { ...pending, checkedAt: now(), result: resolved ? "confirmed" : "not-observed" };
        delete task.pendingAction;
        if (resolved) delete task.error;
        else task.error = "이전 커밋의 결과가 확인되지 않았습니다. 변경 검토에서 현재 파일과 커밋을 확인하세요.";
        save(task);
        return { task: clone(task) };
      }
      if (task.finishMode === "local") {
        // 병합을 마친 작업은 폴더가 이미 사라졌어도 대상 브랜치 기준으로 확인한다.
        if ((task.state !== "merged" || hasFolder(task)) && !offBranch(task)) {
          await assertTaskWorktree(task);
          await assertTaskGitIdle(task);
        }
        if (task.state !== "merged") await freshness(task);
        const targetHead = await taskRef(task.projectPath, `refs/heads/${task.targetBranch}`);
        const pending = task.pendingAction;
        if (pending) {
          let resolved = false;
          if (pending.action === "local-merge") {
            const target = (await listWorkbranches(task.projectPath, { forTarget: true })).branches.find((branch) => branch.name === task.targetBranch);
            if (target?.cwd) await assertTaskGitIdle({ cwd: target.cwd });
            resolved = !!targetHead && await taskAncestor(task.cwd, pending.expectedHead, targetHead);
            if (resolved) {
              task.state = "merged"; task.mergedHead = pending.expectedHead;
              task.completion = { kind: "local", sourceHead: pending.expectedHead, targetHead, cwd: target?.cwd, mergedAt: now(), publishState: "not-requested" };
            }
          } else if (pending.action === "target-push") {
            const remote = (await taskGit(task.projectPath, ["ls-remote", "--heads", task.remote, `refs/heads/${task.targetBranch}`])).trim().split(/\s+/)[0];
            resolved = remote === pending.expectedHead;
            task.completion.publishState = resolved ? "done" : "pending";
          } else if (pending.action === "develop-merge") {
            const developHead = await taskRef(task.projectPath, `refs/heads/${taskSettings(task).develop}`);
            resolved = !!developHead && await taskAncestor(task.cwd, pending.expectedHead, developHead);
            if (resolved) Object.assign(task.completion, { developHead, developPublishState: task.completion.publishState === "not-requested" ? "not-requested" : "pending" });
          } else if (pending.action === "develop-push") {
            const remote = (await taskGit(task.projectPath, ["ls-remote", "--heads", task.remote, `refs/heads/${taskSettings(task).develop}`])).trim().split(/\s+/)[0];
            resolved = remote === pending.expectedHead;
            task.completion.developPublishState = resolved ? "done" : "pending";
          } else if (pending.action === "commit") resolved = await taskRef(task.cwd, "HEAD") !== pending.expectedHead;
          else if (pending.action === "backup") { resolved = await backedUp(task, pending.expectedHead); }
          else throw new HttpError(409, "이전 요청의 종류가 달라 자동 확인할 수 없습니다.", "task-outcome-unknown");
          task.lastRecovery = { ...pending, checkedAt: now(), result: resolved ? "confirmed" : "not-observed" };
          delete task.pendingAction;
        }
        delete task.error;
        if (task.state === "merged" && (!targetHead || !await taskAncestor(task.cwd, task.mergedHead, targetHead)))
          task.error = "대상 브랜치에서 반영한 커밋을 찾지 못했습니다. Git 탭에서 기록을 확인하세요.";
        if (needsDevelop(task) && task.state === "merged") {
          const developHead = await taskRef(task.projectPath, `refs/heads/${taskSettings(task).develop}`);
          task.developPending = !developHead || !await taskAncestor(task.cwd, task.mergedHead, developHead);
        }
        await syncIssue(task);
        save(task);
        return { task: clone(task) };
      }
      await freshness(task);
      const target = await githubTarget(task);
      const pull = task.pull ? (await github.detail(taskDir(task), task.pull.number, { remote: task.remote })).pull : await findPull(task, target);
      if (pull) setPull(task, pull);
      const pending = task.pendingAction;
      if (pending) {
        let resolved = false;
        let checked = false;
        if (pending.action === "pull") { resolved = !!pull && pull.headRefOid === pending.expectedHead; checked = true; }
        else if (pending.action === "pull-update") { resolved = !!pull && pull.body?.includes(task.description || task.title) && pull.body?.includes(task.verification || "검증 결과를 입력하지 않았습니다."); checked = true; }
        else if (pending.action === "merge-pull") { resolved = pull?.state === "MERGED"; checked = true; }
        else if (pending.action === "push") {
          resolved = await github.remoteHead(target, task.branch) === pending.expectedHead;
          checked = true;
          if (resolved) task.publishedHead = pending.expectedHead;
        } else if (pending.action === "backup") { resolved = await backedUp(task, pending.expectedHead); checked = true; }
        else if (pending.action === "develop") { resolved = !!task.freshness.developSha; checked = true; }
        else if (pending.action === "develop-pull") {
          const back = await findBackMerge(task, target);
          if (back) task.developPull = back;
          resolved = !!back || !task.freshness.mainMissing; checked = true;
        }
        else if (pending.action === "commit") {
          await assertTaskGitIdle(task);
          resolved = await taskRef(task.cwd, "HEAD") !== pending.expectedHead; checked = true;
        }
        if (checked) {
          task.lastRecovery = { ...pending, checkedAt: now(), result: resolved ? "confirmed" : "not-observed" };
          delete task.pendingAction;
          if (!resolved) task.error = "이전 요청의 결과가 현재 상태에서 확인되지 않았습니다. 작업 마무리를 다시 누르면 현재 상태를 재검증하고 재시도합니다.";
        }
      }
      if (needsDevelop(task) && task.state === "merged")
        task.developPending = !task.freshness.developSha || task.freshness.mainMissing;
      if (task.developPull?.state === "OPEN") {
        try { task.developPull = normalizePull(await github.api(target, "GET", `repos/${target.repo}/pulls/${task.developPull.number}`), target.repo); }
        catch (error) { if (error.reason === "github-timeout") throw error; }
      }
      await syncIssue(task, target);
      save(task);
      return { task: clone(task) };
    });
  }
  return { refresh };
}
