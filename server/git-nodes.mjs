import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { listWorkbranches, resolveWorkbranch } from "./workbranches.mjs";
import { taskGit, taskRepo } from "./tasks.mjs";
import { withGitRepoLock } from "./git-lock.mjs";

const OUTPUT_MAX = 200_000;
const operationMarkers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"];
const pathKey = (value) => { try { value = fs.realpathSync(value); } catch {} return process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value); };
const samePath = (a, b) => !!a && !!b && pathKey(a) === pathKey(b);
const failure = (reason, message) => Object.assign(new Error(message), { reason });

// Read only Git's location metadata: unrelated projects may use the same branch name.
function sessionCommonDir(session) {
  const cwd = session.cwd || session.worktree?.dir || session.task?.cwd || session.projectPath;
  if (!cwd) return null;
  let folder = path.resolve(cwd);
  try {
    while (true) {
      const marker = path.join(folder, ".git");
      if (fs.existsSync(marker)) {
        const gitDir = fs.statSync(marker).isDirectory() ? marker : path.resolve(folder, fs.readFileSync(marker, "utf8").match(/^gitdir: (.+)\s*$/m)[1].trim());
        const commonFile = path.join(gitDir, "commondir");
        return fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim()) : gitDir;
      }
      const parent = path.dirname(folder);
      if (parent === folder) return null;
      folder = parent;
    }
  } catch { return null; }
}

function sessionBusy(session, branch, cwd, repoCommonDir, isSessionBusy) {
  if (!(isSessionBusy ? isSessionBusy(session) : session.state === "running")) return false;
  const sessionDir = session.cwd || session.worktree?.dir || session.task?.cwd;
  if (samePath(sessionDir, cwd) || samePath(session.worktree?.dir, cwd) || samePath(session.task?.cwd, cwd)) return true;
  return samePath(sessionCommonDir(session), repoCommonDir) &&
    (session.worktree?.branch === branch || session.task?.branch === branch || session.branch === branch);
}

