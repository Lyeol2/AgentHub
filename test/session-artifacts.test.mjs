import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectReportReferences } from "../public/report-references.js";
import {
  readSessionArtifact, readSessionArtifactContent, resolveSessionArtifact,
  validateArtifactReferences, openPreviewMedia, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_TEXT_BYTES,
} from "../server/session-artifacts.mjs";
import { Writable } from "node:stream";
import { sessionRoutes } from "../server/transport/routes/sessions.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-artifacts-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("agenthub-artifacts-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, "project"), cwd = path.join(project, "worktree"), outside = path.join(root, "outside");
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(outside);
  const session = { id: "artifact-session", cwd, projectPath: project, events: [] };
  const write = (name, content, base = cwd) => {
    const file = path.join(base, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
    return file;
  };
  return { root, project, cwd, outside, session, write };
}

test("session artifacts: encoded and file-URL transcript links authorize the exact external media file", (t) => {
  const { session, outside, write } = fixture(t);
  const file = write("화면 #1.png", Buffer.from([1, 2]), outside);
  const neighbour = write("화면 #2.png", Buffer.from([3, 4]), outside);
  for (const link of [pathToFileURL(file).href, encodeURI(file.replace(/\\/g, "/")).replace(/#/g, "%23")]) {
    session.events = [{ kind: "text", text: `![화면](${link})` }];
    const ref = collectReportReferences(session.events[0].text)[0];
    assert.equal(readSessionArtifact(session, ref.path).path, file);
    assert.throws(() => readSessionArtifact(session, neighbour), { status: 403 });
  }
});

test("session artifacts: video metadata and bounded HTML media assets are preserved", (t) => {
  const { session, write } = fixture(t);
  write("clip.webm", Buffer.from([1, 2, 3]));
  assert.equal(readSessionArtifact(session, "clip.webm").kind, "video");
  assert.equal(readSessionArtifactContent(session, "clip.webm").mimeType, "video/webm");
  write("video.html", '<video controls src="clip.webm"></video>');
  const result = readSessionArtifact(session, "video.html");
  // 영상은 페이지에 넣지 않고 미리보기 전용 임시 주소로 받는다.
  const token = result.previewHtml.match(/src="\/preview-media\/([0-9a-f]{48})"/)?.[1];
  assert.ok(token, result.previewHtml);
  assert.equal(openPreviewMedia(token).mimeType, "video/webm");
  assert.throws(() => openPreviewMedia("0".repeat(48)), { status: 404 });
  assert.match(result.previewHtml, /media-src data: http:\/\/127\.0\.0\.1:\*/);
  assert.equal(result.previewWarnings, undefined);
});

test("session artifacts: an external HTML page mentioned by the answer loads its own folder's media but nothing outside it", (t) => {
  const { session, outside, write } = fixture(t);
  const page = write("review/index.html", '<img src="thumb.png"><video src="render/edit.mp4"></video><img src="../secret.png">', outside);
  write("review/thumb.png", Buffer.from([1, 2]), outside);
  write("review/render/edit.mp4", Buffer.from([0, 1, 2]), outside);
  write("secret.png", Buffer.from([3]), outside);
  // Codex처럼 드라이브 앞에 /를 붙인 링크로 언급한다.
  session.events = [{ kind: "text", text: `[검토 페이지](</${page.split(path.sep).join("/")}>)` }];
  const result = readSessionArtifact(session, page);
  assert.match(result.previewHtml, /<img src="data:image\/png;base64,AQI=">/);
  assert.match(result.previewHtml, /<video src="\/preview-media\/[0-9a-f]{48}">/);
  assert.match(result.previewHtml, /<img src="data:,">/);
  assert.deepEqual(result.previewWarnings, ["불러오지 못한 리소스: ../secret.png"]);
  assert.throws(() => readSessionArtifact(session, path.join(outside, "review", "thumb.png")), { status: 403 });
});

test("session artifact routes: video playback streams full, partial and suffix byte requests", async (t) => {
  const { session, write } = fixture(t);
  write("clip.mp4", Buffer.from([0, 1, 2, 3, 4, 5]));
  const handler = sessionRoutes({ artifactContent: (_, file) => readSessionArtifactContent(session, file) }).find((route) => route[1] === "sessions/:id/artifact/content")[2];
  // 영상은 파일을 통째로 읽지 않고 스트림으로 보낸다. 받은 조각을 모으는 Writable을 응답으로 넘긴다.
  const request = (range, download = false) => new Promise((resolve) => {
    const chunks = [], response = {};
    const res = new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); } });
    res.writeHead = (status, headers) => Object.assign(response, { status, headers });
    res.on("finish", () => resolve({ ...response, body: Buffer.concat(chunks) }));
    handler({ params: { id: session.id }, query: new URLSearchParams({ path: "clip.mp4", ...(download ? { download: "1" } : {}) }), req: { headers: { range } }, res });
  });
  const full = await request();
  assert.equal(full.headers["Content-Type"], "video/mp4");
  assert.equal(full.status, 200);
  assert.deepEqual([...full.body], [0, 1, 2, 3, 4, 5]);
  for (const [range, bytes, contentRange] of [["bytes=1-3", [1, 2, 3], "bytes 1-3/6"], ["bytes=4-", [4, 5], "bytes 4-5/6"], ["bytes=-2", [4, 5], "bytes 4-5/6"]]) {
    const response = await request(range);
    assert.equal(response.status, 206);
    assert.equal(response.headers["Content-Range"], contentRange);
    assert.deepEqual([...response.body], bytes);
  }
  for (const range of ["bytes=9-", "bytes=4-2", "bytes=-0", "bytes=-", "bytes=0-1,3-4", "garbage"]) assert.equal((await request(range)).status, 416, range);
  const download = await request("bytes=1-2", true);
  assert.equal(download.headers["Content-Type"], "application/octet-stream");
  assert.equal(download.status, 200, "a download ignores the range and sends the whole file");
});

