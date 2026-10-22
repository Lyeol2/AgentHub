import fs from "node:fs";

// A checkpoint's generation makes replay idempotent if the app exits after the
// checkpoint rename but before deleting its old journal.
export function replaySessionJournal(file, session, generation, revision = 0) {
  let content;
  try { content = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { changed: false, revision }; throw error; }
  const end = content.lastIndexOf("\n") + 1;
  if (end < content.length) fs.truncateSync(file, Buffer.byteLength(content.slice(0, end)));
  let changed = false;
  for (const line of content.slice(0, end).split("\n")) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.generation !== generation || record.revision <= revision) continue;
    if (!record.metadata || record.metadata.id !== session.id || !Array.isArray(record.events)
      || !Number.isSafeInteger(record.revision) || (record.revision !== revision + 1 && record.from !== 0)
      || !Number.isSafeInteger(record.from) || record.from < 0 || record.from > session.events.length) throw new Error("Invalid session journal record");
    // Validate the entire record before mutating the last recoverable state.
    const length = record.from + record.events.length;
    if (record.patches != null && !Array.isArray(record.patches)) throw new Error("Invalid session journal patches");
    for (const patch of record.patches ?? []) {
      if (!patch || !Number.isSafeInteger(patch.index) || patch.index < 0 || patch.index >= length) throw new Error("Invalid session journal event index");
    }
    const events = session.events;
    events.length = record.from;
    for (const event of record.events) events.push(event);
    for (const { index, event } of record.patches ?? []) {
      events[index] = event;
    }
    for (const key of Object.keys(session)) if (key !== "events") delete session[key];
    Object.assign(session, record.metadata, { events });
    changed = true;
    revision = record.revision;
  }
  return { changed, revision };
}
