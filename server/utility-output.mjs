import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const OUTPUT_PARTS = ["docs", "agenthub", "outputs"];

function unsafe() {
  return Object.assign(new Error("출력 경로는 작업 폴더 안의 실제 폴더와 파일이어야 합니다. 심볼릭 링크는 사용할 수 없습니다."), { code: "OUTPUT_UNSAFE_PATH" });
}

function samePath(a, b) {
  return path.relative(a, b) === "";
}

function outputDirectory(cwd, create = false) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw unsafe();
  let directory = path.resolve(cwd);
  const rootStat = fs.lstatSync(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw unsafe();
  const root = fs.realpathSync(directory);
  // Resolving the selected worktree itself is allowed; all output components below it must be real directories.
  directory = root;
  for (const part of OUTPUT_PARTS) {
    directory = path.join(directory, part);
    if (create) {
      try { fs.mkdirSync(directory); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(directory), directory)) throw unsafe();
  }
  return { root, directory };
}

// Text events include progress messages. Only the final message in the current turn is printed.
// Unlike workflow handoffs, this keeps whitespace and the complete message without truncation.
export function finalAnswer(session) {
  const events = session.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "user") return "";
    if (events[i].kind === "text" && typeof events[i].text === "string") return events[i].text;
  }
  return "";
}

function safeStem(value) {
  const stem = String(value ?? "output").normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "-").slice(0, 60).toWellFormed().replace(/^[. -]+|[. -]+$/g, "");
  return "output-" + (stem || "message");
}

export function writeMessageOutput({ cwd, title, text }) {
  if (typeof text !== "string" || !text.trim()) throw new Error("저장할 완료 메시지가 없습니다.");
  const { root, directory } = outputDirectory(cwd, true);
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  let fileName, target, descriptor;
  for (let attempt = 0; attempt < 10; attempt++) {
    fileName = `${safeStem(title)}-${stamp}-${randomBytes(8).toString("hex")}.md`;
    target = path.join(directory, fileName);
    try { descriptor = fs.openSync(target, "wx", 0o600); break; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (descriptor === undefined) throw new Error("출력 파일 이름을 만들지 못했습니다.");
  try {
    // Check parents again before writing to the exclusively created file.
    if (!samePath(outputDirectory(cwd).directory, directory)) throw unsafe();
    fs.writeFileSync(descriptor, text, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  return { path: target, relativePath: path.relative(root, target).split(path.sep).join("/"), fileName };
}

export function readMessageOutput(command) {
  const output = command.lastRun?.output;
  if (!output) throw Object.assign(new Error("아직 저장한 완료 메시지가 없습니다."), { code: "OUTPUT_NOT_FOUND" });
  const { directory } = outputDirectory(command.lastRun.cwd);
  if (typeof output.fileName !== "string" || !output.fileName.startsWith("output-") || !output.fileName.endsWith(".md") || path.basename(output.fileName) !== output.fileName) throw unsafe();
  const target = path.join(directory, output.fileName);
  if (!samePath(target, output.path) || output.relativePath !== [...OUTPUT_PARTS, output.fileName].join("/")) throw unsafe();
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(fs.realpathSync(target), target)) throw unsafe();
  return { text: fs.readFileSync(target, "utf8"), path: target, relativePath: output.relativePath, fileName: output.fileName };
}
