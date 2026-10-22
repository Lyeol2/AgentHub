import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateInstall } from "../electron/update-install.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));

test("update installer waits for durable shutdown after the HTTP response can finish", async () => {
  const events = [];
  let finishSave;
  const saving = new Promise(resolve => { finishSave = resolve; });
  const begin = createUpdateInstall({
    prepare: () => { events.push("prepare"); return saving; },
    install: () => events.push("install"),
    onError: error => { throw error; },
  });
  begin();
  begin();
  events.push("response");
  assert.deepEqual(events, ["response"]);
  await tick();
  assert.deepEqual(events, ["response", "prepare"]);
  finishSave();
  await tick();
  begin();
  await tick();
  assert.deepEqual(events, ["response", "prepare", "install"]);
});

test("failed shutdown never launches the installer and reports the original error", async () => {
  const failure = new Error("disk unavailable"), errors = [];
  let installed = 0, attempts = 0;
  const begin = createUpdateInstall({
    prepare: async () => { if (++attempts === 1) throw failure; },
    install: () => installed++,
    onError: error => errors.push(error),
  });
  begin();
  await tick();
  assert.equal(installed, 0);
  assert.deepEqual(errors, [failure]);
  begin();
  await tick();
  assert.equal(installed, 1);
});

test("synchronous preparation and installer failures use the same error path", async () => {
  for (const failPreparation of [true, false]) {
    const failure = new Error("cannot finish update"), errors = [];
    let installed = false;
    const begin = createUpdateInstall({
      prepare: () => { if (failPreparation) throw failure; },
      install: () => { installed = true; throw failure; },
      onError: error => errors.push(error),
    });
    begin();
    await tick();
    assert.equal(installed, !failPreparation);
    assert.deepEqual(errors, [failure]);
  }
});
