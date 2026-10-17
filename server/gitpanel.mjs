// 프로젝트 화면의 Git 패널: 변경 파일을 스테이징하고 커밋하며, 기록·브랜치를 보고 병합·체크아웃한다.
// 원격(push·pull·fetch)은 다루지 않는다. 명령은 execFile로 인자를 따로 넘기고, 사용자가 고른 값은 실제 목록에 있는지 확인한 뒤에만 쓴다.
import fs from "node:fs";
import path from "node:path";
import { git } from "./git.mjs";
import { withGitRepoLock } from "./git-lock.mjs";

const FILES_MAX = 500;
const COMMITS_MAX = 40;
const GRAPH_COMMITS_MAX = 100;
const DIFF_MAX = 1_500_000; // 화면에 보낼 diff 최대 글자 수
const UNTRACKED_MAX = 200_000;
const HASH = /^[0-9a-f]{4,40}$/i;

const cutDiff = (text) => (text.length > DIFF_MAX ? `${text.slice(0, DIFF_MAX)}\n… (너무 길어 ${text.length - DIFF_MAX}자 생략)` : text);

// `git status --porcelain=v1 -z` 결과. 이름이 바뀐 파일은 원래 이름(orig)도 담는다.
export function parseStatus(out) {
  const parts = out.split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = { x, y, path: entry.slice(3) };
    if (x === "R" || x === "C" || y === "R" || y === "C") file.orig = parts[++i];
    files.push(file);
  }
  return files;
}

// 상태 두 글자를 사람이 읽는 말로
export function statusLabel({ x, y }) {
  if (x === "?" && y === "?") return "새 파일";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "충돌";
  const code = x !== " " ? x : y;
  return { M: "수정", A: "추가", D: "삭제", R: "이름 바꿈", C: "복사", T: "형식 바꿈" }[code] ?? code;
}

const conflicted = ({ x, y }) => x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");

function fileState(file) {
  const conflict = conflicted(file);
  const staged = !conflict && file.x !== " " && file.x !== "?";
  const unstaged = conflict || file.y !== " ";
  return {
    ...file, label: statusLabel(file), staged, unstaged,
    stageLabel: staged ? statusLabel({ x: file.x, y: " " }) : null,
    workLabel: unstaged ? (conflict ? "충돌" : file.x === "?" ? "새 파일" : statusLabel({ x: " ", y: file.y })) : null,
  };
}

// Validation and mutations share the repository queue with Git graph nodes.
const mutationDirs = new Map();
async function mutate(dir, action) {
  const real = fs.realpathSync(dir);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  // Share location resolution so calls from the same folder retain request order.
  let resolving = mutationDirs.get(key);
  if (!resolving) {
    resolving = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).then((value) => fs.realpathSync(value.trim()));
    mutationDirs.set(key, resolving);
    resolving.catch(() => { if (mutationDirs.get(key) === resolving) mutationDirs.delete(key); });
  }
  return withGitRepoLock(await resolving, action);
}

// -- 다음의 pathspec도 해석된다. 저장소 루트 기준의 리터럴 이름으로 한정한다.
const literalPaths = (files) => files.map((file) => `:(top,literal)${file}`);

const SEP = "\x1f";
const END = "\x1e";

export function parseLog(out) {
  return out.split(END).map((r) => r.trim()).filter(Boolean).map((r) => {
    const [hash, short, author, date, refs, subject] = r.split(SEP);
    return { hash, short, author, date, refs: refs ? refs.split(", ").filter(Boolean) : [], subject };
  });
}

// 노선도는 현재 브랜치 밖의 커밋과 분기·병합 관계도 보여 준다. refs는 로컬 브랜치 이름만 담는다.
function parseGraphLog(out, refsByTip) {
  return out.split(END).map((r) => r.trim()).filter(Boolean).map((r) => {
    const [hash, short, parents, author, date, subject] = r.split(SEP);
    return { hash, short, parents: parents ? parents.split(" ") : [], author, date, subject, refs: refsByTip.get(hash) ?? [] };
  });
}

