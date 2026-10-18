// 작성창의 명령: "@경로"로 작업 폴더의 파일을 참조하고, 요청 첫머리의 "/스킬이름"으로 스킬을 실행한다.
// Claude Code·Codex의 @·/ 명령처럼 쓰되, 두 CLI에서 똑같이 동작하도록 AgentHub가 CLI에 넘길 내용으로 풀어 쓴다.
// 화면의 요청 기록에는 사용자가 쓴 그대로 남는다.
import fs from "node:fs";
import path from "node:path";
import { git } from "./git.mjs";
import { listSkills } from "./skills.mjs";
import { isBundleName, parseBundle, recordReadText } from "./session-bundle.mjs";

const REF_MAX = 10; // 요청 하나에서 풀어 쓰는 참조 수
const FILE_INLINE_MAX = 64 * 1024; // 이보다 큰 파일은 경로만 넘긴다.
const INLINE_TOTAL_MAX = 256 * 1024;
const DIR_ENTRIES_MAX = 100;
const LIST_MAX = 20_000; // 자동 완성에 쓰는 파일 목록 최대 수
const WALK_SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "Library", "Temp", "obj"]);
const CACHE_MS = 15_000;
const BACKTICK = String.fromCharCode(96);

// ── 자동 완성용 파일 목록 ───────────────────────────────────────
const cache = new Map(); // cwd → { at, files }

function walk(root) {
  const files = [];
  const stack = [""];
  while (stack.length && files.length < LIST_MAX) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) stack.push(rel);
      } else if (entry.isFile()) files.push(rel);
    }
  }
  return files;
}

// git 저장소면 추적 중이거나 무시하지 않은 파일, 아니면 폴더를 직접 훑는다. 경로는 /로 구분한다.
export async function projectFiles(cwd, { now = Date.now() } = {}) {
  const key = path.resolve(cwd).toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.files;
  let files;
  try {
    files = (await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).slice(0, LIST_MAX);
  } catch {
    files = walk(cwd);
  }
  // 파일 경로에서 폴더도 뽑아 함께 고를 수 있게 한다.
  const dirs = new Set();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
  }
  const all = [...new Set(files.map((f) => f.replace(/\\/g, "/")))].concat([...dirs]);
  cache.set(key, { at: now, files: all });
  return all;
}

