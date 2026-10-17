import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./json-file.mjs";

// 받은 작업(GitHub 이슈)과 그 작업을 맡은 AgentHub 세션의 연결. 작업 내용 자체는 GitHub에만 둔다.
export class FileIssueLinkStore {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, "issue-links.json");
    // 손상된 항목 하나 때문에 다른 연결까지 잃지 않도록 형식이 맞는 항목만 되살린다.
    this.items = readJsonFile(this.file, { dataDir, fallback: () => [], valid: Array.isArray })
      .filter((item) => item && typeof item.repo === "string" && Number.isSafeInteger(Number(item.number)) && Number(item.number) > 0)
      .map((item) => ({ ...item, number: Number(item.number), sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.filter((id) => typeof id === "string") : [] }))
      .filter((item) => item.sessionIds.length);
  }

  static key(repo, number) { return String(repo).toLowerCase() + "#" + Number(number); }

  list() { return this.items; }

  find(repo, number) {
    const key = FileIssueLinkStore.key(repo, number);
    return this.items.find((item) => FileIssueLinkStore.key(item.repo, item.number) === key) ?? null;
  }

  bySession(sessionId) {
    return this.items.find((item) => item.sessionIds.includes(sessionId)) ?? null;
  }

  upsert(repo, number, change) {
    let item = this.find(repo, number);
    if (!item) {
      item = { repo, number: Number(number), sessionIds: [], progress: true, done: false };
      this.items.push(item);
    }
    Object.assign(item, change);
    this.save();
    return item;
  }

  // 세션을 다시 만들면(대화 이어 가기 등) 새 세션이 연결을 이어 받는다.
  replaceSession(previous, next) {
    let changed = false;
    for (const item of this.items) {
      if (!item.sessionIds.includes(previous)) continue;
      item.sessionIds = [...new Set(item.sessionIds.map((id) => id === previous ? next : id))];
      changed = true;
    }
    if (changed) this.save();
  }

  // 지운 세션은 연결에서 뺀다. 남은 세션이 없으면 연결도 지운다.
  dropSession(sessionId) {
    const before = this.items.length;
    let changed = false;
    for (const item of this.items) {
      if (!item.sessionIds.includes(sessionId)) continue;
      item.sessionIds = item.sessionIds.filter((id) => id !== sessionId);
      changed = true;
    }
    this.items = this.items.filter((item) => item.sessionIds.length);
    if (changed || before !== this.items.length) this.save();
  }

  save() {
    writeJsonAtomic(this.file, this.items);
  }
}
