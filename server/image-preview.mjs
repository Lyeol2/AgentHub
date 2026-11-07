// 이미지 미리보기 노드: 연결로 넘어온 글(handoff의 전달 내용·답변·명령 출력)에서 이미지 경로를 찾아 보여 준다.
// 순수 규칙(경로 찾기)과 파일 검사(허용 폴더·크기)만 둔다. 실행 흐름은 chain.mjs, 화면 주소는 application/commands.mjs가 맡는다.
import fs from "node:fs";
import path from "node:path";
import { MAX_ARTIFACT_BYTES } from "./session-artifacts.mjs";

export const IMAGE_PREVIEW_MIMES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp" };
export const IMAGE_PREVIEW_MAX = 20; // 한 번에 보이는 이미지
export const IMAGE_HISTORY_MAX = 10; // 남겨 두는 받은 기록
const EXT = "png|jpe?g|gif|webp|avif|bmp";
const WHOLE = new RegExp(`\\.(?:${EXT})$`, "i");
// 공백 없는 경로 조각(드라이브 경로, ./ ../ 상대 경로, 폴더/파일)
const TOKEN = new RegExp(`(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/])?[^\\s"'<>|*?\`()\\[\\]]*\\.(?:${EXT})(?![\\w.])`, "gi");

const comparable = (value) => (process.platform === "win32" ? value.toLowerCase() : value).replace(/\\/g, "/");
const within = (root, target) => {
  const rel = path.relative(root, target);
  return !rel || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
};

function clean(value) {
  let text = String(value ?? "").trim();
  text = text.replace(/^file:\/\/\/?/i, "");
  try { if (/%[0-9a-f]{2}/i.test(text)) text = decodeURIComponent(text); } catch { /* 그대로 둔다 */ }
  return text.replace(/^<|>$/g, "").replace(/^["'`]+|["'`.,;:]+$/g, "").trim();
}

// 글에서 이미지 경로를 순서대로 꺼낸다(같은 경로는 하나만, 최대 IMAGE_PREVIEW_MAX개).
// 한 줄 전체가 경로이면 공백이 든 경로도 받는다. 그 밖에는 Markdown 링크·이미지의 주소와 공백 없는 경로 조각을 찾는다.
export function extractImagePaths(text) {
  const found = [];
  const seen = new Set();
  const add = (value) => {
    const item = clean(value);
    if (!item || !WHOLE.test(item) || /^[a-z][\w+.-]*:\/\//i.test(item) || /^data:/i.test(item)) return;
    const key = comparable(item);
    if (seen.has(key) || found.length >= IMAGE_PREVIEW_MAX) return;
    seen.add(key);
    found.push(item);
  };
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "");
    if (!line) continue;
    const links = [...line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)>]+?)>?(?:\s+"[^"]*")?\s*\)/g)];
    if (links.length) { for (const m of links) add(m[1]); continue; }
    const whole = clean(line);
    if (WHOLE.test(whole) && !/\s{2,}/.test(whole) && !/[:：]\s/.test(whole)) { add(whole); continue; }
    for (const m of line.matchAll(TOKEN)) add(m[0]);
  }
  return found;
}

// 경로를 실제 파일로 확인한다. base: 상대 경로의 기준(보낸 세션의 작업 폴더), roots: 열 수 있는 폴더.
// 성공하면 { path, name, size, mtimeMs, mimeType }, 아니면 { path, name, error }.
export function checkImage(value, { base, roots }) {
  const target = path.resolve(base || roots[0] || ".", value);
  const name = path.basename(target);
  const mimeType = IMAGE_PREVIEW_MIMES[path.extname(target).toLowerCase()];
  if (!mimeType) return { path: target, name, error: "이미지 형식이 아닙니다" };
  const allowed = roots.filter(Boolean).map((root) => path.resolve(root));
  if (!allowed.some((root) => within(root, target))) return { path: target, name, error: "프로젝트·작업 폴더 밖의 파일입니다" };
  let real;
  try { real = fs.realpathSync(target); } catch { return { path: target, name, error: "파일이 없습니다" }; }
  const realRoots = allowed.map((root) => { try { return fs.realpathSync(root); } catch { return root; } });
  if (!realRoots.some((root) => within(root, real))) return { path: target, name, error: "작업 폴더 밖으로 연결된 파일입니다" };
  const stat = fs.statSync(real);
  if (!stat.isFile()) return { path: target, name, error: "일반 파일이 아닙니다" };
  if (stat.size > MAX_ARTIFACT_BYTES) return { path: target, name, error: "32 MiB보다 큽니다" };
  return { path: target, name, size: stat.size, mtimeMs: Math.round(stat.mtimeMs), mimeType };
}

// 받은 글 하나를 기록 한 건으로 만든다.
export function imageRun(text, { base, roots, origin = null, at = new Date().toISOString() }) {
  const paths = extractImagePaths(text);
  const images = paths.map((value) => checkImage(value, { base, roots }));
  const shown = images.filter((image) => !image.error).length;
  const error = !paths.length ? "받은 글에서 이미지 경로를 찾지 못했습니다" : !shown ? "보여 줄 수 있는 이미지가 없습니다" : null;
  return {
    at, ok: !error, images, roots: roots.filter(Boolean).map((root) => path.resolve(root)),
    ...(origin ? { originId: origin.id, originTitle: origin.title } : {}),
    ...(error ? { error, text: String(text ?? "").slice(0, 500) } : {}),
  };
}

// 화면이 요청한 기록의 이미지를 다시 검사해 연다(기록에 있는 경로만, 지금도 허용 폴더 안에 있을 때만).
export function openRecordedImage(run, index) {
  const image = run?.images?.[index];
  if (!image || image.error) return null;
  const checked = checkImage(image.path, { base: path.dirname(image.path), roots: run.roots ?? [] });
  if (checked.error) return { error: checked.error };
  return { realPath: fs.realpathSync(checked.path), name: checked.name, mimeType: checked.mimeType, size: checked.size };
}
