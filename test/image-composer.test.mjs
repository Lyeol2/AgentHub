import test from "node:test";
import assert from "node:assert/strict";
import { composerAction } from "../public/composer.js";
import { validateAttachments, attachmentType, uploadAttachments, transferFiles, isPreviewImage, shrinkForAgent, MAX_ATTACHMENT_BYTES, AGENT_IMAGE_BYTES, AGENT_IMAGE_EDGE } from "../public/features/sessions/image-composer.js";
const file = (name = "test.png", type = "image/png", size = 100) => ({ name, type, size });

test("image-only composer sends or queues while empty input retains pause/resume", () => {
  for (const state of ["idle", "paused", "interrupted"]) assert.deepEqual([composerAction({ state }, "", 1).action, composerAction({ state }, "", 1).disabled], ["send", false]);
  assert.equal(composerAction({ state: "running" }, "", 1).action, "queue");
  assert.equal(composerAction({ state: "running" }, "", 0).action, "pause");
  assert.equal(composerAction({ state: "paused" }, "", 0).action, "resume");
});

test("attachment composer accepts documents and empty files while enforcing count and size", () => {
  validateAttachments([file(), file("test.webp", "image/webp", MAX_ATTACHMENT_BYTES)], 2);
  validateAttachments([file("notes.txt", "text/plain"), file("empty.txt", "", 0), file("vector.svg", "image/svg+xml")]);
  assert.equal(attachmentType(file("TEST.JPEG", "")), "image/jpeg");
  assert.equal(attachmentType(file("notes.txt", "")), "text/plain");
  assert.equal(attachmentType(file("binary", "")), "application/octet-stream");
  assert.equal(isPreviewImage("image/svg+xml"), false);
  assert.throws(() => validateAttachments([file()], 20), /최대 20개/);
  assert.throws(() => validateAttachments([file("empty.png", "image/png", 0)]), /20 MiB/);
  assert.throws(() => validateAttachments([file("large.pdf", "application/pdf", MAX_ATTACHMENT_BYTES + 1)]), /20 MiB/);
  // 요청 하나의 합계는 100 MiB까지다.
  validateAttachments([file("a.pdf", "application/pdf", MAX_ATTACHMENT_BYTES)], 4, 80 * 1024 * 1024);
  assert.throws(() => validateAttachments([file("b.pdf", "application/pdf", MAX_ATTACHMENT_BYTES)], 5, 80 * 1024 * 1024 + 1), /합계 100 MiB/);
});

test("clipboard and drop files prefer FileList and fall back to file items without duplicates", () => {
  const attached = file("notes.txt", "text/plain");
  const items = [{ kind: "string", getAsFile: () => null }, { kind: "file", getAsFile: () => attached }, { kind: "file", getAsFile: () => null }];
  assert.deepEqual(transferFiles({ files: [attached], items }), [attached]);
  assert.deepEqual(transferFiles({ files: [], items }), [attached]);
  assert.deepEqual(transferFiles(), []);
  assert.throws(() => transferFiles({ files: [file("folder", "", 0)], items: [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }] }), /폴더/);
});

test("upload retries reuse accepted images and keep destinations isolated", async () => {
  const items = [{ file: file("one.png") }, { file: file("two.png") }];
  const calls = [];
  let rejectSecond = true;
  const api = async (method, url, body) => {
    calls.push({ method, url, body });
    if (rejectSecond && body.name === "two.png") { rejectSecond = false; throw Error("temporary failure"); }
    return { id: url.includes("/other/") ? "other-" + body.name : body.name };
  };
  await assert.rejects(uploadAttachments(api, "first", items, async () => "aGVsbG8="), /temporary/);
  assert.deepEqual(await uploadAttachments(api, "first", items, async () => "aGVsbG8="), ["one.png", "two.png"]);
  assert.equal(calls.filter((call) => call.body.name === "one.png").length, 1);
  assert.deepEqual(await uploadAttachments(api, "other", items, async () => "aGVsbG8="), ["other-one.png", "other-two.png"]);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0], { method: "POST", url: "/api/sessions/first/attachments", body: { name: "one.png", mimeType: "image/png", data: "aGVsbG8=" } });
});

test("큰 이미지는 AI에 보내기 전에 5 MB·긴 변 8000px 안으로 줄이고 작은 이미지·문서는 그대로 둔다", async () => {
  const sized = (name, type, size) => ({ name, type, size, lastModified: 7 });
  const decode = (w, h) => async () => ({ width: w, height: h });
  const made = [];
  const canvas = (width, height) => {
    made.push([width, height]);
    return { width, height, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (done) => done(new Blob([new Uint8Array(made.length < 2 ? AGENT_IMAGE_BYTES + 1 : 10)], { type: "image/jpeg" })) };
  };
  const small = sized("small.png", "image/png", 1000);
  assert.equal(await shrinkForAgent(small, { decode: decode(100, 100), canvas }), small);
  const doc = sized("notes.pdf", "application/pdf", AGENT_IMAGE_BYTES * 2);
  assert.equal(await shrinkForAgent(doc, { decode: decode(1, 1), canvas }), doc);
  const huge = sized("shot.png", "image/png", AGENT_IMAGE_BYTES * 3);
  const out = await shrinkForAgent(huge, { decode: decode(16000, 8000), canvas });
  assert.equal(out.name, "shot.jpg");
  assert.equal(out.type, "image/jpeg");
  // 긴 변을 8000px로 맞춘 뒤에도 크면 한 번 더 줄인다.
  assert.deepEqual(made, [[AGENT_IMAGE_EDGE, 4000], [6400, 3200]]);
});
