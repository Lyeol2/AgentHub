import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createArtifactAccess } from "../electron/artifacts.mjs";

function fixture(options = {}) {
  const contents = new EventEmitter();
  const base = "http://127.0.0.1:4173/";
  contents.mainFrame = { url: base };
  const metadataRequests = [], opened = [], revealed = [];
  const metadata = { path: path.resolve("한글 화면.png"), kind: "image", ...options.metadata };
  const access = createArtifactAccess({
    async fetchMetadata(url, init) {
      metadataRequests.push({ url, init });
      return options.fetchMetadata ? options.fetchMetadata(url, init) : { ok: true, async json() { return metadata; } };
    },
    async openPath(filename) { opened.push(filename); return options.openError ?? ""; },
    async showItemInFolder(filename) { revealed.push(filename); },
  });
  access.register(contents, base);
  return { access, contents, event: { sender: contents, senderFrame: contents.mainFrame }, metadata, metadataRequests, opened, revealed };
}

const request = (patch = {}) => ({ sessionId: "s-fixture", path: "outputs/한글 화면.png", action: "open", ...patch });

test("desktop artifacts: metadata validates the session reference before opening the resolved path", async () => {
  const f = fixture();
  assert.deepEqual(await f.access.open(f.event, request()), { ok: true });
  assert.deepEqual(f.opened, [f.metadata.path]);
  const endpoint = new URL(f.metadataRequests[0].url);
  assert.equal(endpoint.origin, "http://127.0.0.1:4173");
  assert.equal(endpoint.pathname, "/api/sessions/s-fixture/artifact");
  assert.equal(endpoint.searchParams.get("path"), "outputs/한글 화면.png");
  assert.equal(f.metadataRequests[0].init.redirect, "error");
});

test("desktop artifacts: forged windows, subframes and non-app pages cannot request metadata", async () => {
  const f = fixture();
  for (const event of [
    { sender: new EventEmitter(), senderFrame: f.contents.mainFrame },
    { sender: f.contents, senderFrame: { url: f.contents.mainFrame.url } },
  ]) await assert.rejects(f.access.open(event, request()), /AgentHub 화면/);
  for (const url of [
    "https://127.0.0.1:4173/", "http://127.0.0.1:4174/", "http://127.0.0.1:4173.evil.test/",
    "http://localhost:4173/", "http://127.0.0.1:4173/api/sessions/x/artifact", "file:///index.html", "invalid",
  ]) {
    f.contents.mainFrame.url = url;
    await assert.rejects(f.access.open(f.event, request()), /AgentHub 화면/);
  }
  assert.equal(f.metadataRequests.length, 0);
  f.contents.mainFrame.url = "http://127.0.0.1:4173/index.html?session=s-fixture#chat";
  await f.access.open(f.event, request());
  assert.equal(f.opened.length, 1);
});

test("desktop artifacts: malformed requests and arbitrary actions fail before metadata lookup", async () => {
  const f = fixture();
  for (const value of [null, {}, request({ action: "execute" }), request({ path: "" }), request({ path: "a\0.png" }), request({ path: "a".repeat(32769) }), request({ sessionId: "../../secrets" }), request({ sessionId: 1 })]) {
    await assert.rejects(f.access.open(f.event, value), /올바른 파일 참조/);
  }
  assert.equal(f.metadataRequests.length, 0);
});

test("desktop artifacts: executables, scripts, shortcuts and macro files can only be revealed", async () => {
  for (const extension of [".exe", ".cmd", ".bat", ".ps1", ".sh", ".js", ".vbs", ".msi", ".lnk", ".url", ".docm", ".xlsm", ".pptm"]) {
    const f = fixture({ metadata: { path: path.resolve(`artifact${extension}`), kind: "file" } });
    await assert.rejects(f.access.open(f.event, request()), /위치 보기/);
    assert.equal(f.opened.length, 0);
    assert.deepEqual(await f.access.open(f.event, request({ action: "reveal" })), { ok: true });
    assert.deepEqual(f.revealed, [f.metadata.path]);
  }
});

test("desktop artifacts: verified document and image formats use the system association", async () => {
  for (const extension of [".PNG", ".md", ".pdf", ".html", ".txt", ".docx", ".xlsx", ".pptx"]) {
    const f = fixture({ metadata: { path: path.resolve(`artifact${extension}`), kind: "file" } });
    await f.access.open(f.event, request());
    assert.equal(f.opened.length, 1);
  }
});

test("desktop artifacts: missing files and invalid metadata never reach the OS", async () => {
  const missing = fixture({ fetchMetadata: async () => ({ ok: false, async json() { assert.fail("Error responses are not artifact metadata"); } }) });
  await assert.rejects(missing.access.open(missing.event, request()), /찾을 수 없거나/);
  for (const metadata of [{ path: "relative.png" }, { path: "bad\0.png" }, { kind: "executable" }, { path: 2 }, { path: "https://example.test/a.png" }]) {
    const f = fixture({ metadata });
    await assert.rejects(f.access.open(f.event, request()), /경로가 올바르지/);
    assert.equal(f.opened.length + f.revealed.length, 0);
  }
  const failed = fixture({ openError: "Association failed" });
  await assert.rejects(failed.access.open(failed.event, request()), /파일을 열 수 없습니다/);
});

test("desktop artifacts: navigation or destruction during verification cancels opening", async () => {
  for (const invalidate of [(contents) => { contents.mainFrame.url = "https://example.test/"; }, (contents) => { contents.emit("destroyed"); }]) {
    let complete;
    const f = fixture({ fetchMetadata: () => new Promise((resolve) => { complete = resolve; }) });
    const opening = f.access.open(f.event, request());
    invalidate(f.contents);
    complete({ ok: true, async json() { return f.metadata; } });
    await assert.rejects(opening, /화면이 바뀌었/);
    assert.equal(f.opened.length, 0);
  }
});
