// AgentHub 데스크톱 앱: 메인 프로세스 안에서 로컬 서버를 띄우고 그 화면을 창에 보여 준다.
import { app, BrowserWindow, Menu, dialog, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(HERE, "..", "build", "icon.ico");

let win = null;
let server = null;

// 설치본은 앱 폴더가 읽기 전용일 수 있으므로 사용자 데이터 폴더에 기록을 둔다.
if (app.isPackaged && !process.env.AGENTHUB_DATA) {
  process.env.AGENTHUB_DATA = path.join(app.getPath("userData"), "data");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start);
}

async function start() {
  Menu.setApplicationMenu(null);
  try {
    server = await import("../server/index.mjs");
    await server.listening;
  } catch (err) {
    const detail = err.code === "EADDRINUSE"
      ? `포트 ${server?.port ?? ""}가 이미 쓰이고 있습니다. npm start로 띄운 서버가 있다면 끄고 다시 실행하세요.`
      : String(err.stack ?? err);
    dialog.showErrorBox("AgentHub를 시작하지 못했습니다", detail);
    app.exit(1);
    return;
  }
  createWindow(`http://127.0.0.1:${server.port}/`);
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());

  // 앱 밖으로 나가는 링크는 기본 브라우저에서 연다.
  const isLocal = (target) => target.startsWith(url);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (isLocal(target)) return;
    event.preventDefault();
    if (/^https?:/.test(target)) shell.openExternal(target);
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) win.reload();
    if (input.key === "F12") win.webContents.toggleDevTools();
  });

  win.on("closed", () => (win = null));
  win.loadURL(url);
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => server?.shutdown?.());
