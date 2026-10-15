import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_CLIPBOARD_FILES = 4;
export const MAX_CLIPBOARD_FILE_BYTES = 10 * 1024 * 1024;
const MAX_URI_LIST_BYTES = 128 * 1024;
const PASTE_WINDOW_MS = 1500;
const MIME_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain",
  ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
};

// Electron 44 maps native copied files (Windows CF_HDROP) to this URI list.
// Plain text that happens to contain a file path is never opened.
export function parseClipboardFileUris(text) {
  if (Buffer.byteLength(text, "utf8") > MAX_URI_LIST_BYTES) throw new Error("클립보드의 파일 목록이 너무 큽니다.");
  const files = [], seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const uri = line.trim();
    if (!uri || uri.startsWith("#") || !/^file:/i.test(uri)) continue;
    let filename;
    try {
      const url = new URL(uri);
      if (url.search || url.hash) continue;
      filename = fileURLToPath(url);
    } catch { continue; }
    if (!path.isAbsolute(filename) || filename.includes("\0")) continue;
    const key = process.platform === "win32" ? filename.toLowerCase() : filename;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(filename);
    if (files.length > MAX_CLIPBOARD_FILES) throw new Error(`파일은 한 번에 ${MAX_CLIPBOARD_FILES}개까지 첨부할 수 있습니다.`);
  }
  return files;
}

async function readFileAttachment(filename) {
  const name = path.basename(filename);
  let file;
  try {
    file = await open(filename, "r");
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("폴더는 첨부할 수 없습니다.");
    if (stat.size > MAX_CLIPBOARD_FILE_BYTES) throw new Error("파일은 10MB까지 첨부할 수 있습니다.");
    // Bound the read even if another process grows the file after stat.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_CLIPBOARD_FILE_BYTES + 1));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size) throw new Error("파일이 변경되었습니다. 다시 복사해 주세요.");
    return { name, mimeType: MIME_TYPES[path.extname(name).toLowerCase()] || "application/octet-stream", data: bytes.subarray(0, length).toString("base64") };
  } catch (error) {
    if (error.code) throw new Error(`${name}: 파일을 읽을 수 없습니다. 다시 복사해 주세요.`);
    throw new Error(`${name}: ${error.message}`);
  } finally { await file?.close(); }
}

export async function readClipboardFiles(clipboard) {
  const items = await clipboard.read();
  const uriLists = [];
  for (const item of items) {
    if (!item.types.includes("text/uri-list")) continue;
    const blob = await item.getType("text/uri-list");
    if (blob.size > MAX_URI_LIST_BYTES) throw new Error("클립보드의 파일 목록이 너무 큽니다.");
    uriLists.push(await blob.text());
  }
  const files = parseClipboardFileUris(uriLists.join("\n"));
  const attachments = [];
  for (const filename of files) attachments.push(await readFileAttachment(filename));
  return attachments;
}

function isAppPage(target, base) {
  try {
    const url = new URL(target);
    return url.origin === new URL(base).origin && ["/", "/index.html"].includes(url.pathname);
  } catch { return false; }
}

// No renderer paths: one read for the focused app frame after native paste.
export function createClipboardFileAccess(readFiles, now = Date.now) {
  const grants = new Map();
  return {
    register(contents, base) {
      const grant = { base, expires: 0 };
      grants.set(contents, grant);
      contents.on("before-input-event", (_event, input) => {
        const paste = (input.control || input.meta) && input.key?.toLowerCase() === "v";
        const insert = input.shift && input.key === "Insert";
        if (input.type === "keyDown" && !input.alt && !input.isComposing && (paste || insert)) grant.expires = now() + PASTE_WINDOW_MS;
      });
      contents.on("did-start-navigation", () => { grant.expires = 0; });
      contents.once("destroyed", () => grants.delete(contents));
    },
    async read(event) {
      const { sender, senderFrame } = event;
      const grant = grants.get(sender);
      if (!grant || senderFrame !== sender.mainFrame || !sender.isFocused()
        || grant.expires <= now() || !isAppPage(senderFrame.url, grant.base)) return [];
      grant.expires = 0;
      return readFiles();
    },
  };
}
