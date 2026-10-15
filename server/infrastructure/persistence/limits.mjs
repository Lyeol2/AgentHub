import fs from "node:fs";
import path from "node:path";

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
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(saved, null, 2));
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
  constructor({ codexDir }) {
    this.directory = path.join(codexDir, "sessions");
  }

  recentFiles(limit = 40) {
    if (!fs.existsSync(this.directory)) return [];
    const files = [];
    const desc = (directory) => fs.readdirSync(directory).sort().reverse();
    for (const year of desc(this.directory)) {
      for (const month of desc(path.join(this.directory, year))) {
        for (const day of desc(path.join(this.directory, year, month))) {
          const directory = path.join(this.directory, year, month, day);
          for (const name of fs.readdirSync(directory)) {
            if (name.endsWith(".jsonl")) files.push(path.join(directory, name));
          }
          if (files.length >= limit) break;
        }
        if (files.length >= limit) break;
      }
      if (files.length >= limit) break;
    }
    return files.map((file) => ({ file, mtime: fs.statSync(file).mtimeMs })).sort((left, right) => right.mtime - left.mtime);
  }

  tail(file) {
    const descriptor = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(descriptor).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
  }

  *recentTails() {
    for (const { file } of this.recentFiles()) {
      let text;
      try { text = this.tail(file); }
      catch { continue; }
      yield text;
    }
  }
}
