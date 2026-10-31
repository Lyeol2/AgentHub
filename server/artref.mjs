// 아트 레퍼런스 노드. 레퍼런스 이미지 폴더와 메모를 정해 두고, "참고" 연결로 이은 세션에 그 폴더를 알려 준다.
// 노드는 실행하지 않는다. 세션이 요청을 받을 때마다 짧은 안내(경로·한 줄 요약)를 붙이고,
// 새 대화·레퍼런스 변경·대화 요약 직후에는 전체 안내를 붙인다. 폴더에는 AI가 먼저 읽을 INDEX.md를 만든다.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { imageSize } from "./figcraft.mjs";

export const ARTREF_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
export const ARTREF_INDEX = "INDEX.md";
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const LIST_MAX = 500;
const fail = (message) => { throw new Error(message); };
const str = (value, label, max) => {
  const text = String(value ?? "");
  if (text.length > max) fail(`${label}은 ${max}자까지 입력할 수 있습니다.`);
  return text;
};
const slug = (value) => String(value ?? "").trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 60) || "refs";

// 노드 설정 검사. flow-nodes의 checkFlowNode가 kind "artref"일 때 부른다.
export function checkArtrefNode(body, current = {}) {
  const title = str(body.title ?? current.title, "이름", 100).trim() || "아트 레퍼런스";
  const folder = str(body.folder ?? current.folder ?? `references/${slug(title)}`, "폴더", 1000).trim().replaceAll("\\", "/") || `references/${slug(title)}`;
  if (/[\r\n]/.test(folder) || folder.split("/").includes("..")) fail("레퍼런스 폴더 경로가 올바르지 않습니다.");
  const palette = (Array.isArray(body.palette ?? current.palette) ? body.palette ?? current.palette : String(body.palette ?? current.palette ?? "").split(/[\s,]+/))
    .map((color) => String(color).trim()).filter(Boolean);
  if (palette.length > 24 || palette.some((color) => !/^#[0-9a-f]{3,8}$/i.test(color))) fail("팔레트는 #F6C453처럼 색 코드를 24개까지 입력하세요.");
  const items = body.items ?? current.items ?? {};
  if (!items || typeof items !== "object" || Array.isArray(items)) fail("이미지 메모 형식이 올바르지 않습니다.");
  const checked = {};
  for (const [name, item] of Object.entries(items).slice(0, LIST_MAX)) {
    if (!name || /[\\/]/.test(name) || name.length > 200) continue;
    const note = str(item?.note ?? "", "이미지 메모", 500).trim();
    const tags = (Array.isArray(item?.tags) ? item.tags : String(item?.tags ?? "").split(/[,，]/)).map((tag) => String(tag).trim()).filter(Boolean).slice(0, 10).map((tag) => tag.slice(0, 30));
    if (note || tags.length) checked[name] = { note, tags };
  }
  return { kind: "artref", title, folder, style: str(body.style ?? current.style ?? "", "스타일 메모", 4000).trim(), palette, items: checked };
}

// 레퍼런스 폴더의 절대 경로(프로젝트 기준 상대 경로도 받는다)
export function artrefFolder(node) {
  return path.resolve(node.projectPath, node.folder || `references/${slug(node.title)}`);
}

// 폴더의 이미지 목록(하위 폴더 한 단계까지). 이름은 폴더 기준 상대 경로(/ 구분)
export function listArtrefImages(node) {
  const root = artrefFolder(node);
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= LIST_MAX) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 1 && !entry.name.startsWith(".")) walk(full, depth + 1);
      else if (entry.isFile() && ARTREF_IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) found.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root, 0);
  return found;
}

// AI가 먼저 읽을 목록. 이미지마다 메모·태그·크기를 글로 적어 두어, 이미지를 다시 열지 않아도 핵심은 남게 한다.
export function artrefIndexText(node, images = listArtrefImages(node)) {
  const root = artrefFolder(node);
  const lines = [`# 아트 레퍼런스 · ${node.title}`, "", "AgentHub가 만든 목록이다. 작업에 관련된 이미지만 열어 본다. 레퍼런스를 그대로 베끼지 말고 색·분위기·형태를 맞춘다.", ""];
  if (node.style) lines.push("## 스타일", node.style, "");
  if (node.palette?.length) lines.push("## 팔레트", node.palette.join(" "), "");
  lines.push(`## 이미지 (${images.length}장)`);
  for (const name of images) {
    const item = node.items?.[name] ?? {};
    const size = imageSize(path.join(root, name));
    const parts = [item.note, item.tags?.length ? `[${item.tags.join(", ")}]` : "", size ? `${Math.round(size.width)}×${Math.round(size.height)}` : ""].filter(Boolean);
    lines.push(`- ${name}${parts.length ? ` — ${parts.join(" · ")}` : ""}`);
  }
  if (!images.length) lines.push("- (아직 이미지가 없다)");
  return `${lines.join("\n")}\n`;
}

