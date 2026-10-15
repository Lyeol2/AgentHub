// CLI 설치와 로그인(Claude Code, Codex, GitHub CLI). 앱 안에서 진행 상황을 보여 주고, 로그인 주소·코드를 꺼내 화면에 띄운다.
// Windows에서는 winget을 먼저 준비하고, 실패하면 다른 공식 설치 방법과 수동 안내를 제공한다.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { locateCli, locateCommand, spawnCli, refreshPath, cliVersion, cliAuth, forgetAuth } from "./cli.mjs";
import { findWinget, wingetBootstrapPlan } from "./winget.mjs";

const isWindows = process.platform === "win32";

export const TOOLS = {
  claude: { label: "Claude Code", winget: "Anthropic.ClaudeCode", login: ["auth", "login"] },
  codex: { label: "Codex", winget: "OpenAI.Codex", login: ["login"] },
  gh: { label: "GitHub CLI", winget: "GitHub.cli", login: ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"] },
};

const LOG_MAX = 20000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;
const CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/;

// 출력에서 로그인 주소와 일회용 코드를 꺼낸다. 로컬 콜백 주소(localhost)는 열 필요가 없다.
export function parseLoginOutput(text) {
  const clean = text.replace(ANSI, "");
  const urls = [...clean.matchAll(URL_PATTERN)].map((m) => m[0].replace(/[.,)]+$/, "")).filter((u) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u));
  return { url: urls[0] ?? null, code: clean.match(CODE_PATTERN)?.[0] ?? null, waitsForCode: /paste code/i.test(clean) };
}

function findNpm() {
  return locateCommand(isWindows ? "npm.cmd" : "npm");
}

