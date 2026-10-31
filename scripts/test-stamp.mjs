// 전체 테스트를 통과한 커밋 기록. 릴리스가 같은 코드를 다시 테스트하지 않게 쓴다.
// 기록은 저장소의 공통 git 폴더(.git)에 두므로 작업 트리(worktree)끼리 함께 본다.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const KEEP = 30;
// 이 경로만 다르면 같은 코드로 본다(문서만 고친 커밋, 머지 커밋).
export const DOC_ONLY = [":(exclude,glob)**/*.md", ":(exclude)docs"];

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export function stampFile(cwd = process.cwd()) {
  return path.resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd), "agenthub-tested.json");
}

export function readStamps(cwd = process.cwd()) {
  try {
    const value = JSON.parse(fs.readFileSync(stampFile(cwd), "utf8"));
    return Array.isArray(value) ? value.filter((item) => typeof item?.commit === "string") : [];
  } catch { return []; }
}

// 커밋하지 않은 변경(추적하지 않는 새 파일 포함)이 없을 때만 HEAD를 통과로 남긴다. 남겼으면 커밋을 돌려준다.
export function recordPass(cwd = process.cwd()) {
  try {
    if (git(["status", "--porcelain"], cwd)) return null;
    const commit = git(["rev-parse", "HEAD"], cwd);
    const stamps = [{ commit, at: new Date().toISOString() }, ...readStamps(cwd).filter((item) => item.commit !== commit)].slice(0, KEEP);
    fs.writeFileSync(stampFile(cwd), JSON.stringify(stamps, null, 2));
    return commit;
  } catch { return null; }
}

// HEAD와 코드가 같은(문서만 다른) 통과 기록을 찾는다. 없으면 null
export function testedMatch(cwd = process.cwd(), ref = "HEAD") {
  for (const stamp of readStamps(cwd)) {
    try {
      execFileSync("git", ["diff", "--quiet", stamp.commit, ref, "--", ".", ...DOC_ONLY], { cwd, stdio: "ignore" });
      return stamp;
    } catch { /* 코드가 다르거나 기록의 커밋이 없다 */ }
  }
  return null;
}
