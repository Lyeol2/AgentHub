// 새 버전을 빌드해 GitHub Release로 올린다. 앱의 업데이트 기능은 이 릴리스의 latest.yml을 읽는다.
// 사용법: npm run release [patch|minor|major|x.y.z] (기본 patch)
// 필요: 커밋하지 않은 변경이 없을 것, GitHub CLI(gh) 로그인
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const bump = process.argv[2] ?? "patch";
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" && ["npm", "npx"].includes(cmd), ...opts }); // npm·npx는 .cmd라 셸이 필요하다.
const read = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

function findGh() {
  const candidates = [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "GitHub CLI", "gh.exe")];
  for (const file of candidates) if (fs.existsSync(file)) return file;
  return "gh";
}

if (read("git", ["status", "--porcelain"])) {
  console.error("커밋하지 않은 변경이 있습니다. 먼저 커밋하세요.");
  process.exit(1);
}
const gh = findGh();
read(gh, ["auth", "status"]);

run("npm", ["test"]);
run("npm", ["version", bump, "--no-git-tag-version"]);
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tag = `v${version}`;

try {
  run("npx", ["electron-builder", "--win", "--publish", "never"]);
} catch (err) {
  // 빌드에 실패하면 올린 버전을 되돌린다.
  run("git", ["checkout", "--", "package.json", "package-lock.json"]);
  throw err;
}

const files = [
  `dist/AgentHub-Setup-${version}.exe`,
  `dist/AgentHub-Setup-${version}.exe.blockmap`,
  "dist/latest.yml",
  `dist/AgentHub-${version}-portable.exe`,
];
for (const file of files) {
  if (!fs.existsSync(file)) throw new Error(`빌드 결과가 없습니다: ${file}`);
}

run("git", ["commit", "-am", `chore: release ${tag}`]);
run("git", ["tag", "-a", tag, "-m", tag]); // --follow-tags는 주석 태그만 올린다.
run("git", ["push", "--follow-tags"]);
run(gh, ["release", "create", tag, ...files, "--title", `AgentHub ${version}`, "--generate-notes"]);
console.log(`\n릴리스 완료: ${tag}`);
