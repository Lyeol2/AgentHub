import { githubCredentialArgs, normalizePull } from "../github.mjs";
import { listWorkbranches } from "../workbranches.mjs";
import { HttpError } from "./errors.mjs";
import { taskGit, taskRef, taskAncestor, gitflowContext, assertTaskWorktree, taskDirty, assertTaskGitIdle } from "../tasks.mjs";
import { reviewSnapshot, assertReviewed } from "../task-review.mjs";
import { runGitNode } from "../git-nodes.mjs";
import { clone, now, remoteFingerprint, recordError, needsDevelop } from "./task-domain.mjs";

/** Publish and merge reviewed work; persist uncertain write intent before every external mutation. */
export function createTaskPublication({ assertActive, assertIdle, freshness, get, github, hasFolder, mutate, requireFresh, save, sessionBusy, store, taskSettings }) {
  // 작업 폴더가 이미 사라졌으면 원본 폴더에서 GitHub를 조회한다.
  const taskDir = (task) => hasFolder(task) ? task.cwd : task.projectPath;
  async function githubTarget(task) {
    const target = await github.target(taskDir(task), task.remote);
    if (target.name !== task.remote || (task.repo && task.repo.toLowerCase() !== target.repo.toLowerCase()))
      throw new HttpError(409, "작업에 연결된 GitHub 저장소가 바뀌었습니다.", "task-remote");
    task.repo = target.repo;
    save(task);
    return target;
  }
  async function findPull(task, target, state = "all") {
    const [owner] = target.repo.split("/");
    const raw = await github.api(target, "GET", `repos/${target.repo}/pulls?state=${state}&head=${encodeURIComponent(`${owner}:${task.branch}`)}&base=${encodeURIComponent(task.targetBranch)}&per_page=100`);
    if (raw.length > 1) throw new HttpError(409, "이 브랜치에 PR이 여러 개 있습니다. GitHub에서 연결할 PR을 확인하세요.", "task-pull-ambiguous");
    return raw.length ? normalizePull(raw[0], target.repo) : null;
  }
  function setPull(task, pull) {
    if (!pull || pull.headRefName !== task.branch || pull.baseRefName !== task.targetBranch)
      throw new HttpError(409, "작업과 PR의 브랜치가 일치하지 않습니다.", "task-pull");
    task.pull = pull;
    task.state = pull.state === "MERGED" ? "merged" : pull.state === "OPEN" ? "review" : "working";
    if (pull.state === "MERGED") task.mergedHead = pull.headRefOid;
    save(task);
  }
  async function externalWrite(task, action, expectedHead, call) {
    task.pendingAction = { action, expectedHead, startedAt: now() };
    save(task);
    try {
      const result = await call();
      delete task.pendingAction;
      save(task);
      return result;
    } catch (error) {
      if (!error.outcomeUnknown) delete task.pendingAction;
      else task.pendingAction.outcomeUnknown = true;
      save(task);
      throw error;
    }
  }
  async function ensureDevelop(task, target) {
    if (task.freshness.developSha) { task.needsDevelopSetup = false; return; }
    const sha = task.freshness.mainSha;
    try {
      await externalWrite(task, "develop", sha, () => github.api(target, "POST", `repos/${target.repo}/git/refs`,
        { ref: `refs/heads/${taskSettings(task).develop}`, sha }, { write: true }));
    } catch (error) {
      if (error.outcomeUnknown) throw error;
      // Another client may have created develop. Fetch and validate it; never update an existing ref.
      const current = await gitflowContext(task.projectPath, task.remote, taskSettings(task));
      if (!current.developSha) throw error;
    }
    await freshness(task);
    task.needsDevelopSetup = false;
    save(task);
  }
  async function finishLocal(task, body, head) {
    if (task.pull) throw new HttpError(409, "이미 PR이 있는 작업입니다. PR에서 병합을 완료하세요.", "task-pull");
    const targetRef = `refs/heads/${task.targetBranch}`;
    const beforeHead = await taskRef(task.projectPath, targetRef);
    if (body.reviewToken && body.expectedTargetHead !== beforeHead)
      throw new HttpError(409, "대상 브랜치가 변경됐습니다. 변경 목록을 다시 확인하세요.", "task-stale-review");
    if (beforeHead && !await taskAncestor(task.cwd, beforeHead, head))
      throw new HttpError(409, "대상 브랜치 변경을 먼저 반영하고 검증하세요.", "task-behind");
    if (!beforeHead) await taskGit(task.projectPath, ["branch", task.targetBranch, task.freshness.targetSha], { write: true });
    const targetHead = beforeHead || task.freshness.targetSha;
    const result = await externalWrite(task, "local-merge", head, async () => {
      const merged = await runGitNode({ command: { projectPath: task.projectPath, gitAction: "merge", branch: task.branch, targetBranch: task.targetBranch,
        expectedSourceHead: head, expectedTargetHead: targetHead, removeTemporaryTarget: true }, sessions: store.list(), isSessionBusy: sessionBusy });
      if (!merged.ok) throw new HttpError(409, merged.output || "병합하지 못했습니다.", merged.reason, { outcomeUnknown: !!merged.recoveryRequired });
      return merged;
    });
    task.finishMode = "local";
    task.mergedHead = head;
    task.state = "merged";
    task.completion = { kind: "local", sourceHead: head, beforeHead: targetHead, targetHead: result.afterHead, cwd: result.cwd, mergedAt: now(), publishState: body.push === true ? "pending" : "not-requested" };
    task.finishProgress = { ...task.finishProgress, merge: { at: now(), head: result.afterHead } };
    save(task);
    if (needsDevelop(task)) {
      // GitFlow처럼 main 반영에 이어 develop에도 병합한다. 충돌하면 main 반영은 그대로 두고 카드에서 다시 시도한다.
      task.developPending = true;
      try { await mergeLocalDevelop(task); }
      catch (error) {
        if (error.outcomeUnknown) throw error;
        recordError(task, error);
        save(task);
      }
    }
    if (body.push === true) await pushLocalTarget(task);
    return { task: clone(task), merge: result };
  }
  async function mergeLocalDevelop(task) {
    const { develop } = taskSettings(task);
    const source = task.mergedHead;
    let developHead = await taskRef(task.projectPath, `refs/heads/${develop}`);
    if (developHead && await taskAncestor(task.projectPath, source, developHead)) {
      Object.assign(task.completion, { developHead, developPublishState: task.completion.developPublishState ?? "done" });
      task.developPending = false;
      save(task);
      return;
    }
    if (!developHead) {
      // 로컬 develop이 없으면 원격 develop(없으면 방금 반영한 main)에서 만든다.
      developHead = task.freshness?.developSha || task.completion.targetHead;
      await taskGit(task.projectPath, ["branch", develop, developHead], { write: true });
    }
    const result = await externalWrite(task, "develop-merge", source, async () => {
      const merged = await runGitNode({ command: { projectPath: task.projectPath, gitAction: "merge", branch: task.branch, targetBranch: develop,
        expectedSourceHead: source, expectedTargetHead: developHead, removeTemporaryTarget: true }, sessions: store.list(), isSessionBusy: sessionBusy });
      if (!merged.ok) throw new HttpError(409, merged.reason === "git-merge-conflict"
        ? `${task.targetBranch}에는 반영했지만 ${develop}에 병합하다 충돌이 났습니다. 실행 전 상태로 되돌렸습니다. Git 탭에서 ${task.branch}를 ${develop}에 직접 병합해 충돌을 해결한 뒤 최신 확인을 누르세요.\n${merged.output || ""}`.trim()
        : merged.output || `${develop}에 병합하지 못했습니다.`, merged.reason, { outcomeUnknown: !!merged.recoveryRequired });
      return merged;
    });
    Object.assign(task.completion, { developHead: result.afterHead, developPublishState: task.completion.publishState === "not-requested" ? "not-requested" : "pending" });
    task.developPending = false;
    task.finishProgress = { ...task.finishProgress, develop: { at: now(), head: result.afterHead } };
    save(task);
  }
  // PR 방식에서는 main → develop 반영 PR을 연다. 같은 PR이 열려 있으면 다시 쓴다.
  async function openDevelopPull(task) {
    const { main, develop } = taskSettings(task);
    await freshness(task);
    const target = await githubTarget(task);
    if (!task.freshness.developSha) await ensureDevelop(task, target);
    if (!task.freshness.mainMissing) { task.developPending = false; save(task); return; }
    let pull = await findBackMerge(task, target);
    if (!pull) {
      const body = [`${main}에 반영한 ${task.type === "hotfix" ? "긴급 수정" : "배포 준비"}을 ${develop}에도 반영합니다.`,
        `AgentHub 작업: ${task.id}\n작업 브랜치: ${task.branch}${task.pull?.number ? `\n원래 PR: #${task.pull.number}` : ""}`].join("\n\n");
      try {
        const raw = await externalWrite(task, "develop-pull", task.freshness.mainSha, () => github.api(target, "POST", `repos/${target.repo}/pulls`,
          { title: `${main} → ${develop} 반영: ${task.title}`.slice(0, 256), body, head: main, base: develop }, { write: true }));
        pull = normalizePull(raw, target.repo);
      } catch (error) {
        if (error.outcomeUnknown) throw error;
        // 동시에 만든 경우 열린 PR을 다시 찾는다.
        pull = await findBackMerge(task, target);
        if (!pull) throw error;
      }
    }
    task.developPull = pull;
    task.developPending = true;
    save(task);
  }
  async function findBackMerge(task, target) {
    const { main, develop } = taskSettings(task);
    const [owner] = target.repo.split("/");
    const raw = await github.api(target, "GET", `repos/${target.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${main}`)}&base=${encodeURIComponent(develop)}&per_page=10`);
    return raw.length ? normalizePull(raw[0], target.repo) : null;
  }
  const mergeDevelop = (id) => mutate(id, async (task) => {
    if (!needsDevelop(task) || task.state !== "merged")
      throw new HttpError(409, "배포 브랜치에 반영을 마친 배포 준비·긴급 수정만 개발 브랜치에 반영할 수 있습니다.", "task-state");
    if (task.pendingAction) throw new HttpError(409, "이전 요청의 결과를 먼저 확인하세요.", "task-outcome-unknown");
    await assertTaskWorktree(task);
    if (task.completion?.kind === "local") await mergeLocalDevelop(task);
    else await openDevelopPull(task);
    delete task.error;
    save(task);
    return { task: clone(task) };
  });
  // 작업을 만들 때 확인한 원격 주소로만 푸시한다. 강제 푸시·태그·서브모듈 푸시는 하지 않는다.
  async function remotePush(task) {
    const fetchUrl = (await taskGit(task.projectPath, ["remote", "get-url", task.remote])).trim();
    const pushes = (await taskGit(task.projectPath, ["remote", "get-url", "--push", "--all", task.remote])).trim().split(/\r?\n/);
    if (remoteFingerprint(fetchUrl) !== task.remoteFingerprint || pushes.length !== 1 || pushes[0] !== fetchUrl)
      throw new HttpError(409, "작업 생성 때의 원격 주소와 푸시 주소가 다릅니다. Git 탭에서 원격 설정을 확인하세요.", "task-remote");
    return (cwd, sha, branch) => taskGit(cwd, [...githubCredentialArgs(), "-c", `remote.${task.remote}.mirror=false`, "push", "--no-follow-tags", "--recurse-submodules=no",
      "--", pushes[0], `${sha}:refs/heads/${branch}`], { write: true });
  }
  async function pushLocalTarget(task) {
    const completion = task.completion;
    if (task.state !== "merged" || completion?.kind !== "local") throw new HttpError(409, "로컬 반영을 먼저 완료하세요.");
    const push = await remotePush(task);
    if (completion.publishState !== "done") {
      // 푸시는 커밋만 보내므로 대상 브랜치를 체크아웃한 작업 폴더를 새로 만들지 않는다. 이미 연 폴더가 있으면 쉬고 있는지만 본다.
      const selected = (await listWorkbranches(task.projectPath, { forTarget: true })).branches.find((branch) => branch.name === task.targetBranch);
      if (selected?.cwd) {
        assertIdle({ cwd: selected.cwd });
        await assertTaskGitIdle({ cwd: selected.cwd });
      }
      if (await taskRef(task.projectPath, `refs/heads/${task.targetBranch}`) !== completion.targetHead) throw new HttpError(409, "반영 후 대상 브랜치가 변경됐습니다. Git 탭에서 새 커밋을 검토한 뒤 푸시하세요.", "task-stale-head");
      completion.publishState = "pending";
      save(task);
      await externalWrite(task, "target-push", completion.targetHead, () => push(task.projectPath, completion.targetHead, task.targetBranch));
      completion.publishState = "done";
      task.finishProgress = { ...task.finishProgress, push: { at: now(), head: completion.targetHead } };
      save(task);
    }
    // 배포 준비·긴급 수정은 develop에 병합한 커밋도 함께 보낸다.
    if (completion.developHead && completion.developPublishState !== "done") {
      const { develop } = taskSettings(task);
      if (await taskRef(task.projectPath, `refs/heads/${develop}`) !== completion.developHead)
        throw new HttpError(409, `반영 후 ${develop} 브랜치가 변경됐습니다. Git 탭에서 새 커밋을 검토한 뒤 푸시하세요.`, "task-stale-head");
      completion.developPublishState = "pending";
      save(task);
      await externalWrite(task, "develop-push", completion.developHead, () => push(task.projectPath, completion.developHead, develop));
      completion.developPublishState = "done";
      save(task);
    }
  }
  // 원격 작업 브랜치에 로컬에 없는 커밋이 있어 거절된 푸시는 작업 카드에서 풀 수 있는 방법을 알린다.
  const pushRejected = (task, error) => error.reason !== "git-push-rejected" ? error
    : new HttpError(409, `원격 작업 브랜치 ${task.remote}/${task.branch}에 이 폴더에 없는 커밋이 있어 푸시가 거절됐습니다.`, "git-push-rejected",
      { hint: `작업 카드의 '업데이트 프롬 ${task.targetBranch}'에서 방향을 확인하면 원격 작업 브랜치의 새 커밋도 합칩니다. 그다음 업데이트 PR이나 푸시를 다시 실행하세요.`, raw: error.raw });
  // 결과를 모르는 백업 푸시가 원격에 닿았는지 본다. 닿았으면 게시한 커밋으로 기록한다.
  async function backedUp(task, sha) {
    const remote = (await taskGit(task.projectPath, [...githubCredentialArgs(), "ls-remote", "--heads", task.remote, `refs/heads/${task.branch}`])).trim().split(/\s+/)[0];
    if (remote !== sha) return false;
    task.publishedHead = sha;
    return true;
  }
  // 리뷰·PR 없이 작업 브랜치만 원격에 올려 둔다. 대상 브랜치는 건드리지 않고, 원격이 앞서 있으면 강제로 덮지 않는다.
  const backup = (id) => mutate(id, async (task) => {
    assertActive(task);
    if (task.pendingAction) throw new HttpError(409, "이전 요청의 결과를 먼저 확인하세요.", "task-outcome-unknown", { outcomeUnknown: true });
    const head = await assertTaskWorktree(task);
    await assertTaskGitIdle(task);
    const push = await remotePush(task);
    await externalWrite(task, "backup", head, () => push(task.cwd, head, task.branch)).catch((error) => { throw pushRejected(task, error); });
    // URL로 푸시하면 원격 추적 브랜치가 그대로이므로 맞춰 둔다. 카드의 "푸시 안 됨" 개수가 바로 사라진다.
    await taskGit(task.cwd, ["update-ref", `refs/remotes/${task.remote}/${task.branch}`, head], { write: true }).catch(() => {});
    task.publishedHead = head;
    task.finishProgress = { ...task.finishProgress, backup: { at: now(), head } };
    delete task.error;
    save(task);
    return { task: clone(task) };
  });
  const pushTarget = (id) => mutate(id, async (task) => {
    if (task.pendingAction) throw new HttpError(409, "이전 요청의 결과를 먼저 확인하세요.", "task-outcome-unknown");
    await pushLocalTarget(task); return { task: clone(task) };
  });
  async function finish(id, body = {}) {
    const description = String(body.description ?? get(id).description ?? "").trim();
    const verification = String(body.verification ?? get(id).verification ?? "").trim();
    if (description.length > 40_000 || verification.length > 10_000) throw new HttpError(400, "PR 설명 또는 검증 결과가 너무 깁니다.");
    return mutate(id, async (task) => {
      assertActive(task);
      const message = String(body.message ?? `${task.type === "feature" ? "feat" : task.type === "release" ? "chore" : "fix"}: ${task.title}`).trim();
      if ((!message && await taskDirty(task)) || message.length > 2000) throw new HttpError(400, "커밋 메시지를 1~2000자로 입력하세요.");
      if (task.pendingAction) throw new HttpError(409, "이전 요청의 완료 여부를 확인해야 합니다. 먼저 상태를 새로고침하세요.", "task-outcome-unknown", { outcomeUnknown: true });
      const mode = body.mode ?? task.finishMode ?? "pr";
      if (!["pr", "local"].includes(mode)) throw new HttpError(400, "작업 반영 방식을 선택하세요.");
      if (mode === "local" && task.pull) throw new HttpError(409, "이미 PR이 있는 작업입니다. PR에서 병합을 완료하세요.", "task-pull");
      await assertTaskWorktree(task);
      await assertTaskGitIdle(task);
      if (body.reviewToken) {
        const snapshot = await reviewSnapshot(task);
        assertReviewed(snapshot, body);
        if (!snapshot.clean) throw new HttpError(409, "변경 검토에서 먼저 커밋을 완료하세요.", "task-dirty");
      }
      task.description = description;
      task.verification = verification;
      task.finishMode = mode;
      save(task);
      await freshness(task);
      if (mode === "local") {
        requireFresh(task);
        if (await taskDirty(task)) {
          await taskGit(task.cwd, ["add", "--all", "--", "."], { write: true });
          await externalWrite(task, "commit", await taskRef(task.cwd, "HEAD"), () => taskGit(task.cwd, ["commit", "-m", message], { write: true }));
        }
        return finishLocal(task, body, await assertTaskWorktree(task));
      }
      const target = await githubTarget(task);
      const existing = task.pull ? (await github.detail(task.cwd, task.pull.number, { remote: task.remote })).pull : await findPull(task, target);
      if (existing) {
        setPull(task, existing);
        if (existing.state === "MERGED") return { task: clone(task), pull: clone(existing) };
        if (existing.state === "CLOSED") throw new HttpError(409, "이 작업의 PR이 닫혔습니다. 새 작업에서 진행하세요.", "task-pull-closed");
      }
      if (!existing && !await taskDirty(task) && !(await taskGit(task.cwd, ["diff", "--name-only", task.freshness.targetSha, "HEAD"])).trim())
        throw new HttpError(409, "기준 브랜치와 다른 변경이 없습니다.", "task-empty");
      if (task.type !== "hotfix") await ensureDevelop(task, target);
      if (await taskDirty(task)) {
        await taskGit(task.cwd, ["add", "--all", "--", "."], { write: true });
        await externalWrite(task, "commit", await taskRef(task.cwd, "HEAD"), () => taskGit(task.cwd, ["commit", "-m", message], { write: true }));
      }
      const head = await assertTaskWorktree(task);
      await freshness(task);
      if (!existing && !(await taskGit(task.cwd, ["diff", "--name-only", task.freshness.targetSha, head])).trim())
        throw new HttpError(409, "기준 브랜치와 다른 변경이 없습니다.", "task-empty");
      const args = { remote: task.remote, repo: target.repo, branch: task.branch, head: task.branch, expectedHead: head };
      await externalWrite(task, "push", head, () => github.push(task.cwd, args)).catch((error) => { throw pushRejected(task, error); });
      task.publishedHead = head;
      task.finishProgress = { ...task.finishProgress, push: { at: now(), head } };
      save(task);
      // 대상의 최신 상태는 표시용으로 갱신한다. PR 생성·갱신은 대상 병합을 요구하지 않는다.
      await freshness(task);
      // 연결한 이슈는 PR이 기본 브랜치에 병합될 때 GitHub가 닫는다.
      const issueLine = task.issue && task.issue.repo.toLowerCase() === target.repo.toLowerCase() ? `\n관련 이슈: Closes #${task.issue.number}` : "";
      const text = [`## 작업\n${description || task.title}`, `## 검증\n${verification || "검증 결과를 입력하지 않았습니다."}`,
        `AgentHub 작업: ${task.id}\n유형: ${task.type}${task.version ? `\n버전: ${task.version}` : ""}\n기준: ${task.baseBranch} → ${task.targetBranch}${issueLine}`].join("\n\n");
      if (!existing) {
        try {
          const result = await externalWrite(task, "pull", head, () => github.create(task.cwd, { ...args, base: task.targetBranch, title: task.title, body: text }));
          setPull(task, result.pull);
        } catch (error) {
          if (error.reason !== "pull-exists") throw error;
          const pull = await findPull(task, target, "open");
          if (!pull) throw error;
          setPull(task, pull);
        }
      } else {
        if ((body.description !== undefined || body.verification !== undefined) && existing.body !== text) {
          await externalWrite(task, "pull-update", head, () => github.api(target, "PATCH", `repos/${target.repo}/pulls/${existing.number}`, { body: text }, { write: true }));
        }
        setPull(task, (await github.detail(task.cwd, existing.number, { remote: task.remote })).pull);
      }
      task.finishProgress = { ...task.finishProgress, pull: { at: now(), head, number: task.pull?.number } };
      task.verification = verification;
      delete task.error;
      save(task);
      return { task: clone(task), pull: clone(task.pull) };
    });
  }
  async function mergePull(id, body = {}) {
    return mutate(id, async (task) => {
      assertActive(task);
      if (!task.pull || task.pendingAction) throw new HttpError(409, "PR 상태를 먼저 확인하세요.", "task-pull");
      const snapshot = await reviewSnapshot(task);
      assertReviewed(snapshot, body);
      if (!snapshot.clean) throw new HttpError(409, "커밋하지 않은 변경이 있습니다. PR 업데이트를 먼저 완료하세요.", "task-dirty");
      await assertTaskGitIdle(task);
      await freshness(task);
      // 실제 병합 조건(충돌·검사·리뷰·최신화 정책)은 GitHub에서 검사한다.
      const target = await githubTarget(task);
      const pull = (await github.detail(task.cwd, task.pull.number, { remote: task.remote })).pull;
      setPull(task, pull);
      if (pull.state === "MERGED") return { task: clone(task) };
      if (pull.headRefOid !== snapshot.head || body.expectedPullHead !== pull.headRefOid)
        throw new HttpError(409, "PR 또는 작업 커밋이 변경됐습니다. PR을 업데이트하고 다시 검토하세요.", "task-stale-head");
      const result = await externalWrite(task, "merge-pull", snapshot.head, () => github.merge(task.cwd, pull.number,
        { remote: task.remote, repo: target.repo, sha: snapshot.head, method: body.method || "merge" }));
      setPull(task, result.pull);
      // main에 막 병합했으므로 develop 반영이 남았다. 최신 확인에서 다시 계산한다.
      if (needsDevelop(task) && task.state === "merged") task.developPending = true;
      task.finishProgress = { ...task.finishProgress, merge: { at: now(), head: snapshot.head } };
      save(task);
      return { task: clone(task), pull: clone(task.pull) };
    });
  }
  return { taskDir, githubTarget, findPull, setPull, externalWrite, findBackMerge, mergeDevelop, backedUp, backup, pushTarget, finish, mergePull };
}