async function operationInProgress(cwd, git = taskGit) {
  const gitDir = (await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
  return operationMarkers.some((marker) => fs.existsSync(path.join(gitDir, marker)));
}

export async function listGitNodeBranches(projectPath, { sessions = [], isSessionBusy } = {}) {
  const repo = await taskRepo(projectPath);
  const [uses, targets] = await Promise.all([
    listWorkbranches(projectPath), listWorkbranches(projectPath, { forTarget: true }),
  ]);
  const branches = await Promise.all(uses.branches.map(async (item) => {
    const target = targets.branches.find((entry) => entry.name === item.name);
    const busy = sessions.some((session) => sessionBusy(session, item.name, item.cwd, repo.common, isSessionBusy));
    let dirty = false, operation = false, inspectReason;
    if (item.cwd && target?.selectable) {
      try {
        [dirty, operation] = await Promise.all([
          taskGit(item.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).then(Boolean),
          operationInProgress(item.cwd),
        ]);
      } catch { inspectReason = "작업 폴더의 Git 상태를 확인할 수 없습니다."; }
    }
    const busyReason = busy ? "이 브랜치의 세션이 실행 중입니다." : undefined;
    const operationReason = operation ? "병합·리베이스 등 Git 작업이 진행 중입니다." : undefined;
    const useReason = item.reason || inspectReason || busyReason || operationReason;
    const targetReason = target?.reason || inspectReason || busyReason || operationReason || (dirty ? "대상 작업 폴더에 커밋하지 않은 변경이 있습니다." : undefined);
    return { ...item, useSelectable: !useReason, targetSelectable: !targetReason,
      reason: useReason, useReason, targetReason, busy, dirty };
  }));
  return { branches, currentBranch: uses.currentBranch };
}

// Each Git invocation uses argv, waits for process termination, and preserves uncertain writes.
function executeGit(cwd, args, { signal, deadline, write = false, onData = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || Date.now() >= deadline) {
      reject(Object.assign(new Error(signal?.aborted ? "작업을 중지했습니다." : "Git 작업 시간이 초과되었습니다."),
        { stopped: !!signal?.aborted, timedOut: !signal?.aborted }));
      return;
    }
    const child = spawn("git", ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false", "-C", cwd, ...args], {
      cwd, windowsHide: true, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_MERGE_AUTOEDIT: "no", NO_COLOR: "1" },
    });
    let stdout = "", stderr = "", timedOut = false, stopped = false, overflow = false, finished = false;
    let fallback, terminating = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(fallback);
      signal?.removeEventListener("abort", abort);
      if (error) reject(Object.assign(error, { stopped, timedOut, overflow, outcomeUnknown: write && (stopped || timedOut || overflow), stdout, stderr }));
      else resolve(stdout);
    };
    const stop = () => {
      if (terminating) return;
      terminating = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, shell: false, stdio: "ignore" })
          .on("error", () => child.kill()).on("close", (code) => { if (code) child.kill(); });
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      fallback = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(new Error("Git 프로세스 종료를 확인할 수 없습니다. 상태를 확인한 뒤 다시 실행하세요."));
      }, 3000);
    };
    const abort = () => { stopped = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, deadline - Date.now()));
    signal?.addEventListener("abort", abort, { once: true });
    const add = (kind, chunk) => {
      if (kind === "stdout") stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 5_000_000) { overflow = true; stop(); return; }
      onData(chunk);
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => add("stdout", chunk));
    child.stderr.on("data", (chunk) => add("stderr", chunk));
    child.on("error", finish);
    child.on("close", (code) => {
      if (code === 0 && !stopped && !timedOut && !overflow) finish();
      else finish(Object.assign(new Error(stopped ? "작업을 중지했습니다." : timedOut ? "Git 작업 시간이 초과되었습니다." : stderr.trim() || stdout.trim() || "Git 실행에 실패했습니다."), { exitCode: code }));
    });
    if (signal?.aborted) abort();
  });
}

