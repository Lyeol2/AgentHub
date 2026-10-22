import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import { writeJsonAtomic } from "./json-file.mjs";
import { replaySessionJournal } from "./session-journal.mjs";

// The worker owns serialization, append and fsync; the application thread only
// transfers new events and changed metadata. Messages are processed in order.
parentPort.on("message", ({ id, file, value, signal }) => {
  const state = new Int32Array(signal);
  let error;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "a+");
    const start = fs.fstatSync(fd).size;
    try {
      fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
      fs.fsyncSync(fd);
    } catch (failure) {
      // Do not leave a partially written line ahead of a later valid append.
      try { fs.ftruncateSync(fd, start); fs.fsyncSync(fd); } catch {}
      throw failure;
    } finally { fs.closeSync(fd); }
    if (fs.statSync(file).size >= 4 * 1024 * 1024) {
      const snapshotFile = file.replace(/\.journal\.jsonl$/, ".json");
      const session = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
      const generation = session._journalGeneration ?? "legacy";
      const previous = session._journalRevision ?? 0;
      delete session._journalGeneration;
      delete session._journalRevision;
      const { revision } = replaySessionJournal(file, session, generation, previous);
      writeJsonAtomic(snapshotFile, { ...session, _journalGeneration: generation, _journalRevision: revision });
      // Rename happens before truncation. Replaying an old journal is harmless
      // because the snapshot records its last included revision.
      fs.truncateSync(file, 0);
    }
  } catch (failure) { error = { message: failure.message, code: failure.code }; }
  Atomics.store(state, 0, error ? 2 : 1);
  Atomics.notify(state, 0);
  parentPort.postMessage({ id, error });
});