test("session artifacts: videos have their own larger size limit", (t) => {
  const { session, write } = fixture(t);
  fs.truncateSync(write("big.mp4", ""), MAX_ARTIFACT_BYTES + 1);
  assert.equal(resolveSessionArtifact(session, "big.mp4").size, MAX_ARTIFACT_BYTES + 1);
  fs.truncateSync(write("big.txt", ""), MAX_ARTIFACT_BYTES + 1);
  assert.throws(() => resolveSessionArtifact(session, "big.txt"), { status: 413 });
});

test("session artifacts: relative working files and absolute original-project files have typed metadata", (t) => {
  const { session, project, write } = fixture(t);
  const report = write("검증 기록.md", "# 확인\n완료");
  const original = write("original.txt", "원본 폴더", project);
  assert.deepEqual(readSessionArtifact(session, "검증 기록.md"), {
    path: report, name: "검증 기록.md", kind: "markdown", mimeType: "text/markdown",
    size: Buffer.byteLength("# 확인\n완료"), text: "# 확인\n완료", truncated: false,
  });
  assert.equal(readSessionArtifact(session, original).text, "원본 폴더");
  assert.equal(Object.hasOwn(readSessionArtifact(session, report), "realPath"), false);
  write("empty.txt", "");
  assert.equal(readSessionArtifact(session, "empty.txt").text, "");
});

test("session artifacts: exact external transcript references grant only that absolute file", (t) => {
  const { session, outside, write } = fixture(t);
  const report = write("최종 보고서.md", "외부 검증", outside);
  const neighbour = write("최종 보고서.md.backup", "비공개", outside);
  assert.throws(() => readSessionArtifact(session, report), { status: 403 });
  session.events.push({ kind: "text", text: `[최종 보고서](${report.replace(/\\/g, "/")})` });
  assert.equal(readSessionArtifact(session, report).text, "외부 검증");
  assert.throws(() => readSessionArtifact(session, neighbour), { status: 403 });
  assert.throws(() => readSessionArtifact(session, path.relative(session.cwd, report)), { status: 403 });
  session.events = [{ kind: "text", text: `경로 ${report}.backup` }];
  assert.throws(() => readSessionArtifact(session, report), { status: 403 });
  session.events = [{ kind: "text", text: `근거 [파일](${report}:12)` }];
  assert.equal(readSessionArtifact(session, report).kind, "markdown");
});

test("session artifacts: attachment IDs are resolved only through the owning session", (t) => {
  const { session, outside, write } = fixture(t);
  const image = write("uploaded.png", Buffer.from([1, 2, 3]), outside);
  session.events.push({ kind: "user", attachments: [{ id: "own-image" }] });
  assert.throws(() => resolveSessionArtifact(session, image), { status: 403 });
  const options = { resolveAttachment: (attachment) => { assert.equal(attachment.id, "own-image"); return { path: image }; } };
  assert.deepEqual(readSessionArtifactContent(session, image, options).bytes, Buffer.from([1, 2, 3]));
  assert.equal(readSessionArtifact(session, image, options).kind, "image");
});

