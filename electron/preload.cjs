const { contextBridge, ipcRenderer } = require("electron");

let pasteExpires = 0;
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
});
