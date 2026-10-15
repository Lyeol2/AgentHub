import test from "node:test";
import assert from "node:assert/strict";
import { parseCommits, formatNotes, discordPayload } from "../scripts/release-notes.mjs";

const LOG = [
  "feat: 세션 AI 바꾸기\n\n- 진행 상황을 넘김\n- 권한을 옮김\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
  "fix(ui): 사이드바 겹침\n\n- 세션 목록 최소 높이",
  "chore: release v0.1.15",
  "chore: 스킬 정리",
  "그냥 메시지",
].join("\x1e\n") + "\x1e";

test("release-notes: 커밋을 종류별로 묶고 본문의 - 줄을 붙인다", () => {
  const commits = parseCommits(LOG);
  assert.deepEqual(commits.map((c) => [c.type, c.subject]), [
    ["feat", "세션 AI 바꾸기"], ["fix", "사이드바 겹침"], ["chore", "스킬 정리"], ["other", "그냥 메시지"],
  ]); // 릴리스 커밋은 뺀다.
  assert.deepEqual(commits[0].bullets, ["진행 상황을 넘김", "권한을 옮김"]); // Co-Authored-By는 넣지 않는다.
  const notes = formatNotes(commits);
  assert.match(notes, /^### 새 기능\n- \*\*세션 AI 바꾸기\*\*\n {2}- 진행 상황을 넘김/);
  assert.ok(notes.indexOf("### 고친 것") < notes.indexOf("### 기타"));
  assert.match(notes, /### 기타\n- \*\*스킬 정리\*\*\n- \*\*그냥 메시지\*\*/);
  assert.equal(notes.match(/### 기타/g).length, 1); // chore와 알 수 없는 앞머리가 한 절로 모인다.
  assert.equal(formatNotes([]), "바뀐 내용이 없습니다.");
});

test("release-notes: Discord 임베드는 릴리스 페이지로 잇고 길면 자른다", () => {
  const payload = discordPayload("0.1.16", "### 새 기능\n- **a**");
  const [embed] = payload.embeds;
  assert.equal(embed.title, "AgentHub 0.1.16 업데이트");
  assert.equal(embed.url, "https://github.com/Lyeol2/AgentHub/releases/tag/v0.1.16");
  assert.equal(embed.description, "**새 기능**\n- **a**"); // 제목 줄은 굵은 글씨로
  const long = discordPayload("1.0.0", Array.from({ length: 400 }, (_, i) => `- 항목 ${i} ${"x".repeat(20)}`).join("\n"));
  assert.ok(long.embeds[0].description.length <= 4096);
  assert.match(long.embeds[0].description, /릴리스 페이지에서 보세요/);
});

test("release-notes: 사용자용 초안은 쓴 시점의 커밋이 지금과 같을 때만 쓴다", async () => {
  const { parseDraft } = await import("../scripts/release-notes.mjs");
  const head = "0123456789abcdef0123456789abcdef01234567";
  const draft = (base, body = "### 새 기능\n- 세션끼리 메시지를 주고받을 수 있습니다") => `<!-- agenthub-release-draft base=${base} -->\n${body}\n`;
  assert.deepEqual(parseDraft(draft(head), head), { notes: "### 새 기능\n- 세션끼리 메시지를 주고받을 수 있습니다" });
  assert.ok(parseDraft(draft(head.slice(0, 8)), head).notes); // 짧은 해시도 된다.
  assert.match(parseDraft(draft("fedcba98"), head).reason, /커밋이 더 생겼습니다/);
  assert.match(parseDraft("### 새 기능\n- a", head).reason, /기준 커밋 표시/);
  assert.match(parseDraft(draft(head, " "), head).reason, /비어 있습니다/);
});
