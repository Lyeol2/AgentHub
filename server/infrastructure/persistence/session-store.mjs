import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../../config.mjs";
import { handoverText } from "../../handover.mjs";
import { sessionReadState } from "../../session-read.mjs";
import { readJsonFile, writeJsonAtomic, quarantine } from "./json-file.mjs";
import { JournalWriter } from "./journal-writer.mjs";
import { replaySessionJournal } from "./session-journal.mjs";

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
  if (session.taskId || session.worktree?.shared) return false;
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

// 세션은 메모리에 두고 변경분을 worker 저널에, 명시적 저장은 JSON 스냅샷에 기록한다.
export class SessionStore {
  constructor({ dataDir = DATA_DIR } = {}) {
    this.directory = path.join(dataDir, "sessions");
    this.sessions = new Map();
    this.timers = new Map();
    this.journals = new Map();
    this.checkpoints = new Set();
    this.writer = new JournalWriter();
    this.persistenceError = null;
    fs.mkdirSync(this.directory, { recursive: true });
    for (const file of fs.readdirSync(this.directory)) {
      // 저장 도중 꺼져 남은 임시 파일. 원래 파일은 이전 내용 그대로다.
      if (file.endsWith(".tmp")) { fs.rmSync(path.join(this.directory, file), { force: true }); continue; }
      if (!file.endsWith(".json")) continue;
      // 깨진 파일 하나 때문에 시작이 실패하지 않도록 data/corrupted로 옮기고 나머지 세션으로 시작한다.
      const session = readJsonFile(path.join(this.directory, file), { dataDir, fallback: () => null, valid: validSession });
      if (!session) continue;
      const generation = session._journalGeneration ?? "legacy";
      let revision = session._journalRevision ?? 0;
      delete session._journalGeneration;
      delete session._journalRevision;
      let replayed = false;
      try { ({ changed: replayed, revision } = replaySessionJournal(this.journalFile(session.id), session, generation, revision)); }
      catch (error) {
        const moved = quarantine(this.journalFile(session.id), dataDir);
        // Preserve the valid prefix before beginning a new journal generation.
        replayed = true;
        console.warn(`[agenthub] Session journal could not be fully restored: ${session.id} (${error.message})${moved ? ` → ${moved}` : ""}`);
      }
      this.journals.set(session.id, { generation, revision, count: session.events.length, full: false, patches: new Set() });
      // 서버가 꺼질 때 실행 중이던 턴은 중단된 것으로 보고 타이머도 종료한다.
      // 백그라운드 작업 중이던 세션도 CLI가 함께 끝났으므로 중단된 것이다.
      const interrupted = session.state === "running" || session.state === "background";
      // 서버가 꺼지며 CLI와 함께 끝난 하위 작업
      const cut = (session.subtasks ?? []).filter((task) => task.status === "running");
      for (const task of cut) Object.assign(task, { status: "interrupted", endedAt: task.endedAt ?? session.updatedAt ?? null });
      const staleTimer = session.runningStartedAt != null;
      if (interrupted) session.state = "interrupted";
      if (interrupted || staleTimer) session.runningStartedAt = null;
      // 실행 중 진행 표시(시작 단계·마지막 출력 시각)는 남은 실행이 없으므로 지운다.
      if (interrupted || staleTimer) { delete session.runPhase; delete session.lastOutputAt; }
      const migrated = useProjectFolder(session);
      this.sessions.set(session.id, session);
      if (replayed || migrated || interrupted || staleTimer || cut.length) this.flush(session.id);
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

  touch(session, { appendOnly = false, metadataOnly = false, event } = {}) {
    session.updatedAt = new Date().toISOString();
    const state = this.journals.get(session.id);
    if (state) {
      if (event) {
        const index = session.events[event.seq] === event ? event.seq : session.events.indexOf(event);
        if (index >= 0) state.patches.add(index);
        else state.full = true;
      } else if (!appendOnly && !metadataOnly) state.full = true;
    }
    if (this.timers.has(session.id)) return;
    this.timers.set(session.id, setTimeout(() => this.flushJournal(session.id), 500));
  }

  journalFile(id) { return path.join(this.directory, `${id}.journal.jsonl`); }

  flushJournal(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const session = this.sessions.get(id);
    const state = this.journals.get(id);
    if (!session || !state) return Promise.resolve();
    // One transferred record per session at a time. Further changes stay in the
    // live session and are captured together when the worker catches up.
    if (state.saving) return state.next ??= state.saving.then(() => {
      state.next = null;
      if (this.journals.get(id) === state) return this.flushJournal(id);
    });
    const { events, ...metadata } = session;
    const from = state.full || state.count > events.length ? 0 : state.count;
    const record = { generation: state.generation, revision: ++state.revision, metadata, from, events: events.slice(from),
      patches: from ? [...state.patches].filter(index => index < from).map(index => ({ index, event: events[index] })) : [] };
    let saving;
    try { saving = this.writer.append(this.journalFile(id), record); }
    catch (error) { saving = Promise.reject(error); }
    state.count = events.length;
    state.full = false;
    state.patches.clear();
    state.saving = saving.catch(error => {
      state.full = true;
      this.persistenceError = error;
      console.error(`[agenthub] Could not save session ${id}: ${error.message}`);
    }).finally(() => { state.saving = null; });
    return state.saving;
  }

  flush(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const session = this.sessions.get(id);
    if (!session) return;
    this.checkpoints.add(id);
    this.writer.drainSync({ ignoreFailure: true });
    const generation = randomUUID();
    writeJsonAtomic(path.join(this.directory, `${id}.json`), { ...session, _journalGeneration: generation });
    this.journals.set(id, { generation, revision: 0, count: session.events.length, full: false, patches: new Set() });
    fs.rmSync(this.journalFile(id), { force: true });
    this.checkpoints.delete(id);
  }

  // 파일을 먼저 지운다. 파일을 못 지웠는데(다른 프로그램이 잡고 있는 등) 목록에서만 빠지면 다음 실행 때 되살아난다.
  remove(id) {
    const dirty = this.timers.has(id) || this.checkpoints.has(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.writer.drainSync({ ignoreFailure: true });
    // If either unlink fails, the remaining snapshot must still contain every
    // durable event. Checkpoint first so a partial deletion cannot lose deltas.
    if (dirty || fs.existsSync(this.journalFile(id))) this.flush(id);
    fs.rmSync(path.join(this.directory, `${id}.json`), { force: true, maxRetries: 3 });
    fs.rmSync(this.journalFile(id), { force: true, maxRetries: 3 });
    this.sessions.delete(id);
    this.journals.delete(id);
    this.checkpoints.delete(id);
  }

  flushAll() {
    for (const id of this.sessions.keys()) this.flush(id);
  }

  async close() {
    // Flush only dirty sessions. Clean, potentially large histories need no rewrite.
    await Promise.all([...this.timers.keys()].map(id => this.flushJournal(id)));
    await Promise.all([...this.journals.values()].map(state => state.next ?? state.saving));
    try { await this.writer.close(); }
    catch {
      // A failed journal cannot prevent a final durable snapshot of current state.
      this.writer.drainSync({ ignoreFailure: true });
      for (const id of this.sessions.keys()) this.flush(id);
    }
    for (const id of this.checkpoints) this.flush(id);
  }
}

// 폴더의 지금 브랜치. git을 실행하지 않고 HEAD 파일만 읽는다. 브랜치가 아니거나(분리된 HEAD) Git 폴더가 아니면 null.
function currentBranch(cwd) {
  try {
    const dotgit = path.join(cwd, ".git");
    const gitdir = fs.statSync(dotgit).isDirectory() ? dotgit : path.resolve(cwd, fs.readFileSync(dotgit, "utf8").match(/^gitdir: (.+)\s*$/m)[1].trim());
    const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice(16) : null;
  } catch { return null; }
}

// 목록에 쓰는 요약. 이벤트와 AI를 바꿀 때 넘길 긴 기록(handover)은 빼고, 넘길 것이 있는지만 알린다.
// 원본 폴더에서 일하는 세션은 원본 폴더의 지금 브랜치를 함께 알려, 다른 작업이 브랜치를 바꿨는지 볼 수 있게 한다.
export function summary(session) {
  const { events, handover, subtasks, ...rest } = session;
  const branch = !session.chat && !session.worktree && session.cwd ? currentBranch(session.cwd) : null;
  // 목록에는 하위 작업 수만 싣는다(작업 목록·최근 활동은 세션 상세에 있다).
  const subtaskCount = subtasks?.length ? { running: subtasks.filter((task) => task.status === "running" && !task.ambient).length, total: subtasks.length } : null;
  return { ...rest, ...sessionReadState(session), locked: !!session.locked, eventCount: events.length, handoverPending: !!handover, ...(branch ? { branch } : {}), ...(subtaskCount ? { subtaskCount } : {}) };
}
