import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "./json-file.mjs";

export class FileRunHistoryRepository {
  constructor(dataDir, validRuns) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "run-history.json");
    this.directory = path.join(dataDir, "run-history");
    this.validRuns = validRuns;
    this.ids = [];
  }

  path(id) { return path.join(this.directory, createHash("sha256").update(id).digest("hex") + ".json"); }

  load() {
    const saved = readJsonFile(this.file, { dataDir: this.dataDir, fallback: () => [],
      valid: value => this.validRuns(value) || (value?.version === 2 && Array.isArray(value.ids) && value.ids.every(id => typeof id === "string")) });
    this.legacy = Array.isArray(saved);
    if (this.legacy) return saved;
    this.ids = [...new Set(saved.ids)];
    return this.ids.flatMap(id => {
      const run = readJsonFile(this.path(id), { dataDir: this.dataDir, fallback: () => null,
        valid: value => value?.id === id && this.validRuns([value]) });
      return run ? [run] : [];
    });
  }

  save(runs, dirty) {
    const ids = runs.map(run => run.id);
    for (const run of runs) if (this.legacy || dirty.has(run.id)) writeJsonAtomic(this.path(run.id), run);
    if (this.legacy || ids.length !== this.ids.length || ids.some((id, i) => id !== this.ids[i])) {
      // Publish the index only after every referenced record is durable.
      writeJsonAtomic(this.file, { version: 2, ids });
      const kept = new Set(ids);
      for (const id of this.ids) if (!kept.has(id)) fs.rmSync(this.path(id), { force: true });
      this.ids = ids;
      this.legacy = false;
    }
  }
}
