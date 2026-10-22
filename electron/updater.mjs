// 앱 안에서 GitHub Releases로 업데이트한다. 저장소가 공개라서 토큰 없이 누구나 받을 수 있다.
import { app, shell } from "electron";
import { EventEmitter } from "node:events";
import updaterPkg from "electron-updater";
import { createUpdateInstall } from "./update-install.mjs";

const { autoUpdater } = updaterPkg;
const OWNER = "Lyeol2";
const REPO = "AgentHub";
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;

export class Updater extends EventEmitter {
  constructor({ beforeInstall = async () => {}, onInstallError = () => {} } = {}) {
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

    // 새 버전을 찾으면 바로 백그라운드에서 받는다. 받아 둔 업데이트는 앱을 닫을 때 설치 창 없이 설치된다.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-available", (info) => this.set({ status: "downloading", latest: info.version, progress: 0 }));
    autoUpdater.on("update-not-available", (info) => this.set({ status: "none", latest: info.version }));
    autoUpdater.on("download-progress", (p) => this.set({ status: "downloading", progress: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (info) => this.set({ status: "ready", latest: info.version, progress: 100 }));
    autoUpdater.on("error", (err) => this.set({ status: "error", error: shortError(err) }));
    this.beginInstall = createUpdateInstall({
      prepare: beforeInstall,
      install: () => autoUpdater.quitAndInstall(true, true),
      onError: (error) => {
        this.set({ status: "error", error: shortError(error) });
        onInstallError(error);
      },
    });
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
    if (["checking", "downloading", "ready"].includes(this.state.status)) return this.state;
    this.set({ status: "checking", error: null });
    try {
      autoUpdater.setFeedURL({ provider: "github", owner: OWNER, repo: REPO });
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
    // quitAndInstall은 before-quit보다 먼저 설치 프로그램을 띄운다.
    // 응답을 먼저 보내고 세션 저장이 끝난 뒤 설치 창 없이 실행한다.
    this.beginInstall();
    return this.state;
  }
}

// GitHub 오류 응답 전체(요청 헤더 포함)가 붙어 오므로 첫 줄만 남긴다.
function shortError(err) {
  const text = String(err?.message ?? err);
  if (/404|Not Found|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/.test(text)) return "릴리스를 찾지 못했습니다.";
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|net::ERR_/.test(text)) return "GitHub에 연결하지 못했습니다. 인터넷 연결을 확인하세요.";
  return text.split("\n")[0].slice(0, 300);
}