test("session artifacts: source line suffixes and @ mentions keep path identity", (t) => {
  const { session, outside, write } = fixture(t);
  const source = write("source.ts", "const source = true;", outside);
  session.events = [{ kind: "user", text: `@${source} 확인` }];
  const line = readSessionArtifact(session, source + ":12:3");
  assert.equal(line.path, source);
  assert.equal(line.line, 12);
  assert.equal(line.column, 3);
  assert.equal(readSessionArtifact(session, source + "#L24").line, 24);
  session.events = [{ kind: "user", text: `@"${source}" 확인` }];
  assert.equal(readSessionArtifact(session, source).kind, "text");
  session.events = [{ kind: "text", text: `[근거](${source}#L24)` }];
  assert.equal(readSessionArtifact(session, source + "#L24").line, 24);
});

test("session artifacts: reject protocols, network paths, directories and missing files", (t) => {
  const { session, cwd } = fixture(t);
  for (const value of [undefined, "", "file:///C:/secret.txt", "https://example.test/file", "javascript:alert(1)", "//server/share/file", "\\\\server\\file", "C:relative.txt", "a.txt:stream", "bad\u0000.txt"]) {
    assert.throws(() => readSessionArtifact(session, value), { status: 400 });
  }
  assert.throws(() => readSessionArtifact(session, cwd), { status: 400 });
  assert.throws(() => readSessionArtifact(session, "missing.md"), { status: 404 });
  session.locked = true;
  assert.throws(() => readSessionArtifact(session, "missing.md"), { status: 423 });
});

