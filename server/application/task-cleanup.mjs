import fs from "node:fs";
import path from "node:path";
import { githubCredentialArgs } from "../github.mjs";
import { HttpError } from "./errors.mjs";
import { taskGit, taskRef, taskAncestor, assertTaskWorktree, readTaskBranch, taskDirty, taskWorktreeLocation, sameTaskPath, assertTaskGitIdle, removeWorktreeDir } from "../tasks.mjs";
import { clone, now, remoteFingerprint, failure, recordError } from "./task-domain.mjs";

/** Verify ownership and merged content before releasing task branches, folders and sessions. */
export function createTaskCleanup({ busy, directory, findPull, freshness, get, github, githubTarget, hasFolder, isBusy, issues, leaveInPlaceBranch, locked, mutate, notify, offBranch, records, save, sessionService, setPull, store, taskDir, taskSettings, workspace }) {
  // 작업 브랜치의 내용이 이미 대상에 모두 들어 있는지 본다. 병합한 뒤 기준 브랜치를 받아온 병합 커밋만 더 붙었거나
  // 하나로 합치기(squash)로 병합했어도, 작업 브랜치를 대상에 다시 합친 결과가 대상과 같으면 정리해도 잃는 내용이 없다.
  async function contentInTarget(task, head, target) {
    if (!head || !target) return false;
    if (await taskAncestor(task.projectPath, head, target)) return true;
    try {
      const merged = (await taskGit(task.projectPath, ["merge-tree", "--write-tree", target, head])).trim().split(/\r?\n/)[0];
      return merged === (await taskGit(task.projectPath, ["rev-parse", `${target}^{tree}`])).trim();
    } catch (error) { if (error.reason === "git-timeout") throw error; return false; }
  }
  // 정리를 막은 커밋을 보여 준다. 무엇이 남았는지 보고 판단할 수 있게 한다.
  async function extraCommits(task, from, head) {
    if (!from || !head) return undefined;
    const lines = (await taskGit(task.projectPath, ["log", "--format=%h %s", "-n", "11", `${from}..${head}`]).catch(() => "")).trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) return undefined;
    return `남은 커밋:\n${lines.slice(0, 10).join("\n")}${lines.length > 10 ? "\n…" : ""}`;
  }
  // 이 작업이 만든 원격 작업 브랜치를 찾는다. 작업을 만들 때 확인한 원격 주소일 때만 다룬다.
  async function remoteTaskBranch(task) {
    if (task.ownsBranch === false || !task.remote) return null;
    const url = (await taskGit(task.projectPath, ["remote", "get-url", task.remote])).trim();
    if (remoteFingerprint(url) !== task.remoteFingerprint) throw new HttpError(409, "작업 생성 후 원격 주소가 바뀌었습니다. 원격 브랜치는 Git 탭에서 직접 확인하세요.", "task-remote");
    const sha = (await taskGit(task.projectPath, [...githubCredentialArgs(), "ls-remote", "--heads", "--", url, `refs/heads/${task.branch}`])).trim().split(/\s+/)[0];
    return sha ? { url, sha } : null;
  }
  // 확인한 커밋일 때만 지운다. 그사이 누가 올렸으면 거절된다.
  async function deleteRemoteBranch(task, { url, sha }) {
    await taskGit(task.projectPath, [...githubCredentialArgs(), "push", `--force-with-lease=refs/heads/${task.branch}:${sha}`, "--", url, `:refs/heads/${task.branch}`], { write: true });
    // URL로 지우면 원격 추적 브랜치가 남으므로 함께 지운다.
    await taskGit(task.projectPath, ["update-ref", "-d", `refs/remotes/${task.remote}/${task.branch}`], { write: true }).catch(() => {});
  }
  async function cleanup(id) {
    return mutate(id, async (task) => {
      if (task.state === "cleaned") {
        // 정리는 끝났지만 잠긴 파일 때문에 폴더가 남았으면 다시 누를 때 남은 폴더만 지운다.
        if (task.folderLeft) {
          await removeTaskWorktree(task);
          if (!task.folderLeft) delete task.cleanupWarning;
          save(task);
        }
        return { task: clone(task) };
      }
      if (task.pendingAction) throw new HttpError(409, "이전 요청의 완료 여부를 먼저 확인하세요.", "task-outcome-unknown", { outcomeUnknown: true });
      // 작업 폴더가 이미 사라졌으면 로컬 작업 브랜치로 병합 여부를 확인하고 남은 기록과 브랜치만 정리한다.
      // 원본 폴더가 작업 브랜치를 벗어났으면 폴더는 그대로 두고 로컬 작업 브랜치만 확인해 정리한다.
      const moved = offBranch(task);
      const present = !moved && (task.inPlace || hasFolder(task));
      const head = present ? await assertTaskWorktree(task) : await taskRef(task.projectPath, `refs/heads/${task.branch}`);
      if (!head) throw new HttpError(409, moved ? `로컬 작업 브랜치 ${task.branch}가 없고 원본 폴더도 다른 브랜치에 있어 정리할 것이 없습니다.` : "작업 폴더와 로컬 작업 브랜치가 모두 없습니다.",
        "task-record-only", { hint: "작업 카드의 '기록만 정리'(작업 삭제)로 작업 기록만 지우세요. 원본 폴더와 원격 브랜치·PR은 그대로 둡니다." });
      if (present) {
        await assertTaskGitIdle(task);
        if (await taskDirty(task)) throw new HttpError(409, "커밋하지 않은 변경이나 새 파일이 남아 있어 정리할 수 없습니다.", "task-dirty");
      }
      let mergedInto;
      if (task.completion?.kind === "local") {
        const targetHead = await taskRef(task.projectPath, `refs/heads/${task.targetBranch}`);
        mergedInto = targetHead;
        if (task.state !== "merged" || !task.mergedHead || !targetHead || !await taskAncestor(task.projectPath, task.mergedHead, targetHead)
          || (head !== task.mergedHead && !await contentInTarget(task, head, targetHead)))
          throw new HttpError(409, "대상 브랜치에 반영되지 않은 커밋이 있어 정리할 수 없습니다.", "task-unmerged-commits", { hint: await extraCommits(task, task.mergedHead, head) });
        if (task.completion.publishState === "pending") throw new HttpError(409, "대상 브랜치 푸시를 먼저 완료하세요.", "task-unpushed");
        if (task.completion.developPublishState === "pending") throw new HttpError(409, `${taskSettings(task).develop} 브랜치 푸시를 먼저 완료하세요.`, "task-unpushed");
        if (["hotfix", "release"].includes(task.type)) {
          const developHead = await taskRef(task.projectPath, `refs/heads/${taskSettings(task).develop}`);
          if (!developHead || !await contentInTarget(task, head, developHead)) throw new HttpError(409, "개발 브랜치에도 작업을 반영한 뒤 정리하세요.", "gitflow-develop-pending");
        }
      } else {
      await freshness(task);
      mergedInto = task.freshness.targetSha;
      const target = await githubTarget(task);
      // Git 탭에서 만든 PR처럼 작업에 아직 연결되지 않은 PR도 찾아 확인한다.
      const pull = task.pull ? (await github.detail(taskDir(task), task.pull.number, { remote: task.remote })).pull : await findPull(task, target);
      if (!pull) throw new HttpError(409, "PR 병합을 먼저 완료하세요.", "task-unmerged");
      setPull(task, pull);
      if (pull.state !== "MERGED") throw new HttpError(409, "병합이 확인된 작업만 정리할 수 있습니다.", "task-unmerged");
      if (!pull.headRefOid || (head !== pull.headRefOid && !await contentInTarget(task, head, task.freshness.targetSha)))
        throw new HttpError(409, "PR에 병합되지 않은 추가 커밋이 있어 정리할 수 없습니다.", "task-unmerged-commits", { hint: await extraCommits(task, pull.headRefOid, head) });
      const remoteHead = await github.remoteHead(target, task.branch);
      if (remoteHead && remoteHead !== head && remoteHead !== pull.headRefOid && !await contentInTarget(task, remoteHead, task.freshness.targetSha))
        throw new HttpError(409, "원격 작업 브랜치가 달라졌습니다. 추가 변경을 먼저 확인하세요.", "task-unpushed");
      if (["release", "hotfix"].includes(task.type) && (!task.freshness.developSha || task.freshness.mainMissing)) {
        task.developPending = true;
        const { main, develop } = taskSettings(task);
        throw new HttpError(409, `${main}의 배포·긴급 수정을 ${develop}에도 반영한 뒤 정리하세요.`, "gitflow-develop-pending");
      }
      }
      const expected = taskWorktreeLocation({ common: task.gitCommonDir, top: task.projectPath }, task.id, task.worktreeName);
      const ownsWorktree = task.ownsWorktree !== false;
      const ownsBranch = task.ownsBranch !== false;
      const expectedRoot = task.selectedWorkBranch ? task.worktreeRoot : expected.root;
      if (ownsWorktree && ((!task.selectedWorkBranch && !sameTaskPath(expected.cwd, task.cwd)) || !sameTaskPath(path.dirname(task.cwd), expectedRoot)))
        throw new HttpError(409, "AgentHub가 생성한 작업 폴더인지 확인할 수 없습니다.", "task-worktree");
      if (present ? await assertTaskWorktree(task) !== head || await taskDirty(task)
        : (!moved && hasFolder(task)) || (moved && !offBranch(task)) || await taskRef(task.projectPath, `refs/heads/${task.branch}`) !== head)
        throw new HttpError(409, "정리 확인 중 작업 폴더가 변경됐습니다. 다시 확인하세요.", "task-stale-head");
      // 원격에 올린 작업 브랜치도 대상에 모두 들어갔으면 함께 지운다. 확인하지 못하거나 남은 커밋이 있으면 원격 브랜치만 남기고 알린다.
      let remoteBranch = null, remoteWarning;
      try {
        remoteBranch = await remoteTaskBranch(task);
        if (remoteBranch && ![head, task.mergedHead].includes(remoteBranch.sha) && !await taskAncestor(task.projectPath, remoteBranch.sha, head)
          && !await contentInTarget(task, remoteBranch.sha, mergedInto)) {
          remoteWarning = `원격 작업 브랜치 ${task.remote}/${task.branch}에 대상에 반영되지 않은 커밋이 있어 원격 브랜치는 남겼습니다.`;
          remoteBranch = null;
        }
      } catch (error) {
        remoteWarning = `원격 작업 브랜치를 확인하지 못해 남겼습니다: ${error.message}`;
        remoteBranch = null;
      }
      // 기존 워크트리를 골라 시작한 작업은 폴더를 남기고 작업 전 브랜치로 되돌린다. AgentHub가 만든 폴더는 재사용 대기 폴더로 남기거나 지운다.
      if (task.inPlace || (task.reusedWorktree && present)) { if (present) await leaveInPlaceBranch(task); }
      else if (ownsWorktree) { if (!await workspace.park(task)) await removeTaskWorktree(task); }
      else task.worktreePreserved = true;
      task.localBranchRemoved = false;
      // Compare-and-delete permits squash merges without using a destructive force flag.
      try {
        if (ownsBranch) {
          await taskGit(task.projectPath, ["update-ref", "-d", `refs/heads/${task.branch}`, head], { write: true });
          task.localBranchRemoved = true;
        }
      } catch (error) { task.cleanupWarning = `작업 폴더는 정리됐지만 로컬 브랜치는 남았습니다: ${error.message}`; }
      if (remoteBranch) {
        try {
          await deleteRemoteBranch(task, remoteBranch);
          task.remoteBranchRemoved = true;
        } catch (error) { remoteWarning = `원격 작업 브랜치 ${task.remote}/${task.branch}는 남았습니다: ${error.message}`; }
      }
      if (remoteWarning) task.cleanupWarning = [task.cleanupWarning, remoteWarning].filter(Boolean).join("\n");
      task.state = "cleaned";
      task.cleanedAt = now();
      task.developPending = false;
      save(task);
      return { task: clone(task) };
    });
  }
  // Windows에서는 편집기·탐색기·백신·남은 개발 서버가 파일을 잡고 있으면 git이 폴더를 다 지우지 못한다.
  // 잠시 기다리며 다시 시도하고, git 기록은 빠졌는데 폴더만 남았으면 정리는 끝내고 남은 폴더를 기록해 다시 지울 수 있게 한다.
  async function removeTaskWorktree(task) {
    await workspace.stopCopy(task.id);
    const result = await removeWorktreeDir(task.projectPath, task.folderLeft ?? task.cwd);
    if (result.registered) throw new HttpError(409, `작업 폴더를 지우지 못했습니다. 그 폴더를 연 편집기·탐색기·터미널을 닫고 다시 정리하세요.\n${result.error?.message ?? ""}`.trim(), "task-worktree-locked");
    if (result.removed) { delete task.folderLeft; return; }
    task.folderLeft = task.cwd;
    task.cleanupWarning = `작업 폴더 일부가 남았습니다. 파일을 잡고 있는 프로그램을 닫은 뒤 정리를 다시 누르세요: ${task.cwd}`;
  }
  // 작업을 지운다. 연결된 세션을 멈추고 지운 뒤, AgentHub가 만든 작업 폴더를 지우고 작업 기록을 없앤다.
  // 원격 브랜치와 PR은 건드리지 않는다. deleteBranch면 이 작업이 만든 로컬 브랜치도 지운다.
  // force가 없으면 실행 중인 세션이나 커밋하지 않은 변경이 있을 때 멈추고 알린다.
  async function remove(id, { force = false, deleteBranch = false } = {}) {
    const task = get(id);
    return locked(task.gitCommonDir, async () => {
      if (records.get(id) !== task) throw new HttpError(404, "작업이 없습니다.", "task-missing");
      if (busy.has(id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
      const owned = store.list().filter((session) => session.taskId === id || task.sessionIds.includes(session.id));
      if (!force && owned.some((session) => isBusy(session.id)))
        throw new HttpError(409, "이 작업에서 실행 중인 세션이 있습니다.", "running");
      busy.add(id);
      try {
        const live = task.state !== "cleaned";
        const ownsFolder = live && !task.inPlace && task.ownsWorktree !== false;
        const removeFolder = ownsFolder && fs.existsSync(task.cwd);
        let dirty = null, parked = false;
        if (removeFolder) {
          const expected = taskWorktreeLocation({ common: task.gitCommonDir, top: task.projectPath }, task.id, task.worktreeName);
          const expectedRoot = task.selectedWorkBranch ? task.worktreeRoot : expected.root;
          if ((!task.selectedWorkBranch && !sameTaskPath(expected.cwd, task.cwd)) || !sameTaskPath(path.dirname(task.cwd), expectedRoot))
            throw new HttpError(409, "AgentHub가 생성한 작업 폴더인지 확인할 수 없어 지우지 않았습니다.", "task-worktree");
          // 반쯤 지워져 Git 작업 폴더가 아니게 된 폴더는 변경 여부를 읽을 수 없으므로, 세션을 지우기 전에 강제 삭제 확인을 받는다.
          dirty = await taskDirty(task).then((value) => value ? "작업 폴더에 커밋하지 않은 변경이나 새 파일이 있습니다." : null,
            () => "작업 폴더가 손상되어 커밋하지 않은 변경이 있는지 확인할 수 없습니다. 남은 파일을 확인한 뒤 강제로 지우세요.");
          if (!force && dirty) throw new HttpError(409, dirty, "task-dirty");
        }
        for (const session of owned) await sessionService().remove(session.id, { force: true });
        let warning;
        await workspace.stopCopy(id);
        // 깨끗한 작업 폴더는 설정에 따라 지우지 않고 재사용 대기 폴더로 남긴다.
        if (removeFolder && !dirty) parked = await workspace.park(task).catch(() => false);
        if (removeFolder && !parked) {
          // 막 멈춘 세션 프로세스가 파일을 잡고 있을 수 있어 잠시 기다리며 다시 시도한다.
          const result = await removeWorktreeDir(task.projectPath, task.cwd, { force });
          if (result.registered) throw new HttpError(409, `세션은 지웠지만 작업 폴더를 지우지 못했습니다. 그 폴더를 연 프로그램을 닫고 다시 삭제하세요.\n${result.error?.message ?? ""}`.trim(), "task-worktree-locked");
          if (!result.removed) warning = `작업 폴더 일부가 남았습니다. 파일을 잡고 있는 프로그램을 닫은 뒤 직접 지우세요: ${task.cwd}`;
        } else if (!parked && (ownsFolder || task.folderLeft)) {
          // 이미 사라진 폴더의 기록을 정리하고, 정리 뒤 남았던 폴더가 있으면 마저 지운다.
          const result = await removeWorktreeDir(task.projectPath, task.folderLeft ?? task.cwd, { force: true });
          if (!result.removed) warning = `작업 폴더 일부가 남았습니다. 직접 지우세요: ${task.folderLeft ?? task.cwd}`;
        }
        // 원본 폴더나 이어받은 워크트리에서 한 작업은 브랜치를 남기더라도 폴더를 작업 전 브랜치로 되돌린다.
        if (live && (task.inPlace || task.reusedWorktree) && fs.existsSync(task.cwd) && readTaskBranch(task.cwd) === task.branch) {
          try { await leaveInPlaceBranch(task); }
          catch (error) { warning = `${task.inPlace ? "원본 폴더" : "작업 폴더"}를 작업 전 브랜치로 되돌리지 못했습니다: ${error.message}`; }
        }
        let branchRemoved = false;
        if (deleteBranch && live && task.ownsBranch !== false && await taskRef(task.projectPath, `refs/heads/${task.branch}`)) {
          try {
            await taskGit(task.projectPath, ["branch", "-D", task.branch], { write: true });
            branchRemoved = true;
          } catch (error) { warning = `작업은 지웠지만 로컬 브랜치 ${task.branch}는 남았습니다: ${error.message}`; }
        }
        fs.rmSync(path.join(directory, `${id}.json`), { force: true });
        records.delete(id);
        notify("tasks", { projectPath: task.projectPath, taskId: id });
        return { ok: true, sessionIds: owned.map((session) => session.id), worktreeRemoved: removeFolder, branchRemoved, ...(parked ? { parked: task.parkedWorktree } : {}), ...(warning ? { warning } : {}) };
      } finally { busy.delete(id); }
    });
  }
  // 작업을 그만둔다. 열린 PR을 닫고, 이 작업이 만든 원격 브랜치를 지우고, 연결된 이슈에서 내 담당을 뺀 뒤
  // 세션·작업 폴더·로컬 브랜치·작업 기록을 모두 지운다. 원격 처리에 실패하면 로컬은 그대로 두고 알린다.
  // 기존 브랜치를 골라 시작한 작업은 그 브랜치를 남긴다.
  async function abandon(id, { force = false } = {}) {
    const task = get(id);
    if (task.state === "merged" || task.state === "cleaned") throw new HttpError(409, "이미 반영한 작업은 그만둘 수 없습니다. 작업 삭제나 정리를 사용하세요.", "task-completed");
    if (busy.has(id)) throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
    if (task.pendingAction) throw new HttpError(409, "이전 요청의 결과를 먼저 확인하세요.", "task-outcome-unknown", { outcomeUnknown: true });
    const owned = store.list().filter((session) => session.taskId === id || task.sessionIds.includes(session.id));
    if (!force && owned.some((session) => isBusy(session.id))) throw new HttpError(409, "이 작업에서 실행 중인 세션이 있습니다.", "running");
    if (!force && !task.inPlace && task.ownsWorktree !== false && fs.existsSync(task.cwd) && await taskDirty(task))
      throw new HttpError(409, "작업 폴더에 커밋하지 않은 변경이나 새 파일이 있습니다.", "task-dirty");
    const remote = { pullClosed: null, remoteBranchRemoved: false, issueUnassigned: false };
    const warnings = [];
    await locked(task.gitCommonDir, async () => {
      busy.add(id);
      try {
        if (task.pull?.number && task.pull.state === "OPEN") {
          const target = await githubTarget(task);
          await github.close(task.projectPath, task.pull.number, { remote: task.remote, repo: target.repo });
          remote.pullClosed = task.pull.number;
          task.pull = { ...task.pull, state: "CLOSED" };
          save(task);
        }
        const branch = await remoteTaskBranch(task);
        if (branch) {
          await deleteRemoteBranch(task, branch);
          remote.remoteBranchRemoved = true;
        }
      } catch (error) { recordError(task, error); save(task); throw failure(error); }
      finally { busy.delete(id); }
    });
    if (task.issue?.number) {
      try {
        const target = await githubTarget(task);
        const viewer = await issues.viewer(target);
        await github.api(target, "DELETE", `repos/${task.issue.repo}/issues/${task.issue.number}/assignees`, { assignees: [viewer] }, { write: true });
        remote.issueUnassigned = true;
      } catch (error) { warnings.push(`이슈 #${task.issue.number}의 담당을 해제하지 못했습니다: ${error.message}`); }
    }
    const result = await remove(id, { force: true, deleteBranch: true });
    if (result.warning) warnings.push(result.warning);
    return { ...result, ...remote, ...(warnings.length ? { warning: warnings.join("\n") } : {}) };
  }
  return { cleanup, remove, abandon };
}
