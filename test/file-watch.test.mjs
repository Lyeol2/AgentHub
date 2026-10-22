import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { createFileWatch } from "../server/file-watch.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-file-watch-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const close = [];
  t.after(() => {
    for (const stop of close) stop();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const events = [];
  const errors = [];
  const watch = (watchPaths = ["."], debounceMs = 100) => {
    const handle = createFileWatch({ node: { projectPath: project, watchPaths, debounceMs }, onChange: value => events.push(value), onError: error => errors.push(error) });
    close.push(() => handle.stop());
    return handle;
  };
  return { root, project, events, errors, watch };
}

async function waitFor(check) {
  const end = Date.now() + 3000;
  while (!check() && Date.now() < end) await delay(25);
  assert.ok(check(), "file watch event did not arrive");
}

test("file watch: coalesces file changes and stop clears pending work", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, "a.txt"), "a");
  fs.writeFileSync(path.join(f.project, "b.txt"), "b");
  const handle = f.watch();
  fs.appendFileSync(path.join(f.project, "a.txt"), "1");
  fs.appendFileSync(path.join(f.project, "a.txt"), "2");
  fs.appendFileSync(path.join(f.project, "b.txt"), "3");
  await waitFor(() => f.events.length);
  assert.deepEqual(f.events[0].paths, ["a.txt", "b.txt"]);
  assert.ok(Number.isFinite(Date.parse(f.events[0].at)));
  fs.appendFileSync(path.join(f.project, "a.txt"), "pending");
  await delay(30);
  handle.stop();
  await delay(180);
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.errors, []);
});

test("file watch: a selected file survives replacement and ignores adjacent files", async t => {
  const f = fixture(t);
  const target = path.join(f.project, "selected.txt");
  fs.writeFileSync(target, "before");
  f.watch(["selected.txt"]);
  fs.writeFileSync(path.join(f.project, "other.txt"), "ignored");
  fs.writeFileSync(path.join(f.project, "temporary.txt"), "after");
  fs.renameSync(path.join(f.project, "temporary.txt"), target);
  await waitFor(() => f.events.length === 1);
  assert.deepEqual(f.events[0].paths, ["selected.txt"]);
  fs.appendFileSync(target, "again");
  await waitFor(() => f.events.length === 2);
  assert.deepEqual(f.events[1].paths, ["selected.txt"]);
});

test("file watch: Windows selected-file matching ignores filename case", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  const actualFile = path.join(f.project, "Foo.txt");
  fs.writeFileSync(actualFile, "before");
  f.watch(["foo.txt"]);
  fs.appendFileSync(actualFile, "after");
  await waitFor(() => f.events.length === 1);
  assert.deepEqual(f.events[0].paths, ["Foo.txt"]);
  assert.deepEqual(f.errors, []);
});

test("file watch: excluded folders and symlinks outside the project cannot trigger", async t => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  for (const directory of [".git", "node_modules", "data"]) fs.mkdirSync(path.join(f.project, directory));
  assert.throws(() => f.watch(["../outside"]));
  assert.throws(() => f.watch(["missing"]), /없습니다/);
  assert.throws(() => f.watch([".git"]));
  const link = path.join(f.project, "external");
  try { fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("symlink unavailable"); throw error; }
  assert.throws(() => f.watch(["external"]), /프로젝트 밖/);
  f.watch();
  for (const directory of [".git", "node_modules", "data"]) fs.writeFileSync(path.join(f.project, directory, "ignore.txt"), "ignored");
  fs.writeFileSync(path.join(outside, "secret.txt"), "ignored");
  await delay(250);
  assert.deepEqual(f.events, []);
  fs.writeFileSync(path.join(f.project, "real.txt"), "real");
  await waitFor(() => f.events.length === 1);
  assert.deepEqual(f.events[0].paths, ["real.txt"]);
});

test("file watch: ignored bursts avoid disk checks and duplicate paths are checked once after debounce", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, "changed.txt"), "before");
  let emit;
  t.mock.method(fs, "watch", (_, options, callback) => {
    emit = callback;
    return Object.assign(new EventEmitter(), { close() {} });
  });
  const lstat = fs.promises.lstat;
  let checked = 0;
  t.mock.method(fs.promises, "lstat", async function (...args) { checked++; return lstat.apply(this, args); });
  f.watch();
  for (let i = 0; i < 1000; i++) emit("change", "node_modules/package/installed.js");
  await delay(150);
  assert.equal(checked, 0);
  assert.equal(f.events.length, 0);
  for (let i = 0; i < 100; i++) emit("change", "changed.txt");
  assert.equal(checked, 0);
  await waitFor(() => f.events.length === 1);
  assert.equal(checked, 1);
  assert.deepEqual(f.events[0].paths, ["changed.txt"]);
});

test("file watch: rechecks replaced symlinks at flush time", async t => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  const nested = path.join(f.project, "nested");
  fs.mkdirSync(outside);
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(outside, "file.txt"), "outside");
  let emit;
  t.mock.method(fs, "watch", (_, options, callback) => {
    emit = callback;
    return Object.assign(new EventEmitter(), { close() {} });
  });
  f.watch();
  emit("change", "nested/file.txt");
  fs.rmdirSync(nested);
  try { fs.symlinkSync(outside, nested, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("symlink unavailable"); throw error; }
  await delay(250);
  assert.deepEqual(f.events, []);
});
