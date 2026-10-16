// 한 번 묻고 답 한 개를 받는 CLI 호출. 파일은 읽기만 하고, 대화 기록은 남기지 않는다.
// Claude CLI가 있으면 쓰고, 없으면 Codex로 대신한다.
import { spawnCli } from "./cli.mjs";
import { HttpError } from "./application/errors.mjs";

export function askOnce({ cliPaths, prompt, cwd, model = "haiku", timeoutMs = 120_000, label = "AI 요청" }) {
  const paths = cliPaths();
  const agent = paths.claude ? "claude" : paths.codex ? "codex" : null;
  if (!agent) return Promise.reject(new HttpError(400, `${label}을 처리할 Claude나 Codex CLI를 찾지 못했습니다.`));
  const args = agent === "claude"
    ? ["-p", "--output-format", "json", "--model", model, "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep",
      "--permission-mode", "default", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]
    : ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", cwd, "-"];
  return new Promise((resolve, reject) => {
    const child = spawnCli(paths[agent], args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => reject(new HttpError(500, `${label} 실패: ${e.message}`)));
    child.on("close", () => {
      clearTimeout(timer);
      try {
        // Claude: { result }, Codex: 줄마다 이벤트(마지막 agent_message)
        resolve(agent === "claude"
          ? JSON.parse(out).result ?? ""
          : out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter((m) => m?.item?.type === "agent_message").map((m) => m.item.text).at(-1) ?? "");
      } catch {
        reject(new HttpError(500, `${label} 실패: ${err.trim().slice(-300) || "CLI 응답을 읽지 못했습니다."}`));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}
