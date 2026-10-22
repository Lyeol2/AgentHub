import fs from "node:fs";

// Bound both reads and individual records. A missing final newline is reported
// separately so append-only consumers can keep the last committed byte offset.
export async function* jsonLines(file, { start = 0, end = Infinity, maxLineBytes = 16 << 20, chunkBytes = 64 << 10 } = {}) {
  const handle = await fs.promises.open(file, "r");
  const buffer = Buffer.alloc(chunkBytes);
  let position = start;
  let parts = [];
  let bytes = 0;
  let oversized = false;
  try {
    while (position < end) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - position), position);
      if (!bytesRead) break;
      let from = 0;
      while (from < bytesRead) {
        const newline = buffer.indexOf(10, from);
        const complete = newline >= from && newline < bytesRead;
        const until = complete ? newline : bytesRead;
        const size = until - from;
        bytes += size;
        if (bytes > maxLineBytes) { oversized = true; parts = []; }
        if (!oversized && size) parts.push(Buffer.from(buffer.subarray(from, until)));
        if (complete) {
          yield { line: oversized ? null : Buffer.concat(parts, bytes).toString("utf8"), end: position + until + 1, complete: true };
          parts = [];
          bytes = 0;
          oversized = false;
        }
        from = until + (complete ? 1 : 0);
      }
      position += bytesRead;
    }
    if (bytes || oversized) yield { line: oversized ? null : Buffer.concat(parts, bytes).toString("utf8"), end: position, complete: false };
  } finally {
    await handle.close();
  }
}
