import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createClipboardFileAccess, MAX_CLIPBOARD_FILES, MAX_CLIPBOARD_FILE_BYTES,
  parseClipboardFileUris, readClipboardFiles,
} from "../electron/clipboard-files.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-clipboard-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(dir), /^agenthub-clipboard-/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    write(name, data = "") {
      const filename = path.join(dir, name);
      fs.writeFileSync(filename, data);
      return filename;
    },
  };
}

function uriItem(text) {
  return {
    types: ["text/uri-list"],
    async getType(type) {
      assert.equal(type, "text/uri-list");
      return new Blob([text], { type });
    },
  };
}

function clipboardWithFiles(...files) {
  return { async read() { return [uriItem(files.map((file) => pathToFileURL(file).href).join("\r\n"))]; } };
}

test("desktop clipboard: native file URIs preserve Unicode, spaces and escaped filename characters", (t) => {
  const { dir } = fixture(t);
  const filename = path.join(dir, "한글 é 😀 #100%.txt");
  const uri = pathToFileURL(filename).href;
  assert.deepEqual(parseClipboardFileUris(`# copied files\r\n${uri}\r\n\r\n${uri}\n`), [filename]);
  if (process.platform === "win32") {
    assert.deepEqual(parseClipboardFileUris(`${uri}\n${uri.toUpperCase()}`), [filename]);
  }
});

test("desktop clipboard: plain paths, web URLs, malformed and unsafe URI entries are not file grants", (t) => {
  const { dir } = fixture(t);
  const filename = path.join(dir, "secret.txt");
  const uri = pathToFileURL(filename).href;
  assert.deepEqual(parseClipboardFileUris([
    filename, `"${filename}"`, "relative.txt", "https://example.com/file.txt",
    "data:text/plain,content", "file://[invalid", `${uri}?download=1`, `${uri}#section`,
    `${uri}%00`, `${uri}%2Fchild`, `${uri}%zz`, "# file:///ignored.txt",
  ].join("\n")), []);
});

test("desktop clipboard: URI lists enforce unique file count and UTF-8 byte bounds", (t) => {
  const { dir } = fixture(t);
  const uris = Array.from({ length: MAX_CLIPBOARD_FILES + 1 }, (_, n) => pathToFileURL(path.join(dir, `${n}.txt`)).href);
  assert.equal(parseClipboardFileUris(uris.slice(0, MAX_CLIPBOARD_FILES).join("\n")).length, MAX_CLIPBOARD_FILES);
  assert.throws(() => parseClipboardFileUris(uris.join("\n")), /4개/);
  assert.throws(() => parseClipboardFileUris("한".repeat(48 * 1024)), /목록이 너무 큽니다/);
});

test("desktop clipboard: native files become byte-exact attachments with basenames and empty files", async (t) => {
  const { write } = fixture(t);
  const text = write("한글 메모.txt", "파일 내용\n");
  const binary = write("opaque.bin", Buffer.from([0, 255, 17, 128]));
  const image = write("SCREENSHOT.PNG", Buffer.from([137, 80, 78, 71]));
  const empty = write("empty.md");
  const attachments = await readClipboardFiles(clipboardWithFiles(text, binary, image, empty));
  assert.deepEqual(attachments, [
    { name: "한글 메모.txt", mimeType: "text/plain", data: Buffer.from("파일 내용\n").toString("base64") },
    { name: "opaque.bin", mimeType: "application/octet-stream", data: "AP8RgA==" },
    { name: "SCREENSHOT.PNG", mimeType: "image/png", data: "iVBORw==" },
    { name: "empty.md", mimeType: "text/markdown", data: "" },
  ]);
  for (const item of attachments) assert.deepEqual(Object.keys(item).sort(), ["data", "mimeType", "name"]);
});

test("desktop clipboard: text and image clipboard representations are left for normal paste", async (t) => {
  const { write } = fixture(t);
  const existing = write("must-not-read.txt", "private content");
  const neverRead = {
    types: ["text/plain", "text/html", "image/png"],
    async getType() { assert.fail("Only the native file URI representation may be read"); },
  };
  assert.deepEqual(await readClipboardFiles({ async read() { return [neverRead]; } }), []);
  assert.deepEqual(await readClipboardFiles({ async read() { return [uriItem(existing)]; } }), []);
});

