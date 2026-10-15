// 릴리스 노트(지난 태그 이후 커밋)를 만들고 Discord 웹후크로 알린다.
// 웹후크 주소는 비밀이라 저장소에 두지 않는다. 환경 변수 AGENTHUB_DISCORD_WEBHOOK 또는 release.local.json(git 제외)의 discordWebhook.
//
// 따로 실행하면 미리 보거나 다시 보낸다.
//   node scripts/release-notes.mjs                 다음 릴리스에 나갈 노트를 보여 준다(쓸 수 있는 초안이 있으면 초안, 없으면 지난 태그 이후 커밋)
//   node scripts/release-notes.mjs v0.1.15         그 태그의 노트를 보여 준다
//   node scripts/release-notes.mjs v0.1.15 --discord   그 태그의 노트를 Discord로 보낸다
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_URL = "https://github.com/Lyeol2/AgentHub";
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

const TYPES = [
  ["feat", "새 기능"],
  ["fix", "고친 것"],
  ["perf", "개선"],
  ["refactor", "개선"],
  ["docs", "문서"],
  ["chore", "기타"],
];

// to 직전 태그. 없으면 null(처음 릴리스)
export function previousTag(to = "HEAD") {
  try {
    return git("describe", "--tags", "--abbrev=0", `${to}^`);
  } catch {
    return null;
  }
}

// 커밋 기록을 { type, subject, bullets } 목록으로. 릴리스 커밋과 병합 커밋은 뺀다.
export function parseCommits(log) {
  return log.split("\x1e").map((c) => c.trim()).filter(Boolean).map((c) => {
    const [subjectLine, ...body] = c.split(/\r?\n/);
    const m = subjectLine.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
    const bullets = body.map((l) => l.trim()).filter((l) => /^[-*]\s+/.test(l)).map((l) => l.replace(/^[-*]\s+/, ""));
    return { type: m ? m[1].toLowerCase() : "other", subject: m ? m[2] : subjectLine, bullets };
  }).filter((c) => !/^release v?\d/i.test(c.subject) && !/^Merge /.test(c.subject));
}

// 마크다운 노트. 종류(새 기능·고친 것 …)별로 묶고 커밋 본문의 "- " 줄을 아래에 붙인다.
export function formatNotes(commits) {
  if (!commits.length) return "바뀐 내용이 없습니다.";
  const sections = new Map();
  for (const c of commits) {
    const title = TYPES.find(([t]) => t === c.type)?.[1] ?? "기타";
    if (!sections.has(title)) sections.set(title, []);
    sections.get(title).push(c);
  }
  // TYPES에 이미 "기타"가 있으므로 Set으로 한 번만 둔다(알 수 없는 앞머리도 "기타"로 모인다).
  const order = [...new Set([...TYPES.map(([, t]) => t), "기타"])];
  return order.filter((t) => sections.has(t)).map((title) => [
    `### ${title}`,
    ...sections.get(title).flatMap((c) => [`- **${c.subject}**`, ...c.bullets.map((b) => `  - ${b}`)]),
  ].join("\n")).join("\n\n");
}

// from(없으면 처음부터)..to 사이 커밋의 노트
export function releaseNotes(from, to = "HEAD") {
  const range = from ? `${from}..${to}` : to;
  return formatNotes(parseCommits(git("log", "--no-merges", "--format=%B%x1e", range)));
}

// ── 사용자용 초안 ────────────────────────────────────────────────
// 릴리스 준비 세션이 커밋 노트를 사용자 말투로 다시 쓴 초안(git 제외). 첫 줄에 쓴 시점의 커밋을 적는다.
//   <!-- agenthub-release-draft base=<git rev-parse HEAD> bump=minor -->
// bump는 선택 사항이며 없으면 기존 릴리스 기본값을 쓴다.
// 그 뒤로 커밋이 더 생겼으면 초안에 빠진 내용이 있으므로 쓰지 않는다.
export const DRAFT_FILE = path.join(ROOT, "release-notes.draft.md");
const DRAFT_HEAD = /^<!--\s*agenthub-release-draft\s+base=([0-9a-f]{7,40})(?:\s+bump=([^\s<>]+))?\s*-->\s*\r?\n?/i;