// 설치 방법. winget을 먼저 쓰고, 없으면 각 CLI의 다른 공식 방법을 쓴다. 방법이 없으면 null.
export function installPlan(tool, { winget = findWinget(), npm = findNpm(), windows = isWindows } = {}) {
  if (!Object.hasOwn(TOOLS, tool)) return null;
  if (winget) {
    return {
      how: "winget",
      file: winget,
      args: ["install", "--id", TOOLS[tool].winget, "--exact", "--source", "winget", "--silent",
        "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"],
    };
  }
  if (tool === "claude" && windows) {
    // Claude Code 공식 설치 스크립트(~/.local/bin에 설치)
    return { how: "install.ps1", file: wingetBootstrapPlan().file, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"] };
  }
  if (tool === "codex" && npm) return { how: "npm", file: npm, args: ["install", "-g", "@openai/codex"] };
  return null;
}

// 앱이 실행할 URL이나 명령을 사용자 입력에서 조합하지 않는다.
export const MANUAL_INSTALL = {
  winget: {
    links: [
      { label: "Microsoft Store에서 앱 설치 관리자 설치", url: "https://apps.microsoft.com/detail/9nblggh4nns1" },
      { label: "앱 설치 관리자 공식 설치 파일 다운로드", url: "https://aka.ms/getwinget" },
      { label: "Microsoft winget 설치 안내", url: "https://learn.microsoft.com/windows/package-manager/winget/" },
    ],
    command: "Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe",
    note: "앱 설치 관리자를 설치하거나 업데이트하세요. 이미 설치했는데 winget을 찾지 못하면 PowerShell에서 아래 명령으로 현재 사용자에게 다시 등록할 수 있습니다.",
  },
  claude: {
    links: [{ label: "Claude Code 공식 설치 안내", url: "https://code.claude.com/docs/en/setup" }],
    command: "irm https://claude.ai/install.ps1 | iex",
    note: "Windows PowerShell에서 공식 설치 명령을 실행하세요.",
  },
  codex: {
    links: [
      { label: "Codex CLI 공식 설치 안내", url: "https://developers.openai.com/codex/cli" },
      { label: "Node.js 공식 다운로드", url: "https://nodejs.org/en/download" },
    ],
    command: "npm install -g @openai/codex",
    note: "npm 설치를 사용하려면 먼저 Node.js LTS를 설치하고 새 터미널에서 아래 명령을 실행하세요. 공식 안내의 Windows 실행 파일도 사용할 수 있습니다.",
  },
  gh: {
    links: [{ label: "GitHub CLI 공식 다운로드", url: "https://cli.github.com/" }],
    note: "공식 페이지에서 Windows 설치 파일(.msi)을 내려받아 실행하세요.",
  },
};

// 도구마다 한 번에 하나의 작업(설치 또는 로그인)만 돈다.
export class Setup extends EventEmitter {
  constructor({ cliPath, wingetPath = findWinget, npmPath = findNpm, version = cliVersion, platform = process.platform, installTimeoutMs = INSTALL_TIMEOUT_MS }) {
    super();
    this.cliPath = cliPath; // (tool) → 실행 파일 경로(설정에서 직접 지정한 경로 포함)
    this.wingetPath = wingetPath;
    this.npmPath = npmPath;
    this.version = version;
    this.windows = platform === "win32";
    this.installTimeoutMs = installTimeoutMs;
    this.wingetPreparation = null;
    this.jobs = new Map(); // tool → { kind, state, log, url, code, waitsForCode, child }
  }

  async status({ fresh = false } = {}) {
    if (fresh) refreshPath();
    const tools = await Promise.all(Object.entries(TOOLS).map(async ([id, t]) => {
      const file = this.cliPath(id);
      const [version, loggedIn] = await Promise.all([this.version(file, { fresh }), cliAuth(id, file, { fresh })]);
      const plan = installPlan(id, { winget: this.windows ? this.wingetPath() : null, npm: this.npmPath(), windows: this.windows });
      return { id, label: t.label, path: file, version, loggedIn, installable: this.windows || !!plan, manual: MANUAL_INSTALL[id] };
    }));
    const file = this.windows ? this.wingetPath() : null;
    const winget = this.windows ? { id: "winget", label: "Windows 패키지 관리자 (winget)", path: file, version: await this.version(file, { fresh }), installable: true, manual: MANUAL_INSTALL.winget } : null;
    return { tools, winget, jobs: this.jobList() };
  }

  jobList() {
    return Object.fromEntries([...this.jobs].map(([tool, { child, ...job }]) => [tool, job]));
  }

  changed() {
    this.emit("change", this.jobList());
  }

  begin(tool, kind) {
    if (tool !== "winget" && !Object.hasOwn(TOOLS, tool)) throw new Error("없는 설치 도구입니다.");
    const running = this.jobs.get(tool);
    if (running?.state === "running") throw new Error(`${TOOLS[tool]?.label ?? "winget"} ${running.kind === "install" ? "설치" : "로그인"}가 이미 진행 중입니다.`);
    const job = { kind, state: "running", log: "", url: null, code: null, waitsForCode: false, startedAt: new Date().toISOString() };
    this.jobs.set(tool, job);
    this.changed();
    return job;
  }

  addLog(job, chunk) {
    if (job.state !== "running") return;
    job.log = (job.log + chunk.replace(ANSI, "")).split("\n").map((line) => line.split("\r").filter(Boolean).at(-1) ?? "").join("\n").slice(-LOG_MAX);
    this.changed();
  }

  finish(tool, job, code, error = null) {
    if (job.state !== "running") return;
    if (error) this.addLog(job, `\n${error.message}\n설치 창의 수동 설치 안내를 확인하세요.\n`);
    job.state = job.canceled ? "canceled" : code === 0 && !error ? "done" : "error";
    job.exitCode = code;
    job.waitsForCode = false;
    delete job.child;
    refreshPath();
    forgetAuth();
    this.changed();
    this.emit("finished", tool, { ...job });
  }

  run(tool, job, file, args) {
    if (job.canceled || job.state !== "running") return Promise.resolve(null);
    // winget 출력은 콘솔 코드 페이지를 따르므로 UTF-8로 바꿔 실행한다.
    let child;
    try {
      child = job.kind === "install" && /winget\.exe$/i.test(file)
        ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"chcp 65001 >nul & "${file}" ${args.join(" ")}"`], { windowsHide: true, windowsVerbatimArguments: true, stdio: ["pipe", "pipe", "pipe"] })
        : spawnCli(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    } catch (error) { return Promise.reject(error); }
    job.child = child;
    let opened = false;
    const add = (chunk) => {
      if (job.state !== "running") return;
      this.addLog(job, chunk);
      if (job.kind === "login") {
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
    return new Promise((resolve, reject) => {
      let ended = false;
      const done = (error, code) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (job.child === child) delete job.child;
        if (error) reject(error); else resolve(code);
      };
      const timer = job.kind === "install" ? setTimeout(() => {
        done(new Error("설치 응답을 10분 동안 받지 못했습니다. 네트워크 상태를 확인하거나 수동 설치를 사용하세요."));
        this.kill(child);
      }, this.installTimeoutMs) : null;
      timer?.unref?.();
      child.once("error", (error) => done(error));
      child.once("close", (code) => done(null, code));
    });
  }

  start(tool, kind, file, args) {
    const job = this.begin(tool, kind);
    this.run(tool, job, file, args).then((code) => this.finish(tool, job, code), (error) => this.finish(tool, job, null, error));
    return this.jobList()[tool];
  }

  prepareWinget() {
    if (this.wingetPreparation) return this.wingetPreparation;
    if (!this.windows) throw new Error("winget은 Windows에서만 설치할 수 있습니다.");
    const plan = wingetBootstrapPlan();
    const job = this.begin("winget", "install");
    const promise = (async () => {
      this.addLog(job, "현재 사용자용 winget을 등록하거나 설치합니다.\n");
      const code = await this.run("winget", job, plan.file, plan.args);
      if (job.canceled) throw new Error("winget 준비를 취소했습니다.");
      if (code !== 0) throw new Error(`winget 준비에 실패했습니다 (종료 코드 ${code}).`);
      refreshPath();
      const file = this.wingetPath();
      if (!file || !await this.version(file, { fresh: true })) throw new Error("설치가 끝났지만 winget 실행을 확인하지 못했습니다.");
      this.finish("winget", job, 0);
      return file;
    })().catch((error) => {
      this.finish("winget", job, null, error);
      throw error;
    }).finally(() => {
      if (this.wingetPreparation?.job === job) this.wingetPreparation = null;
    });
    this.wingetPreparation = { job, promise };
    promise.catch(() => {}); // winget만 설치한 경우에도 오류는 작업 상태로 보고한다.
    return this.wingetPreparation;
  }

  async ensureWinget(requestJob) {
    if (this.wingetPreparation) return this.wingetPreparation.promise;
    const file = this.wingetPath();
    if (file && await this.version(file, { fresh: true })) return file;
    if (requestJob?.canceled || requestJob?.state !== "running") return null;
    return this.prepareWinget().promise;
  }

  async installCli(tool, job) {
    let winget = null;
    if (this.windows) {
      this.addLog(job, "winget을 확인하고, 없거나 실행할 수 없으면 먼저 준비합니다.\n");
      try { winget = await this.ensureWinget(job); }
      catch (error) { this.addLog(job, `winget 준비 실패: ${error.message}\n다른 공식 설치 방법을 확인합니다.\n`); }
    }
    if (job.canceled || job.state !== "running") return;
    const options = { winget, npm: this.npmPath(), windows: this.windows };
    const plan = installPlan(tool, options);
    if (!plan) throw new Error(`${TOOLS[tool].label}의 자동 설치를 진행할 수 없습니다. 공식 다운로드를 이용해 수동 설치하세요.`);
    this.addLog(job, `${plan.how}으로 ${TOOLS[tool].label} 설치를 시작합니다.\n`);
    let code;
    try { code = await this.run(tool, job, plan.file, plan.args); }
    catch (error) { this.addLog(job, `설치 명령 실행 실패: ${error.message}\n`); code = null; }
    if (job.canceled || job.state !== "running") return;
    refreshPath();
    let installed = await this.version(this.cliPath(tool), { fresh: true });
    if (!installed && plan.how === "winget" && code !== 0) {
      const fallback = installPlan(tool, { ...options, winget: null });
      if (fallback) {
        this.addLog(job, `winget 설치 실패 (종료 코드 ${code}). ${fallback.how}으로 다시 설치합니다.\n`);
        code = await this.run(tool, job, fallback.file, fallback.args);
        if (job.canceled || job.state !== "running") return;
        refreshPath();
        installed = await this.version(this.cliPath(tool), { fresh: true });
      }
    }
    if (!installed) throw new Error(`설치 후 ${TOOLS[tool].label} 실행을 확인하지 못했습니다 (종료 코드 ${code}). 설치 경로를 확인하고 다시 확인하거나 수동 설치를 사용하세요.`);
    this.addLog(job, `실행 확인: ${installed}\n`);
    this.finish(tool, job, 0);
  }

  install(tool) {
    if (tool === "winget") {
      if (this.jobs.get(tool)?.state === "running") throw new Error("winget 설치가 이미 진행 중입니다.");
      this.prepareWinget();
      return this.jobList()[tool];
    }
    const job = this.begin(tool, "install");
    this.installCli(tool, job).catch((error) => this.finish(tool, job, null, error));
    return this.jobList()[tool];
  }

  login(tool) {
    if (!Object.hasOwn(TOOLS, tool)) throw new Error("로그인할 수 없는 도구입니다.");
    const file = this.cliPath(tool);
    if (!file) throw new Error(`${TOOLS[tool].label}가 설치되어 있지 않습니다. 먼저 설치하세요.`);
    return this.start(tool, "login", file, TOOLS[tool].login);
  }

  // 로그인 중인 CLI에 입력을 보낸다(Claude가 브라우저에서 받은 코드를 붙여 넣으라고 할 때).
  input(tool, text) {
    const job = this.jobs.get(tool);
    if (job?.state !== "running" || job.kind !== "login" || !job.child) throw new Error("진행 중인 로그인이 없습니다.");
    job.child.stdin.write(`${String(text).trim()}\n`);
    job.waitsForCode = false;
    this.changed();
  }

  cancel(tool) {
    const job = this.jobs.get(tool);
    if (job?.state !== "running") return false;
    job.canceled = true;
    if (job.child) this.kill(job.child);
    this.finish(tool, job, null);
    return true;
  }

  kill(child) {
    if (this.windows && Number.isInteger(child.pid)) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    else child.kill("SIGTERM");
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