test("desktop clipboard: file size limit accepts the boundary and rejects oversize files", async (t) => {
  const { write } = fixture(t);
  const limit = write("limit.bin", Buffer.alloc(MAX_CLIPBOARD_FILE_BYTES, 17));
  const [attachment] = await readClipboardFiles(clipboardWithFiles(limit));
  assert.equal(Buffer.from(attachment.data, "base64").length, MAX_CLIPBOARD_FILE_BYTES);
  const oversized = write("oversized.bin", Buffer.alloc(MAX_CLIPBOARD_FILE_BYTES + 1));
  await assert.rejects(readClipboardFiles(clipboardWithFiles(oversized)), /oversized\.bin:.*10MB/);
});

test("desktop clipboard: directories and missing files fail without disclosing absolute paths", async (t) => {
  const { dir } = fixture(t);
  for (const filename of [dir, path.join(dir, "missing.txt")]) {
    await assert.rejects(readClipboardFiles(clipboardWithFiles(filename)), (error) => {
      assert.ok(error.message.startsWith(`${path.basename(filename)}:`));
      assert.equal(error.message.includes(dir), false);
      return true;
    });
  }
});

test("desktop clipboard: URI blob and combined-list bounds apply before reading files", async () => {
  const oversizeItem = {
    types: ["text/uri-list"],
    async getType() { return { size: 128 * 1024 + 1, text() { assert.fail("Oversize blobs must not be decoded"); } }; },
  };
  await assert.rejects(readClipboardFiles({ async read() { return [oversizeItem]; } }), /목록이 너무 큽니다/);
  await assert.rejects(readClipboardFiles({ async read() { return [uriItem("#".repeat(70 * 1024)), uriItem("#".repeat(70 * 1024))]; } }), /목록이 너무 큽니다/);
});

function accessFixture() {
  let now = 10_000, reads = 0;
  const contents = new EventEmitter();
  const base = "http://127.0.0.1:4173/";
  contents.mainFrame = { url: base };
  contents.focused = true;
  contents.isFocused = () => contents.focused;
  const access = createClipboardFileAccess(async () => { reads++; return ["fixture attachment"]; }, () => now);
  access.register(contents, base);
  return {
    contents, access,
    event: { sender: contents, senderFrame: contents.mainFrame },
    paste(input = {}) { contents.emit("before-input-event", {}, { type: "keyDown", key: "v", control: true, ...input }); },
    advance(ms) { now += ms; },
    get reads() { return reads; },
  };
}

test("desktop clipboard access: a native paste grants exactly one concurrent read", async () => {
  const f = accessFixture();
  assert.deepEqual(await f.access.read(f.event), []);
  assert.equal(f.reads, 0);
  f.paste();
  assert.deepEqual(await Promise.all([f.access.read(f.event), f.access.read(f.event)]), [["fixture attachment"], []]);
  assert.equal(f.reads, 1);
});

test("desktop clipboard access: only native paste shortcuts grant access, with expiry", async () => {
  const f = accessFixture();
  for (const input of [
    { type: "keyUp" }, { control: false }, { key: "c" }, { alt: true }, { isComposing: true },
    { key: "Insert", control: false, shift: false },
  ]) {
    f.paste(input);
    assert.deepEqual(await f.access.read(f.event), []);
  }
  for (const input of [{ key: "V" }, { control: false, meta: true }, { key: "Insert", control: false, shift: true }]) {
    f.paste(input);
    assert.deepEqual(await f.access.read(f.event), ["fixture attachment"]);
  }
  f.paste();
  f.advance(1500);
  assert.deepEqual(await f.access.read(f.event), []);
  assert.equal(f.reads, 3);
});

test("desktop clipboard access: only the registered focused main app frame can read", async () => {
  const f = accessFixture();
  f.paste();
  assert.deepEqual(await f.access.read({ sender: new EventEmitter(), senderFrame: f.contents.mainFrame }), []);
  assert.deepEqual(await f.access.read({ sender: f.contents, senderFrame: { url: f.contents.mainFrame.url } }), []);
  f.contents.focused = false;
  assert.deepEqual(await f.access.read(f.event), []);
  f.contents.focused = true;
  for (const url of [
    "http://127.0.0.1:4174/", "https://127.0.0.1:4173/", "http://localhost:4173/",
    "http://127.0.0.1:4173/api/sessions/x/attachments/y", "file:///index.html", "not a URL",
  ]) {
    f.contents.mainFrame.url = url;
    assert.deepEqual(await f.access.read(f.event), []);
  }
  assert.equal(f.reads, 0);
  f.contents.mainFrame.url = "http://127.0.0.1:4173/index.html?session=a#chat";
  assert.deepEqual(await f.access.read(f.event), ["fixture attachment"]);
  assert.equal(f.reads, 1);
});