// 폴더를 만들고 INDEX.md를 내용이 바뀌었을 때만 다시 쓴다. 돌려주는 값: { folder, images, index, key }
export function syncArtref(node) {
  const folder = artrefFolder(node);
  fs.mkdirSync(folder, { recursive: true });
  const images = listArtrefImages(node);
  const text = artrefIndexText(node, images);
  const index = path.join(folder, ARTREF_INDEX);
  let current = null;
  try { current = fs.readFileSync(index, "utf8"); } catch { /* 처음 */ }
  if (current !== text) fs.writeFileSync(index, text);
  return { folder, images, index, key: createHash("sha256").update(`${folder}\n${text}`).digest("hex").slice(0, 16) };
}

// 노드 화면에서 끌어 놓은 이미지를 폴더에 넣는다. 같은 이름이 있으면 뒤에 번호를 붙인다.
export function addArtrefImage(node, { name, data }) {
  const base = path.basename(String(name ?? "")).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").slice(0, 120);
  const ext = path.extname(base).toLowerCase();
  if (!base || !ARTREF_IMAGE_EXT.has(ext)) fail("레퍼런스는 PNG·JPG·WebP·GIF·SVG 이미지만 넣을 수 있습니다.");
  if (typeof data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail("이미지 내용을 읽지 못했습니다.");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) fail("레퍼런스 이미지는 20MB까지 넣을 수 있습니다.");
  const folder = artrefFolder(node);
  fs.mkdirSync(folder, { recursive: true });
  const stem = base.slice(0, -ext.length);
  let file = path.join(folder, base), n = 1;
  while (fs.existsSync(file)) file = path.join(folder, `${stem}-${++n}${ext}`);
  fs.writeFileSync(file, bytes);
  return path.basename(file);
}

// 노드 폴더 안의 이미지 파일(목록에 보이는 것만)
export function artrefImageFile(node, name) {
  const value = String(name ?? "");
  if (!listArtrefImages(node).includes(value)) fail("레퍼런스 폴더의 이미지가 아닙니다.");
  return path.join(artrefFolder(node), value);
}

// ── 세션에 붙이는 안내 ─────────────────────────────────────────
const shortLine = (ref) => `- ${ref.title}: ${ref.folder} (먼저 ${ARTREF_INDEX}) · 이미지 ${ref.images.length}장${ref.style ? ` · ${ref.style.split(/\r?\n/)[0].slice(0, 120)}` : ""}`;

// 매 요청: 경로와 한 줄 요약, 다시 열기 규칙. 전체 안내(full): 새 대화·변경·대화 요약 직후
export function artrefNotice(refs, { full = false, reason = "" } = {}) {
  if (!refs.length) return "";
  const list = refs.map(shortLine).join("\n");
  const rules = "새 화면·에셋을 다루거나 레퍼런스의 색·형태를 지금 구체적으로 말할 수 없으면 INDEX.md와 관련 이미지를 다시 연다(이 대화에서 이미 열어 본 이미지는 다시 열지 않는다). 하위 작업을 맡길 때는 이 경로를 함께 넘긴다. 디자인·이미지 작업의 답변 끝에는 \"참고한 레퍼런스: 파일 이름\"을 쓴다.";
  if (!full) return `[아트 레퍼런스] 디자인·이미지 작업이면 참고한다.\n${list}\n${rules}`;
  return `[아트 레퍼런스 안내]${reason ? ` ${reason}` : ""}
이 세션에는 아래 레퍼런스 폴더가 이어져 있다. 디자인·이미지 작업을 할 때는 먼저 각 폴더의 ${ARTREF_INDEX}를 읽고, 지금 작업에 관련된 이미지를 열어 본다.
레퍼런스를 그대로 베끼지 말고 색·분위기·형태·구도를 맞춘다. 스타일 메모와 팔레트가 있으면 그 값을 따른다.
${list}
${rules}`;
}

// 대화 요약 직후 진행 중인 작업에 끼워 넣는 안내
export function artrefCompactNotice(refs) {
  return `[대화가 요약되었다] 아트 레퍼런스의 ${ARTREF_INDEX}를 다시 읽고, 지금 작업에 관련된 이미지를 다시 열어 본 뒤 작업을 이어 간다.\n${refs.map(shortLine).join("\n")}`;
}
