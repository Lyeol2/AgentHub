import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "./json-file.mjs";

const TAIL_BYTES = 512 * 1024;

export class FileLimitsRepository {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, "limits.json");
  }

  load() {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch { return {}; }
  }

  save(saved) {
    writeJsonAtomic(this.file, saved);
  }
}

export class FileClaudeCredentials {
  constructor({ claudeDir }) {
    this.file = path.join(claudeDir, ".credentials.json");
  }

  read() {
    return JSON.parse(fs.readFileSync(this.file, "utf8")).claudeAiOauth;
  }
}

// Codex가 날짜별로 남기는 최근 실행 기록의 끝부분만 읽는다.
export class FileCodexRollouts {
  constructor({ codexDir, now = Date.now, cacheMs = 5000 }) {
    this.directory = path.join(codexDir, "sessions");
    this.now = now;
    this.cacheMs = cacheMs;
    this.files = null;
    this.checkedAt = 0;
    this.scanFlight = null;
    this.tails = new Map();
  }

  async recentFiles(limit = 40, { fresh = false } = {}) {
    limit = Math.max(0, Math.min(40, Math.floor(limit)));
    if (!limit) return [];
    if (this.files && !fresh && this.now() - this.checkedAt < this.cacheMs) return this.files.slice(0, limit);
    this.scanFlight ??= this.scanFiles().finally(() => { this.scanFlight = null; });
    return (await this.scanFlight).slice(0, limit);
  }

  async scanFiles() {
    const files = [];
    const pending = [this.directory];
    // An older thread can be resumed today. Sort by actual mtime across all
    // dates, retaining only the newest 40 candidates and eight stat calls.
    while (pending.length) {
      const directory = pending.pop();
      let entries;
      try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
      const candidates = [];
      for (const entry of entries) {
        if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) candidates.push(path.join(directory, entry.name));
      }
      for (let offset = 0; offset < candidates.length; offset += 8) {
        const batch = await Promise.all(candidates.slice(offset, offset + 8).map(async file => {
          try { const stat = await fs.promises.stat(file); return { file, mtime: stat.mtimeMs, size: stat.size }; }
          catch { return null; }
        }));
        for (const item of batch) {
          if (!item) continue;
          files.push(item);
          files.sort((left, right) => right.mtime - left.mtime || left.file.localeCompare(right.file));
          if (files.length > 40) files.pop();
        }
      }
    }
    this.files = files;
    this.checkedAt = this.now();
    const keep = new Set(files.map(item => item.file));
    for (const file of this.tails.keys()) if (!keep.has(file)) this.tails.delete(file);
    return files;
  }

  async tail(file) {
    const descriptor = await fs.promises.open(file, "r");
    try {
      const { size, mtimeMs } = await descriptor.stat();
      const cached = this.tails.get(file);
      if (cached?.size === size && cached.mtimeMs === mtimeMs) return cached.text;
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await descriptor.read(buffer, filled, buffer.length - filled, start + filled);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      const text = buffer.subarray(0, filled).toString("utf8");
      this.tails.delete(file);
      this.tails.set(file, { size, mtimeMs, text });
      while (this.tails.size > 40) this.tails.delete(this.tails.keys().next().value);
      return text;
    } finally {
      await descriptor.close();
    }
  }

  async *recentTails(options) {
    for (const { file } of await this.recentFiles(40, options)) {
      let text;
      try { text = await this.tail(file); }
      catch { continue; }
      yield text;
    }
  }
}
