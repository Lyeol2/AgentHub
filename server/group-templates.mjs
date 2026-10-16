import path from "node:path";
import { DATA_DIR } from "./config.mjs";
import { readJsonFile, writeJsonAtomic } from "./infrastructure/persistence/json-file.mjs";

const validTemplate = (item) => item && typeof item.id === "string" && typeof item.title === "string"
  && item.version === 1 && Array.isArray(item.nodes) && Array.isArray(item.links) && item.group;

// Reusable definitions are separate from project containers and executable run history.
export class GroupTemplateStore {
  constructor({ dataDir = DATA_DIR } = {}) {
    this.file = path.join(dataDir, "group-templates.json");
    this.templates = readJsonFile(this.file, { dataDir, fallback: () => [],
      valid: (value) => Array.isArray(value) && value.every(validTemplate) });
  }
  list() { return this.templates; }
  get(id) { return this.templates.find((item) => item.id === id); }
  add(item) { this.templates.push(item); this.save(); return item; }
  remove(id) { this.templates = this.templates.filter((item) => item.id !== id); this.save(); }
  save() { writeJsonAtomic(this.file, this.templates); }
}
