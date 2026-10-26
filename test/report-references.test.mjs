import test from "node:test";
import assert from "node:assert/strict";
import { collectReportReferences, classifyReportTarget, tokenizeReportInline, isLocalPreviewUrl } from "../public/report-references.js";

test("report references: encoded local links and direct media URLs retain the correct target and type", () => {
  const refs = collectReportReferences("![화면](docs/%ED%99%94%EB%A9%B4%20%231.png) [영상](<file:///C:/My%20Clips/demo.webm>) [원본](https://example.com/screen.png?v=1) [재생](https://example.com/demo.mp4?token=example)");
  assert.deepEqual(refs.map((ref) => [ref.path || ref.url, ref.kind]), [
    ["docs/화면 #1.png", "image"], ["C:/My Clips/demo.webm", "video"],
    ["https://example.com/screen.png?v=1", "image"], ["https://example.com/demo.mp4?token=example", "video"],
  ]);
  assert.equal(classifyReportTarget("out/literal%20.png").path, "out/literal%20.png");
  assert.equal(collectReportReferences("[literal](out/literal%2520.png)")[0].path, "out/literal%20.png");
  assert.equal(collectReportReferences("![bad](out/bad%00.png)").length, 0);
  assert.equal(collectReportReferences("[영상](My%20Clips/demo.mp4)")[0].path, "My Clips/demo.mp4");
  assert.equal(collectReportReferences("[완료](out/100%.png)")[0].path, "out/100%.png");
  assert.equal(collectReportReferences("<file:///C:/My%20Clips/demo.webm>")[0].path, "C:/My Clips/demo.webm");
});

test("report references: local Markdown paths retain spaces, parentheses, Korean and line numbers", () => {
  const source = String.raw`[최종 보고서](C:/My Reports/검증 (최종).md:12) · [화면](<C:\Users\frog1\My Screens\미리보기 (2).png>)`;
  assert.deepEqual(collectReportReferences(source), [
    { path: "C:/My Reports/검증 (최종).md:12", label: "최종 보고서", kind: "markdown" },
    { path: String.raw`C:\Users\frog1\My Screens\미리보기 (2).png`, label: "화면", kind: "image" },
  ]);
  assert.equal(collectReportReferences(String.raw`[윈도우](C:\작업\(최종)\결과.md:3)`)[0].path, String.raw`C:\작업\(최종)\결과.md:3`);
});

test("report references: bare paths and file mentions omit ordinary prose and email", () => {
  const source = String.raw`결과 C:\My Reports\결과 (최종).md:9 확인. @src/main.ts @"docs/기능 명세.md" 및 public/화면.png, /tmp/result.html 그리고 hi@example.com 또는 문장입니다.`;
  const refs = collectReportReferences(source);
  assert.deepEqual(refs.map((ref) => ref.path), [String.raw`C:\My Reports\결과 (최종).md:9`, "src/main.ts", "docs/기능 명세.md", "public/화면.png", "/tmp/result.html"]);
  assert.deepEqual(refs.map((ref) => ref.kind), ["markdown", "text", "markdown", "image", "html"]);
  assert.equal(collectReportReferences("문장입니다. README.md example.com 일반적인 a/b 표현").length, 0);
  assert.deepEqual(collectReportReferences("C:/out/screen.html.png. 확인 src/report.js.txt.").map((ref) => ref.path), ["C:/out/screen.html.png", "src/report.js.txt"]);
});

test("report references: inline code, repeated backticks and all fenced code are excluded", () => {
  const source = "`[hidden](C:/private.md)` ``@src/private.ts ` value``\n```md\n[hidden](C:/secret.png)\n```\n> ~~~\n> @src/secret.ts\n> ~~~\n[visible](out/report.md)";
  assert.deepEqual(collectReportReferences(source), [{ path: "out/report.md", label: "visible", kind: "markdown" }]);
  assert.deepEqual(collectReportReferences("`example\nC:/hidden.md\n` [visible](out/report.md)"), [{ path: "out/report.md", label: "visible", kind: "markdown" }]);
});

