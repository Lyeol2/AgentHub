import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../server/store.mjs";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-journal-"));
  const stores = [];
  const open = () => { const store = new SessionStore({ dataDir }); stores.push(store); return store; };
  t.after(async () => {
    for (const store of stores) await store.close();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, open };
}
const session = () => ({ id: "test", chat: true, state: "idle", title: "Initial", updatedAt: new Date().toISOString(), events: [] });

test("session journal saves only appended events and restores metadata and patches", async t => {
  const f = fixture(t), store = f.open(), value = session();
  value.events = [{ seq: 0, kind: "user", text: "x".repeat(100000) }];
  store.add(value);
  const snapshot = fs.readFileSync(path.join(f.dataDir, "sessions", "test.json"), "utf8");
  value.events.push({ seq: 1, kind: "text", text: "new" });
  store.touch(value, { appendOnly: true });
  await store.flushJournal(value.id);
  const line = JSON.parse(fs.readFileSync(store.journalFile(value.id), "utf8").trim());
  assert.equal(line.from, 1);
  assert.equal(line.events.length, 1);
  assert.ok(JSON.stringify(line).length < 1000);
  assert.equal(fs.readFileSync(path.join(f.dataDir, "sessions", "test.json"), "utf8"), snapshot);
  value.events[0].delivery = "applied";
  store.touch(value, { event: value.events[0] });
  await store.flushJournal(value.id);
  value.title = "Changed";
  store.touch(value, { metadataOnly: true });
  await store.flushJournal(value.id);
  assert.deepEqual(f.open().get(value.id), value);
});

test("a checkpoint followed by its old journal cannot resurrect earlier metadata", async t => {
  const f = fixture(t), store = f.open(), value = session();
  store.add(value);
  value.title = "Old journal";
  store.touch(value, { metadataOnly: true });
  await store.flushJournal(value.id);
  const old = fs.readFileSync(store.journalFile(value.id));
  value.title = "New checkpoint";
  store.flush(value.id);
  fs.writeFileSync(store.journalFile(value.id), old);
  assert.equal(f.open().get(value.id).title, "New checkpoint");
});

test("journal recovery ignores a torn final append and retains durable events", async t => {
  const f = fixture(t), store = f.open(), value = session();
  store.add(value);
  value.events.push({ seq: 0, kind: "text", text: "Durable" });
  store.touch(value, { appendOnly: true });
  await store.flushJournal(value.id);
  fs.appendFileSync(store.journalFile(value.id), '{"incomplete":');
  assert.deepEqual(f.open().get(value.id).events, value.events);
});

test("deleting during a queued journal write never recreates a session", async t => {
  const f = fixture(t), store = f.open(), value = session();
  store.add(value);
  value.events.push({ seq: 0, kind: "text", text: "x".repeat(50000) });
  store.touch(value, { appendOnly: true });
  const writing = store.flushJournal(value.id);
  store.remove(value.id);
  await writing;
  assert.equal(fs.existsSync(store.journalFile(value.id)), false);
  assert.equal(f.open().get(value.id), undefined);
});

test("background journal compaction preserves subsequent appends on restart", async t => {
  const f = fixture(t), store = f.open(), value = session();
  store.add(value);
  value.events.push({ seq: 0, kind: "text", text: "x".repeat(4 * 1024 * 1024) });
  store.touch(value, { appendOnly: true });
  await store.flushJournal(value.id);
  assert.equal(fs.statSync(store.journalFile(value.id)).size, 0);
  value.events.push({ seq: 1, kind: "result", text: "Done" });
  store.touch(value, { appendOnly: true });
  await store.flushJournal(value.id);
  assert.deepEqual(f.open().get(value.id), value);
});

test("a corrupt journal record preserves the valid prefix across later restarts", async t => {
  t.mock.method(console, "warn", () => {});
  const f = fixture(t), store = f.open(), value = session();
  store.add(value);
  value.events.push({ seq: 0, kind: "text", text: "Durable prefix" });
  store.touch(value, { appendOnly: true });
  await store.flushJournal(value.id);
  const record = JSON.parse(fs.readFileSync(store.journalFile(value.id), "utf8").trim());
  fs.appendFileSync(store.journalFile(value.id), JSON.stringify({ ...record, revision: 2, from: 0,
    events: [{ seq: 0, text: "Must not replace the prefix" }], patches: [{ index: 999, event: {} }] }) + "\n");
  const restored = f.open(), current = restored.get(value.id);
  assert.deepEqual(current.events, value.events);
  current.events.push({ seq: 1, kind: "text", text: "After recovery" });
  restored.touch(current, { appendOnly: true });
  await restored.close();
  assert.deepEqual(f.open().get(value.id).events, current.events);
});

test("a slow writer coalesces repeated flushes without copying an unbounded queue", async t => {
  const f = fixture(t), store = f.open(), value = session();
  store.add(value);
  const append = store.writer.append.bind(store.writer);
  let release, writes = 0;
  store.writer.append = (file, record) => {
    writes++;
    return writes === 1 ? new Promise(resolve => { release = () => resolve(append(file, record)); }) : append(file, record);
  };
  value.events.push({ seq: 0, text: "First" });
  store.touch(value, { appendOnly: true });
  const promises = [store.flushJournal(value.id)];
  for (let i = 1; i <= 100; i++) {
    value.events.push({ seq: i, text: `Update ${i}` });
    store.touch(value, { appendOnly: true });
    promises.push(store.flushJournal(value.id));
  }
  const before = writes;
  release();
  await Promise.all(promises);
  assert.equal(before, 1);
  assert.equal(writes, 2);
  assert.deepEqual(f.open().get(value.id).events, value.events);
});

test("a full journal record recovers a transient append failure", async t => {
  t.mock.method(console, "error", () => {});
  const f = fixture(t), store = f.open(), value = session();
  store.add(value);
  const append = store.writer.append.bind(store.writer);
  store.writer.append = () => Promise.reject(new Error("temporary write failure"));
  value.events.push({ seq: 0, text: "First" });
  store.touch(value, { appendOnly: true });
  await store.flushJournal(value.id);
  store.writer.append = append;
  value.events.push({ seq: 1, text: "After recovery" });
  store.touch(value, { appendOnly: true });
  await store.close();
  assert.deepEqual(f.open().get(value.id).events, value.events);
});

test("a failed deletion retains a complete snapshot for the next start", async t => {
  const f = fixture(t), store = f.open(), value = session();
  store.add(value);
  value.events.push({ seq: 0, text: "Keep on failed delete" });
  store.touch(value, { appendOnly: true });
  await store.flushJournal(value.id);
  const unlink = fs.rmSync;
  const mock = t.mock.method(fs, "rmSync", (file, options) => {
    if (file === path.join(f.dataDir, "sessions", "test.json")) throw Object.assign(new Error("locked"), { code: "EACCES" });
    return unlink(file, options);
  });
  assert.throws(() => store.remove(value.id), /locked/);
  mock.mock.restore();
  assert.deepEqual(f.open().get(value.id).events, value.events);
});

test("shutdown retries explicit checkpoints that failed before a journal existed", async t => {
  const f = fixture(t), store = f.open(), value = session();
  store.add(value);
  value.title = "Changed before disk error";
  store.touch(value, { metadataOnly: true });
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === path.join(f.dataDir, "sessions", "test.json")) throw Object.assign(new Error("disk error"), { code: "EIO" });
    return rename(from, to);
  });
  assert.throws(() => store.flush(value.id), /disk error/);
  mock.mock.restore();
  await store.close();
  assert.equal(f.open().get(value.id).title, value.title);
});
