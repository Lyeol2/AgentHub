import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseStatus, statusLabel } from "./gitpanel.mjs";
import { taskGit, assertTaskWorktree } from "./tasks.mjs";
import { HttpError } from "./application/errors.mjs";

// Tie a review to HEAD, the index and worktree metadata; reject an intervening edit.
export async function reviewSnapshot(task) {
  const head = await assertTaskWorktree(task);
  const raw = await taskGit(task.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const indexed = await taskGit(task.cwd, ["diff", "--cached", "--raw", "--no-abbrev", "-z"]);
  const files = parseStatus(raw).map((file) => ({ ...file, label: statusLabel(file) }));
  const hash = createHash("sha256").update(head).update(raw).update(indexed);
  for (const file of files) {
    for (const name of [file.path, file.orig].filter(Boolean)) {
      hash.update(name);
      try {
        const stat = fs.lstatSync(path.join(task.cwd, name), { bigint: true });
        hash.update([stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(":"));
        if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(path.join(task.cwd, name)));
      } catch (error) { if (error.code !== "ENOENT") throw error; hash.update("missing"); }
    }
  }
  return { head, token: hash.digest("hex"), files, clean: files.length === 0 };
}

export function assertReviewed(snapshot, body) {
  if (!body.expectedHead || body.expectedHead !== snapshot.head || body.reviewToken !== snapshot.token)
    throw new HttpError(409, "검토 후 파일이나 커밋이 변경됐습니다. 변경 목록을 새로 확인하세요.", "task-stale-review");
}

export async function commitReviewedFiles(task, body) {
  const snapshot = await reviewSnapshot(task);
  assertReviewed(snapshot, body);
  const message = String(body.message ?? "").trim();
  if (!message || message.length > 2000) throw new HttpError(400, "커밋 메시지를 1~2000자로 입력하세요.");
  if (!Array.isArray(body.files) || !body.files.length || body.files.length > 500 || body.files.some((file) => typeof file !== "string"))
    throw new HttpError(400, "커밋할 파일을 1~500개 선택하세요.");
  if (snapshot.files.some((file) => file.label === "충돌")) throw new HttpError(409, "충돌을 먼저 해결하세요.", "task-conflict");
  const selected = new Set(body.files);
  if ([...selected].some((file) => !snapshot.files.some((changed) => changed.path === file)))
    throw new HttpError(409, "선택한 파일이 변경 목록에 없습니다. 다시 확인하세요.", "task-stale-review");
  const names = [...new Set(snapshot.files.filter((file) => selected.has(file.path))
    .flatMap((file) => [file.path, file.x === "R" || file.y === "R" ? file.orig : null].filter(Boolean)))];
  const paths = names.map((name) => `:(top,literal)${name}`);
  await taskGit(task.cwd, ["add", "--all", "--", ...paths], { write: true });
  // --only preserves unrelated staged entries; selected new files were staged above.
  await taskGit(task.cwd, ["commit", "--only", "-m", message, "--", ...paths], { write: true });
  return reviewSnapshot(task);
}
