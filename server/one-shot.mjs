// 한 번 묻고 답 한 개를 받는다. 기존 CLI 로그인과 설정을 사용하며 작업 파일은 읽기만 한다.
import { spawnCli, killProcessTree } from "./cli.mjs";
import { HttpError } from "./application/errors.mjs";
import { configMcpServers } from "./agents/codex.mjs";

export function selectOneShotAgent(paths, requested) {
  if (requested !== undefined && !["claude", "codex"].includes(requested)) throw new HttpError(400, "초안을 만들 AI는 Claude 또는 Codex를 선택하세요.", "assistant-agent");
  const agent = requested ?? (paths.claude ? "claude" : paths.codex ? "codex" : null);
  if (!agent || !paths[agent]) throw new HttpError(400, `${agent === "claude" ? "Claude" : agent === "codex" ? "Codex" : "Claude나 Codex"} CLI를 찾지 못했습니다. 설정에서 설치·로그인을 확인하세요.`, "assistant-cli");
  return agent;
}

// 읽기 전용 한 번 요청에는 MCP가 필요 없다. 사용자가 Codex에 등록한 MCP 서버(Unity 등)가 꺼져 있으면
// 연결 오류가 섞이므로 이 요청에서만 끈다. Claude는 --strict-mcp-config로 같은 효과를 낸다.
export function oneShotArgs({ agent, model, cwd, mcpServers = agent === "codex" ? configMcpServers() : [] }) {
  if (model !== undefined && (typeof model !== "string" || model.length > 200 || /[\u0000-\u001f]/.test(model))) throw new HttpError(400, "모델 이름을 확인하세요.", "assistant-model");
  const selected = model?.trim();
  return agent === "claude"
    ? ["-p", "--output-format", "json", ...(selected ? ["--model", selected] : []), "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep",
      "--permission-mode", "default", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]
    : ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", ...(selected ? ["--model", selected] : []),
      ...mcpServers.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]), "--cd", cwd, "-"];
}

// stderr에는 설정 경고·MCP 연결 로그가 섞인다. 실패 이유를 가리지 않도록 이런 줄은 빼고 마지막 부분만 쓴다.
const NOISE = /rmcp::|\bERROR codex_|Codex is ignoring|is ignored\.$/;
function stderrDetail(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() && !NOISE.test(line)).join("\n").trim().slice(-300);
}

// Codex는 실패 이유(사용량 한도·로그인 등)를 stdout JSON 이벤트로 보낸다.
// 턴 실패를 먼저 보고, 없으면 마지막 오류 이벤트를 쓴다.
function codexFailure(out) {
  const events = out.split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } });
  const failure = events.findLast((event) => event?.type === "turn.failed") ?? events.findLast((event) => event?.type === "error");
  return failure ? String(failure.error?.message || failure.message || "CLI 요청 실패") : null;
}

export async function askOnce({ cliPaths, prompt, cwd, agent: requested, model, timeoutMs = 120_000, label = "AI 요청", spawn = spawnCli }) {
  const paths = cliPaths();
  const agent = selectOneShotAgent(paths, requested);
  // 기존 호출자는 가벼운 Claude 모델을 계속 사용한다. 명시적으로 선택한 AI는 CLI 기본 모델을 따른다.
  const args = oneShotArgs({ agent, model: model ?? (!requested && agent === "claude" ? "haiku" : undefined), cwd });
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, out = "", err = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const stop = () => {
      if (process.platform === "win32" && child?.pid) killProcessTree(child.pid);
      else child?.kill();
    };
    try { child = spawn(paths[agent], args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NO_COLOR: "1" } }); }
    catch (error) { finish(new HttpError(500, `${label} 실패: ${error.message}`, "assistant-cli")); return; }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const receive = (key, data) => {
      if (settled) return;
      if (key === "out") out += data; else err += data;
      if (out.length + err.length > 2_000_000) { finish(new HttpError(502, `${label}의 응답이 너무 큽니다. 요청을 나눠 주세요.`, "assistant-output")); stop(); }
    };
    child.stdout.on("data", (data) => receive("out", data));
    child.stderr.on("data", (data) => receive("err", data));
    timer = setTimeout(() => { finish(new HttpError(504, `${label} 시간이 초과됐습니다. 입력은 유지됩니다. 다시 시도하거나 직접 작성하세요.`, "assistant-timeout")); stop(); }, timeoutMs);
    child.on("error", (error) => finish(new HttpError(500, `${label} 실패: ${error.message}`, "assistant-cli")));
    child.on("close", (code) => {
      if (settled) return;
      const detail = (agent === "codex" ? codexFailure(out)?.slice(-300) : null) || stderrDetail(err);
      if (code !== 0) { finish(new HttpError(502, `${label} 실패: ${detail || "CLI 실행을 완료하지 못했습니다. 설치·로그인과 모델을 확인하세요."}`, "assistant-cli")); return; }
      try {
        let text;
        if (agent === "claude") {
          const result = JSON.parse(out);
          if (result.is_error) throw Error(String(result.result || "CLI 요청 실패"));
          text = result.result;
        } else {
          const events = out.split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } });
          const failure = codexFailure(out);
          if (failure) throw Error(failure);
          text = events.filter((event) => event?.item?.type === "agent_message").at(-1)?.item.text;
        }
        if (typeof text !== "string" || !text.trim()) throw Error("AI가 답을 보내지 않았습니다. 로그인과 선택한 모델을 확인하세요.");
        finish(null, text);
      } catch (error) { finish(new HttpError(502, `${label} 실패: ${error.message.slice(-300) || detail}`, "assistant-response")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}
