import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jsonLines } from "../server/infrastructure/persistence/json-lines.mjs";

test("JSONL reader preserves multibyte boundaries, byte offsets, and resumes after oversized records", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-json-lines-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "records.jsonl");
  const prefix = '"한글"\n';
  fs.writeFileSync(file, prefix + "x".repeat(1000) + '\n{"ok":true}\n"끝"');
  const records = [];
  for await (const record of jsonLines(file, { chunkBytes: 7, maxLineBytes: 32 })) records.push(record);
  assert.deepEqual(records.map(({ line, complete }) => [line, complete]), [
    ['"한글"', true], [null, true], ['{"ok":true}', true], ['"끝"', false],
  ]);
  assert.equal(records[0].end, Buffer.byteLength(prefix));
  const resumed = [];
  for await (const record of jsonLines(file, { start: records[1].end, chunkBytes: 3 })) resumed.push(record.line);
  assert.deepEqual(resumed, ['{"ok":true}', '"끝"']);
});
