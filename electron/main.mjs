// AgentHub 데스크톱 앱: 메인 프로세스 안에서 로컬 서버를 띄우고 그 화면을 창에 보여 준다.
import { app, BrowserWindow, Menu, dialog, shell, clipboard, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Updater } from "./updater.mjs";
import { createClipboardFileAccess, readClipboardFiles } from "./clipboard-files.mjs";
import { createArtifactAccess } from "./artifacts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(HERE, "..", "build", "icon.ico");
const PRELOAD = path.join(HERE, "preload.cjs");
const clipboardAccess = createClipboardFileAccess(() => readClipboardFiles(clipboard));
ipcMain.handle("agenthub:clipboard-files", (event) => clipboardAccess.read(event));
const artifactAccess = createArtifactAccess({ openPath: (filename) => shell.openPath(filename), showItemInFolder: (filename) => shell.showItemInFolder(filename) });
ipcMain.handle("agenthub:open-artifact", (event, request) => artifactAccess.open(event, request));

let win = null;
let server = null;

// 설치본은 앱 폴더가 읽기 전용일 수 있으므로 사용자 데이터 폴더에 기록을 둔다.
if (app.isPackaged && !process.env.AGENTHUB_DATA) {
  process.env.AGENTHUB_DATA = path.join(app.getPath("userData"), "data");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 다시 실행하면 기존 창을 앞으로 가져온다. 창이 숨은 채 남아 있거나 없으면 보이게/새로 만든다.
  app.on("second-instance", () => {
    if (!win) {
      if (server?.port) createWindow(`http://127.0.0.1:${server.port}/`);
      return;
    }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });
  app.whenReady().then(start);
}

async function start() {
  Menu.setApplicationMenu(null);
  try {
    const { createHub } = await import("../server/bootstrap.mjs");
    server = createHub();
    await server.start();
  } catch (err) {
    const detail = err.code === "EADDRINUSE"
      ? `포트 ${server?.port ?? ""}가 이미 쓰이고 있습니다. npm start로 띄운 서버가 있다면 끄고 다시 실행하세요.`
      : String(err.stack ?? err);
    dialog.showErrorBox("AgentHub를 시작하지 못했습니다", detail);
    app.exit(1);
    return;
  }
  const updater = new Updater({
    beforeInstall: () => server.shutdown(),
    onInstallError: error => dialog.showErrorBox("기록을 저장하지 못했습니다", String(error.message ?? error)),
  });
  server.setUpdater(updater);
  createWindow(`http://127.0.0.1:${server.port}/`);
  // 시작하고 잠시 뒤, 이후 1시간마다 조용히 확인한다. 실패해도 화면의 업데이트 버튼에만 표시된다.
  if (updater.state.supported) {
    setTimeout(() => updater.check(), 5000);
    setInterval(() => updater.check(), 60 * 60 * 1000).unref(); // 켜 둔 채로 쓰는 경우를 위해 1시간마다
  }
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: "AgentHub",
    icon: ICON,
    backgroundColor: "#f6f6f4",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: PRELOAD },
  });
  win.once("ready-to-show", () => win.show());
  // 업데이트 직후 등 ready-to-show가 오지 않는 경우가 있어, 잠시 뒤에는 그냥 보여 준다.
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  }, 5000);

  guard(win.webContents, url);

  win.on("closed", () => (win = null));
  win.loadURL(url);
}

// 앱 밖으로 나가는 링크는 기본 브라우저에서 연다. 앱 안의 링크(채팅 "새 창으로")는 AgentHub 창으로 연다.
function guard(contents, base) {
  clipboardAccess.register(contents, base);
  artifactAccess.register(contents, base);
  const isLocal = (target) => target.startsWith(base);
  contents.setWindowOpenHandler(({ url: target }) => {
    if (isLocal(target)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 760,
          height: 900,
          minWidth: 420,
          minHeight: 400,
          icon: ICON,
          backgroundColor: "#0d1016",
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: PRELOAD },
        },
      };
    }
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => guard(child.webContents, base));
  contents.on("will-navigate", (event, target) => {
    if (isLocal(target)) return;
    event.preventDefault();
    if (/^https?:/.test(target)) shell.openExternal(target);
  });
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) contents.reload();
    if (input.key === "F12") contents.toggleDevTools();
  });
}

app.on("window-all-closed", () => app.quit());
let quitting = false;
app.on("before-quit", event => {
  if (quitting || !server) return;
  event.preventDefault();
  server.shutdown().then(() => { quitting = true; app.quit(); }).catch(error => {
    dialog.showErrorBox("기록을 저장하지 못했습니다", String(error.message ?? error));
  });
});
