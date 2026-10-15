import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AttachmentStore, MAX_IMAGE_BYTES } from "../server/attachments.mjs";

export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAZ0AAAAASUVORK5CYII=";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-images-"));
  const storage = new AttachmentStore({ dataDir: dir });
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, storage };
}

test("attachments: session-owned images survive a new store without exposing client paths", (t) => {
  const { dir, storage } = fixture(t);
  const image = storage.save("session-a", { name: "../한글.png", mimeType: "image/png", data: PNG, path: "C:/secret" });
  assert.equal(Object.hasOwn(image, "path"), false);
  assert.equal(image.size, Buffer.from(PNG, "base64").length);
  assert.match(image.url, /^\/api\/sessions\/session-a\/attachments\/[a-f0-9]{32}$/);
  const restored = new AttachmentStore({ dataDir: dir }).resolve("session-a", image.id);
  assert.equal(path.dirname(restored.path), path.join(dir, "attachments", "session-a"));
  assert.deepEqual(fs.readFileSync(restored.path), Buffer.from(PNG, "base64"));
  assert.throws(() => storage.resolve("session-b", image.id), { status: 404 });
  assert.throws(() => storage.resolve("session-a", "../private"), { status: 400 });
  assert.throws(() => storage.save("../escape", { name: "a.png", mimeType: "image/png", data: PNG }), { status: 400 });
  assert.throws(() => storage.resolveAll("session-a", [image.id, image.id]), { status: 400 });
  assert.throws(() => storage.resolveAll("session-a", Array(5).fill(image.id)), { status: 400 });
  storage.remove("session-a");
  assert.equal(fs.existsSync(path.join(dir, "attachments", "session-a")), false);
});

test("attachments: invalid bytes, MIME mismatches and oversize data create no files", (t) => {
  const { dir, storage } = fixture(t);
  for (const body of [
    { mimeType: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") },
    { mimeType: "image/jpeg", data: PNG },
    { mimeType: "image/png", data: "not base64" },
    { mimeType: "image/png", data: "AAAA" },
    { mimeType: "image/png", data: null },
  ]) assert.throws(() => storage.save("session-a", body), { status: 400 });
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  assert.throws(() => storage.save("session-a", { mimeType: "image/png", data: bytes.toString("base64") }), { status: 413 });
  assert.equal(fs.existsSync(path.join(dir, "attachments")), false);
});

test("attachments: directory links cannot redirect uploads or delete outside files", (t) => {
  const { dir, storage } = fixture(t);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  try { fs.symlinkSync(outside, path.join(dir, "attachments"), "junction"); }
  catch (err) { if (["EPERM", "EACCES"].includes(err.code)) return t.skip("Directory links unavailable"); throw err; }
  assert.throws(() => storage.save("session-a", { mimeType: "image/png", data: PNG }), { status: 400 });
  assert.throws(() => storage.remove("session-a"), { status: 400 });
  assert.equal(fs.existsSync(path.join(outside, "session-a")), false);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
});
