import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../config.mjs";

// 메시지 기록 파일의 위치와 읽기·쓰기만 담당한다.
export class FileMessageLog {
  constructor({ dataDir = DATA_DIR } = {}) {
    this.file = path.join(dataDir, "messages.json");
  }

  list() {
    return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : [];
  }

  save(entries) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(entries, null, 2));
  }
}
