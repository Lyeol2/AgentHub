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
    for (const c of this.commands) if (c.kind === "schedule") {
      // 예약 사용 여부와 예정 시각은 복원을 위해 유지한다. 타이머는 서버 시작 시 다시 만든다.
      c.scheduleEnabled = c.scheduleEnabled === true;
      c.state = c.scheduleEnabled ? "scheduled" : c.state === "scheduled" ? "idle" : c.state;
      if (!c.scheduleEnabled) c.nextRunAt = null;
      c.live = null;
      c.queued = null;
    } else if (c.kind === "watch") {
      // 파일 감시는 서버 재시작 후 사용자가 다시 켜야 한다.
      c.state = "idle";
      c.live = null;
      c.queued = null;
    } else if (c.state === "running") {
      c.state = "error";
      if (["input", "repeat", "transform", "notify", "webhook", "group"].includes(c.kind)) {
        c.lastRun = { ...c.live, ok: false, exitCode: 1, stopped: true, tail: "앱이 종료되어 흐름 실행이 중단되었습니다. 다시 실행하세요." };
        c.live = null;
        c.queued = null;
      }
      if (c.kind === "git") {
        const output = "앱이 종료되어 Git 작업 결과를 확인할 수 없습니다. 브랜치와 작업 폴더 상태를 확인한 뒤 다시 실행하세요.";
        c.lastRun = { ...c.live, ok: false, exitCode: 1, stopped: true, tail: output,
          gitResult: { ok: false, reason: "outcome-unknown", output, recoveryRequired: true } };
        c.live = null;
        c.queued = null;
      }
    }
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

