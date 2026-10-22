import { execGit } from "./git-execution.mjs";
import { runCommand } from "./command-process.mjs";

// Return one extra row so the caller can reject an oversized operation without
// spawning a process for every subject. NUL keeps unusual subjects unambiguous.
export async function readCommitSummaries(cwd, range, { run = execGit, limit = 500 } = {}) {
  const fields = (await run(cwd, ["log", "--topo-order", `--max-count=${limit + 1}`, "-z", "--format=%H%x00%s", range])).split("\0");
  const result = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const hash = fields[index].trim();
    if (hash) result.push({ hash, short: hash.slice(0, 8), subject: fields[index + 1].trim() });
  }
  return result;
}

// Exact reachability, including every freshly read remote tip. Stream the
// history so a large remote repository cannot overflow a captured-output buffer.
export async function containsAnyCommit(cwd, tips, commits, { run = runCommand } = {}) {
  if (!tips.size || !commits.size) return false;
  let pending = "", found = false;
  await run("git", ["--no-optional-locks", "-C", cwd, "rev-list", "--stdin"], {
    cwd, input: [...tips].join("\n") + "\n", collectOutput: false,
    onStdout(chunk) {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const line of lines) if (commits.has(line.trim())) found = true;
    },
  });
  return found || commits.has(pending.trim());
}
