import test from "node:test";
import assert from "node:assert/strict";
import { composerAction } from "../public/composer.js";
import { validateAttachments, attachmentType, uploadAttachments, transferFiles, isPreviewImage, MAX_ATTACHMENT_BYTES } from "../public/features/sessions/image-composer.js";
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
  assert.throws(() => validateAttachments([file()], 4), /최대 4개/);
  assert.throws(() => validateAttachments([file("empty.png", "image/png", 0)]), /10 MiB/);
  assert.throws(() => validateAttachments([file("large.pdf", "application/pdf", MAX_ATTACHMENT_BYTES + 1)]), /10 MiB/);
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
