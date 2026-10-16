// CLI 설치와 로그인(Claude Code, Codex, GitHub CLI). 앱 안에서 진행 상황을 보여 주고, 로그인 주소·코드를 꺼내 화면에 띄운다.
// Windows에서는 winget을 먼저 준비하고, 실패하면 다른 공식 설치 방법과 수동 안내를 제공한다.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { locateCli, locateCommand, spawnCli, refreshPath, cliVersion, cliAuth, forgetAuth } from "./cli.mjs";
import { findWinget, installedWingetPaths, resolveWinget, wingetBootstrapPlan } from "./winget.mjs";

const isWindows = process.platform === "win32";

export const TOOLS = {
  claude: { label: "Claude Code", winget: "Anthropic.ClaudeCode", login: ["auth", "login"] },
  codex: { label: "Codex", winget: "OpenAI.Codex", login: ["login"] },
  gh: { label: "GitHub CLI", winget: "GitHub.cli", login: ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"] },
};

const LOG_MAX = 20000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
// APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE (winget's signed/unsigned HRESULT).
const WINGET_NO_UPDATE = 0x8a15002b;
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

function smallFile(file) {
  try { return fs.statSync(file).size <= 128_000 ? fs.readFileSync(file, "utf8") : ""; }
  catch { return ""; }
}

// Resolve the selected executable, not whichever package manager happens to be installed.
// Unrecognized wrappers, desktop-managed copies and custom binaries must keep their owner.
export function updateInstallation(tool, file, { windows = isWindows, homeDir = os.homedir() } = {}) {
  if (!["claude", "codex"].includes(tool)) return { reason: "Claude Code와 Codex만 업데이트할 수 있습니다." };
  if (!file) return { reason: "먼저 CLI를 설치하세요." };
  let resolved;
  try { resolved = fs.realpathSync(file); } catch { return { reason: "선택한 CLI 실행 파일을 확인할 수 없습니다. 경로를 다시 확인하세요." }; }
  const paths = windows ? path.win32 : path.posix;
  const normalized = (value) => paths.normalize(value).replaceAll("\\", "/");
  const original = normalized(file), actual = normalized(resolved);
  if (windows && actual.toLowerCase().includes(`/winget/packages/${TOOLS[tool].winget.toLowerCase()}_`)) return { how: "winget" };
  if (tool === "codex" || tool === "claude") {
    const packageName = tool === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
    const packageMatch = actual.match(tool === "codex"
      ? /^(.*)\/node_modules\/@openai\/(codex(?:-(?:win32|linux|darwin)-(?:x64|arm64))?)(?:\/|$)/i
      : /^(.*)\/node_modules\/@anthropic-ai\/claude-code(?:\/|$)/i);
    let modulesRoot = packageMatch ? packageMatch[1] : null;
    if (!modulesRoot && new RegExp(`(?:^|/)${tool}(?:\\.cmd|\\.bat|\\.ps1)?$`, "i").test(original)) {
      const shim = smallFile(file).replaceAll("\\", "/");
      if (shim.includes(`node_modules/${packageName}/${tool === "codex" ? "bin/codex.js" : "cli.js"}`)) modulesRoot = normalized(paths.dirname(file));
    }
    if (modulesRoot) {
      try {
        const metadata = JSON.parse(smallFile(paths.join(modulesRoot, "node_modules", packageName, "package.json")));
        if (metadata.name === packageName) {
          if (tool === "claude") return { how: "claude" };
          const prefix = !windows && paths.basename(modulesRoot) === "lib" ? paths.dirname(modulesRoot) : modulesRoot;
          return { how: "npm", prefix: paths.normalize(prefix) };
        }
      } catch {}
    }
  }
  if (tool === "claude") {
    const key = (value) => windows ? normalized(value).toLowerCase() : normalized(value);
    const native = paths.join(homeDir, ".local", "bin", windows ? "claude.exe" : "claude");
    const versions = key(paths.join(homeDir, ".local", "share", "claude", "versions")) + "/";
    if (key(file) === key(native) && (key(resolved) === key(native) || key(resolved).startsWith(versions))) return { how: "native" };
  }
  return { reason: "이 CLI의 설치 방식을 확인할 수 없습니다. 직접 지정한 파일이나 다른 앱이 관리하는 CLI는 기존 설치 방법으로 업데이트하세요." };
}

export function updatePlan(tool, file, { installation = updateInstallation(tool, file), winget = findWinget(), npm = findNpm() } = {}) {
  if (installation.reason) return installation;
  if (installation.how === "winget") return winget ? {
    how: "winget", file: winget,
    args: ["upgrade", "--id", TOOLS[tool].winget, "--exact", "--source", "winget", "--silent",
      "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"],
  } : { reason: "현재 CLI를 설치한 winget을 실행할 수 없습니다. winget을 복구한 뒤 다시 확인하세요." };
  if (installation.how === "npm") return npm ? {
    how: "npm", file: npm, args: ["install", "-g", "@openai/codex@latest", "--prefix", installation.prefix],
  } : { reason: "현재 CLI를 설치한 npm을 찾지 못했습니다. Node.js와 npm 경로를 확인하세요." };
  // No channel argument: Claude keeps the user's configured stable/latest channel.
  return { how: installation.how, file, args: ["update"] };
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

// 도구마다 한 번에 하나의 작업(설치·업데이트·로그인)만 돈다.
export class Setup extends EventEmitter {
  constructor({ cliPath, wingetPath = findWinget, wingetPackages = installedWingetPaths, npmPath = findNpm, version = cliVersion, auth = cliAuth, platform = process.platform, installTimeoutMs = INSTALL_TIMEOUT_MS, updateTimeoutMs = installTimeoutMs, isBusy = () => false, homeDir = os.homedir() }) {
    super();
    this.cliPath = cliPath; // (tool) → 실행 파일 경로(설정에서 직접 지정한 경로 포함)
    this.wingetPath = wingetPath;
    this.wingetPackages = wingetPackages;
    this.npmPath = npmPath;
    this.version = version;
    this.auth = auth;
    this.windows = platform === "win32";
    this.installTimeoutMs = installTimeoutMs;
    this.updateTimeoutMs = updateTimeoutMs;
    this.isBusy = isBusy;
    this.homeDir = homeDir;
    this.wingetPreparation = null;
    this.stopRuns = new WeakMap();
    this.jobs = new Map(); // tool → { kind, state, log, url, code, waitsForCode, child }
  }

  async status({ fresh = false } = {}) {
    if (fresh) refreshPath();
    const wingetState = this.windows ? await this.detectWinget({ fresh }) : null;
    const tools = await Promise.all(Object.entries(TOOLS).map(async ([id, t]) => {
      const file = this.cliPath(id);
      const [version, loggedIn] = await Promise.all([this.version(file, { fresh }), this.auth(id, file, { fresh })]);
      const plan = installPlan(id, { winget: wingetState?.version ? wingetState.path : null, npm: this.npmPath(), windows: this.windows });
      const update = ["claude", "codex"].includes(id)
        ? updatePlan(id, file, { installation: updateInstallation(id, file, this), winget: wingetState?.version ? wingetState.path : null, npm: this.npmPath() }) : null;
      return { id, label: t.label, path: file, version, loggedIn, installable: this.windows || !!plan, manual: MANUAL_INSTALL[id],
        ...(update ? { updatable: Boolean(version && !update.reason), updateReason: update.reason ?? (version ? null : "CLI 실행을 확인하지 못했습니다. 다시 확인하세요.") } : {}) };
    }));
    const winget = wingetState ? { id: "winget", label: "Windows 패키지 관리자 (winget)", ...wingetState, installable: true, manual: MANUAL_INSTALL.winget } : null;
    return { tools, winget, jobs: this.jobList() };
  }

  detectWinget(options = {}) {
    return resolveWinget({ ...options, find: this.wingetPath, version: this.version, packagePaths: this.wingetPackages });
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
    if (running?.state === "running") throw new Error(`${TOOLS[tool]?.label ?? "winget"} ${running.kind === "install" ? "설치" : running.kind === "update" ? "업데이트" : "로그인"}가 이미 진행 중입니다.`);
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
    if (error) {
      job.error = error.message;
      if (error.code) job.errorCode = error.code;
      this.addLog(job, `\n${error.message}\n${job.kind === "update" ? "다시 확인한 뒤 업데이트를 재시도하세요." : "설치 창의 수동 설치 안내를 확인하세요."}\n`);
    }
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
    if (job.kind === "update" && this.isBusy(tool)) return Promise.reject(this.busyError(tool));
    // winget 출력은 콘솔 코드 페이지를 따르므로 UTF-8로 바꿔 실행한다.
    let child;
    try {
      child = ["install", "update"].includes(job.kind) && /winget\.exe$/i.test(file)
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
        this.stopRuns.delete(job);
        if (job.child === child) delete job.child;
        if (error) reject(error); else resolve(code);
      };
      const timer = ["install", "update"].includes(job.kind) ? setTimeout(() => {
        done(new Error(job.kind === "update" ? "업데이트 응답 시간이 초과되었습니다. 네트워크 상태를 확인하고 다시 시도하세요." : "설치 응답을 10분 동안 받지 못했습니다. 네트워크 상태를 확인하거나 수동 설치를 사용하세요."));
        this.kill(child);
      }, job.kind === "update" ? this.updateTimeoutMs : this.installTimeoutMs) : null;
      timer?.unref?.();
      this.stopRuns.set(job, () => done(null, null));
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
      const found = await this.detectWinget({ fresh: true });
      if (!found.version) throw new Error("설치가 끝났지만 winget 실행을 확인하지 못했습니다.");
      this.finish("winget", job, 0);
      return found.path;
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
    const found = await this.detectWinget({ fresh: true });
    if (found.version) return found.path;
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

  isUpdating(tool) {
    const job = this.jobs.get(tool);
    return job?.kind === "update" && job.state === "running";
  }

  busyError(tool) {
    return Object.assign(new Error(`${TOOLS[tool]?.label ?? tool} 세션이 실행 중입니다. 세션이 끝난 뒤 업데이트하세요.`), { code: "CLI_BUSY" });
  }

  update(tool, { automatic = false } = {}) {
    if (!["claude", "codex"].includes(tool)) throw new Error("Claude Code와 Codex만 업데이트할 수 있습니다.");
    if (this.isBusy(tool)) throw this.busyError(tool);
    const file = this.cliPath(tool);
    const installation = updateInstallation(tool, file, this);
    if (installation.reason) throw new Error(installation.reason);
    const job = this.begin(tool, "update");
    job.automatic = automatic === true;
    this.updateCli(tool, job, file, installation).catch((error) => this.finish(tool, job, job.exitCode ?? null, error));
    return this.jobList()[tool];
  }

  async updateCli(tool, job, file, installation) {
    const winget = installation.how === "winget" ? await this.detectWinget({ fresh: true }) : null;
    if (job.canceled || job.state !== "running") return;
    const plan = updatePlan(tool, file, { installation, winget: winget?.version ? winget.path : null, npm: this.npmPath() });
    if (plan.reason) throw new Error(plan.reason);
    // Config may change while probing the package manager; never update the old selection.
    if (this.cliPath(tool) !== file) throw new Error("CLI 경로가 변경되었습니다. 다시 확인한 뒤 업데이트하세요.");
    this.addLog(job, `${plan.how}으로 ${TOOLS[tool].label} 업데이트를 시작합니다.\n`);
    const code = await this.run(tool, job, plan.file, plan.args);
    if (job.canceled || job.state !== "running") return;
    job.exitCode = code;
    const noUpdate = plan.how === "winget" && Number.isInteger(code) && (code >>> 0) === WINGET_NO_UPDATE;
    if (code !== 0 && !noUpdate) throw new Error(`업데이트에 실패했습니다 (종료 코드 ${code}).`);
    refreshPath();
    const updated = await this.version(file, { fresh: true });
    if (job.canceled || job.state !== "running") return;
    if (!updated) throw new Error("업데이트 후 CLI 실행을 확인하지 못했습니다. 설치 경로를 확인하고 다시 시도하세요.");
    job.version = updated;
    if (noUpdate) this.addLog(job, "적용할 업데이트가 없습니다.\n");
    this.addLog(job, `실행 확인: ${updated}\n`);
    this.finish(tool, job, 0);
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
    const child = job.child;
    this.stopRuns.get(job)?.();
    if (this.wingetPreparation?.job === job) this.wingetPreparation = null;
    if (child) this.kill(child);
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