async function status(dir) {
  return parseStatus(await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
}

async function count(dir, range) {
  try {
    return Number((await git(dir, ["rev-list", "--count", range])).trim());
  } catch {
    return null;
  }
}

// sessions: 이 프로젝트의 AgentHub 세션(작업 폴더를 분리한 세션의 브랜치를 세션과 잇는다)
export async function gitOverview(repo, sessions = []) {
  // 서로 기다릴 필요가 없는 조회는 함께 실행한다. git 프로세스 하나가 수십 ms라 차례로 부르면 화면이 늦게 뜬다.
  const [branchOut, files, logOut, refsOut, graphOut, elsewhere, upstreamOut] = await Promise.all([
    git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD"),
    status(repo),
    git(repo, ["log", `-n${COMMITS_MAX}`, "--date=iso-strict", `--pretty=format:%H${SEP}%h${SEP}%an${SEP}%ad${SEP}%D${SEP}%s${END}`]).catch(() => ""),
    git(repo, ["for-each-ref", "refs/heads", `--format=%(refname:short)${SEP}%(objectname)${SEP}%(committerdate:iso-strict)${SEP}%(subject)`]).catch(() => ""),
    git(repo, ["log", "--branches", "HEAD", "--topo-order", `-n${GRAPH_COMMITS_MAX + 1}`, "--date=iso-strict", `--pretty=format:%H${SEP}%h${SEP}%P${SEP}%an${SEP}%ad${SEP}%s${END}`]).catch(() => ""),
    otherWorktreeBranches(repo).catch(() => new Map()),
    git(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => ""),
  ]);
  const branch = branchOut.trim();
  const upstream = upstreamOut.trim() || null;
  // 앞섬·뒤처짐 수는 아래 브랜치별 수와 함께 센다.
  const tracking = upstream ? Promise.all([count(repo, `${upstream}..HEAD`), count(repo, `HEAD..${upstream}`)]) : [null, null];

  const bySession = new Map(sessions.filter((s) => s.worktree).map((s) => [s.worktree.branch, s]));
  const refs = refsOut.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, tip, date, subject] = line.split(SEP);
    return { name, tip, date, subject };
  });
  const refsByTip = new Map();
  for (const { name, tip } of refs) {
    if (!refsByTip.has(tip)) refsByTip.set(tip, []);
    refsByTip.get(tip).push(name);
  }
  const graphCommits = parseGraphLog(graphOut, refsByTip);
  const branches = await Promise.all(refs.slice(0, 80).map(async ({ name, tip, date, subject }) => {
    const session = bySession.get(name);
    const current = name === branch;
    // 세션은 보통 커밋하지 않고 작업 폴더에 변경을 남기므로 그 수도 센다.
    const dir = session?.worktree.dir;
    const [ahead, dirty] = await Promise.all([
      current ? 0 : count(repo, `HEAD..${name}`),
      session && fs.existsSync(dir) ? status(dir).then((files) => files.length, () => 0) : null,
    ]);
    const item = { name, tip, date, subject, current, ahead, checkedOutAt: elsewhere.get(name) ?? null };
    if (session) Object.assign(item, { sessionId: session.id, sessionTitle: session.title, sessionState: session.state, worktree: dir, dirty });
    return item;
  }));
  const [ahead, behind] = await tracking;
  // 세션 브랜치를 먼저, 그다음 최근에 바뀐 순서
  branches.sort((a, b) => (b.current - a.current) || (!!b.sessionId - !!a.sessionId) || String(b.date).localeCompare(String(a.date)));

  return {
    branch,
    upstream,
    ahead,
    behind,
    files: files.slice(0, FILES_MAX).map(fileState),
    stagedCount: files.filter((f) => fileState(f).staged).length,
    unstagedCount: files.filter((f) => fileState(f).unstaged).length,
    moreFiles: Math.max(0, files.length - FILES_MAX),
    commits: parseLog(logOut),
    graph: { commits: graphCommits.slice(0, GRAPH_COMMITS_MAX), truncated: graphCommits.length > GRAPH_COMMITS_MAX },
    branches,
  };
}

