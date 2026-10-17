const { contextBridge, ipcRenderer } = require("electron");

let pasteExpires = 0;
let artifactExpires = 0;
window.addEventListener("click", (event) => {
  if (event.isTrusted) artifactExpires = Date.now() + 1500;
}, true);
window.addEventListener("paste", (event) => {
  if (event.isTrusted) pasteExpires = Date.now() + 1500;
}, true);
window.addEventListener("keydown", (event) => {
  const paste = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
  const insert = event.shiftKey && event.key === "Insert";
  if (event.isTrusted && !event.altKey && !event.isComposing && (paste || insert)) {
    pasteExpires = Date.now() + 1500;
  }
}, true);

contextBridge.exposeInMainWorld("agenthubDesktop", {
  readClipboardFiles: () => {
    if (pasteExpires <= Date.now()) return Promise.resolve([]);
    pasteExpires = 0;
    return ipcRenderer.invoke("agenthub:clipboard-files");
  },
  openArtifact: (request) => {
    if (artifactExpires <= Date.now()) return Promise.reject(new Error("파일 열기 버튼을 눌러 주세요."));
    artifactExpires = 0;
    return ipcRenderer.invoke("agenthub:open-artifact", {
      sessionId: request?.sessionId, path: request?.path, action: request?.action,
    });
  },
});
