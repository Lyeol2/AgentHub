import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../config.mjs";
import { handoverText } from "../../handover.mjs";
import { readJsonFile, writeJsonAtomic } from "./json-file.mjs";

const validSession = (session) => typeof session?.id === "string" && typeof session.updatedAt === "string";

// 사용 중인 worktree는 재시작해도 유지한다. 폴더가 없거나 메타데이터가 없는 이전 세션만 원본으로 인계한다.
export function useProjectFolder(session) {
  if (session.chat || !session.projectPath) return false;
  const key = (folder) => {
    const resolved = path.resolve(folder);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  if (session.worktree?.dir && fs.existsSync(session.worktree.dir) && fs.statSync(session.worktree.dir).isDirectory()) {
    if (session.cwd && key(session.cwd) === key(session.worktree.dir)) return false;
    session.cwd = session.worktree.dir;
    return true;
  }
  // 작업 폴더가 정리되거나 사라져도 작업 세션을 원본 브랜치로 옮기지 않는다.
  // 실행 가능 여부는 작업 서비스가 판정하며, 대화 기록은 원래 작업에 남긴다.
  if (session.taskId) return false;
  const previousCwd = session.worktree?.dir || session.cwd;
  const moved = !!previousCwd && key(previousCwd) !== key(session.projectPath);
  if (!moved && !session.worktree) {
    if (session.cwd) return false;
    session.cwd = session.projectPath;
    return true;
  }
  const previousBranch = session.worktree?.branch;
  if (session.worktree) session.previousWorktree = session.worktree;
  session.previousCwd = previousCwd;
  session.cwd = session.projectPath;
  session.worktree = null;
  if (moved) {
    // CLI resume은 이전 폴더를 다시 쓸 수 있으므로 기록을 인계하고 새 대화를 시작한다.
    session.cliSessionIds = [...new Set([...(session.cliSessionIds ?? []), session.agentSessionId].filter(Boolean))];
    session.handover = [handoverText(session, "", { previousCwd, previousBranch }), session.handover].filter(Boolean).join("\n\n");
    session.agentSessionId = null;
    session.compactions = 0;
    session.context = null;
    session.waiting = false;
    delete session.roleChanged;
  }
  session.events.push({
    seq: session.events.length,
    ts: new Date().toISOString(),
    kind: "status",
    text: `작업 폴더를 프로젝트 원본(${session.projectPath})으로 바꿨습니다. 이전 폴더(${previousCwd})와 브랜치는 그대로 남아 있으며 변경은 자동으로 합치지 않았습니다.`,
  });
  return true;
}

// 세션은 메모리에 두고 변경 시 data/sessions/<id>.json에 저장한다.
export class SessionStore {
  constructor({ dataDir = DATA_DIR } = {}) {
    this.directory = path.join(dataDir, "sessions");
    this.sessions = new Map();
    this.timers = new Map();
    fs.mkdirSync(this.directory, { recursive: true });
    for (const file of fs.readdirSync(this.directory)) {
      // 저장 도중 꺼져 남은 임시 파일. 원래 파일은 이전 내용 그대로다.
      if (file.endsWith(".tmp")) { fs.rmSync(path.join(this.directory, file), { force: true }); continue; }
      if (!file.endsWith(".json")) continue;
      // 깨진 파일 하나 때문에 시작이 실패하지 않도록 data/corrupted로 옮기고 나머지 세션으로 시작한다.
      const session = readJsonFile(path.join(this.directory, file), { dataDir, fallback: () => null, valid: validSession });
      if (!session) continue;
      // 서버가 꺼질 때 실행 중이던 턴은 중단된 것으로 보고 타이머도 종료한다.
      const interrupted = session.state === "running";
      const staleTimer = session.runningStartedAt != null;
      if (interrupted) session.state = "interrupted";
      if (interrupted || staleTimer) session.runningStartedAt = null;
      const migrated = useProjectFolder(session);
      this.sessions.set(session.id, session);
      if (migrated || interrupted || staleTimer) this.flush(session.id);
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
    if (session) writeJsonAtomic(path.join(this.directory, `${id}.json`), session);
  }

  // 파일을 먼저 지운다. 파일을 못 지웠는데(다른 프로그램이 잡고 있는 등) 목록에서만 빠지면 다음 실행 때 되살아난다.
  remove(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    fs.rmSync(path.join(this.directory, `${id}.json`), { force: true, maxRetries: 3 });
    this.sessions.delete(id);
  }

  flushAll() {
    for (const id of this.sessions.keys()) this.flush(id);
  }
}

// 목록에 쓰는 요약. 이벤트와 AI를 바꿀 때 넘길 긴 기록(handover)은 빼고, 넘길 것이 있는지만 알린다.
export function summary(session) {
  const { events, handover, ...rest } = session;
  return { ...rest, eventCount: events.length, handoverPending: !!handover };
}
