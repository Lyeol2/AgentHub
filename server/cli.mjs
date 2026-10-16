import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const isWindows = process.platform === "win32";

// 설치 프로그램이 다시 실행한 앱처럼 환경 변수가 줄어든 채 뜨는 경우가 있어 홈 폴더 기준 값으로 보완한다.
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");

// 앱 실행 후 설치한 CLI와 npm shim이 쓰는 Node도 같은 최신 PATH에서 찾는다.
let registryPath = null;
let registryAt = 0;
const PATH_TTL = 30_000;
const envValue = (env, name) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const fallbackEnv = { USERPROFILE: HOME, HOME, APPDATA, LOCALAPPDATA };
const systemFile = (name) => path.join(envValue(process.env, "SystemRoot") || "C:\\Windows", "System32", name);

export function normalizeCliPath(value) {
  let result = String(value ?? "").trim();
  if (result.startsWith('"') && result.endsWith('"')) result = result.slice(1, -1).trim();
  result = result.replace(/%([^%]+)%/g, (match, name) => envValue(process.env, name) ?? envValue(fallbackEnv, name) ?? match);
  if (/^~(?:[\\/]|$)/.test(result)) result = HOME + result.slice(1);
  return result;
}

export function isCliFile(file) {
  if (!file || (isWindows && !/\.(exe|com|cmd|bat)$/i.test(file))) return false;
  try { return fs.statSync(file).isFile(); }
  catch (error) {
    // WindowsApps의 실행 별칭(winget.exe 등)은 stat이 EACCES로 실패하지만 실행은 된다.
    if (!isWindows || error.code !== "EACCES") return false;
    try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
  }
}

