import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.mjs";

const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

// 세션은 메모리에 두고 변경 시 data/sessions/<id>.json에 저장한다.
export class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.timers = new Map();
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith(".json")) continue;
      const session = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
      // 서버가 꺼질 때 실행 중이던 턴은 중단된 것으로 본다.
      if (session.state === "running") session.state = "interrupted";
      this.sessions.set(session.id, session);
    }
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id) {
    return this.sessions.get(id);
  }

  add(session) {
    this.sessions.set(session.id, session);
    this.flush(session.id);
  }

  touch(session) {
    session.updatedAt = new Date().toISOString();
    if (this.timers.has(session.id)) return;
    this.timers.set(session.id, setTimeout(() => this.flush(session.id), 500));
  }

  flush(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const session = this.sessions.get(id);
    if (session) fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify(session, null, 2));
  }

  remove(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.sessions.delete(id);
    fs.rmSync(path.join(SESSIONS_DIR, `${id}.json`), { force: true });
  }

  flushAll() {
    for (const id of this.sessions.keys()) this.flush(id);
  }
}

export function summary(session) {
  const { events, ...rest } = session;
  return { ...rest, eventCount: events.length };
}