// area를 주면 index 또는 작업 폴더 쪽의 차이만 보여 준다. 생략하면 기존 HEAD 기준 보기다.
export async function fileDiff(dir, file, area = null) {
  if (area !== null && area !== "staged" && area !== "unstaged") throw new Error("변경 영역이 올바르지 않습니다.");
  const files = await status(dir);
  const found = files.find((f) => f.path === file);
  if (!found || (area && !fileState(found)[area])) throw new Error("변경된 파일이 아닙니다. 목록을 새로고침하세요.");
  if (found.x === "?" && found.y === "?") {
    const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    const full = path.join(top, file);
    const stat = fs.statSync(full);
    if (stat.size > UNTRACKED_MAX) return `새 파일 (${stat.size.toLocaleString()} 바이트, 너무 커서 내용을 보이지 않습니다)`;
    const text = fs.readFileSync(full, "utf8");
    if (text.includes("\0")) return "새 파일 (바이너리)";
    return [`새 파일: ${file}`, "@@ 새 파일 @@", ...text.split(/\r?\n/).map((l) => `+${l}`)].join("\n");
  }
  const names = found.x === "R" && found.orig && area !== "unstaged" ? [found.orig, file] : [file];
  const target = ["--", ...literalPaths(names)];
  let diff;
  if (area === "staged") diff = await git(dir, ["diff", "--cached", "--no-color", ...target]);
  else if (area === "unstaged") diff = await git(dir, ["diff", "--no-color", ...target]);
  else diff = await git(dir, ["diff", "HEAD", "--no-color", ...target]).catch(() => git(dir, ["diff", "--cached", "--no-color", ...target]));
  return cutDiff(diff || "(내용 차이 없음 · 권한이나 줄 끝만 바뀌었을 수 있습니다)");
}

// 선택 목록 전체를 현재 상태와 대조한 뒤 바꾼다. 오래된 항목이 섞이면 일부만 적용하지 않는다.
function selectedFiles(changed, files, area) {
  if (!Array.isArray(files) || !files.length || files.some((f) => typeof f !== "string" || !f || f.includes("\0"))) {
    throw new Error("변경할 파일을 고르세요.");
  }
  return [...new Set(files)].map((file) => {
    const found = changed.find((f) => f.path === file && fileState(f)[area]);
    if (!found) throw new Error("파일 상태가 바뀌었습니다. 목록을 새로고침하세요.");
    return found;
  });
}

export async function stage(dir, files) {
  return mutate(dir, async () => {
    const picked = selectedFiles(await status(dir), files, "unstaged");
    // 이미 index에서 이름이 바뀐 파일의 원래 이름은 add에 넘기지 않는다.
    const names = [...new Set(picked.flatMap((f) => f.y === "R" && f.orig ? [f.orig, f.path] : [f.path]))];
    await git(dir, ["add", "-A", "--", ...literalPaths(names)]);
    return picked.length;
  });
}