test("report references: explicit supported session/task URIs and web preview URLs", () => {
  const source = "[디자인](agenthub://session/design-01) @agenthub://task/task-02 [앱](http://localhost:5173/view?q=a&b=2) https://example.com/a_(b).";
  assert.deepEqual(collectReportReferences(source), [
    { sessionId: "design-01", label: "디자인", kind: "session" },
    { taskId: "task-02", label: "task-02", kind: "task" },
    { url: "http://localhost:5173/view?q=a&b=2", label: "앱", kind: "web" },
    { url: "https://example.com/a_(b)", label: "https://example.com/a_(b)", kind: "web" },
  ]);
  for (const url of ["http://localhost:3", "https://127.0.0.1:44", "http://[::1]:5555"]) assert.equal(isLocalPreviewUrl(url), true);
  for (const url of ["https://localhost.evil.test", "file:///tmp/a", "http://user:pass@localhost"]) assert.equal(isLocalPreviewUrl(url), false);
});

test("report references: deduplication merges Windows spellings and trusted structured references", () => {
  assert.deepEqual(collectReportReferences("[보고서](C:/Reports/Result.md) [원문](c:\\reports\\result.md)", {
    references: [{ path: "C:/Reports/Result.md", status: "passed" }, { path: "out/screen.png", label: "화면" }, { path: "javascript:evil", status: "passed" }],
  }), [
    { path: "C:/Reports/Result.md", label: "보고서", kind: "markdown", status: "passed" },
    { path: "out/screen.png", label: "화면", kind: "image" },
  ]);
});

test("report references: QA statuses require explicit statements and ignore code", () => {
  const refs = collectReportReferences("[A](out/a.md) 검증 통과\n[B](out/b.md) 테스트 실패\n[C](out/c.md) 검증 미실행\n[D](out/d.md) 저장 완료\n[E](out/e.md) `검증 통과`\n[F](out/f.md) 검증 통과하지 못함");
  assert.deepEqual(refs.map((ref) => ref.status), ["passed", "failed", "not-run", undefined, undefined, undefined]);
  assert.equal(collectReportReferences("[A](out/a.md) 검증 통과, 검증 실패")[0].status, undefined);
  for (const text of ["[검증](out/verification-passed.md)", "[A](out/a.md) 검증 통과해야 함", "[A](out/a.md) 검증 통과 안 됨", "[A](out/a.md) failed to save"]) assert.equal(collectReportReferences(text)[0].status, undefined);
  assert.equal(collectReportReferences("[A](out/a.md) 검증 통과\n[A](out/a.md) 검증 실패\n[A](out/a.md) 검증 통과")[0].status, undefined);
});

test("report references: saved composer aliases restore their paths or session/task targets", () => {
  const references = [{ label: "명세 초안", path: "docs/spec.md" }, { label: "디자인", path: "agenthub://session/design-1" }, { label: "할 일", taskId: "todo-2" }];
  assert.deepEqual(collectReportReferences('@"명세 초안" @디자인 @"할 일"', { references }).map((ref) => [ref.path, ref.sessionId, ref.taskId, ref.label]), [
    ["docs/spec.md", undefined, undefined, "명세 초안"],
    [undefined, "design-1", undefined, "디자인"],
    [undefined, undefined, "todo-2", "할 일"],
  ]);
});

test("report references: unsafe schemes, credentials, injected targets and unsupported images are rejected", () => {
  for (const target of ["javascript:alert(1)", "data:text/html,<script>", "vbscript:evil", "https://user:secret@example.com", "agenthub://session/a%22onclick", "C:/a\u0000.txt", 'C:/a" onclick="bad.md']) {
    assert.equal(classifyReportTarget(target), null, target);
  }
  assert.equal(classifyReportTarget("http://example.com/screen.png", { image: true }), null);
  assert.equal(classifyReportTarget("/api/settings", { image: true })?.path, "/api/settings");
  assert.equal(classifyReportTarget("/api/sessions/a/attachments/b", { image: true }).url, "/api/sessions/a/attachments/b");
  assert.equal(tokenizeReportInline("[bad](javascript:alert('https://example.com'))")[0].reference, null);
  assert.equal(classifyReportTarget("out/vector.svg", { image: true }).kind, "text");
  assert.equal(classifyReportTarget("out/scan.tiff", { image: true }).kind, "file");
  assert.equal(classifyReportTarget("out/page.html", { image: true }).kind, "html");
});
