import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

function findOnPath(names) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (isWindows && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

// Claude 데스크톱 앱이 내려받은 Claude Code 실행 파일 중 가장 최근 것.
function findDesktopClaude() {
  if (!isWindows || !process.env.APPDATA) return null;
  const base = path.join(process.env.APPDATA, "Claude", "claude-code");
  if (!fs.existsSync(base)) return null;
  const found = [];
  for (const version of fs.readdirSync(base)) {
    const versionDir = path.join(base, version);
    if (!fs.statSync(versionDir).isDirectory()) continue;
    for (const build of fs.readdirSync(versionDir)) {
      const exe = path.join(versionDir, build, "claude.exe");
      if (fs.existsSync(exe)) found.push({ exe, mtime: fs.statSync(exe).mtimeMs });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.exe ?? null;
}

export function locateCli(agent, override) {
  if (override) return fs.existsSync(override) ? override : null;
  if (agent === "claude") {
    const names = isWindows ? ["claude.exe", "claude.cmd"] : ["claude"];
    return findOnPath(names) ?? findDesktopClaude();
  }
  if (agent === "codex") {
    const names = isWindows ? ["codex.exe", "codex.cmd"] : ["codex"];
    return findOnPath(names);
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
