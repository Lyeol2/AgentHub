import test from "node:test";
import assert from "node:assert/strict";
import { composerAction } from "../public/composer.js";
import { validateImages, imageType, uploadImages, MAX_IMAGE_BYTES } from "../public/features/sessions/image-composer.js";
const file = (name = "test.png", type = "image/png", size = 100) => ({ name, type, size });

test("image-only composer sends or queues while empty input retains pause/resume", () => {
  for (const state of ["idle", "paused", "interrupted"]) assert.deepEqual([composerAction({ state }, "", 1).action, composerAction({ state }, "", 1).disabled], ["send", false]);
  assert.equal(composerAction({ state: "running" }, "", 1).action, "queue");
  assert.equal(composerAction({ state: "running" }, "", 0).action, "pause");
  assert.equal(composerAction({ state: "paused" }, "", 0).action, "resume");
});

test("image composer enforces format, count, and size before upload", () => {
  validateImages([file(), file("test.webp", "image/webp", MAX_IMAGE_BYTES)], 2);
  assert.equal(imageType(file("TEST.JPEG", "")), "image/jpeg");
  assert.throws(() => validateImages([file()], 4), /최대 4장/);
  assert.throws(() => validateImages([file("bad.svg", "image/svg+xml")]), /PNG/);
  assert.throws(() => validateImages([file("empty.png", "image/png", 0)]), /10 MiB/);
  assert.throws(() => validateImages([file("large.png", "image/png", MAX_IMAGE_BYTES + 1)]), /10 MiB/);
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
  await assert.rejects(uploadImages(api, "first", items, async () => "aGVsbG8="), /temporary/);
  assert.deepEqual(await uploadImages(api, "first", items, async () => "aGVsbG8="), ["one.png", "two.png"]);
  assert.equal(calls.filter((call) => call.body.name === "one.png").length, 1);
  assert.deepEqual(await uploadImages(api, "other", items, async () => "aGVsbG8="), ["other-one.png", "other-two.png"]);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0], { method: "POST", url: "/api/sessions/first/attachments", body: { name: "one.png", mimeType: "image/png", data: "aGVsbG8=" } });
});
