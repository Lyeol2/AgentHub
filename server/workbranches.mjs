import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { HttpError } from "./application/errors.mjs";
import { taskGit, taskRepo } from "./tasks.mjs";

const queues = new Map();
const pathKey = (value) => {
  const resolved = fs.realpathSync(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const samePath = (a, b) => pathKey(a) === pathKey(b);
const unavailable = (message, reason = "workbranch-unavailable", details = {}) => new HttpError(409, message, reason, details);

function parseWorktrees(output) {
  const records = [];
  let record = null;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      if (record) records.push(record);
      record = { cwd: path.resolve(field.slice(9)), locked: false, bare: false, prunable: false };
    } else if (!field) {
      if (record) records.push(record);
      record = null;
    } else if (record) {
      if (field.startsWith("HEAD ")) record.head = field.slice(5);
      else if (field.startsWith("branch refs/heads/")) record.branch = field.slice(18);
      else if (field === "bare") record.bare = true;
      else if (field === "locked" || field.startsWith("locked ")) record.locked = true;
      else if (field === "prunable" || field.startsWith("prunable ")) record.prunable = true;
    }
  }
  if (record) records.push(record);
  return records;
}

async function validateBranch(projectPath, branch) {
  if (typeof branch !== "string" || !branch || branch.length > 1024 || branch.startsWith("-"))
    throw new HttpError(400, "기존 작업 브랜치를 선택하세요.", "workbranch-invalid");
  try {
    // Full refs avoid Git's @{-1} shorthand expansion; --branch rejects names such as HEAD.
    await taskGit(projectPath, ["check-ref-format", `refs/heads/${branch}`]);
    if ((await taskGit(projectPath, ["check-ref-format", "--branch", branch])).trim() !== branch) throw Error("branch shorthand");
  } catch (error) {
    if (error.reason === "git-timeout") throw error;
    throw new HttpError(400, "작업 브랜치 이름이 올바르지 않습니다.", "workbranch-invalid");
  }
  if (branch === "main" || branch === "develop")
    throw unavailable("main과 develop은 작업 브랜치로 선택할 수 없습니다.", "workbranch-protected");
}

async function inspectWorktree(repo, entry, original) {
  const result = { ...entry, original, missing: !fs.existsSync(entry.cwd) };
  if (original) result.reason = "원본 작업 폴더는 기본 모드에서 사용하세요.";
  else if (entry.bare) result.reason = "Bare 저장소는 작업 폴더로 사용할 수 없습니다.";
  else if (result.missing) result.reason = "등록된 작업 폴더가 없습니다. Git 워크트리 상태를 먼저 복구하세요.";
  else if (entry.locked) result.reason = "잠긴 작업 폴더입니다. 잠금 상태를 먼저 확인하세요.";
  else if (entry.prunable) result.reason = "정리가 필요한 작업 폴더입니다. Git 워크트리 상태를 먼저 복구하세요.";
  else {
    try {
      const actual = await taskRepo(entry.cwd);
      if (!samePath(actual.common, repo.common) || !samePath(actual.top, entry.cwd))
        result.reason = "작업 폴더가 다른 Git 저장소에 연결되어 있습니다.";
      else {
        const branch = (await taskGit(entry.cwd, ["symbolic-ref", "--quiet", "HEAD"])).trim();
        if (branch !== `refs/heads/${entry.branch}`) result.reason = "작업 폴더의 브랜치가 변경됐습니다. 목록을 다시 확인하세요.";
      }
    } catch (error) {
      if (error.reason === "git-timeout") throw error;
      result.reason = "작업 폴더의 Git 연결을 확인할 수 없습니다.";
    }
  }
  return result;
}

