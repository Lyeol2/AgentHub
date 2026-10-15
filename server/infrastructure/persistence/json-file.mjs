import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const RENAME_RETRIES = 5;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 임시 파일에 다 쓰고 디스크에 내린 뒤 이름을 바꾼다.
// 강제 종료되어도 원래 파일은 이전 내용 그대로 남고, NUL로 채워진 반쪽 파일이 생기지 않는다.
export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const descriptor = fs.openSync(temp, "w");
    try {
      fs.writeSync(descriptor, text);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    // Windows에서는 백신·검색 색인이 대상 파일을 잠깐 잡고 있으면 이름 바꾸기가 실패한다.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temp, file); return; }
      catch (error) {
        if (attempt >= RENAME_RETRIES || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        pause(20 * (attempt + 1));
      }
    }
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

// 읽을 수 없는 파일을 data/corrupted/<시각>/<원래 상대 경로>로 옮긴다. 옮기지 못하면 그대로 둔다.
export function quarantine(file, dataDir) {
  const relative = path.relative(dataDir, file);
  const inside = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dataDir, "corrupted", stamp, inside ? relative : path.basename(file));
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(file, target);
    return target;
  } catch {
    return null;
  }
}

// JSON 파일을 읽는다. 없으면 fallback, 깨졌거나 valid()를 통과하지 못하면 격리하고 경고한 뒤 fallback.
// 파일 하나가 깨졌다고 서버 시작 전체가 실패하지 않게 한다.
export function readJsonFile(file, { dataDir, fallback, valid = () => true }) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return fallback();
    throw error;
  }
  let reason;
  try {
    const value = JSON.parse(text);
    if (valid(value)) return value;
    reason = "형식이 올바르지 않습니다";
  } catch (error) {
    reason = text.includes("\0") ? "NUL 바이트로 채워져 있습니다" : error.message;
  }
  const moved = quarantine(file, dataDir);
  console.warn(`[agenthub] 읽을 수 없는 데이터 파일을 건너뜁니다: ${file} (${reason})${moved ? ` → ${moved}` : ""}`);
  return fallback();
}
