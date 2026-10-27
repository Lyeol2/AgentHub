import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./errors.mjs";
import { taskGit, taskRepo, taskRef, taskAncestor, gitflowContext, GITFLOW_FETCH_REUSE_MS, assertTaskWorktree, readTaskBranch, taskDirty, assertTaskGitIdle } from "../tasks.mjs";
import { projectGitflowSettings } from "../gitflow-settings.mjs";
import { reviewSnapshot, commitReviewedFiles, assertReviewed } from "../task-review.mjs";
import { fileDiff, parseStatus } from "../gitpanel.mjs";
import { clone, now, remoteFingerprint, recordError, FRESHNESS_MAX_AGE } from "./task-domain.mjs";

/** Read/review task state and integrate upstream changes under the shared mutation policy. */
export function createTaskReviewService({ assertActive, busy, config, externalWrite, finishModeFor, get, github, hasFolder, isBusy, locked, mutate, offBranch, save, selectFinishMode, taskSessions, taskSettings }) {
  // refresh: 사용자가 최신 상태 확인을 눌렀다. 그때는 방금 받은 fetch도 다시 쓰지 않는다.
  async function context(projectPath, { refresh = false } = {}) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    let valueSettings = projectGitflowSettings(config, projectPath);
    try {
      const repo = await taskRepo(projectPath);
      valueSettings = projectGitflowSettings(config, repo.top);
      const value = await gitflowContext(repo.top, undefined, valueSettings, { maxAge: refresh ? 0 : GITFLOW_FETCH_REUSE_MS });
      return { ...value, settings: valueSettings, finishMode: finishModeFor(repo.top), mainInDevelop: !value.mainMissing, freshness: { state: value.state, checkedAt: value.checkedAt } };
    } catch (error) {
      return { state: "error", checkedAt: now(), mainSha: null, developSha: null, warnings: [error.message],
        settings: valueSettings, freshness: { state: "error", checkedAt: now(), message: error.message }, error: error.message, reason: error.reason };
    }
  }
  async function freshness(task) {
    try {
      const gitflow = taskSettings(task);
      const value = await gitflowContext(task.projectPath, task.remote, gitflow);
      const url = (await taskGit(task.projectPath, ["remote", "get-url", task.remote])).trim();
      if (remoteFingerprint(url) !== task.remoteFingerprint) throw new HttpError(409, "작업 생성 후 원격 주소가 바뀌었습니다. 기존 원격을 복원하세요.", "task-remote");
      const targetSha = task.targetBranch === gitflow.main ? value.mainSha : value.developSha ?? value.mainSha;
      // 폴더가 사라졌거나 원본 폴더가 작업 브랜치를 벗어났으면 로컬 작업 브랜치로 판단한다.
      const head = task.state === "cleaned" ? task.publishedHead
        : (!task.inPlace && !hasFolder(task)) || offBranch(task) ? await taskRef(task.projectPath, `refs/heads/${task.branch}`) : await assertTaskWorktree(task);
      const behind = !!head && !await taskAncestor(task.projectPath, targetSha, head);
      task.freshness = { ...value, targetSha, behind, head, state: behind || (task.type !== "hotfix" && value.mainMissing) ? "needs-update" : "current" };
      delete task.error;
      save(task);
      return value;
    } catch (error) {
      task.freshness = { state: "error", checkedAt: now(), message: error.message };
      recordError(task, error);
      save(task);
      throw error;
    }
  }
  // main→develop 미반영은 작업 브랜치에서 풀 수 없다. 해야 할 일을 함께 알린다.
  const developBehindHint = (task) => { const { main, develop } = taskSettings(task);
    return `Git 탭에서 ${main}을 ${develop}에 병합해 원격에 푸시하거나, GitHub에서 ${main} → ${develop} PR을 만들어 병합하세요. 그다음 작업 카드의 최신 상태 확인을 누르면 이어서 진행할 수 있습니다.`; };
  function requireFresh(task) {
    if (task.type !== "hotfix" && task.freshness.mainMissing) {
      const { main, develop } = taskSettings(task);
      throw new HttpError(409, `${main}의 변경이 ${develop}에 아직 없습니다. 로컬 반영 전에 ${develop}에 먼저 반영해야 합니다.`,
        "gitflow-develop-behind", { hint: developBehindHint(task) });
    }
    if (task.freshness.behind) {
      throw new HttpError(409, `대상 브랜치가 변경됐습니다. '업데이트 프롬 ${task.targetBranch}'으로 최신 변경을 합친 뒤 로컬 반영하세요.`, "task-behind");
    }
  }
  async function review(id) {
    const task = get(id);
    return locked(task.gitCommonDir, async () => {
      const snapshot = await reviewSnapshot(task);
      await freshness(task);
      const localTargetHead = await taskRef(task.projectPath, `refs/heads/${task.targetBranch}`);
      const localBehind = !!localTargetHead && !await taskAncestor(task.cwd, localTargetHead, snapshot.head);
      const commits = (await taskGit(task.cwd, ["log", "--format=%H%x00%s", "-n", "100", `${task.freshness.targetSha}..${snapshot.head}`]))
        .trim().split(/\r?\n/).filter(Boolean).map((line) => { const [hash, subject] = line.split("\0"); return { hash, subject }; });
      const reviewedTask = clone(task);
      if (task.pull) {
        const { pull } = await github.detail(task.cwd, task.pull.number, { remote: task.remote });
        if (pull.headRefName !== task.branch || pull.baseRefName !== task.targetBranch) throw new HttpError(409, "작업과 PR의 브랜치가 일치하지 않습니다.", "task-pull");
        reviewedTask.pull = pull;
      }
      return { task: reviewedTask, ...snapshot, localTargetHead, localBehind, commits, finishMode: task.finishMode || "pr" };
    });
  }
  // 카드의 단계 표시용 가벼운 상태. 네트워크 없이 로컬 Git만 읽고 작업 기록은 바꾸지 않는다.
  async function status(id) {
    const task = get(id);
    const sessions = taskSessions(task);
    const result = { id: task.id, state: task.state, checkedAt: now(), sessions: sessions.length,
      running: sessions.filter((session) => isBusy(session.id)).length,
      behind: !!task.freshness?.behind, head: null, shortHead: null, commits: null, dirty: null, pushed: null, folder: true };
    const count = async (cwd, range) => Number((await taskGit(cwd, ["rev-list", "--count", "--first-parent", "--no-merges", range])).trim());
    const finishedHead = task.mergedHead || task.completion?.sourceHead || task.publishedHead || null;
    const active = task.state === "working" || task.state === "review";
    // 원본 폴더가 작업 브랜치를 벗어났거나 작업 브랜치가 지워졌으면 카드에 알린다. 이때 원본 폴더의 Git 동작은 막지 않는다.
    if (offBranch(task)) {
      result.offBranch = true;
      result.currentBranch = readTaskBranch(task.cwd);
      result.branchMissing = !await taskRef(task.projectPath, `refs/heads/${task.branch}`);
    }
    if (!active || !fs.existsSync(task.cwd) || readTaskBranch(task.cwd) !== task.branch) {
      result.folder = active ? (result.offBranch ? true : false) : fs.existsSync(task.cwd);
      if (finishedHead) {
        result.head = finishedHead;
        result.shortHead = finishedHead.slice(0, 7);
        result.pushed = !!task.publishedHead || task.completion?.publishState === "done";
        try { if (task.baseCommit) result.commits = await count(task.projectPath, `${task.baseCommit}..${finishedHead}`); } catch { /* 정리 후 지워진 커밋은 개수를 모를 수 있다. */ }
      }
      return result;
    }
    const head = await taskRef(task.cwd, "HEAD");
    result.head = head;
    result.shortHead = head?.slice(0, 7) ?? null;
    result.dirty = parseStatus(await taskGit(task.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length;
    const target = task.freshness?.targetSha || task.baseCommit;
    if (head && target) result.commits = await count(task.cwd, `${target}..${head}`);
    const tracked = await taskRef(task.cwd, `refs/remotes/${task.remote}/${task.branch}`);
    result.pushed = !!head && (tracked === head || task.publishedHead === head);
    if (head) {
      // 원격(작업 브랜치·기준 브랜치)에 없는 커밋 수. 0보다 크면 이 컴퓨터에만 있는 작업이다.
      const known = [...new Set([tracked, task.publishedHead, target].filter(Boolean))];
      result.unpushed = Number((await taskGit(task.cwd, ["rev-list", "--count", head, "--not", ...known]).catch(() => "0")).trim()) || 0;
      // 원격 작업 브랜치에 아직 합치지 않은 커밋이 있는지. 있으면 푸시가 거절되므로 먼저 합쳐야 한다.
      result.remoteAhead = !!tracked && tracked !== head && !await taskAncestor(task.cwd, tracked, head);
      // 저장된 최신 확인 결과를 지금 HEAD로 다시 따진다. 세션이 기준 브랜치를 직접 병합했으면 바로 최신으로 보인다.
      if (task.freshness?.targetSha) result.behind = !await taskAncestor(task.cwd, task.freshness.targetSha, head);
      const age = Date.now() - Date.parse(task.freshness?.checkedAt || 0);
      result.freshness = { state: result.behind || (task.type !== "hotfix" && task.freshness?.mainMissing) ? "needs-update" : task.freshness?.state === "error" ? "error" : "current",
        mainMissing: task.type !== "hotfix" && !!task.freshness?.mainMissing, checkedAt: task.freshness?.checkedAt ?? null,
        stale: !task.freshness?.checkedAt || !(age < FRESHNESS_MAX_AGE) || (!!task.freshness.head && task.freshness.head !== head) };
    }
    return result;
  }
  async function reviewDiff(id, file) {
    const task = get(id);
    return locked(task.gitCommonDir, async () => {
      const snapshot = await reviewSnapshot(task);
      if (!snapshot.files.some((changed) => changed.path === file)) throw new HttpError(404, "변경 목록에 없는 파일입니다.");
      return { diff: await fileDiff(task.cwd, file), head: snapshot.head, token: snapshot.token };
    });
  }
  async function commitReview(id, body = {}) {
    return mutate(id, async (task) => {
      assertActive(task);
      if (task.pendingAction) throw new HttpError(409, "이전 요청의 결과를 먼저 확인하세요.", "task-outcome-unknown");
      await assertTaskGitIdle(task);
      selectFinishMode(task, body);
      await externalWrite(task, "commit", await assertTaskWorktree(task), () => commitReviewedFiles(task, body));
      task.finishProgress = { ...task.finishProgress, commit: { at: now(), head: await assertTaskWorktree(task) } };
      save(task);
      return { task: clone(task) };
    });
  }
  // 카드가 오래된 최신 확인 결과를 조용히 다시 확인한다. 기준 브랜치만 받아 보고 작업 폴더·PR은 건드리지 않는다.
  // 세션이 실행 중이어도 막지 않고, 실패하면 이전 결과와 카드 오류를 그대로 둔다(최신 상태 확인을 누르면 사유를 볼 수 있다).
  async function recheck(id) {
    const task = get(id);
    return locked(task.gitCommonDir, async () => {
      if (!["working", "review"].includes(task.state) || busy.has(id) || task.pendingAction) return { task: clone(task), checked: false };
      const before = { freshness: task.freshness, error: task.error, errorReason: task.errorReason, errorHint: task.errorHint };
      busy.add(id);
      try { await freshness(task); return { task: clone(task), checked: true }; }
      catch (error) {
        Object.assign(task, before);
        for (const key of ["error", "errorReason", "errorHint"]) if (before[key] === undefined) delete task[key];
        save(task);
        return { task: clone(task), checked: false, message: error.message };
      } finally { busy.delete(id); }
    });
  }
  async function sync(id, body = {}) {
    return mutate(id, async (task) => {
      assertActive(task);
      if (task.pendingAction) throw new HttpError(409, "이전 요청의 완료 여부를 먼저 확인하세요.", "task-outcome-unknown", { outcomeUnknown: true });
      selectFinishMode(task, body);
      await assertTaskWorktree(task);
      await assertTaskGitIdle(task);
      if (await taskDirty(task)) throw new HttpError(409, "커밋하지 않은 변경이 있습니다. 커밋한 뒤 최신화하세요.", "task-dirty");
      await freshness(task);
      if (body.reviewToken) assertReviewed(await reviewSnapshot(task), body);
      // 다른 곳에서 원격 작업 브랜치에 올린 커밋을 먼저 합친다. 푸시가 거절된 작업도 여기서 풀린다.
      // main→develop 미반영은 작업 브랜치에서 풀 수 없으므로 원격 작업 브랜치만 합치고 안내한다.
      const remoteWork = await taskRef(task.cwd, `refs/remotes/${task.remote}/${task.branch}`);
      const developBehind = task.type !== "hotfix" && task.freshness.mainMissing;
      const mode = body.mode ?? task.finishMode ?? "pr";
      const localTarget = mode === "local" && !developBehind ? await taskRef(task.projectPath, `refs/heads/${task.targetBranch}`) : null;
      const sources = [remoteWork && { sha: remoteWork, label: `원격 작업 브랜치(${task.remote}/${task.branch})` },
        ...[...new Set([developBehind ? null : task.freshness.targetSha, localTarget].filter(Boolean))].map((sha) => ({ sha, label: "기준 브랜치" }))].filter(Boolean);
      if (developBehind && (!remoteWork || await taskAncestor(task.cwd, remoteWork, await assertTaskWorktree(task)))) requireFresh(task);
      for (const { sha, label } of sources) {
        const before = await assertTaskWorktree(task);
        if (await taskAncestor(task.cwd, sha, before)) continue;
        try { await externalWrite(task, "commit", before, () => taskGit(task.cwd, ["merge", "--no-edit", sha], { write: true })); }
        catch (error) {
          if (error.outcomeUnknown) throw error;
          let conflicts = [];
          try {
            const merging = await taskRef(task.cwd, "MERGE_HEAD");
            if (merging && merging !== sha) throw Error("다른 병합이 진행 중입니다.");
            if (merging) {
              conflicts = (await taskGit(task.cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
              await taskGit(task.cwd, ["merge", "--abort"], { write: true });
            }
            await assertTaskGitIdle(task);
            if (await assertTaskWorktree(task) !== before || await taskDirty(task)) throw Error("실행 전 상태로 복원하지 못했습니다.");
          } catch (restore) { throw new HttpError(409, `병합 복원을 확인하지 못했습니다. 작업 폴더를 확인하세요: ${restore.message}`, "task-recovery-required", { outcomeUnknown: true }); }
          // 충돌이 아닌 실패(잠금, 무시한 파일 덮어쓰기 등)는 충돌로 바꾸지 않고 원래 사유를 그대로 알린다.
          if (!conflicts.length && error.reason !== "git-conflict") throw error;
          const files = conflicts.length ? `\n충돌 파일: ${conflicts.slice(0, 10).join(", ")}${conflicts.length > 10 ? ` 외 ${conflicts.length - 10}개` : ""}` : "";
          const branch = sha === remoteWork ? `${task.remote}/${task.branch}` : task.targetBranch;
          throw new HttpError(409, `${label}와 같은 부분이 바뀌어 충돌이 났습니다. 반영을 취소하고 실행 전 상태로 복원했습니다.${files}`, "task-conflict",
            { hint: `세션에 ${branch} 브랜치를 병합해 충돌을 해결하도록 요청한 뒤 다시 확인하세요.`, raw: error.raw || error.message, conflicts, source: branch });
        }
      }
      await freshness(task);
      // 원격 작업 브랜치만 합친 경우에도 main→develop 미반영은 그대로 남아 있으므로 해야 할 일을 알린다.
      if (developBehind) { task.finishProgress = { ...task.finishProgress, sync: { at: now(), head: await assertTaskWorktree(task) } }; save(task); requireFresh(task); }
      task.finishProgress = { ...task.finishProgress, sync: { at: now(), head: await assertTaskWorktree(task) } };
      task.verification = '';
      save(task);
      return { task: clone(task) };
    });
  }
  // 시간 초과나 강제 종료로 병합·리베이스가 중간에 멈춰 작업이 막혔을 때 실행 전 상태로 되돌린다.
  // Git이 직접 취소하게 하며, 다른 Git 프로그램이 쓰고 있을 수 있는 잠금 파일(index.lock)은 지우지 않는다.
  const abortOperation = (id) => mutate(id, async (task) => {
    await assertTaskWorktree(task);
    const exists = async (marker) => fs.existsSync(path.resolve(task.cwd, (await taskGit(task.cwd, ["rev-parse", "--git-path", marker])).trim()));
    const command = await exists("rebase-merge") || await exists("rebase-apply") ? ["rebase", "--abort"]
      : await exists("MERGE_HEAD") ? ["merge", "--abort"]
      : await exists("CHERRY_PICK_HEAD") ? ["cherry-pick", "--abort"]
      : await exists("REVERT_HEAD") ? ["revert", "--abort"] : null;
    if (!command) throw new HttpError(409, "작업 폴더에 취소할 병합·리베이스가 없습니다. 최신 상태 확인을 눌러 주세요.", "task-git-idle");
    await taskGit(task.cwd, command, { write: true });
    await assertTaskGitIdle(task);
    delete task.error;
    save(task);
    return { task: clone(task), aborted: command[0] };
  });
  return { context, freshness, developBehindHint, requireFresh, review, status, reviewDiff, commitReview, recheck, sync, abortOperation };
}