test("desktop clipboard access: navigation and destroyed windows revoke native paste grants", async () => {
  const f = accessFixture();
  f.paste();
  f.contents.emit("did-start-navigation");
  assert.deepEqual(await f.access.read(f.event), []);
  f.paste();
  f.contents.emit("destroyed");
  f.paste();
  assert.deepEqual(await f.access.read(f.event), []);
  assert.equal(f.reads, 0);
});

const preloadSource = fs.readFileSync(fileURLToPath(new URL("../electron/preload.cjs", import.meta.url)), "utf8");

function preloadFixture() {
  let now = 10_000, bridge;
  const listeners = new Map(), calls = [];
  vm.runInNewContext(preloadSource, {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, "agenthubDesktop"); bridge = api; } },
        ipcRenderer: { async invoke(...args) { calls.push(args); return ["fixture attachment"]; } },
      };
    },
    window: { addEventListener(name, handler, capture) { assert.equal(capture, true); listeners.set(name, handler); } },
    Date: { now: () => now },
  }, { filename: "preload.cjs" });
  return {
    bridge, calls,
    dispatch(name, event) { listeners.get(name)(event); },
    advance(ms) { now += ms; },
  };
}

test("desktop preload: synthetic events cannot read clipboard and trusted paste is single-use", async () => {
  const f = preloadFixture();
  assert.deepEqual(Object.keys(f.bridge), ["readClipboardFiles", "openArtifact"]);
  assert.equal((await f.bridge.readClipboardFiles()).length, 0);
  f.dispatch("paste", { isTrusted: false });
  f.dispatch("keydown", { isTrusted: false, key: "v", ctrlKey: true });
  assert.equal((await f.bridge.readClipboardFiles()).length, 0);
  assert.equal(f.calls.length, 0);
  f.dispatch("paste", { isTrusted: true });
  assert.deepEqual(await f.bridge.readClipboardFiles({ paths: ["C:/private.txt"] }), ["fixture attachment"]);
  assert.equal((await f.bridge.readClipboardFiles()).length, 0);
  assert.deepEqual(f.calls, [["agenthub:clipboard-files"]]);
});

test("desktop preload: native paste shortcut fallback expires and rejects unrelated shortcuts", async () => {
  const f = preloadFixture();
  for (const event of [
    { key: "c", ctrlKey: true }, { key: "v" }, { key: "v", ctrlKey: true, altKey: true },
    { key: "v", ctrlKey: true, isComposing: true },
  ]) {
    f.dispatch("keydown", { isTrusted: true, ...event });
    assert.equal((await f.bridge.readClipboardFiles()).length, 0);
  }
  for (const event of [{ key: "V", ctrlKey: true }, { key: "v", metaKey: true }, { key: "Insert", shiftKey: true }]) {
    f.dispatch("keydown", { isTrusted: true, ...event });
    assert.deepEqual(await f.bridge.readClipboardFiles(), ["fixture attachment"]);
  }
  f.dispatch("paste", { isTrusted: true });
  f.advance(1500);
  assert.equal((await f.bridge.readClipboardFiles()).length, 0);
  assert.equal(f.calls.length, 3);
});

test("desktop preload: opening artifacts requires a trusted click and consumes it once", async () => {
  const f = preloadFixture();
  const request = { sessionId: "s-fixture", path: "outputs/report.md", action: "open", ignored: "not forwarded" };
  await assert.rejects(f.bridge.openArtifact(request), /버튼을 눌러/);
  f.dispatch("click", { isTrusted: false });
  await assert.rejects(f.bridge.openArtifact(request), /버튼을 눌러/);
  assert.equal(f.calls.length, 0);
  f.dispatch("click", { isTrusted: true });
  await f.bridge.openArtifact(request);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "agenthub:open-artifact");
  assert.equal(JSON.stringify(f.calls[0][1]), JSON.stringify({ sessionId: "s-fixture", path: "outputs/report.md", action: "open" }));
  await assert.rejects(f.bridge.openArtifact(request), /버튼을 눌러/);
  f.dispatch("click", { isTrusted: true });
  f.advance(1500);
  await assert.rejects(f.bridge.openArtifact(request), /버튼을 눌러/);
});
