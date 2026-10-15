import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.mjs";

export { hasSessionLink } from "./policies/messaging.mjs";

// 세션 사이의 연결(넘기기 규칙). data/links.json 하나에 저장한다.
export class LinkStore {
  constructor({ dataDir = DATA_DIR } = {}) {
    this.file = path.join(dataDir, "links.json");
    this.links = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : [];
  }

  list() {
    return this.links;
  }

  get(id) {
    return this.links.find((l) => l.id === id);
  }

  from(sessionId) {
    return this.links.filter((l) => l.from === sessionId);
  }

  add(link) {
    this.links.push(link);
    this.save();
  }

  update(link, changes) {
    Object.assign(link, changes);
    this.save();
  }

  remove(id) {
    this.links = this.links.filter((l) => l.id !== id);
    this.save();
  }

  removeForSession(sessionId) {
    const before = this.links.length;
    this.links = this.links.filter((l) => l.from !== sessionId && l.to !== sessionId);
    if (this.links.length !== before) this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.links, null, 2));
  }
}
