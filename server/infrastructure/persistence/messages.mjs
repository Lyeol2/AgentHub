import path from "node:path";
import { DATA_DIR } from "../../config.mjs";
import { readJsonFile, writeJsonAtomic } from "./json-file.mjs";

// 메시지 기록 파일의 위치와 읽기·쓰기만 담당한다.
export class FileMessageLog {
  constructor({ dataDir = DATA_DIR } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "messages.json");
  }

  list() {
    return readJsonFile(this.file, { dataDir: this.dataDir, fallback: () => [], valid: Array.isArray });
  }

  save(entries) {
    writeJsonAtomic(this.file, entries);
  }
}
