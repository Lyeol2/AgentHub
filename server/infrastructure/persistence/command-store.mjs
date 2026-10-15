import path from "node:path";
import { DATA_DIR } from "../../config.mjs";
import { readJsonFile, writeJsonAtomic } from "./json-file.mjs";

// ── 저장 ───────────────────────────────────────────────────────
export class CommandStore {
  constructor({ dataDir = DATA_DIR } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "commands.json");
    this.commands = readJsonFile(this.file, { dataDir, fallback: () => [], valid: Array.isArray });
    // 서버가 꺼질 때 실행 중이던 명령은 중단된 것으로 본다.
    for (const c of this.commands) if (c.state === "running") c.state = "error";
  }

  list(projectPath) {
    if (!projectPath) return this.commands;
    const key = path.resolve(projectPath).toLowerCase();
    return this.commands.filter((c) => path.resolve(c.projectPath).toLowerCase() === key);
  }

  get(id) {
    return this.commands.find((c) => c.id === id);
  }

  add(command) {
    this.commands.push(command);
    this.save();
  }

  update(command, changes) {
    Object.assign(command, changes);
    this.save();
  }

  remove(id) {
    this.commands = this.commands.filter((c) => c.id !== id);
    this.save();
  }

  save() {
    writeJsonAtomic(this.file, this.commands);
  }
}

