// 세션 지침(역할 대체): 요청에 붙이는 때(첫 요청·파일 변경·대화 요약), 호환 모드(역할), 판정어·검사, 만들기·옮기기·복제, 넘기는 글·소통 표시
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withSessionGuide, verdictWords, guideFromRole, sessionGuideChecks, parseSessionGuide, formatSessionGuide } from "../server/session-guide.mjs";
import { withRole } from "../server/role.mjs";
import { handoffText } from "../server/policies/workflows.mjs";
import { directoryText, messageText } from "../server/policies/messaging.mjs";
import { createHub } from "../server/bootstrap.mjs";

const GUIDE = formatSessionGuide({ name: "계획서 작성", summary: "계획서를 쓰고 자원을 모은다", body: "## 맡는 일\n- 계획서를 쓴다.\n\n## 마지막 줄 판정\n- 자원이 다 있으면 \"자원 준비 완료\"\n- 아직이면 \"자원 대기\"" });

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-sguide-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return root;
}

test("session guide: 첫 요청·파일 변경·대화 요약 뒤에만 붙이고, 파일이 없으면 붙이지 않는다", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, ".agenthub", "sessions"), { recursive: true });
  const file = path.join(root, ".agenthub", "sessions", "plan.md");
  fs.writeFileSync(file, GUIDE);
  const session = { id: "s1", title: "계획", cwd: root, projectPath: root, guideFile: ".agenthub/sessions/plan.md", role: "예전 역할" };
  const first = withSessionGuide(session, "요청");
  assert.match(first, /^\[이 세션의 지침: 계획서 작성\]\n## 맡는 일[\s\S]*이 지침을 대화 내내 지킨다[\s\S]*\[요청\]\n요청$/);
  assert.doesNotMatch(first, /예전 역할/, "세션 지침이 있으면 역할을 붙이지 않는다");
  assert.equal(session.guideState, "sent");
  assert.deepEqual(session.guideVerdicts, ["자원 준비 완료", "자원 대기"]);
  session.agentSessionId = "conv";
  assert.equal(withSessionGuide(session, "둘째"), "둘째");
  fs.writeFileSync(file, GUIDE.replace("계획서를 쓴다.", "계획서를 짧게 쓴다."));
  assert.match(withSessionGuide(session, "셋째"), /\(지침이 바뀌었다\. 지금부터 아래 지침을 따른다\)\n[\s\S]*짧게/);
  assert.equal(withSessionGuide(session, "넷째"), "넷째");
  session.guideCompacted = true;
  assert.match(withSessionGuide(session, "다섯째"), /\(대화가 요약되어 다시 알린다\)/);
  assert.equal(session.guideState, "resent-compact");
  fs.rmSync(file);
  assert.equal(withSessionGuide(session, "여섯째"), "여섯째");
  assert.equal(session.guideState, "missing");
  assert.equal(session.guideMissing, true);
});

test("session guide: 지침이 없으면 예전 역할을 붙이고, 대화 요약 뒤에도 다시 붙인다(호환 모드)", () => {
  const session = { id: "s1", role: "리뷰만 한다." };
  assert.match(withSessionGuide(session, "요청"), /^\[이 세션의 역할\]\n리뷰만 한다\./);
  session.agentSessionId = "c";
  assert.equal(withRole(session, "다음"), "다음");
  session.roleCompacted = true;
  assert.match(withRole(session, "요약 뒤"), /^\[대화가 요약되어 이 세션의 역할을 다시 알린다\]\n리뷰만 한다\./);
});

