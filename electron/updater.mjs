// 앱 안에서 GitHub Releases로 업데이트한다. 저장소가 비공개이므로 토큰을 앱에 넣지 않고,
// 이 PC에 로그인된 GitHub CLI(`gh auth token`)의 토큰을 확인할 때마다 빌려 쓴다.
import { app, shell } from "electron";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import updaterPkg from "electron-updater";

const { autoUpdater } = updaterPkg;
const OWNER = "Lyeol2";
const REPO = "AgentHub";
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;

function findGh() {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  dirs.push(path.join(process.env.ProgramFiles ?? "C:\\Program Files", "GitHub CLI"));
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "GitHub CLI"));
  for (const dir of dirs) {
    const file = path.join(dir, "gh.exe");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function ghToken() {
  const gh = findGh();
  if (!gh) return Promise.reject(new Error("GitHub CLI(gh)가 없습니다. 설치한 뒤 gh auth login으로 로그인하세요."));
  return new Promise((resolve, reject) => {
    execFile(gh, ["auth", "token"], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      const token = stdout?.trim();
      if (err || !token) reject(new Error("GitHub CLI에 로그인되어 있지 않습니다. gh auth login으로 로그인하세요."));
      else resolve(token);
    });
  });
}

export class Updater extends EventEmitter {
  constructor() {
    super();
    // 포터블 실행 파일은 자기 자신을 바꿀 수 없으므로 릴리스 페이지만 열어 준다.
    this.portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
    this.state = {
      desktop: true,
      supported: app.isPackaged && !this.portable,
      portable: this.portable,
      current: app.getVersion(),
      status: "idle", // idle | checking | none | available | downloading | ready | error
      latest: null,
      progress: 0,
      error: null,
    };

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true; // 받아 둔 업데이트는 앱을 닫을 때 설치된다.
    autoUpdater.on("update-available", (info) => this.set({ status: "available", latest: info.version }));
    autoUpdater.on("update-not-available", (info) => this.set({ status: "none", latest: info.version }));
    autoUpdater.on("download-progress", (p) => this.set({ status: "downloading", progress: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (info) => this.set({ status: "ready", latest: info.version, progress: 100 }));
    autoUpdater.on("error", (err) => this.set({ status: "error", error: shortError(err) }));
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.emit("state", this.state);
  }

  async check() {
    if (this.portable) {
      shell.openExternal(RELEASES_URL);
      return this.state;
    }
    if (!this.state.supported) throw new Error("설치한 앱에서만 업데이트할 수 있습니다.");
    if (["checking", "downloading"].includes(this.state.status)) return this.state;
    this.set({ status: "checking", error: null });
    try {
      autoUpdater.setFeedURL({ provider: "github", owner: OWNER, repo: REPO, private: true, token: await ghToken() });
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.set({ status: "error", error: shortError(err) });
    }
    return this.state;
  }

  async download() {
    if (this.state.status !== "available") throw new Error("받을 업데이트가 없습니다.");
    this.set({ status: "downloading", progress: 0 });
    autoUpdater.downloadUpdate().catch((err) => this.set({ status: "error", error: shortError(err) }));
    return this.state;
  }

  install() {
    if (this.state.status !== "ready") throw new Error("설치할 업데이트가 없습니다.");
    // before-quit에서 서버가 세션을 저장한 뒤 설치 프로그램이 실행된다.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return this.state;
  }
}

// GitHub 오류 응답 전체(요청 헤더 포함)가 붙어 오므로 첫 줄만 남긴다.
function shortError(err) {
  const text = String(err?.message ?? err);
  if (/404|Not Found|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/.test(text)) return "릴리스를 찾지 못했습니다. 저장소 권한을 확인하세요.";
  if (/401|Bad credentials/.test(text)) return "GitHub 인증에 실패했습니다. gh auth login으로 다시 로그인하세요.";
  return text.split("\n")[0].slice(0, 300);
}
