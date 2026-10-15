import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const run = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
  cwd, encoding: "utf8", windowsHide: true,
});

// Each test file owns its temp root; repositories and indexes are never shared across files.
// Keep this helper outside test/ so `node --test` does not collect it as an extra test.
export function gitFixtures(t, prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tmp).startsWith(prefix));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  });
  return (name) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    run(dir, "init", "-q", "-b", "main");
    run(dir, "config", "user.name", "t");
    run(dir, "config", "user.email", "t@t");
    run(dir, "config", "commit.gpgsign", "false");
    return dir;
  };
}
