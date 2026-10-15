import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseCommits, formatNotes, discordPayload, parseDraft, readDraft, readPreparedRelease, DRAFT_FILE } from "../scripts/release-notes.mjs";

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

const DRAFT_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DRAFT_NOTES = "### 새 기능\n- 세션끼리 메시지를 주고받을 수 있습니다";
const draft = (base = DRAFT_COMMIT, body = DRAFT_NOTES, bump) =>
  `<!-- agenthub-release-draft base=${base}${bump === undefined ? "" : ` bump=${bump}`} -->\n${body}\n`;

test("release-notes: 기존 초안 헤더와 짧은 기준 해시를 계속 지원한다", () => {
  assert.deepEqual(parseDraft(draft(), DRAFT_COMMIT), { notes: DRAFT_NOTES });
  assert.deepEqual(parseDraft(draft(DRAFT_COMMIT.slice(0, 8)), DRAFT_COMMIT), { notes: DRAFT_NOTES });
  assert.match(parseDraft("### 새 기능\n- a", DRAFT_COMMIT).reason, /기준 커밋 표시/);
});

for (const bump of ["patch", "minor", "major"]) {
  test(`release-notes: 초안의 ${bump} 버전 단위를 본문과 함께 읽는다`, () => {
    assert.deepEqual(parseDraft(draft(DRAFT_COMMIT, DRAFT_NOTES, bump), DRAFT_COMMIT), { notes: DRAFT_NOTES, bump });
  });
}

test("release-notes: 버전 단위를 소문자로 정규화하고 헤더는 노트에서 뺀다", () => {
  assert.deepEqual(parseDraft(draft(DRAFT_COMMIT, DRAFT_NOTES, "MINOR").replace(/\n/g, "\r\n"), DRAFT_COMMIT), {
    notes: DRAFT_NOTES.replace(/\n/g, "\r\n"),
    bump: "minor",
  });
});

test("release-notes: 만료된 초안은 본문과 버전 단위를 모두 쓰지 않는다", () => {
  for (const bump of [undefined, "minor"]) {
    const result = parseDraft(draft("fedcba98", DRAFT_NOTES, bump), DRAFT_COMMIT);
    assert.match(result.reason, /커밋이 더 생겼습니다/);
    assert.equal(result.notes, undefined);
    assert.equal(result.bump, undefined);
  }
});

test("release-notes: 잘못된 버전 단위나 빈 본문이면 초안 전체가 무효다", () => {
  for (const bump of ["prerelease", "1.2.0", "", "minor patch"]) {
    const result = parseDraft(draft(DRAFT_COMMIT, DRAFT_NOTES, bump), DRAFT_COMMIT);
    assert.ok(result.reason, `잘못된 버전 단위: ${JSON.stringify(bump)}`);
    assert.equal(result.notes, undefined);
    assert.equal(result.bump, undefined);
  }
  for (const bump of [undefined, "minor"]) {
    const result = parseDraft(draft(DRAFT_COMMIT, " \r\n\t ", bump), DRAFT_COMMIT);
    assert.match(result.reason, /비어 있습니다/);
    assert.equal(result.bump, undefined);
  }
});

test("release-notes: 준비 정보는 버전 단위를 전달하고 기존 노트 API는 문자열을 유지한다", (t) => {
  let text = draft(DRAFT_COMMIT, DRAFT_NOTES, "minor");
  t.mock.method(fs, "existsSync", (file) => {
    assert.equal(file, DRAFT_FILE);
    return true;
  });
  t.mock.method(fs, "readFileSync", (file, encoding) => {
    assert.equal(file, DRAFT_FILE);
    assert.equal(encoding, "utf8");
    return text;
  });
  assert.deepEqual(readPreparedRelease(DRAFT_COMMIT), { notes: DRAFT_NOTES, bump: "minor" });
  assert.equal(readDraft(DRAFT_COMMIT), DRAFT_NOTES);
  text = draft();
  assert.deepEqual(readPreparedRelease(DRAFT_COMMIT), { notes: DRAFT_NOTES });
  assert.equal(readDraft(DRAFT_COMMIT), DRAFT_NOTES);
});

test("release-notes: 초안이 없거나 무효면 준비 정보와 기존 노트 API가 null을 돌려준다", (t) => {
  let exists = false;
  let text = draft("fedcba98", DRAFT_NOTES, "minor");
  t.mock.method(fs, "existsSync", () => exists);
  const read = t.mock.method(fs, "readFileSync", () => text);
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(readPreparedRelease(DRAFT_COMMIT), null);
  assert.equal(readDraft(DRAFT_COMMIT), null);
  assert.equal(read.mock.callCount(), 0);
  exists = true;
  for (const invalid of [
    text,
    draft(DRAFT_COMMIT, DRAFT_NOTES, "prerelease"),
    draft(DRAFT_COMMIT, "", "minor"),
  ]) {
    text = invalid;
    assert.equal(readPreparedRelease(DRAFT_COMMIT), null);
    assert.equal(readDraft(DRAFT_COMMIT), null);
  }
  assert.equal(warn.mock.callCount(), 6);
  assert.ok(warn.mock.calls.every(({ arguments: [message] }) => /초안을 쓰지 않고 커밋 노트를 씁니다/.test(message)));
});
