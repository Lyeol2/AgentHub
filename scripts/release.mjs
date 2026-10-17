// 새 버전을 빌드해 GitHub Release로 올린다. 앱의 업데이트 기능은 이 릴리스의 latest.yml을 읽는다.
// 사용법: npm run release [patch|minor|major|x.y.z] (인수 > 현재 HEAD의 준비 초안 > patch)
// 마지막 커밋을 임시 작업 트리에 꺼내 빌드하므로 커밋하지 않은 변경은 릴리스에 들어가지 않고 그대로 남는다.
// 필요: package.json·package-lock.json에 커밋하지 않은 변경이 없을 것, GitHub CLI(gh) 로그인
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { releaseNotes, postDiscord, readPreparedRelease, DRAFT_FILE } from "./release-notes.mjs";

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" && ["npm", "npx"].includes(cmd), ...opts }); // npm·npx는 .cmd라 셸이 필요하다.
const read = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();

function findGh() {
  const candidates = [path.join(process.env.ProgramFiles ?? "C:\Program Files", "GitHub CLI", "gh.exe")];
  for (const file of candidates) if (fs.existsSync(file)) return file;
  return "gh";
}

// 버전 커밋을 현재 브랜치로 fast-forward할 때 겹치지 않도록 버전 파일만 깨끗해야 한다.
if (read("git", ["status", "--porcelain", "--", "package.json", "package-lock.json"])) {
  console.error("package.json이나 package-lock.json에 커밋하지 않은 변경이 있습니다. 먼저 커밋하거나 되돌리세요.");
  process.exit(1);
}
const gh = findGh();
read(gh, ["auth", "status"]);

// 릴리스 노트: 지난 태그 이후 커밋(릴리스 커밋을 만들기 전에 읽는다). GitHub 릴리스와 Discord 알림에 같이 쓴다.
let lastTag = null;
try {
  lastTag = read("git", ["describe", "--tags", "--abbrev=0"]);
} catch {
  // 첫 릴리스
}
// 릴리스 준비 세션이 쓴 사용자용 초안(release-notes.draft.md)이 지금 커밋 기준이면 그것을, 아니면 커밋 노트를 쓴다.
const draft = readPreparedRelease();
const bump = process.argv[2] ?? draft?.bump ?? "patch";
const notes = draft?.notes ?? releaseNotes(lastTag);
console.log(`버전 단위: ${bump}`);
console.log(draft ? "업데이트 내역: 릴리스 준비 세션의 초안을 씁니다." : "업데이트 내역: 지난 태그 이후 커밋으로 만듭니다.");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-release-"));
fs.rmdirSync(dir); // git worktree add는 없는 경로를 받는다.
run("git", ["worktree", "add", "--detach", dir, "HEAD"]);
// Ctrl+C에 Node가 바로 끝나지 않게 한다. 실행 중인 명령이 멈추면 finally에서 임시 작업 트리를 지운다.
let interrupted = false;
process.once("SIGINT", () => { interrupted = true; });

try {
  const inTree = { cwd: dir };
  run("npm", ["ci"], inTree);
  run("npm", ["test"], inTree);
  run("npm", ["version", bump, "--no-git-tag-version"], inTree);
  const { version } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const tag = `v${version}`;

  run("npx", ["electron-builder", "--win", "--publish", "never"], inTree);

  const files = [
    `dist/AgentHub-Setup-${version}.exe`,
    `dist/AgentHub-Setup-${version}.exe.blockmap`,
    "dist/latest.yml",
    `dist/AgentHub-${version}-portable.exe`,
  ].map((file) => path.join(dir, file));
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error(`빌드 결과가 없습니다: ${file}`);
  }

  run("git", ["commit", "-m", `chore: release ${tag}`, "--", "package.json", "package-lock.json"], inTree);
  const commit = read("git", ["rev-parse", "HEAD"], inTree);
  run("git", ["tag", "-a", tag, "-m", tag, commit]); // --follow-tags는 주석 태그만 올린다.
  run("git", ["merge", "--ff-only", commit]); // 남은 변경은 버전 파일과 겹치지 않아 그대로 유지된다.
  run("git", ["push", "--follow-tags"]);
  // 노트 파일은 임시 작업 트리가 지워져도 남도록 원래 저장소의 dist/에 둔다.
  fs.mkdirSync("dist", { recursive: true });
  const notesFile = path.join("dist", `release-notes-${version}.md`);
  fs.writeFileSync(notesFile, `${notes}\n\n**전체 변경**: https://github.com/Lyeol2/AgentHub/compare/${lastTag ?? ""}...${tag}\n`);
  run(gh, ["release", "create", tag, ...files, "--title", `AgentHub ${version}`, "--notes-file", notesFile]);
  console.log(`\n릴리스 완료: ${tag}`);
  await postDiscord(version, notes);
  // 쓴 초안은 지운다(dist/release-notes-<버전>.md에 남는다). 다음 릴리스에 같은 초안이 다시 나가지 않게 한다.
  if (draft) fs.rmSync(DRAFT_FILE, { force: true });
} finally {
  // 빌드에 실패해도 올린 버전은 임시 작업 트리와 함께 사라진다.
  removeReleaseTree(dir);
  if (interrupted) process.exitCode = 130;
}

// 빌드 도구가 잠시 파일을 잡고 있으면 git이 폴더를 다 지우지 못한다. 남은 폴더를 마저 지우고 기록을 prune해
// 임시 작업 트리가 git worktree 목록에 남지 않게 한다. 정리 실패가 원래 오류를 가리지 않도록 알리기만 한다.
function removeReleaseTree(tree) {
  try { run("git", ["worktree", "remove", "--force", tree]); }
  catch (error) { console.error(`임시 작업 트리를 git으로 지우지 못했습니다: ${error.message}`); }
  try { fs.rmSync(tree, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); }
  catch (error) { console.error(`임시 작업 트리 폴더가 남았습니다. 직접 지우세요: ${tree}`); }
  try { run("git", ["worktree", "prune"]); } catch {}
}
