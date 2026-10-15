import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { HttpError } from "./application/errors.mjs";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;
export const IMAGE_BODY_LIMIT = 14_100_000;
const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const inside = (base, file) => {
  const relative = path.relative(base, file);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

function imageType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0) return "image/gif";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function publicAttachment({ id, name, mimeType, size, url }) {
  return { id, name, mimeType, size, url };
}

// Client-supplied paths are never used. Each session owns a separate image directory.
export class AttachmentStore {
  constructor({ dataDir }) {
    this.dataDir = path.resolve(dataDir);
    this.root = path.join(this.dataDir, "attachments");
  }

  folder(sessionId, create = false) {
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) throw new HttpError(400, "세션 ID가 올바르지 않습니다.");
    const dir = path.join(this.root, sessionId);
    if (create) fs.mkdirSync(this.dataDir, { recursive: true });
    for (const part of [this.root, dir]) {
      if (!fs.existsSync(part)) {
        if (!create) throw new HttpError(404, "첨부 이미지를 찾지 못했습니다.");
        fs.mkdirSync(part);
      }
      if (fs.lstatSync(part).isSymbolicLink() || !fs.statSync(part).isDirectory() || !inside(fs.realpathSync(this.dataDir), fs.realpathSync(part))) throw new HttpError(400, "첨부 이미지 폴더가 올바르지 않습니다.");
    }
    return dir;
  }

  save(sessionId, { name, mimeType, data } = {}) {
    if (!Object.hasOwn(TYPES, mimeType)) throw new HttpError(400, "PNG·JPEG·GIF·WebP 이미지만 첨부할 수 있습니다.");
    if (typeof data !== "string" || !data) throw new HttpError(400, "이미지 데이터를 입력하세요.");
    if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new HttpError(413, "이미지는 파일당 10MB까지 첨부할 수 있습니다.");
    if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new HttpError(400, "이미지 데이터가 올바른 base64 형식이 아닙니다.");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "이미지는 파일당 10MB까지 첨부할 수 있습니다.");
    if (bytes.toString("base64") !== data || imageType(bytes) !== mimeType) throw new HttpError(400, "이미지 내용과 파일 형식이 일치하지 않습니다.");
    const id = randomBytes(16).toString("hex");
    const descriptor = {
      id, name: String(name ?? "이미지").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) || "이미지",
      mimeType, size: bytes.length,
      url: "/api/sessions/" + encodeURIComponent(sessionId) + "/attachments/" + id,
    };
    const dir = this.folder(sessionId, true);
    const file = path.join(dir, id + "." + TYPES[mimeType]);
    fs.writeFileSync(file, bytes, { flag: "wx" });
    try { fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(descriptor), { flag: "wx" }); }
    catch (err) { fs.rmSync(file); throw err; }
    return descriptor;
  }

  resolve(sessionId, id) {
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new HttpError(400, "첨부 이미지 ID가 올바르지 않습니다.");
    const dir = this.folder(sessionId);
    const metadata = path.join(dir, id + ".json");
    if (!fs.existsSync(metadata)) throw new HttpError(404, "첨부 이미지를 찾지 못했습니다.");
    if (!fs.lstatSync(metadata).isFile() || fs.lstatSync(metadata).isSymbolicLink()) throw new HttpError(400, "첨부 이미지가 올바르지 않습니다.");
    const descriptor = JSON.parse(fs.readFileSync(metadata, "utf8"));
    if (descriptor.id !== id || !Object.hasOwn(TYPES, descriptor.mimeType)) throw new HttpError(400, "첨부 이미지 정보가 올바르지 않습니다.");
    const file = path.join(dir, id + "." + TYPES[descriptor.mimeType]);
    if (!fs.existsSync(file)) throw new HttpError(404, "첨부 이미지를 찾지 못했습니다.");
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || !inside(fs.realpathSync(dir), fs.realpathSync(file))) throw new HttpError(400, "첨부 이미지가 올바르지 않습니다.");
    return { ...publicAttachment(descriptor), path: file };
  }

  resolveAll(sessionId, ids = []) {
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS) throw new HttpError(400, "이미지는 요청당 4장까지 첨부할 수 있습니다.");
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "같은 이미지를 중복 첨부할 수 없습니다.");
    return ids.map((id) => this.resolve(sessionId, id));
  }

  remove(sessionId) {
    let dir;
    try { dir = this.folder(sessionId); } catch (err) { if (err.status === 404) return; throw err; }
    // Verify the absolute target before recursive removal.
    if (!inside(this.root, dir) || path.dirname(dir) !== this.root) throw new Error("잘못된 첨부 폴더입니다.");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
