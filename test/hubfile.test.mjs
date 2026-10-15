import test from "node:test";
import assert from "node:assert/strict";
import { parseHubFile, HUB_TEMPLATE } from "../server/hubfile.mjs";
import { withRole } from "../server/role.mjs";

test("hubfile: 기본 템플릿을 경고 없이 읽는다", () => {
  const hub = parseHubFile(HUB_TEMPLATE);
  assert.deepEqual(hub.warnings, []);
  assert.match(hub.common, /커밋하지 않는다/);
  assert.deepEqual(hub.roles.map((r) => [r.name, r.agent, r.permission, r.isolate]),
    [["구현", "claude", "acceptEdits", false], ["리뷰", "codex", "read-only", false]]);
  assert.match(hub.roles[1].body, /^코드를 고치지 않는다/);
  assert.deepEqual(hub.flows[0].steps, [
    { from: "구현", to: "리뷰", when: "keyword", keyword: "검토 요청", note: "" },
    { from: "리뷰", to: "구현", when: "keyword", keyword: "수정 필요", note: "리뷰에서 지적한 것만 고친다." },
  ]);
});

test("hubfile: 이전 작업 폴더 분리 설정은 본문에 남기지 않고 원본 폴더로 통일한다", () => {
  for (const setting of ["작업 폴더: 분리", "folder: worktree", "isolate: true"]) {
    const hub = parseHubFile(`## 역할: 구현\n- ${setting}\n- agent: codex\n\n기능을 구현한다.`);
    assert.equal(hub.roles[0].isolate, false, setting);
    assert.equal(hub.roles[0].agent, "codex", setting);
    assert.equal(hub.roles[0].body, "기능을 구현한다.", setting);
    assert.equal(hub.warnings.length, 1, setting);
    assert.match(hub.warnings[0], /분리 설정은 자동 적용하지 않습니다.*이름을 입력/);
  }
  for (const setting of ["작업 폴더: 원본", "folder: original", "isolate: false"]) {
    const hub = parseHubFile(`## 역할: 구현\n- ${setting}\n\n역할 설명`);
    assert.equal(hub.roles[0].isolate, false, setting);
    assert.equal(hub.roles[0].body, "역할 설명", setting);
    assert.deepEqual(hub.warnings, [], setting);
  }
});

test("hubfile: 설정이 없는 역할은 기본값을 쓰고 본문 첫 줄의 목록도 본문으로 둔다", () => {
  const hub = parseHubFile("## 역할: 문서\n- README만 고친다.\n\n## 역할: 코덱스\n- agent: Codex\n");
  assert.equal(hub.roles[0].agent, "claude");
  assert.equal(hub.roles[0].permission, "acceptEdits");
  assert.equal(hub.roles[0].body, "- README만 고친다.");
  assert.equal(hub.roles[1].agent, "codex");
  assert.equal(hub.roles[1].permission, "workspace-write");
});

test("hubfile: 조건 표기를 읽고 따옴표 없는 말은 키워드로 둔다", () => {
  const hub = parseHubFile([
    "## 역할: a", "## 역할: b",
    "## 흐름: f",
    "설명 줄은 무시한다.",
    "- a -> b", "- a → b: 실패", "- b -> a: 항상 | 다시 봐", "- a -> b: 수정 필요 | 고쳐", "- a -> c: 수동",
    "- b -> a: 그 외", '- a -> b: "성공" | 키워드로 쓴 조건 이름', '- a -> b: "a|b" | 지시',
    "## 역할: d", "- 권한: plan", "- 에이전트: codex",
  ].join("\n"));
  const steps = hub.flows[0].steps;
  assert.deepEqual(steps.map((s) => s.when), ["success", "error", "always", "keyword", "manual", "otherwise", "keyword", "keyword"]);
  assert.equal(steps[2].note, "다시 봐");
  assert.deepEqual([steps[3].keyword, steps[3].note], ["수정 필요", "고쳐"]);
  assert.equal(steps[6].keyword, "성공");
  assert.deepEqual([steps[7].keyword, steps[7].note], ["a|b", "지시"]);
  assert.ok(hub.warnings.some((w) => w.includes('역할 "c"')));
  // 권한을 에이전트보다 먼저 적어도 에이전트 기준으로 검사한다.
  assert.ok(hub.warnings.some((w) => w.includes('역할 "d"') && w.includes("plan")));
});

test("role: 새 대화에는 공통 지침과 역할을 함께 붙인다", () => {
  const text = withRole({ role: "리뷰어" }, "봐", "커밋 금지");
  assert.match(text, /^\[AgentHub 공통 지침\]\n커밋 금지\n\n\[이 세션의 역할\]\n리뷰어/);
  assert.ok(text.endsWith("[요청]\n봐"));
  assert.equal(withRole({ role: "" }, "봐", ""), "봐");
  assert.equal(withRole({ role: "x", agentSessionId: "1" }, "봐", "커밋 금지"), "봐");
});
