import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "../../config.mjs";

// 프로젝트별 공유 노트 저장소. 파일 형식은 기존 SHA-1 이름의 Markdown을 유지한다.
export class FileBoardRepository {
  constructor({ dataDir = DATA_DIR } = {}) {
    this.directory = path.join(dataDir, "boards");
  }

  file(projectPath) {
    const key = createHash("sha1").update(path.resolve(projectPath).toLowerCase()).digest("hex").slice(0, 16);
    return path.join(this.directory, key + ".md");
  }

  read(projectPath) {
    try { return fs.readFileSync(this.file(projectPath), "utf8"); }
    catch { return ""; }
  }

  write(projectPath, text) {
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(this.file(projectPath), text);
  }

  clear(projectPath) {
    fs.rmSync(this.file(projectPath), { force: true });
  }
}