// 이름이 query로 시작하면 가장 앞, 이름에 있으면 다음, 경로에 있으면 그다음, 글자가 차례로 들어 있으면 마지막이다.
// 띄어쓰기가 있으면 그대로 맞춰 보고, 안 맞으면 나눈 낱말이 모두 경로에 들어 있는 파일을 찾는다.
export function rankFiles(files, query, limit = 30) {
  const q = String(query ?? "").replace(/\\/g, "/").toLowerCase().trim();
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const name = lower.replace(/\/$/, "").split("/").pop();
    let score;
    if (!q) score = file.split("/").length * 10 + (file.endsWith("/") ? 0 : 5);
    else if (terms.length > 1 && !lower.includes(q)) {
      if (!terms.every((term) => lower.includes(term))) continue;
      score = terms.every((term) => name.includes(term)) ? 2 : 3;
    }
    else if (name.startsWith(q)) score = 0;
    else if (lower.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (lower.includes(q)) score = 3;
    else {
      let i = 0;
      for (const ch of lower) if (ch === q[i]) i++;
      if (i < q.length) continue;
      score = 4;
    }
    scored.push({ file, score });
  }
  scored.sort((a, b) => a.score - b.score || a.file.length - b.file.length || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((s) => s.file);
}

// ── 요청 풀어 쓰기 ─────────────────────────────────────────────
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

// "@경로"와 "@\"공백 있는 경로\""를 찾는다. 앞이 줄 처음이거나 공백이어야 한다(메일 주소는 건너뛴다).
export function findRefs(text) {
  const refs = [];
  const pattern = /(^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g;
  let match;
  while ((match = pattern.exec(String(text ?? ""))) && refs.length < REF_MAX * 2) {
    refs.push(match[2] ?? match[3]);
  }
  return refs;
}

// 참조 하나를 작업 폴더 안의 실제 파일·폴더로 찾는다. 끝의 문장 부호(,.)!?)는 없는 경로일 때만 떼어 본다.
export function resolveRef(cwd, ref) {
  const root = path.resolve(cwd);
  const candidates = [ref, ref.replace(/[),.;:!?'\]]+$/, "")].filter((c, i, all) => c && all.indexOf(c) === i);
  for (const candidate of candidates) {
    const target = path.resolve(root, candidate.replace(/\/$/, ""));
    if (!within(root, target)) continue;
    try {
      const real = fs.realpathSync(target);
      if (!within(fs.realpathSync(root), real)) continue;
      const stat = fs.statSync(real);
      if (stat.isFile() || stat.isDirectory()) return { ref: candidate, path: target, dir: stat.isDirectory(), size: stat.size };
    } catch {
      // 없는 경로
    }
  }
  return null;
}

function fenceFor(content) {
  const runs = content.match(new RegExp(BACKTICK + "+", "g")) ?? [];
  return BACKTICK.repeat(runs.reduce((n, run) => Math.max(n, run.length + 1), 3));
}

function refBody(found, budget) {
  const label = found.ref.replace(/\\/g, "/");
  if (found.dir) {
    const entries = fs.readdirSync(found.path, { withFileTypes: true })
      .filter((e) => !WALK_SKIP.has(e.name))
      .map((e) => e.name + (e.isDirectory() ? "/" : ""));
    const shown = entries.slice(0, DIR_ENTRIES_MAX);
    return { text: `- 폴더 ${label} (${found.path})\n${shown.map((e) => `  - ${e}`).join("\n")}${entries.length > shown.length ? `\n  - … 외 ${entries.length - shown.length}개` : ""}`, used: 0 };
  }
  if (isBundleName(found.path) && found.size <= 30 * 1024 * 1024) {
    try {
      const read = recordReadText(path.basename(found.path), parseBundle(fs.readFileSync(found.path, "utf8")), { budget: Math.min(24000, budget) });
      return { text: `- 세션 파일 ${label} (${found.path})\n\n${read}`, used: read.length };
    } catch {
      // 형식이 틀린 .agenthub 파일은 일반 파일처럼 넘긴다.
    }
  }
  if (found.size <= FILE_INLINE_MAX && found.size <= budget) {
    const bytes = fs.readFileSync(found.path);
    if (!bytes.includes(0)) {
      const content = bytes.toString("utf8").replace(/\s+$/, "");
      const fence = fenceFor(content);
      return { text: `- 파일 ${label} (${found.path})\n${fence}\n${content}\n${fence}`, used: bytes.length };
    }
    return { text: `- 파일 ${label} (${found.path}) · 텍스트가 아니라 경로만 넘긴다. 필요하면 직접 연다.`, used: 0 };
  }
  return { text: `- 파일 ${label} (${found.path}) · ${Math.round(found.size / 1024)} KiB라 경로만 넘긴다. 필요한 부분을 직접 읽는다.`, used: 0 };
}

// 요청 안의 @참조를 찾아 내용을 덧붙인다. 찾지 못한 참조는 그대로 둔다.
export function expandRefs(cwd, text) {
  if (!cwd) return text;
  const seen = new Set();
  const blocks = [];
  let budget = INLINE_TOTAL_MAX;
  for (const ref of findRefs(text)) {
    if (blocks.length >= REF_MAX) break;
    const found = resolveRef(cwd, ref);
    if (!found || seen.has(found.path.toLowerCase())) continue;
    seen.add(found.path.toLowerCase());
    try {
      const body = refBody(found, budget);
      budget -= body.used;
      blocks.push(body.text);
    } catch {
      // 읽는 중에 지워진 파일 등은 건너뛴다.
    }
  }
  if (!blocks.length) return text;
  return `${text}\n\n[요청에서 @로 참조한 파일]\n작업 폴더 ${cwd} 기준이다. 아래 내용은 보낸 시점의 것이다.\n${blocks.join("\n\n")}`;
}

// 요청 첫머리의 "/이름 나머지"를 찾는다. 앞에 붙은 AgentHub 안내 한 줄("[...]" + 빈 줄)은 건너뛴다.
export function parseSlash(text) {
  const match = String(text ?? "").match(/^((?:\[[^\n]*\]\n\n)?)\/([a-z0-9][a-z0-9-]{0,63})(?=\s|$)[ \t]*\n?([\s\S]*)$/);
  return match ? { prefix: match[1], name: match[2], rest: match[3].trim() } : null;
}

// 스킬 이름이면 스킬 실행 지시로 바꾼다. 스킬이 아니면 null.
export function expandSlash(session, text, skills) {
  const slash = parseSlash(text);
  if (!slash) return null;
  const skill = skills.find((s) => s.name === slash.name);
  if (!skill) return null;
  const native = session.agent === "claude" && (skill.scope === "claude" || skill.scope === "personal");
  const how = native ? `Skill 도구로 "${skill.name}"을 불러온다. 쓸 수 없으면 파일 ${skill.file}을 읽는다.` : `먼저 스킬 파일 ${skill.file}을 읽는다.`;
  return {
    skill,
    text: `${slash.prefix}[스킬 실행: /${skill.name}]\n사용자가 스킬 "${skill.name}"(${skill.description})을 실행했다. ${how} 그 지침을 그대로 따라 아래 요청을 처리한다.\n\n[요청]\n${slash.rest || "(추가 요청 없음. 스킬 지침대로 진행한다.)"}`,
  };
}

// "/plan 요청": 이번 요청은 파일을 고치지 않고 계획만 세운다. 세션은 그 턴을 계획 모드로 실행한다.
export const PLAN_NOTE = "[계획 모드] 이번 요청은 계획만 세운다. 파일을 만들거나 고치지 말고, 상태를 바꾸는 명령도 실행하지 않는다. " +
  "필요한 코드와 자료는 읽어 보고 구현 단계, 고칠 파일, 확인 방법을 정리해 보고한 뒤 사용자의 승인을 기다린다.";

export function planRequest(text) {
  const slash = parseSlash(text);
  return slash?.name === "plan" ? slash : null;
}

export function expandPlan(text) {
  const plan = planRequest(text);
  if (!plan) return text;
  return `${plan.prefix}${PLAN_NOTE}\n\n[요청]\n${plan.rest || "(추가 요청 없음. 지금까지의 대화를 바탕으로 계획을 세운다.)"}`;
}

// CLI에 넘기기 전에 /plan·/스킬과 @참조를 풀어 쓴다. 일반 채팅은 작업 폴더가 없으므로 /plan만 풀어 쓴다.
export function expandPrompt(session, text, { skills } = {}) {
  if (typeof text !== "string") return text;
  text = expandPlan(text);
  if (session.chat) return text;
  let out = text;
  if (text.includes("/")) {
    const expanded = expandSlash(session, text, skills ?? listSkills(session.projectPath));
    if (expanded) {
      out = expanded.text;
      // 워크트리에서 일하는 Claude는 프로젝트의 스킬 폴더가 작업 폴더 밖이라 읽기를 열어 준다.
      const dir = path.dirname(path.dirname(expanded.skill.file));
      if (session.agent === "claude" && expanded.skill.scope !== "personal" && !within(path.resolve(session.cwd), dir)) {
        session.addDirs = [...new Set([...(session.addDirs ?? []), dir])];
      }
    }
  }
  return text.includes("@") ? expandRefs(session.cwd, out) : out;
}