test("session artifacts: directory junctions cannot escape project boundaries", (t) => {
  const { session, cwd, outside, write } = fixture(t);
  write("secret.txt", "secret", outside);
  const link = path.join(cwd, "escape");
  try { fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Directory links unavailable"); throw error; }
  assert.throws(() => readSessionArtifact(session, "escape/secret.txt"), { status: 403 });
  session.events.push({ kind: "text", text: `파일 ${path.join(link, "secret.txt")}` });
  assert.throws(() => readSessionArtifact(session, "escape/secret.txt"), { status: 403 });
});

test("session artifacts: text prefixes preserve UTF-8 and binary/oversize content is bounded", (t) => {
  const { session, write } = fixture(t);
  write("large.txt", "가".repeat(MAX_ARTIFACT_TEXT_BYTES));
  const preview = readSessionArtifact(session, "large.txt");
  assert.equal(preview.truncated, true);
  assert.ok(Buffer.byteLength(preview.text) <= MAX_ARTIFACT_TEXT_BYTES);
  assert.equal(preview.text.includes("\ufffd"), false);
  write("binary.txt", Buffer.from([0, 255, 3]));
  assert.equal(readSessionArtifact(session, "binary.txt").kind, "file");
  assert.equal(Object.hasOwn(readSessionArtifact(session, "binary.txt"), "text"), false);
  const huge = write("huge.bin", "");
  fs.truncateSync(huge, MAX_ARTIFACT_BYTES + 1);
  assert.throws(() => readSessionArtifact(session, huge), { status: 413 });
  assert.throws(() => readSessionArtifactContent(session, huge), { status: 413 });
});

test("session artifacts: HTML preview embeds local CSS, nested images and scripts while preserving source", (t) => {
  const { session, write } = fixture(t);
  const png = Buffer.from("iVBORw0KGgo=", "base64");
  write("screen.png", png);
  write("styles/theme.css", '.screen { background: url("../screen.png") }');
  write("styles/main.css", '@import "theme.css"; body { color: teal; }');
  const js = 'document.body.dataset.ready = "yes"; const example = "<img src=literal.png>";';
  write("app.js", js);
  const source = '<!doctype html><html><head><base href="https://bad.test/"><link rel="stylesheet" href="styles/main.css"></head><body><img src="screen.png"><script src="app.js"></script></body></html>';
  write("screen.html", source);
  const result = readSessionArtifact(session, "screen.html");
  assert.equal(result.kind, "html");
  assert.equal(result.text, source);
  assert.ok(result.previewHtml.includes("color: teal"));
  assert.ok(result.previewHtml.includes("background:"));
  assert.ok(result.previewHtml.includes("data:image/png;base64,"));
  assert.ok(result.previewHtml.includes(js));
  assert.doesNotMatch(result.previewHtml, /<base\b|<link\b|<script\s+src=/i);
  assert.match(result.previewHtml, /Content-Security-Policy/);
  assert.match(result.previewHtml, /connect-src &#39;none&#39;|connect-src 'none'/);
  assert.equal(result.previewWarnings, undefined);
});

test("session artifacts: HTML preview reports external and escaping dependencies without embedding them", (t) => {
  const { session, outside, write } = fixture(t);
  const secret = write("secret.js", "window.secret = 'private';", outside);
  const relative = path.relative(session.cwd, secret).replace(/\\/g, "/");
  write("restricted.html", `<script src="${relative}"></script><img src="https://example.test/track"><script type="module">import './other.js';</script>`);
  const result = readSessionArtifact(session, "restricted.html");
  assert.ok(result.previewWarnings.some((warning) => warning.includes("secret.js")));
  assert.ok(result.previewWarnings.some((warning) => warning.includes("example.test")));
  assert.ok(result.previewWarnings.some((warning) => warning.includes("import")));
  assert.doesNotMatch(result.previewHtml, /private|https:\/\/example/);
  write("large.html", "<html>" + "a".repeat(MAX_ARTIFACT_TEXT_BYTES));
  assert.equal(readSessionArtifact(session, "large.html").previewHtml, undefined);
});

test("session artifacts: reference metadata must match an accessible file present in the prompt", (t) => {
  const { session, outside, write } = fixture(t);
  const file = write("src/app.js", "export const x = 1;");
  const input = [{ label: "app.js", path: "src/app.js" }];
  assert.deepEqual(validateArtifactReferences(session, input, "@src/app.js 확인"), input);
  assert.deepEqual(validateArtifactReferences(session, [...input, ...input], "@src/app.js"), input);
  assert.throws(() => validateArtifactReferences(session, input, "다른 요청"), { status: 400 });
  assert.throws(() => validateArtifactReferences(session, [{ label: "bad\nlabel", path: file }], file), { status: 400 });
  assert.throws(() => validateArtifactReferences(session, {}, ""), { status: 400 });
  const secret = write("secret.txt", "private", outside);
  assert.throws(() => validateArtifactReferences(session, [{ label: "secret", path: secret }], secret), { status: 403 });
});

test("session artifact routes: raw HTML/SVG are downloads; raster images stay inline; HTML previews are sandboxed", (t) => {
  const { session, write } = fixture(t);
  write("screen.html", "<html><body>preview<script>document.body.dataset.ok = 1</script></body></html>");
  write("vector.svg", '<svg onload="alert(1)"/>');
  write("image.png", Buffer.from([1, 2]));
  const routes = sessionRoutes({
    artifact: (_, file) => readSessionArtifact(session, file),
    artifactContent: (_, file) => readSessionArtifactContent(session, file),
    artifactPreview: (_, file) => readSessionArtifact(session, file).previewHtml,
  });
  const content = routes.find((route) => route[1] === "sessions/:id/artifact/content")[2];
  const preview = routes.find((route) => route[1] === "sessions/:id/artifact/preview")[2];
  const request = (handler, file, download = false) => {
    const response = {};
    handler({ params: { id: session.id }, query: new URLSearchParams({ path: file, ...(download ? { download: "1" } : {}) }), res: {
      writeHead: (status, headers) => Object.assign(response, { status, headers }), end: (body) => { response.body = body; },
    } });
    return response;
  };
  for (const name of ["screen.html", "vector.svg"]) {
    const response = request(content, name);
    assert.equal(response.headers["Content-Type"], "application/octet-stream");
    assert.match(response.headers["Content-Disposition"], /^attachment;/);
    assert.match(response.headers["Content-Security-Policy"], /^sandbox;/);
    assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  }
  assert.match(request(content, "image.png").headers["Content-Disposition"], /^inline;/);
  assert.match(request(content, "image.png", true).headers["Content-Disposition"], /^attachment;/);
  const html = request(preview, "screen.html");
  assert.match(html.headers["Content-Type"], /^text\/html;/);
  assert.match(html.headers["Content-Security-Policy"], /sandbox allow-scripts/);
  assert.doesNotMatch(html.headers["Content-Security-Policy"], /allow-same-origin|unsafe-eval/);
  assert.match(html.headers["Content-Security-Policy"], /frame-ancestors 'self'/);
  assert.match(html.body, /dataset.ok/);
});