// text: 초안 파일 내용, head: 지금 HEAD 커밋. 쓸 수 있으면 { notes, bump? }, 아니면 { reason }
export function parseDraft(text, head) {
  const source = String(text ?? "");
  const m = source.match(DRAFT_HEAD);
  if (!m) return { reason: "초안 첫 줄에 기준 커밋 표시(<!-- agenthub-release-draft base=... -->)가 없습니다." };
  if (!head.startsWith(m[1]) && !m[1].startsWith(head)) return { reason: `초안을 쓴 뒤(${m[1].slice(0, 8)}) 커밋이 더 생겼습니다.` };
  const bump = m[2]?.toLowerCase();
  if (bump && !["patch", "minor", "major"].includes(bump)) return { reason: "초안의 버전 단위는 patch, minor, major 중 하나여야 합니다." };
  const notes = source.slice(m[0].length).trim();
  if (!notes) return { reason: "초안이 비어 있습니다." };
  return bump ? { notes, bump } : { notes };
}

// 초안이 없으면 null. 있지만 쓸 수 없으면 이유를 알리고 null.
export function readPreparedRelease(head = git("rev-parse", "HEAD")) {
  if (!fs.existsSync(DRAFT_FILE)) return null;
  const draft = parseDraft(fs.readFileSync(DRAFT_FILE, "utf8"), head);
  if (draft.reason) {
    console.warn(`업데이트 내역 초안을 쓰지 않고 커밋 노트를 씁니다: ${draft.reason}`);
    return null;
  }
  return draft;
}

// 노트만 필요한 기존 호출자는 같은 문자열|null API를 유지한다.
export function readDraft(head = git("rev-parse", "HEAD")) {
  return readPreparedRelease(head)?.notes ?? null;
}

export function webhookUrl() {
  if (process.env.AGENTHUB_DISCORD_WEBHOOK) return process.env.AGENTHUB_DISCORD_WEBHOOK;
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "release.local.json"), "utf8")).discordWebhook || null;
  } catch {
    return null;
  }
}

// Discord 임베드 설명은 4096자까지라 넘치면 자르고 릴리스 페이지로 안내한다.
export function discordPayload(version, notes) {
  const url = `${REPO_URL}/releases/tag/v${version}`;
  const limit = 3800;
  const description = notes.length > limit ? `${notes.slice(0, limit).replace(/\n[^\n]*$/, "")}\n\n… 나머지는 릴리스 페이지에서 보세요.` : notes;
  return {
    username: "AgentHub",
    embeds: [{
      title: `AgentHub ${version} 업데이트`,
      url,
      description: description.replace(/^### /gm, "**").replace(/^(\*\*[^*\n]+)$/gm, "$1**"),
      color: 0x4c8dff,
      footer: { text: "앱을 켜면 업데이트를 알려 줍니다 · 설치 파일은 릴리스 페이지에" },
      timestamp: new Date().toISOString(),
    }],
  };
}

// 실패해도 릴리스는 이미 끝났으므로 예외를 던지지 않고 결과만 알린다.
export async function postDiscord(version, notes, url = webhookUrl()) {
  if (!url) {
    console.log("Discord 웹후크가 없어 알리지 않았습니다(AGENTHUB_DISCORD_WEBHOOK 또는 release.local.json).");
    return false;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(discordPayload(version, notes)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    console.log("Discord에 업데이트 내역을 보냈습니다.");
    return true;
  } catch (err) {
    console.warn(`Discord 알림 실패(릴리스는 끝났습니다): ${err.message}`);
    return false;
  }
}

// 직접 실행할 때
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const tag = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const send = process.argv.includes("--discord");
  // 태그를 주면 그 릴리스의 노트, 안 주면 가장 최근 태그 이후(다음 릴리스에 들어갈) 노트
  const latestTag = () => {
    try {
      return git("describe", "--tags", "--abbrev=0");
    } catch {
      return null;
    }
  };
  // 다음 릴리스를 미리 볼 때 쓸 수 있는 초안이 있으면 그것이 나간다.
  const notes = tag ? releaseNotes(previousTag(tag), tag) : readDraft() ?? releaseNotes(latestTag());
  console.log(notes);
  if (send) {
    if (!tag) {
      console.error("\n보낼 때는 태그를 적으세요. 예: node scripts/release-notes.mjs v0.1.15 --discord");
      process.exit(1);
    }
    await postDiscord(tag.replace(/^v/, ""), notes);
  }
}