// reg·where 같은 Windows 기본 명령은 UTF-8이 아니라 콘솔 코드페이지(한국어 Windows는 cp949)로 출력한다.
const OEM_ENCODINGS = { 949: "euc-kr", 932: "shift_jis", 936: "gbk", 950: "big5", 65001: "utf-8" };
let oemDecoder;
function oemEncoding() {
  try {
    const out = execFileSync(systemFile("reg.exe"), ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "OEMCP"],
      { encoding: "latin1", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return OEM_ENCODINGS[out.match(/OEMCP\s+REG_SZ\s+(\d+)/i)?.[1]] ?? "windows-1252";
  } catch {
    return "windows-1252";
  }
}
export function decodeConsole(bytes) {
  if (typeof bytes === "string") return bytes;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch {
    oemDecoder ??= new TextDecoder(oemEncoding());
    return oemDecoder.decode(bytes);
  }
}

// 작업 폴더가 없으면 Windows는 실행 파일을 못 찾은 것처럼 ENOENT를 낸다. 진짜 원인을 알려 준다.
export function missingFolder(error, cwd) {
  if (error?.code !== "ENOENT" || !cwd) return null;
  try { if (fs.statSync(cwd).isDirectory()) return null; } catch {}
  return `작업 폴더가 없습니다: ${cwd} (폴더를 옮겼거나 지웠는지, 드라이브가 연결되어 있는지 확인하세요)`;
}

// cmd.exe나 npm shim을 거쳐 실행한 자식 프로세스까지 함께 끝낸다.
export function killProcessTree(pid) {
  spawn(systemFile("taskkill.exe"), ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
}

function registryPathDirs() {
  if (!isWindows) return [];
  if (registryPath === null || Date.now() - registryAt >= PATH_TTL) {
    registryPath = [];
    registryAt = Date.now();
    const reg = systemFile("reg.exe");
    for (const key of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
      try {
        const out = decodeConsole(execFileSync(reg, ["query", key, "/v", "Path"], { windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }));
        const value = out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)?.[1] ?? "";
        registryPath.push(...value.split(";").map(normalizeCliPath).filter(Boolean));
      } catch {
        // 키가 없거나 reg를 실행할 수 없으면 알려진 설치 폴더도 찾는다.
      }
    }
  }
  return registryPath;
}

function pathDirs(env = process.env) {
  const entries = [
    ...(envValue(env, "PATH") ?? "").split(path.delimiter),
    ...registryPathDirs(),
    ...(isWindows ? [path.join(APPDATA, "npm"), path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs"), path.join(LOCALAPPDATA, "Programs", "nodejs")] : []),
    envValue(env, "NPM_CONFIG_PREFIX"),
  ];
  const seen = new Set();
  return entries.filter(Boolean).map(normalizeCliPath).filter((dir) => {
    const key = isWindows ? dir.toLowerCase() : dir;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findIn(dirs, names) {
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isCliFile(candidate)) return candidate;
    }
  }
  return null;
}

export function locateCommand(names, extraDirs = []) {
  return findIn([...pathDirs(), ...extraDirs], Array.isArray(names) ? names : [names]);
}

function findOnPath(names, extraDirs = []) {
  return locateCommand(names, extraDirs);
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
  const directories = (dir) => {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name)); }
    catch { return []; } // 자동 업데이트·삭제 중이거나 접근할 수 없는 버전은 건너뛴다.
  };
  for (const base of desktopClaudeDirs()) {
    for (const versionDir of directories(base)) {
      for (const build of directories(versionDir)) {
        const exe = path.join(build, "claude.exe");
        try { if (fs.statSync(exe).isFile()) found.push({ exe, mtime: fs.statSync(exe).mtimeMs }); } catch {}
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.exe ?? null;
}

// 공식 설치 스크립트(~/.local/bin), npm 전역 설치, 각 앱의 기본 설치 폴더
// winget으로 설치한 실행 파일은 WinGet\Links에 바로 가기가 생긴다.
const WINGET_LINKS = path.join(LOCALAPPDATA, "Microsoft", "WinGet", "Links");
const EXTRA_DIRS = {
  claude: [path.join(HOME, ".local", "bin"), path.join(HOME, ".claude", "local"), path.join(LOCALAPPDATA, "Programs", "claude"), WINGET_LINKS],
  codex: [path.join(HOME, ".local", "bin"), path.join(LOCALAPPDATA, "Programs", "codex"), WINGET_LINKS],
  gh: [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "GitHub CLI"), path.join(LOCALAPPDATA, "Programs", "GitHub CLI"), WINGET_LINKS],
};

// 앱을 켠 뒤 설치한 CLI도 찾도록 레지스트리 PATH를 다시 읽게 한다.
export function refreshPath() {
  registryPath = null;
  versionCache.clear();
  authCache.clear();
}

export function locateCli(agent, override) {
  if (override) {
    const file = normalizeCliPath(override);
    return isCliFile(file) ? file : null;
  }
  if (agent === "claude") {
    const names = isWindows ? ["claude.exe", "claude.cmd"] : ["claude"];
    return findOnPath(names, EXTRA_DIRS.claude) ?? findDesktopClaude();
  }
  if (agent === "codex") {
    const names = isWindows ? ["codex.exe", "codex.cmd"] : ["codex"];
    return findOnPath(names, EXTRA_DIRS.codex);
  }
  if (agent === "gh") return findOnPath(isWindows ? ["gh.exe"] : ["gh"], EXTRA_DIRS.gh);
  return null;
}

function quoteForCmd(arg) {
  if (/^[\w\-.:\\/=@]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

// Windows의 .cmd 셸 스크립트는 cmd.exe를 거쳐야 실행된다.
// 사용자 입력(프롬프트)은 항상 stdin으로 넘기므로 인자에는 검증된 값만 들어간다.
export function spawnCli(file, args, options = {}) {
  // 레지스트리에서 발견한 .cmd도 새 Node 설치 경로를 물려받아야 실행된다.
  const env = { ...(options.env ?? process.env) };
  const dirs = pathDirs(env);
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = dirs.join(path.delimiter);
  options = { ...options, env };
  if (isWindows && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(quoteForCmd).join(" ");
    return spawn(envValue(process.env, "ComSpec") || systemFile("cmd.exe"), ["/d", "/s", "/c", `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(file, args, options);
}

const versionCache = new Map();
const authCache = new Map();
const PROBE_TTL = 60_000;
const PROBE_TIMEOUT = 15_000;

function fileKey(file) {
  if (!isCliFile(file)) return null;
  try { const stat = fs.statSync(file); return file + ":" + stat.mtimeMs + ":" + stat.size; }
  catch { return null; }
}

// 실행 실패·시간 초과는 저장하지 않는다. npm shim은 그대로인 채 본체만 업데이트될 수 있어 성공도 잠시만 캐시한다.
function cachedProbe(cache, key, fresh, read) {
  if (!key) return Promise.resolve(null);
  const cached = cache.get(key);
  if (!fresh && cached && Date.now() - cached.at < PROBE_TTL) return cached.promise;
  const entry = { at: Date.now(), promise: null };
  entry.promise = read().then((result) => {
    if (result === null && cache.get(key) === entry) cache.delete(key);
    return result;
  });
  cache.set(key, entry);
  return entry.promise;
}

// 프로세스가 close를 보내지 못해도 정해진 시간 안에 확인을 마친다.
function probe(file, args) {
  return new Promise((resolve) => {
    let child, timer, output = "", stdout = "", stderr = "", done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code === null ? null : { code, output: output.trim(), stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const stop = () => {
      finish(null);
      if (isWindows && child?.pid) killProcessTree(child.pid);
      else child?.kill();
    };
    try {
      child = spawnCli(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const add = (data) => { output = (output + data).slice(-64_000); };
      child.stdout.on("data", (data) => { stdout = (stdout + data).slice(-64_000); add(data); });
      child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-64_000); add(data); });
      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code));
      timer = setTimeout(stop, PROBE_TIMEOUT);
      timer.unref?.();
    } catch { finish(null); }
  });
}

export function cliVersion(file, { fresh = false } = {}) {
  return cachedProbe(versionCache, fileKey(file), fresh, async () => {
    const result = await probe(file, ["--version"]);
    if (result?.code !== 0) return null;
    // 경고가 stderr에 먼저 나와도 그것을 CLI 버전으로 표시하지 않는다.
    const lines = (result.stdout || result.stderr).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
    return lines.find((line) => !/^\s*(warning|error)\b/i.test(line) && /\bv?\d+\.\d+(?:\.\d+)?\b/.test(line))?.trim() ?? null;
  });
}

// 로그인 여부: true | false | null(실행·출력 확인 실패)
export function cliAuth(agent, file, { fresh = false } = {}) {
  const identity = fileKey(file);
  return cachedProbe(authCache, identity && agent + ":" + identity, fresh, async () => {
    const result = await probe(file, agent === "codex" ? ["login", "status"] : ["auth", "status"]);
    if (!result) return null;
    const out = result.output;
    if (agent === "claude") {
      try {
        const loggedIn = JSON.parse(result.stdout || out).loggedIn;
        return typeof loggedIn === "boolean" && (!loggedIn || result.code === 0) ? loggedIn : null;
      } catch { return null; }
    }
    if (/not logged in(?:to)?/i.test(out)) return false;
    return result.code === 0 && /logged in(?: to)?/i.test(out) ? true : null;
  });
}

// 설치·로그인이 끝나면 다음 확인 때 다시 묻는다.
export function forgetAuth() {
  authCache.clear();
}

// 로그인은 브라우저 인증이라 사용자가 직접 해야 한다. CLI의 로그인 명령을 새 콘솔 창에서 열어 준다.
// 창은 끝난 뒤에도 남겨 두어 오류를 읽을 수 있게 한다.
export function openLogin(agent, file) {
  const args = agent === "claude" ? "auth login" : "login";
  forgetAuth();
  if (!isWindows) throw new Error(`터미널에서 직접 실행하세요: "${file}" ${args}`);
  const line = `start "AgentHub login" cmd /k ""${file}" ${args}"`;
  const child = spawnCli(envValue(process.env, "ComSpec") || systemFile("cmd.exe"), ["/d", "/c", line], {
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  });
  child.on("error", () => {});
  child.unref();
}
