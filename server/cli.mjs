import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const isWindows = process.platform === "win32";

// 설치 프로그램이 다시 실행한 앱처럼 환경 변수가 줄어든 채 뜨는 경우가 있어 홈 폴더 기준 값으로 보완한다.
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");

// 앱을 켠 뒤에 CLI를 설치하면 프로세스의 PATH에는 반영되지 않으므로 레지스트리의 PATH도 읽는다.
let registryPath = null;
function registryPathDirs() {
  if (!isWindows) return [];
  if (registryPath === null) {
    registryPath = [];
    for (const key of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
      try {
        const out = execFileSync("reg", ["query", key, "/v", "Path"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
        const value = out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)?.[1] ?? "";
        const expanded = value.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
        registryPath.push(...expanded.split(";").map((d) => d.trim()).filter(Boolean));
      } catch {
        // 키가 없거나 reg를 실행할 수 없으면 건너뛴다.
      }
    }
  }
  return registryPath;
}

function findIn(dirs, names) {
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // 없는 경로
      }
    }
  }
  return null;
}

function findOnPath(names, extraDirs = []) {
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    ...registryPathDirs(),
    ...(isWindows ? [path.join(APPDATA, "npm")] : []),
    ...extraDirs,
  ];
  return findIn(dirs, names);
}

// Claude 데스크톱 앱이 내려받은 Claude Code 실행 파일 중 가장 최근 것.
// 데스크톱 앱은 MSIX 패키지라 %APPDATA%\Claude가 실제로는 %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude에 있고,
// 패키지 밖에서 실행되는 AgentHub에는 그쪽 경로만 보인다.
function desktopClaudeDirs() {
  const dirs = [path.join(APPDATA, "Claude", "claude-code")];
  const packages = path.join(LOCALAPPDATA, "Packages");
  try {
    for (const name of fs.readdirSync(packages)) {
      if (/^Claude_/i.test(name)) dirs.push(path.join(packages, name, "LocalCache", "Roaming", "Claude", "claude-code"));
    }
  } catch {
    // Packages 폴더가 없는 환경
  }
  return dirs;
}

function findDesktopClaude() {
  if (!isWindows) return null;
  const found = [];
  for (const base of desktopClaudeDirs()) {
    if (!fs.existsSync(base)) continue;
    for (const version of fs.readdirSync(base)) {
      const versionDir = path.join(base, version);
      if (!fs.statSync(versionDir).isDirectory()) continue;
      for (const build of fs.readdirSync(versionDir)) {
        const exe = path.join(versionDir, build, "claude.exe");
        if (fs.existsSync(exe)) found.push({ exe, mtime: fs.statSync(exe).mtimeMs });
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.exe ?? null;
}

// 공식 설치 스크립트(~/.local/bin), npm 전역 설치, 각 앱의 기본 설치 폴더
const EXTRA_DIRS = {
  claude: [path.join(HOME, ".local", "bin"), path.join(HOME, ".claude", "local"), path.join(LOCALAPPDATA, "Programs", "claude")],
  codex: [path.join(HOME, ".local", "bin"), path.join(LOCALAPPDATA, "Programs", "codex")],
};

export function locateCli(agent, override) {
  if (override) return fs.existsSync(override) ? override : null;
  if (agent === "claude") {
    const names = isWindows ? ["claude.exe", "claude.cmd"] : ["claude"];
    return findOnPath(names, EXTRA_DIRS.claude) ?? findDesktopClaude();
  }
  if (agent === "codex") {
    const names = isWindows ? ["codex.exe", "codex.cmd"] : ["codex"];
    return findOnPath(names, EXTRA_DIRS.codex);
  }
  return null;
}

function quoteForCmd(arg) {
  if (/^[\w\-.:\\/=@]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

// Windows의 .cmd 셸 스크립트는 cmd.exe를 거쳐야 실행된다.
// 사용자 입력(프롬프트)은 항상 stdin으로 넘기므로 인자에는 검증된 값만 들어간다.
export function spawnCli(file, args, options) {
  if (isWindows && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(quoteForCmd).join(" ");
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(file, args, options);
}

const versionCache = new Map();

// CLI를 실행해 버전을 확인하는 데 몇 초 걸리므로 파일과 수정 시각 기준으로 캐시한다.
export function cliVersion(file) {
  if (!file) return Promise.resolve(null);
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  if (!versionCache.has(key)) versionCache.set(key, readVersion(file));
  return versionCache.get(key);
}

function readVersion(file) {
  return new Promise((resolve) => {
    if (!file) return resolve(null);
    let out = "";
    const child = spawnCli(file, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(out.trim().split(/\r?\n/)[0] || null));
    setTimeout(() => child.kill(), 15000);
  });
}

// ── 로그인 ──────────────────────────────────────────────────────
// 로그인 여부는 CLI를 실행해야 알 수 있어 잠시 캐시한다. 결과: true | false | null(확인 실패)
const AUTH_TTL = 60_000;
const authCache = new Map();

export function cliAuth(agent, file, { fresh = false } = {}) {
  if (!file) return Promise.resolve(null);
  const cached = authCache.get(file);
  if (!fresh && cached && Date.now() - cached.at < AUTH_TTL) return cached.promise;
  const promise = readAuth(agent, file);
  authCache.set(file, { at: Date.now(), promise });
  return promise;
}

function readAuth(agent, file) {
  const args = agent === "claude" ? ["auth", "status"] : ["login", "status"];
  return new Promise((resolve) => {
    let out = "";
    const child = spawnCli(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 15000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (agent === "claude") {
        // 로그인하지 않았으면 종료 코드 2와 함께 loggedIn: false를 낸다.
        try {
          return resolve(!!JSON.parse(out).loggedIn);
        } catch {
          return resolve(null);
        }
      }
      if (/not logged in/i.test(out)) return resolve(false);
      resolve(/logged in/i.test(out) ? true : null);
    });
  });
}

// 로그인은 브라우저 인증이라 사용자가 직접 해야 한다. CLI의 로그인 명령을 새 콘솔 창에서 열어 준다.
// 창은 끝난 뒤에도 남겨 두어 오류를 읽을 수 있게 한다.
export function openLogin(agent, file) {
  const args = agent === "claude" ? "auth login" : "login";
  authCache.delete(file);
  if (!isWindows) throw new Error(`터미널에서 직접 실행하세요: "${file}" ${args}`);
  const line = `start "AgentHub login" cmd /k ""${file}" ${args}"`;
  const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", line], {
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  });
  child.on("error", () => {});
  child.unref();
}