export async function runGitNode({ command, sessions = [], signal, isSessionBusy, onOutput = () => {} }) {
  const started = Date.now();
  const timeoutSec = Number(command?.timeoutSec ?? 600);
  const deadline = started + (Number.isFinite(timeoutSec) ? Math.min(3600, Math.max(1, timeoutSec)) : 600) * 1000;
  const result = { ok: false, reason: "git-error", output: "", cwd: command?.projectPath,
    branch: command?.branch, ...(command?.gitAction === "merge" ? { targetBranch: command?.targetBranch } : {}), exitCode: 1 };
  let writeStarted = false;
  let repoCommonDir;
  const add = (text) => { result.output = (result.output + text).slice(-OUTPUT_MAX); onOutput(result.output); };
  const check = () => {
    if (signal?.aborted) throw Object.assign(failure("stopped", "작업을 중지했습니다."), { stopped: true });
    if (Date.now() >= deadline) throw Object.assign(failure("git-timeout", "Git 작업 시간이 초과되었습니다."), { timedOut: true });
  };
  const git = (cwd, args, options = {}) => {
    check();
    if (options.write) writeStarted = true;
    return executeGit(cwd, args, { signal, deadline, ...options });
  };
  const readRepo = async (cwd) => {
    const [top, common] = await Promise.all([git(cwd, ["rev-parse", "--show-toplevel"]), git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])]);
    return { top: top.trim(), common: common.trim() };
  };
  const worktreeOptions = { readGit: git, readRepo, writeGit: git };
  const branchHead = async (cwd, branch) => {
    if (typeof branch !== "string" || !branch || branch.startsWith("-")) throw failure("git-branch-invalid", "기존 로컬 브랜치를 선택하세요.");
    try {
      await git(cwd, ["check-ref-format", "refs/heads/" + branch]);
      if ((await git(cwd, ["check-ref-format", "--branch", branch])).trim() !== branch) throw Error("shorthand");
    } catch (error) {
      if (error.stopped || error.timedOut) throw error;
      throw failure("git-branch-invalid", "브랜치 이름이 올바르지 않습니다.");
    }
    const refs = (await git(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/"])).trim().split(/\r?\n/);
    const found = refs.map((line) => line.split("\0")).find(([ref]) => ref === "refs/heads/" + branch);
    if (!found) throw failure("git-branch-missing", "선택한 로컬 브랜치가 없습니다. 목록을 새로고침하세요.");
    return found[1];
  };
  const head = async (cwd) => (await git(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
  const assertIdle = async (cwd) => {
    if (await operationInProgress(cwd, git)) throw failure("git-operation-active", "작업 폴더에서 병합·리베이스 등 Git 작업이 진행 중입니다.");
  };
  const assertSessionsIdle = (branch, cwd) => {
    if (sessions.some((session) => sessionBusy(session, branch, cwd, repoCommonDir, isSessionBusy))) throw failure("git-session-running", "관련 브랜치의 세션이 실행 중입니다. 세션을 마친 뒤 다시 실행하세요.");
  };
  try {
    check();
    if (!command?.projectPath || !["use", "merge"].includes(command.gitAction)) throw failure("git-node-invalid", "Git 노드 설정이 올바르지 않습니다.");
    const projectPath = command.projectPath;
    const repo = await readRepo(projectPath);
    repoCommonDir = repo.common;
    await withGitRepoLock(repo.common, async () => {
      check();
      const sourceHead = await branchHead(projectPath, command.branch);
      const listed = await listWorkbranches(projectPath, { ...worktreeOptions, forTarget: true });
      check();
      const source = listed.branches.find((item) => item.name === command.branch);
      assertSessionsIdle(command.branch, source?.cwd);
      if (source?.cwd) await assertIdle(source.cwd);
      if (command.gitAction === "use") {
        const resolved = await resolveWorkbranch(projectPath, command.branch, worktreeOptions);
        check();
        result.cwd = resolved.dir;
        await assertIdle(result.cwd);
        assertSessionsIdle(command.branch, result.cwd);
        result.beforeHead = sourceHead;
        result.afterHead = await head(result.cwd);
        if ((await git(result.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() !== command.branch || result.afterHead !== await branchHead(projectPath, command.branch)) throw failure("git-branch-changed", "작업 폴더의 브랜치 연결이 바뀌었습니다.");
        result.context = { repoCommonDir: repo.common, branch: command.branch, cwd: result.cwd, head: result.afterHead };
        result.ok = true; result.reason = "git-branch-ready";
        add(command.branch + " 브랜치 작업 폴더를 준비했습니다.\n" + result.cwd + "\n");
        return;
      }
      if (command.branch === command.targetBranch) throw failure("git-same-branch", "같은 브랜치로 병합할 수 없습니다.");
      await branchHead(projectPath, command.targetBranch);
      const target = listed.branches.find((item) => item.name === command.targetBranch);
      assertSessionsIdle(command.targetBranch, target?.cwd);
      if (target?.cwd) await assertIdle(target.cwd);
      const resolved = await resolveWorkbranch(projectPath, command.targetBranch, { ...worktreeOptions, forTarget: true });
      result.cwd = resolved.dir;
      await assertIdle(result.cwd);
      assertSessionsIdle(command.targetBranch, result.cwd);
      if (await git(result.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
        throw failure("git-target-dirty", "대상 작업 폴더에 커밋하지 않은 변경이 있습니다. 먼저 커밋하거나 정리하세요.");
      const actualBranch = (await git(result.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
      if (actualBranch !== command.targetBranch) throw failure("git-branch-changed", "대상 작업 폴더의 브랜치가 바뀌었습니다.");
      result.beforeHead = await head(result.cwd);
      if (result.beforeHead !== await branchHead(projectPath, command.targetBranch) || sourceHead !== await branchHead(projectPath, command.branch))
        throw failure("git-branch-changed", "브랜치가 준비 중 변경됐습니다. 상태를 확인한 뒤 다시 실행하세요.");
      if (source?.cwd && await git(source.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
        add("소스 브랜치의 커밋하지 않은 변경은 포함하지 않습니다. 커밋된 변경만 병합합니다.\n");
      add(command.branch + " → " + command.targetBranch + " 병합을 시작합니다.\n");
      try {
        // Pin the revalidated source commit so an external ref update cannot change what is merged.
        await git(result.cwd, ["merge", "--no-ff", "--no-edit", sourceHead], { write: true, onData: add });
      } catch (error) {
        if (error.stopped || error.timedOut || error.outcomeUnknown) { result.recoveryRequired = true; throw error; }
        result.conflicts = (await git(result.cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
        const mergeHead = await git(result.cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then((value) => value.trim(), () => null);
        if (mergeHead) {
          if (mergeHead !== sourceHead) { result.recoveryRequired = true; throw failure("git-recovery-required", "병합 상태가 변경돼 자동 복원을 멈췄습니다. 작업 폴더를 확인하세요."); }
          try {
            // Cleanup has its own small budget; a known conflict must be restored even at the time limit.
            await executeGit(result.cwd, ["merge", "--abort"], { deadline: Date.now() + 20_000, write: true });
            const restored = await taskGit(result.cwd, ["rev-parse", "HEAD"]);
            const dirty = await taskGit(result.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
            if (restored.trim() !== result.beforeHead || dirty || await operationInProgress(result.cwd)) throw Error("restore verification");
            result.afterHead = restored.trim();
            add("병합을 취소하고 실행 전 상태로 복원했습니다.\n");
          } catch { result.recoveryRequired = true; throw failure("git-recovery-required", "병합 복원을 확인하지 못했습니다. 작업 폴더를 확인하세요."); }
        } else {
          result.afterHead = await head(result.cwd);
          if (result.afterHead !== result.beforeHead || await git(result.cwd, ["status", "--porcelain=v1", "-z"])) result.recoveryRequired = true;
        }
        if (result.conflicts.length) throw failure("git-merge-conflict", "병합 충돌: " + result.conflicts.join(", "));
        throw error;
      }
      result.afterHead = await head(result.cwd);
      await assertIdle(result.cwd);
      await git(result.cwd, ["merge-base", "--is-ancestor", sourceHead, result.afterHead]);
      if ((await git(result.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() !== command.targetBranch ||
          result.afterHead !== await branchHead(projectPath, command.targetBranch) ||
          await git(result.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
        result.recoveryRequired = true;
        throw failure("git-recovery-required", "병합 후 상태가 변경됐습니다. 대상 브랜치를 확인하세요.");
      }
      result.context = { repoCommonDir: repo.common, branch: command.targetBranch, cwd: result.cwd, head: result.afterHead };
      result.ok = true; result.reason = result.beforeHead === result.afterHead ? "git-already-merged" : "git-merged";
      add(result.reason === "git-already-merged" ? "이미 반영된 브랜치입니다.\n" : "병합을 완료했습니다.\n");
    }, { signal, deadline });
    check();
    result.exitCode = 0;
  } catch (error) {
    result.ok = false; result.exitCode = 1;
    result.stopped = !!error.stopped || !!signal?.aborted;
    result.timedOut = !!error.timedOut || error.reason === "git-timeout";
    result.reason = result.stopped ? "stopped" : result.timedOut ? "git-timeout" : error.reason || "git-error";
    if ((result.stopped || result.timedOut || error.outcomeUnknown) && writeStarted) result.recoveryRequired = true;
    add(error.message + "\n");
    if (result.recoveryRequired) add("자동으로 재시도하지 않습니다. Git 상태를 확인한 뒤 다시 실행하세요.\n");
  }
  result.durationMs = Date.now() - started;
  return result;
}