async function snapshot(projectPath, knownRepo) {
  const repo = knownRepo ?? await taskRepo(projectPath);
  const [refs, output, currentBranch] = await Promise.all([
    taskGit(projectPath, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/"]),
    taskGit(projectPath, ["worktree", "list", "--porcelain", "-z"]),
    taskGit(projectPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((value) => value.trim(), (error) => {
      if (error.reason === "git-timeout") throw error;
      return null;
    }),
  ]);
  const entries = parseWorktrees(output);
  if (!entries.length) throw unavailable("Git 원본 작업 폴더를 확인할 수 없습니다.");
  const worktrees = await Promise.all(entries.map((entry, index) => inspectWorktree(repo, entry, index === 0)));
  const branches = refs.split(/\r?\n/).filter(Boolean).map((line) => {
    const [ref, head] = line.split("\0");
    const name = ref.slice("refs/heads/".length);
    const matching = worktrees.filter((item) => item.branch === name);
    const worktree = matching[0];
    const branch = { name, head, cwd: worktree?.cwd ?? null, checkedOut: matching.length > 0,
      locked: matching.some((item) => item.locked), missing: matching.some((item) => item.missing),
      original: matching.some((item) => item.original), selectable: true };
    if (name === "main" || name === "develop") branch.reason = "main과 develop은 작업 브랜치로 선택할 수 없습니다.";
    else if (matching.length > 1) branch.reason = "같은 브랜치가 여러 작업 폴더에 연결되어 있습니다. Git 상태를 먼저 확인하세요.";
    else if (worktree?.reason) branch.reason = worktree.reason;
    branch.selectable = !branch.reason;
    return branch;
  });
  return { branches, currentBranch, repo, original: entries[0].cwd };
}

export async function listWorkbranches(projectPath) {
  if (!projectPath || typeof projectPath !== "string") throw new HttpError(400, "프로젝트를 선택하세요.");
  const { branches, currentBranch } = await snapshot(projectPath);
  return { branches, currentBranch };
}

// Stable hashed locations support any legal branch name without putting its slashes in a path.
export function workbranchLocation(repo, branch) {
  const original = repo.original ?? (path.basename(repo.common).toLowerCase() === ".git" ? path.dirname(repo.common) : repo.top);
  const root = path.join(path.dirname(original), `${path.basename(original)}.agenthub`);
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 24);
  return { root, dir: path.join(root, `work-${hash}`) };
}

async function exclusive(common, action) {
  const key = pathKey(common);
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  queues.set(key, current);
  try { return await current; }
  finally { if (queues.get(key) === current) queues.delete(key); }
}

export async function resolveWorkbranch(projectPath, branch) {
  if (!projectPath || typeof projectPath !== "string") throw new HttpError(400, "프로젝트를 선택하세요.");
  const repo = await taskRepo(projectPath);
  await validateBranch(projectPath, branch);
  return exclusive(repo.common, async () => {
    const initial = await snapshot(projectPath, repo);
    const selected = initial.branches.find((item) => item.name === branch);
    if (!selected) throw unavailable("선택한 로컬 작업 브랜치가 없습니다. 목록을 새로고침하세요.", "workbranch-missing");
    if (!selected.selectable) throw unavailable(selected.reason);
    const extra = { commonDir: repo.common };
    if (selected.cwd) return { dir: selected.cwd, branch, created: false, managed: false, ...extra };
    const location = workbranchLocation({ ...repo, original: initial.original }, branch);
    if (fs.existsSync(location.dir)) throw unavailable("작업 브랜치의 폴더 경로가 이미 사용 중입니다. 기존 폴더를 먼저 확인하세요.", "workbranch-path-exists");
    fs.mkdirSync(location.root, { recursive: true });
    try {
      // Git itself prevents an external process from checking out the same branch twice.
      await taskGit(projectPath, ["worktree", "add", "--", location.dir, branch], { write: true });
    } catch (error) {
      // Worktree hooks or a concurrent client can complete registration before a failure.
      // Inspect the resulting state, preserving every folder and branch on uncertain outcomes.
      try {
        const latest = await snapshot(projectPath, repo);
        const current = latest.branches.find((item) => item.name === branch && item.selectable && item.cwd);
        if (current) return { dir: current.cwd, branch, created: false, managed: false, ...extra };
      } catch {}
      throw error;
    }
    const latest = await snapshot(projectPath, repo);
    const resolved = latest.branches.find((item) => item.name === branch);
    if (!resolved?.selectable || !resolved.cwd || !samePath(resolved.cwd, location.dir))
      throw unavailable("작업 폴더 생성 후 브랜치 연결이 변경됐습니다. 상태를 확인하세요.");
    return { dir: resolved.cwd, branch, created: true, managed: true, root: location.root, ...extra };
  });
}
