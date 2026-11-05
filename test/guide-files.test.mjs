// 지침 갈래: 위치 제안·새 지침(짝·섹션 옮기기)·연결 문서(링크·가져오기·이 파일 만들기)·삭제(백업·참조 정리·되살리기)·갈래 검사·읽힘 보장
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { folderSuggestions, checkFolder, insertDocLink, moveSections, dropReferences, branchChecks, defaultDocDir } from "../server/guide-branches.mjs";
import { guideMap } from "../server/guide.mjs";
import { createHub } from "../server/bootstrap.mjs";

const ROOT = `# 데모 지침

## 프로젝트 요약
앱이다.

## 필독 문서
- C# 수정 시 [Unity 규칙](docs/unity.md)

## 서버 규칙
- 서버는 server/에 둔다.
- 포트는 4517이다.

## 커밋 규칙
- feat: 접두어
`;
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-guide-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  put(path.join(root, "AGENTS.md"), ROOT);
  put(path.join(root, "docs", "unity.md"), "# Unity\n- 씬 이름을 바꾸지 않는다.\n");
  fs.mkdirSync(path.join(root, "server", "routes"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
  return root;
}

test("guide branches: 위치 제안은 생성 폴더를 빼고, 링크 줄은 필독 문서 섹션 끝에 넣는다", (t) => {
  const root = project(t);
  assert.deepEqual(folderSuggestions(root, ""), ["", "docs", "server", "server/routes"]);
  assert.deepEqual(folderSuggestions(root, "rou"), ["server/routes"]);
  assert.equal(checkFolder(root, "server/").rel, "server");
  assert.throws(() => checkFolder(root, "../밖"), /프로젝트 안/);
  assert.throws(() => checkFolder(root, "node_modules/x"), /생성 폴더/);
  assert.equal(defaultDocDir(root), "docs");
  const linked = insertDocLink(ROOT, "- 배포 전에 [배포](docs/deploy.md)", "docs/deploy.md");
  assert.match(linked, /- C# 수정 시 \[Unity 규칙\]\(docs\/unity\.md\)\n- 배포 전에 \[배포\]\(docs\/deploy\.md\)\n\n## 서버 규칙/);
  assert.equal(insertDocLink(linked, "- 또 [배포](docs/deploy.md)", "docs/deploy.md"), linked, "같은 대상은 다시 넣지 않는다");
  assert.match(insertDocLink("# 지침\n", "- a [b](c.md)", "c.md"), /## 필독 문서\n- a \[b\]\(c\.md\)\n$/);
  const moved = moveSections(ROOT, [9], "server/AGENTS.md");
  assert.match(moved.moved, /^## 서버 규칙\n- 서버는 server\/에 둔다\.\n- 포트는 4517이다\.$/);
  assert.match(moved.remaining, /## 서버 규칙\n- → \[server\/AGENTS\.md\]\(server\/AGENTS\.md\) 참고\n\n## 커밋 규칙/);
  const dropped = dropReferences("@AGENTS.md\n@docs/a.md\n- x [a](docs/a.md)\n- 남김\n", root, path.join(root, "docs", "a.md"));
  assert.deepEqual([dropped.text, dropped.removed], ["@AGENTS.md\n- 남김\n", 2]);
});

test("guide branches: 갈래 검사와 읽힘 보장", (t) => {
  const root = project(t);
  put(path.join(root, "CLAUDE.md"), "@AGENTS.md\n@docs/big.md\n");
  put(path.join(root, "docs", "big.md"), "# 큰 문서\n" + "- 줄\n".repeat(800));
  put(path.join(root, "AGENTS.md"), ROOT + "- [링크만](docs/plain.md)\n");
  put(path.join(root, "docs", "plain.md"), "# 링크만\n- 다음도 보라 [더](docs/deeper.md)\n- 승인받은 뒤에만 구현한다.\n");
  put(path.join(root, "server", "AGENTS.md"), "# 서버\n- 작업이 끝나면 커밋한다.\n");
  const files = Object.fromEntries(branchChecks(root).map((f) => [f.file, f.warnings.map((w) => w.kind)]));
  assert.deepEqual(files["docs/unity.md"], ["rule-in-doc"], "링크 문서에만 있는 '하지 않는다' 규칙");
  assert.ok(files["AGENTS.md"].includes("no-condition"));
  assert.ok(files["CLAUDE.md"].includes("big-import"));
  assert.ok(files["docs/plain.md"].includes("link-depth") && files["docs/plain.md"].includes("approval"));
  assert.ok(files["server/AGENTS.md"].includes("commit-every") && files["server/AGENTS.md"].includes("unpaired"));
  const map = guideMap(root, {});
  const node = (id) => map.nodes.find((n) => n.id === id);
  assert.deepEqual([node("AGENTS.md").assurance, node("CLAUDE.md").assurance, node("server/AGENTS.md").assurance, node("docs/unity.md").assurance, node("docs/big.md").assurance, node("docs/plain.md").assurance],
    ["항상", "항상(Claude)", "폴더 진입 시", "조건부", "항상(Claude)", "조건 없는 링크"]);
});

test("guide branches api: 새 지침·연결 문서·삭제·되살리기·영향", { timeout: 30000 }, async (t) => {
  const root = project(t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "AGENTS.md"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: root });
  const hub = createHub({ port: 0, dataDir: path.join(os.tmpdir(), `agenthub-guide-files-data-${Date.now()}`), warmup: false, cliAutoUpdate: false, config: { projects: [{ name: "demo", path: root }] },
    deps: { cliPaths: () => ({ claude: null, codex: null }), discoverProjects: () => [], logger: { log() {} } } });
  await hub.start();
  t.after(() => hub.shutdown());
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/${route}`, { method, headers: { "x-agenthub": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status, reason: value.reason });
    return value;
  };
  const q = `path=${encodeURIComponent(root)}`;
  assert.deepEqual((await api("GET", `guide/folders?${q}&q=serv`)).folders, ["server", "server/routes"]);
  // 새 지침: 짝(AGENTS.md + @AGENTS.md인 CLAUDE.md), 섹션 옮기기
  const created = await api("POST", `guide/files?${q}`, { dir: "server", kind: "both", start: "move", sections: [9], parentText: ROOT });
  assert.deepEqual(created.created, ["server/AGENTS.md", "server/CLAUDE.md"]);
  assert.equal(created.file, "server/AGENTS.md");
  assert.match(fs.readFileSync(path.join(root, "server", "AGENTS.md"), "utf8"), /# server 폴더 지침\n\n## 서버 규칙\n- 서버는/);
  assert.equal(fs.readFileSync(path.join(root, "server", "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.match(created.remaining, /→ \[server\/AGENTS\.md\]/);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), ROOT, "상위 지침은 저장하지 않는다");
  assert.ok(created.files.includes("server/AGENTS.md"));
  await assert.rejects(api("POST", `guide/files?${q}`, { dir: "server" }), (e) => e.status === 409 && e.reason === "guide-exists");
  await assert.rejects(api("POST", `guide/files?${q}`, { dir: "node_modules/x" }), (e) => e.reason === "guide-path");
  // 연결 문서: 조건 필수, 링크 줄을 넣은 글을 돌려준다(지침은 저장하지 않음)
  await assert.rejects(api("POST", `guide/docs?${q}`, { title: "배포", condition: "" }), (e) => e.reason === "guide-condition");
  const doc = await api("POST", `guide/docs?${q}`, { title: "배포 절차", condition: "배포하기 전에", text: ROOT });
  assert.equal(doc.doc, "docs/배포-절차.md");
  assert.match(fs.readFileSync(path.join(root, "docs", "배포-절차.md"), "utf8"), /# 배포 절차\n\n<!-- 언제 읽나: 배포하기 전에/);
  assert.match(doc.text, /- 배포하기 전에 \[배포 절차\]\(docs\/배포-절차\.md\)/);
  const imported = await api("POST", `guide/docs?${q}`, { title: "용어", condition: "항상", mode: "import" });
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "@docs/용어.md\n");
  assert.equal(imported.imported, "CLAUDE.md");
  const exact = await api("POST", `guide/docs?${q}`, { docPath: "docs/new/missing.md" });
  assert.equal(exact.created, true);
  assert.ok(fs.existsSync(path.join(root, "docs", "new", "missing.md")));
  // 영향과 삭제(백업·참조 정리), 되살리기
  const view = await api("GET", `guide?${q}`);
  assert.deepEqual(view.uncommitted.sort(), ["CLAUDE.md", "server/AGENTS.md", "server/CLAUDE.md"]);
  const impact = await api("GET", `guide/impact?${q}&file=docs/unity.md`);
  assert.deepEqual(impact.refs.map((r) => [r.from, r.kind]), [["AGENTS.md", "conditional"]]);
  assert.equal(impact.tracked, false);
  assert.equal((await api("GET", `guide/impact?${q}&file=AGENTS.md`)).tracked, true);
  await assert.rejects(api("DELETE", `guide?${q}&file=docs/unity.md&baseHash=wrong`), (e) => e.status === 409);
  const removed = await api("DELETE", `guide?${q}&file=docs/unity.md&baseHash=${impact.hash}&dropRefs=1`);
  assert.equal(fs.existsSync(path.join(root, "docs", "unity.md")), false);
  assert.deepEqual(removed.cleaned, [{ file: "AGENTS.md", removed: 1 }]);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /unity\.md/);
  const trash = await api("GET", `guide/trash?${q}`);
  assert.deepEqual(trash.items.map((i) => i.file), ["docs/unity.md"]);
  await api("POST", `guide/restore?${q}`, { id: removed.backup });
  assert.equal(fs.readFileSync(path.join(root, "docs", "unity.md"), "utf8"), "# Unity\n- 씬 이름을 바꾸지 않는다.\n");
  assert.deepEqual((await api("GET", `guide/trash?${q}`)).items, []);
  // 지침 파일도 지우고 되살린다. 같은 경로에 새 파일이 있으면 되살리지 않는다.
  const gone = await api("DELETE", `guide?${q}&file=server/CLAUDE.md`);
  put(path.join(root, "server", "CLAUDE.md"), "새 파일\n");
  await assert.rejects(api("POST", `guide/restore?${q}`, { id: gone.backup }), (e) => e.status === 409);
  assert.deepEqual((await api("GET", `guide/check-all?${q}`)).files, [], "링크를 정리하고 짝을 맞추면 갈래 경고가 없다");
});