test("session guide: 판정어·역할 옮기기·판정과 연결 검사", () => {
  assert.deepEqual(verdictWords("## 맡는 일\n- \"무시\"\n## 마지막 줄 판정\n- '검증 통과' 또는 \"보완 필요\""), ["검증 통과", "보완 필요"]);
  assert.deepEqual(verdictWords("리뷰한다. 끝나면 마지막 줄에 '검토 요청'만 쓴다."), ["검토 요청"], "섹션이 없으면 '마지막 줄' 문장에서 찾는다");
  const moved = guideFromRole("사용자 요청을 받아 계획서를 쓴다.\n- 고쳐도 되는 범위: Docs만.\n- 끝나면 마지막 줄에 '자원 준비 완료'만 쓴다.", { name: "기획" });
  assert.equal(moved.name, "기획");
  assert.equal(moved.summary, "사용자 요청을 받아 계획서를 쓴다.");
  assert.match(moved.body, /^## 맡는 일\n사용자 요청을[\s\S]*## 판정\n- 끝나면 판정 '자원 준비 완료'\.$/);
  assert.deepEqual(verdictWords(moved.body), ["자원 준비 완료"]);
  assert.deepEqual(verdictWords("## 판정\n- 끝나면 \"검토 요청\"\n## 기타\n- \"무시\""), ["검토 요청"], "새 섹션 이름");
  const links = [{ from: "s1", to: "s2", when: "keyword", keyword: "자원 대기", enabled: true }, { from: "s1", to: "s3", when: "keyword", keyword: "보완 필요", enabled: true }];
  const warnings = sessionGuideChecks(GUIDE, { users: [{ id: "s1" }], links });
  assert.deepEqual(warnings.map((w) => w.id).sort(), ["verdict-missing:보완 필요", "verdict-unlinked:자원 준비 완료"]);
  assert.deepEqual(sessionGuideChecks("x".repeat(4100), {}).map((w) => w.kind), ["session-guide-long"]);
  assert.deepEqual(parseSessionGuide(GUIDE).summary, "계획서를 쓰고 자원을 모은다");
});

test("session guide: 넘기는 글과 세션 간 소통에 지침 이름을 보인다", () => {
  const source = { id: "s1", title: "계획", agent: "claude", cwd: "C:/p", guideName: "계획서 작성", guideSummary: "계획서를 쓴다", role: "" };
  assert.match(handoffText(source, {}, "답", ""), /보낸 세션의 지침: 계획서 작성 — 계획서를 쓴다/);
  assert.match(handoffText({ ...source, guideName: undefined, role: "리뷰한다\n둘째" }, {}, "답", ""), /보낸 세션의 역할: 리뷰한다/);
  assert.match(directoryText([{ ...source, state: "idle" }]), /계획 \(id s1, claude · 지침 계획서 작성, 대기\)[\s\S]*계획서를 쓴다/);
  assert.match(messageText(source, "안녕"), /claude · 지침 계획서 작성/);
});

test("session guide api: 새 세션 창의 글로 만들기·역할 옮기기·모두 옮기기·복제·지침 탭 정보·저장 뒤 반영", { timeout: 30000 }, async (t) => {
  const root = tempRoot(t);
  const hub = createHub({ port: 0, dataDir: path.join(root, ".data"), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "demo", path: root }] },
    deps: { cliPaths: () => ({ claude: "claude", codex: "codex" }), discoverProjects: () => [], logger: { log() {} } } });
  await hub.start();
  t.after(() => hub.shutdown());
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/${route}`, { method, headers: { "x-agenthub": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status, reason: value.reason });
    return value;
  };
  const q = `path=${encodeURIComponent(root)}`;
  // 새 세션 창: 적은 글로 세션 지침 파일을 만들어 잇는다.
  const a = await api("POST", "sessions", { projectPath: root, agent: "claude", title: "계획", roleName: "기획", guideText: "계획서를 쓴다.\n- 끝나면 마지막 줄에 '자원 대기'만 쓴다." });
  assert.equal(a.guideFile, ".agenthub/sessions/기획.md");
  assert.equal(a.guideName, "기획");
  assert.deepEqual(a.guideVerdicts, ["자원 대기"]);
  assert.match(fs.readFileSync(path.join(root, ".agenthub", "sessions", "기획.md"), "utf8"), /^---\nname: 기획\nsummary: "계획서를 쓴다\."\n---\n\n## 맡는 일\n계획서를 쓴다\./);
  // 역할만 있는 세션 → 하나 옮기기 / 모두 옮기기
  const b = await api("POST", "sessions", { projectPath: root, agent: "codex", title: "검증", role: "계획서를 검증한다.\n- 통과하면 마지막 줄에 '검증 통과'만 쓴다." });
  const c = await api("POST", "sessions", { projectPath: root, agent: "codex", title: "이미지", role: "이미지를 만든다." });
  assert.equal(b.guideFile, undefined);
  assert.equal((await api("GET", `guide?${q}`)).pendingRoles, 2);
  const movedOne = await api("POST", `sessions/${b.id}/guide`, { from: "role" });
  assert.equal(movedOne.file, ".agenthub/sessions/검증.md");
  assert.equal(movedOne.role, "", "옮긴 역할은 비운다");
  const all = await api("POST", `guide/session-guides/migrate?${q}`);
  assert.deepEqual(all.moved.map((m) => [m.title, m.file]), [["이미지", ".agenthub/sessions/이미지.md"]]);
  assert.equal(all.pendingRoles, 0);
  // 지침 탭: 세션 지침 그룹·쓰는 세션·판정과 연결 검사
  await api("POST", "links", { from: a.id, to: b.id, when: "keyword", keyword: "자원 준비 완료" });
  await api("PUT", `sessions/${c.id}`, { guideFile: ".agenthub/sessions/기획.md" });
  const view = await api("GET", `guide?${q}&file=${encodeURIComponent(".agenthub/sessions/기획.md")}`);
  assert.deepEqual(view.sessionGuides.map((g) => [g.file, g.users]), [[".agenthub/sessions/검증.md", 1], [".agenthub/sessions/기획.md", 2], [".agenthub/sessions/이미지.md", 0]]);
  assert.deepEqual(view.sessionGuide.users.map((u) => u.title).sort(), ["계획", "이미지"]);
  assert.ok(view.warnings.some((w) => w.id === "verdict-missing:자원 준비 완료"));
  // 저장하면 쓰는 세션의 이름이 바뀐다.
  await api("PUT", `guide?${q}&file=${encodeURIComponent(".agenthub/sessions/기획.md")}`, { text: view.text.replace("name: 기획", "name: 기획자"), baseHash: view.hash });
  assert.equal(hub.store.get(a.id).guideName, "기획자");
  assert.equal(hub.store.get(c.id).guideName, "기획자");
  // 복제: 이 세션만 따로 쓴다.
  const dup = await api("POST", `guide/session-guides/duplicate?${q}`, { file: ".agenthub/sessions/기획.md", sessionId: c.id });
  assert.equal(hub.store.get(c.id).guideFile, dup.created);
  assert.match(fs.readFileSync(path.join(root, dup.created), "utf8"), /name: 기획자 \(이미지\)/);
  // 잘못된 경로·끊기
  await assert.rejects(api("PUT", `sessions/${c.id}`, { guideFile: "AGENTS.md" }), (e) => e.reason === "session-guide-path");
  const cut = await api("PUT", `sessions/${c.id}`, { guideFile: "" });
  assert.equal(cut.guideFile, undefined);
  // 지도: 세션 지침 노드 → 세션
  const map = await api("GET", `guide/map?${q}`);
  assert.ok(map.edges.some((e) => e.from === ".agenthub/sessions/기획.md" && e.to === `role:${a.id}` && e.label === "세션 지침"));
  // 요청에 붙는다.
  assert.match(hub.services.sessions.composeInput(hub.store.get(a.id), "일해"), /\[이 세션의 지침: 기획자\]/);
});
