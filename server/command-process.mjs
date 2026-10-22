import { spawn } from "node:child_process";
import { cleanError } from "./git-auth.mjs";
import { scheduleGit, gitEnvironment } from "./git-execution.mjs";

// Structured arguments and stdin only; no shell, prompts, pager, or debug token output.
export function runCommand(file, args, { cwd, input, timeout = 30_000, maxBuffer = 5_000_000, onStdout, collectOutput = true } = {}) {
  return scheduleGit(file, args, () => new Promise((resolve, reject) => {
    const env = gitEnvironment({ GH_HOST: "github.com", GH_REPO: "", GH_DEBUG: "", DEBUG: "", GH_FORCE_TTY: "",
      GH_PROMPT_DISABLED: "1", NO_COLOR: "1" });
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0, timedOut = false, overflow = false;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", shell: false })
          .on("error", () => child.kill()).on("close", (code) => { if (code !== 0) child.kill(); });
      } else child.kill();
    };
    const abort = () => {
      stop();
      const error = new Error(timedOut ? "명령 응답 시간이 초과되었습니다." : "명령 출력이 너무 큽니다.");
      Object.assign(error, { timedOut, overflow, stderr, stdout });
      reject(error);
      // Helpers may retain inherited pipes after a failed tree termination.
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref();
    };
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
    const add = (name, data) => {
      if (name !== "stdout" || collectOutput) size += Buffer.byteLength(data);
      if (size > maxBuffer) { overflow = true; clearTimeout(timer); abort(); return; }
      if (name === "stdout") { onStdout?.(data); if (collectOutput) stdout += data; }
      else stderr += data;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => add("stdout", data));
    child.stderr.on("data", (data) => add("stderr", data));
    child.stdin.on("error", () => {});
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut && !overflow) return resolve(stdout);
      const error = new Error(cleanError([stdout, stderr].filter(Boolean).join("\n")) || "명령 실행에 실패했습니다.");
      Object.assign(error, { exitCode: code, timedOut, overflow, stderr, stdout });
      reject(error);
    });
    child.stdin.end(input ?? "");
  }));
}