export async function unstage(dir, files) {
  return mutate(dir, async () => {
    const picked = selectedFiles(await status(dir), files, "staged");
    const names = [...new Set(picked.flatMap((f) => [f.path, f.x === "R" ? f.orig : null].filter(Boolean)))];
    const head = await git(dir, ["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
    if (head) await git(dir, ["reset", "-q", "HEAD", "--", ...literalPaths(names)]);
    // 첫 커밋 전에는 되돌릴 HEAD가 없다. index만 제거하여 작업 파일은 그대로 둔다.
    else await git(dir, ["rm", "-q", "--cached", "-f", "--", ...literalPaths(names)]);
    return picked.length;
  });
}

export async function showCommit(repo, hash) {
  if (!HASH.test(String(hash))) throw new Error("커밋 해시가 올바르지 않습니다.");
  return cutDiff(await git(repo, ["show", "--stat", "--patch", "--no-color", "--format=fuller", hash]));
}

async function localBranches(repo) {
  return (await git(repo, ["for-each-ref", "refs/heads", "--format=%(refname:short)"])).trim().split(/\r?\n/).filter(Boolean);
}

async function checkBranch(repo, branch) {
  if (!branch || String(branch).startsWith("-") || !(await localBranches(repo)).includes(branch)) {
    throw new Error("없는 브랜치입니다.");
  }
}

// 이 폴더가 아닌 다른 작업 폴더(worktree)에서 체크아웃한 브랜치 → 그 폴더. git은 같은 브랜치를 두 곳에서 체크아웃하지 못한다.
async function otherWorktreeBranches(repo) {
  const [top, list] = await Promise.all([git(repo, ["rev-parse", "--show-toplevel"]), git(repo, ["worktree", "list", "--porcelain"])]);
  const here = fs.realpathSync(top.trim());
  const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const used = new Map();
  for (const block of list.split(/\r?\n\r?\n/)) {
    const dir = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (!dir || !branch) continue;
    let real = path.resolve(dir);
    try { real = fs.realpathSync(real); } catch {}
    if (!same(real, here)) used.set(branch, real);
  }
  return used;
}

// 현재 브랜치와 갈라진 뒤 그 브랜치에서 바뀐 것(병합하면 들어올 내용)
export async function branchDiff(repo, branch) {
  await checkBranch(repo, branch);
  return cutDiff(await git(repo, ["diff", "--stat", "--patch", "--no-color", `HEAD...${branch}`]) || "(현재 브랜치에 없는 커밋이 없습니다)");
}

// staged 옵션은 현재 index 그대로 커밋한다. 기존 호출은 선택 파일/전체 담기 동작을 유지한다.
export async function commit(dir, message, files = null, { staged = false } = {}) {
  return mutate(dir, async () => {
    const text = String(message ?? "").trim();
    if (!text) throw new Error("커밋 메시지를 입력하세요.");
    const changed = await status(dir);
    if (staged) {
      if (changed.some(conflicted)) throw new Error("충돌을 해결하고 스테이징한 뒤 커밋하세요.");
      if (!changed.some((f) => fileState(f).staged)) throw new Error("스테이징된 변경이 없습니다.");
    } else {
      if (!changed.length) throw new Error("커밋할 변경이 없습니다.");
      if (files) {
        const wanted = new Set(files.map(String));
        const picked = [...new Set(changed.filter((f) => wanted.has(f.path) || (f.orig && wanted.has(f.orig)))
          .flatMap((f) => [f.path, f.x === "R" || f.y === "R" ? f.orig : null].filter(Boolean)))];
        if (!picked.length) throw new Error("커밋할 파일을 고르세요.");
        await git(dir, ["reset", "-q"]).catch(() => {});
        await git(dir, ["add", "-A", "--", ...literalPaths(picked)]);
      } else {
        await git(dir, ["add", "-A"]);
      }
    }
    await git(dir, ["commit", "-q", "-m", text]);
    return (await git(dir, ["log", "-1", "--pretty=format:%h %s"])).trim();
  });
}

// 세션 브랜치를 현재 브랜치로 병합한다. 충돌하면 되돌리고 충돌한 파일을 알린다.
export async function merge(repo, branch) {
  return mutate(repo, async () => {
    await checkBranch(repo, branch);
    const current = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current === branch) throw new Error("현재 브랜치와 같은 브랜치입니다.");
    // 사용자가 하던 병합(충돌 해결 중 등)이 있으면 시작하지 않는다. 아래의 실패 처리(merge --abort)가 그 병합까지 되돌리면 안 된다.
    const merging = await git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false);
    if (merging) throw new Error("이미 진행 중인 병합이 있습니다. 먼저 그 병합을 끝내거나 취소하세요.");
    try {
      await git(repo, ["merge", "--no-ff", "--no-edit", branch]);
    } catch (err) {
      const conflicts = (await git(repo, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).trim();
      if (conflicts) {
        await git(repo, ["merge", "--abort"]).catch(() => {});
        const error = new Error(`충돌이 나서 병합을 되돌렸습니다. 충돌한 파일:\n${conflicts}`);
        error.conflict = true;
        throw error;
      }
      throw err;
    }
    return (await git(repo, ["log", "-1", "--pretty=format:%h %s"])).trim();
  });
}

// 다른 로컬 브랜치로 전환한다. 커밋하지 않은 변경은 git switch처럼 가져가고, 덮어써질 변경이 있으면 git이 거절한 이유를 알린다.
export async function checkout(repo, branch) {
  return mutate(repo, async () => {
    await checkBranch(repo, branch);
    const current = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (current === branch) throw new Error("이미 현재 브랜치입니다.");
    const merging = await git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false);
    if (merging) throw new Error("진행 중인 병합이 있습니다. 먼저 그 병합을 끝내거나 취소하세요.");
    const elsewhere = (await otherWorktreeBranches(repo)).get(branch);
    if (elsewhere) throw new Error(`다른 작업 폴더에서 쓰는 브랜치라 체크아웃할 수 없습니다.\n${elsewhere}`);
    if ((await status(repo)).some(conflicted)) throw new Error("충돌한 파일이 있습니다. 충돌을 해결한 뒤 체크아웃하세요.");
    try {
      await git(repo, ["switch", "--no-guess", "--quiet", branch]);
    } catch (err) {
      const blocked = /would be overwritten|overwritten by checkout/i.test(err.message);
      throw new Error(blocked
        ? `커밋하지 않은 변경이 ${branch} 브랜치의 내용과 겹쳐 체크아웃하지 않았습니다. 먼저 커밋하세요.\n${err.message}`
        : err.message);
    }
    return branch;
  });
}
