// 프로젝트 화면의 Git 패널: 상태·변경 파일·커밋 기록·세션 브랜치를 보고, 커밋과 세션 브랜치 병합을 한다.
// 원격(push·pull·fetch)은 다루지 않는다. 명령은 execFile로 인자를 따로 넘기고, 사용자가 고른 값은 실제 목록에 있는지 확인한 뒤에만 쓴다.
import fs from "node:fs";
import path from "node:path";
import { git } from "./git.mjs";

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
    if (x === "R" || x === "C") file.orig = parts[++i];
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
  const [branchOut, files, logOut, refsOut, graphOut] = await Promise.all([
    git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD"),
    status(repo),
    git(repo, ["log", `-n${COMMITS_MAX}`, "--date=iso-strict", `--pretty=format:%H${SEP}%h${SEP}%an${SEP}%ad${SEP}%D${SEP}%s${END}`]).catch(() => ""),
    git(repo, ["for-each-ref", "refs/heads", `--format=%(refname:short)${SEP}%(objectname)${SEP}%(committerdate:iso-strict)${SEP}%(subject)`]).catch(() => ""),
    git(repo, ["log", "--branches", "HEAD", "--topo-order", `-n${GRAPH_COMMITS_MAX + 1}`, "--date=iso-strict", `--pretty=format:%H${SEP}%h${SEP}%P${SEP}%an${SEP}%ad${SEP}%s${END}`]).catch(() => ""),
  ]);
  const branch = branchOut.trim();
  const upstream = (await git(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => "")).trim() || null;
  const ahead = upstream ? await count(repo, `${upstream}..HEAD`) : null;
  const behind = upstream ? await count(repo, `HEAD..${upstream}`) : null;

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
    const item = { name, tip, date, subject, current, ahead: current ? 0 : await count(repo, `HEAD..${name}`) };
    if (session) {
      // 세션은 보통 커밋하지 않고 작업 폴더에 변경을 남기므로 그 수도 센다.
      const dir = session.worktree.dir;
      const dirty = fs.existsSync(dir) ? (await status(dir).catch(() => [])).length : null;
      Object.assign(item, { sessionId: session.id, sessionTitle: session.title, sessionState: session.state, worktree: dir, dirty });
    }
    return item;
  }));
  // 세션 브랜치를 먼저, 그다음 최근에 바뀐 순서
  branches.sort((a, b) => (b.current - a.current) || (!!b.sessionId - !!a.sessionId) || String(b.date).localeCompare(String(a.date)));

  return {
    branch,
    upstream,
    ahead,
    behind,
    files: files.slice(0, FILES_MAX).map((f) => ({ ...f, label: statusLabel(f) })),
    moreFiles: Math.max(0, files.length - FILES_MAX),
    commits: parseLog(logOut),
    graph: { commits: graphCommits.slice(0, GRAPH_COMMITS_MAX), truncated: graphCommits.length > GRAPH_COMMITS_MAX },
    branches,
  };
}

// dir 작업 폴더의 파일 하나가 HEAD에서 얼마나 바뀌었는지. file은 지금 상태 목록에 있어야 한다.
export async function fileDiff(dir, file) {
  const files = await status(dir);
  const found = files.find((f) => f.path === file);
  if (!found) throw new Error("변경된 파일이 아닙니다. 목록을 새로고침하세요.");
  if (found.x === "?" && found.y === "?") {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat.size > UNTRACKED_MAX) return `새 파일 (${stat.size.toLocaleString()} 바이트, 너무 커서 내용을 보이지 않습니다)`;
    const text = fs.readFileSync(full, "utf8");
    if (text.includes("\0")) return "새 파일 (바이너리)";
    return [`새 파일: ${file}`, "@@ 새 파일 @@", ...text.split(/\r?\n/).map((l) => `+${l}`)].join("\n");
  }
  const target = found.orig ? ["--", found.orig, file] : ["--", file];
  const diff = await git(dir, ["diff", "HEAD", "--no-color", ...target]).catch(() => git(dir, ["diff", "--cached", "--no-color", ...target]));
  return cutDiff(diff || "(내용 차이 없음 · 권한이나 줄 끝만 바뀌었을 수 있습니다)");
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

// 현재 브랜치와 갈라진 뒤 그 브랜치에서 바뀐 것(병합하면 들어올 내용)
export async function branchDiff(repo, branch) {
  await checkBranch(repo, branch);
  return cutDiff(await git(repo, ["diff", "--stat", "--patch", "--no-color", `HEAD...${branch}`]) || "(현재 브랜치에 없는 커밋이 없습니다)");
}

// dir 작업 폴더에서 커밋한다. files가 있으면 그 파일만, 없으면 모든 변경을 담는다.
export async function commit(dir, message, files = null) {
  const text = String(message ?? "").trim();
  if (!text) throw new Error("커밋 메시지를 입력하세요.");
  const changed = await status(dir);
  if (!changed.length) throw new Error("커밋할 변경이 없습니다.");
  if (files) {
    const wanted = new Set(files.map(String));
    // 이름을 바꾼 파일은 새 이름만 골라도 원래 이름의 삭제까지 함께 담는다(빠지면 옛 파일 삭제가 커밋되지 않고 남는다).
    const picked = [...new Set(changed.filter((f) => wanted.has(f.path) || (f.orig && wanted.has(f.orig)))
      .flatMap((f) => [f.path, f.orig].filter(Boolean)))];
    if (!picked.length) throw new Error("커밋할 파일을 고르세요.");
    // 고른 파일만 담는다. 이미 스테이지에 있던 다른 파일은 빼서 고른 것만 커밋한다.
    await git(dir, ["reset", "-q"]).catch(() => {});
    await git(dir, ["add", "-A", "--", ...picked]);
  } else {
    await git(dir, ["add", "-A"]);
  }
  await git(dir, ["commit", "-q", "-m", text]);
  return (await git(dir, ["log", "-1", "--pretty=format:%h %s"])).trim();
}

// 세션 브랜치를 현재 브랜치로 병합한다. 충돌하면 되돌리고 충돌한 파일을 알린다.
export async function merge(repo, branch) {
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
}
