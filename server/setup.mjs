// CLI 설치와 로그인(Claude Code, Codex, GitHub CLI). 앱 안에서 진행 상황을 보여 주고, 로그인 주소·코드를 꺼내 화면에 띄운다.
// 설치는 winget으로 하고, winget이 없으면 각 CLI의 다른 공식 설치 방법을 쓴다.
import { spawn, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { locateCli, spawnCli, refreshPath, cliVersion, cliAuth, forgetAuth } from "./cli.mjs";

const isWindows = process.platform === "win32";

export const TOOLS = {
  claude: { label: "Claude Code", winget: "Anthropic.ClaudeCode", login: ["auth", "login"] },
  codex: { label: "Codex", winget: "OpenAI.Codex", login: ["login"] },
  gh: { label: "GitHub CLI", winget: "GitHub.cli", login: ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"] },
};

const LOG_MAX = 20000;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;
const CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/;

// 출력에서 로그인 주소와 일회용 코드를 꺼낸다. 로컬 콜백 주소(localhost)는 열 필요가 없다.
export function parseLoginOutput(text) {
  const clean = text.replace(ANSI, "");
  const urls = [...clean.matchAll(URL_PATTERN)].map((m) => m[0].replace(/[.,)]+$/, "")).filter((u) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u));
  return { url: urls[0] ?? null, code: clean.match(CODE_PATTERN)?.[0] ?? null, waitsForCode: /paste code/i.test(clean) };
}

let wingetPath;
function findWinget() {
  if (wingetPath !== undefined) return wingetPath;
  wingetPath = null;
  if (!isWindows) return null;
  try {
    wingetPath = execFileSync("where", ["winget"], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
  } catch {
    // winget이 없는 Windows(오래된 버전 등)
  }
  return wingetPath;
}

let npmPath;
function findNpm() {
  if (npmPath !== undefined) return npmPath;
  npmPath = null;
  try {
    npmPath = execFileSync(isWindows ? "where" : "which", [isWindows ? "npm.cmd" : "npm"], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
  } catch {
    // Node.js가 없음
  }
  return npmPath;
}

// 설치 방법. winget을 먼저 쓰고, 없으면 각 CLI의 다른 공식 방법을 쓴다. 방법이 없으면 null.
export function installPlan(tool) {
  const winget = findWinget();
  if (winget) {
    return {
      how: "winget",
      file: winget,
      args: ["install", "--id", TOOLS[tool].winget, "--exact", "--source", "winget", "--silent",
        "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"],
    };
  }
  if (tool === "claude" && isWindows) {
    // Claude Code 공식 설치 스크립트(~/.local/bin에 설치)
    return { how: "install.ps1", file: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"] };
  }
  if (tool === "codex" && findNpm()) return { how: "npm", file: findNpm(), args: ["install", "-g", "@openai/codex"] };
  return null;
}

// 도구마다 한 번에 하나의 작업(설치 또는 로그인)만 돈다.
export class Setup extends EventEmitter {
  constructor({ cliPath }) {
    super();
    this.cliPath = cliPath; // (tool) → 실행 파일 경로(설정에서 직접 지정한 경로 포함)
    this.jobs = new Map(); // tool → { kind, state, log, url, code, waitsForCode, child }
  }

  async status() {
    const tools = await Promise.all(Object.entries(TOOLS).map(async ([id, t]) => {
      const file = this.cliPath(id);
      const [version, loggedIn] = await Promise.all([cliVersion(file), cliAuth(id, file)]);
      return { id, label: t.label, path: file, version, loggedIn, installable: !!installPlan(id) || !!file };
    }));
    return { tools, jobs: this.jobList() };
  }

  jobList() {
    return Object.fromEntries([...this.jobs].map(([tool, { child, ...job }]) => [tool, job]));
  }

  changed() {
    this.emit("change", this.jobList());
  }

  start(tool, kind, file, args) {
    const running = this.jobs.get(tool);
    if (running?.state === "running") throw new Error(`${TOOLS[tool].label} ${running.kind === "install" ? "설치" : "로그인"}가 이미 진행 중입니다.`);
    const job = { kind, state: "running", log: "", url: null, code: null, waitsForCode: false, startedAt: new Date().toISOString() };
    // winget 출력은 콘솔 코드 페이지를 따르므로 UTF-8로 바꿔 실행한다.
    const child = kind === "install" && /winget/i.test(file)
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"chcp 65001 >nul & "${file}" ${args.join(" ")}"`], { windowsHide: true, windowsVerbatimArguments: true, stdio: ["pipe", "pipe", "pipe"] })
      : spawnCli(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    job.child = child;
    this.jobs.set(tool, job);
    let opened = false;
    const add = (chunk) => {
      // winget 진행 막대(\r로 덮어쓰는 줄)는 마지막 상태만 남긴다.
      job.log = (job.log + chunk.replace(ANSI, "")).split("\n").map((line) => line.split("\r").filter(Boolean).at(-1) ?? "").join("\n").slice(-LOG_MAX);
      if (kind === "login") {
        const found = parseLoginOutput(job.log);
        job.url = found.url ?? job.url;
        job.code = found.code ?? job.code;
        job.waitsForCode = found.waitsForCode;
        // 브라우저를 직접 열지 못하는 CLI(gh)도 있으니 주소가 나오면 한 번 열어 준다.
        if (job.url && !opened) {
          opened = true;
          openBrowser(job.url);
        }
      }
      this.changed();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.stdin.on("error", () => {});
    child.on("error", (err) => add(`\n실행 실패: ${err.message}`));
    child.on("close", (code) => {
      job.state = job.canceled ? "canceled" : code === 0 ? "done" : "error";
      job.exitCode = code;
      job.waitsForCode = false;
      delete job.child;
      refreshPath();
      forgetAuth();
      this.changed();
      this.emit("finished", tool, job);
    });
    this.changed();
    return this.jobList()[tool];
  }

  install(tool) {
    const plan = installPlan(tool);
    if (!plan) throw new Error(`${TOOLS[tool].label}를 자동으로 설치할 방법이 없습니다(winget 없음). 직접 설치하세요.`);
    return this.start(tool, "install", plan.file, plan.args);
  }

  login(tool) {
    const file = this.cliPath(tool);
    if (!file) throw new Error(`${TOOLS[tool].label}가 설치되어 있지 않습니다. 먼저 설치하세요.`);
    return this.start(tool, "login", file, TOOLS[tool].login);
  }

  // 로그인 중인 CLI에 입력을 보낸다(Claude가 브라우저에서 받은 코드를 붙여 넣으라고 할 때).
  input(tool, text) {
    const job = this.jobs.get(tool);
    if (job?.state !== "running" || !job.child) throw new Error("진행 중인 로그인이 없습니다.");
    job.child.stdin.write(`${String(text).trim()}\n`);
    job.waitsForCode = false;
    this.changed();
  }

  cancel(tool) {
    const job = this.jobs.get(tool);
    if (job?.state !== "running" || !job.child) return false;
    job.canceled = true;
    if (isWindows) spawn("taskkill", ["/pid", String(job.child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    else job.child.kill("SIGTERM");
    return true;
  }
}

// 기본 브라우저로 연다. 주소는 CLI 출력에서 꺼낸 http(s) 주소뿐이다.
export function openBrowser(url) {
  if (!/^https:\/\//.test(url)) return;
  const [file, args] = isWindows ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
}

export const locate = (tool, override = "") => locateCli(tool, override);
