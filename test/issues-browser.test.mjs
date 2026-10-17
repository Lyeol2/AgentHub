import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// 팀 작업 탭: 공용 작업함 필터, 맡은 작업을 새 작업으로 시작, 작업 보내기의 링크·첨부 파일.
// 모든 API는 가짜 응답이다. GitHub·Git·사용자 데이터에는 접근하지 않는다.
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const browserExecutable = "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function runBrowser(temp, url, expression) {
  const profile = path.join(temp, "profile");
  const child = spawn(browserExecutable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { windowsHide: true });
  const closed = new Promise((resolve) => child.on("exit", resolve));
  let socket;
  try {
    let port;
    for (const deadline = Date.now() + 10000; !port; ) {
      if (Date.now() > deadline) throw Error("Browser launch timeout");
      port = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8").then((s) => Number(s.split("\n")[0]), () => null);
      if (!port) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const target = await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", { method: "PUT" }).then((res) => res.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map(), errors = [];
    let id = 0;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    });
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => reject(Error("DevTools timed out: " + method + "\n" + errors.join("\n"))), 30000);
      pending.set(requestId, (message) => { clearTimeout(timer); if (message.error) reject(Error(message.error.message)); else resolve(message.result); });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    await command("Runtime.enable");
    await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise((resolve) => { const listener = ({ data }) => { if (JSON.parse(data).method === "Page.loadEventFired") { socket.removeEventListener("message", listener); resolve(); } }; socket.addEventListener("message", listener); });
    await command("Page.navigate", { url }); await loaded;
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error((result.exceptionDetails.exception?.description ?? result.exceptionDetails.text) + "\nBrowser errors:\n" + errors.join("\n"));
    return { checks: result.result.value, errors };
  } finally {
    socket?.close(); child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

const SCENARIO = String.raw`(async () => {
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (fn, label) => { for (let i = 0; i < 200; i++) { if (fn()) return; await wait(25); } throw Error("timeout: " + label); };
  const checks = [];
  const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  await until(() => [...document.querySelectorAll("button")].some((b) => /Fixture/.test(b.textContent) && b.closest("nav, aside, .sidebar")), "project nav");
  [...document.querySelectorAll("button")].find((b) => /Fixture/.test(b.textContent) && b.closest("nav, aside, .sidebar")).click();
  await until(() => document.querySelector('[data-tab="issues"]'), "issues tab");
  document.querySelector('[data-tab="issues"]').click();
  await until(() => !$("i-grid").hidden && $("i-list").children.length, "inbox list");

  document.querySelector('[data-box="shared"]').click();
  await until(() => !$("i-filters").hidden && $("i-list").children.length === 3, "shared list");
  check(document.querySelectorAll("#i-list .issue-assignee-pill.unassigned").length === 1, "shared box shows unassigned work with a needs-someone mark");
  check([...$("i-assignee").options].map((o) => o.value).join() === ",alice,bob", "assignee filter lists the people working on shared tasks");
  document.querySelector('[data-progress="unassigned"]').click();
  check($("i-list").children.length === 1 && /맡을 사람 필요/.test($("i-list").textContent), "needs-someone filter keeps only unassigned work");
  document.querySelector('[data-progress="assigned"]').click();
  check($("i-list").children.length === 2, "in-progress filter keeps assigned work");
  $("i-assignee").value = "bob"; $("i-assignee").dispatchEvent(new Event("change"));
  check($("i-list").children.length === 1 && /담당 @alice, @bob/.test($("i-list").textContent) && /1개 \/ 3개 중/.test($("i-list-note").textContent), "assignee filter narrows the list and shows how many are hidden: " + $("i-list-note").textContent);
  $("i-assignee").value = ""; $("i-assignee").dispatchEvent(new Event("change"));
  document.querySelector('[data-progress="all"]').click();

  document.querySelector('[data-box="inbox"]').click();
  await until(() => $("i-filters").hidden && $("i-list").children.length === 1, "inbox again");
  check($("i-filters").hidden, "filters are only shown for the shared box");
  $("i-list").querySelector("button").click();
  await until(() => [...document.querySelectorAll("#i-detail button")].some((b) => b.textContent === "작업으로 시작"), "start as task button");
  [...document.querySelectorAll("#i-detail button")].find((b) => b.textContent === "작업으로 시작").click();
  await until(() => $("new-task-dialog").open, "new task dialog");
  check($("task-create-heading").textContent === "새 작업 · 이슈 #7", "the new task dialog names the issue it will link");
  check($("task-title").value === "로그인 오류" && /GitHub 이슈 #7/.test($("task-content").value) && /버튼이 안 눌림/.test($("task-content").value), "issue title and body are prefilled for review");
  check(!$("task-create-draft").hidden && !$("task-create-submit").hidden, "prefilled task opens ready to start without the AI draft step");
  check($("task-branch-summary").textContent.startsWith("브랜치 feature/로그인-오류"), "branch name is shown from the issue title");
  $("new-task-form").requestSubmit($("task-create-submit"));
  await until(() => !$("new-task-dialog").open, "task created");
  const requests = await fetch("/fixture/requests").then((r) => r.json());
  const created = requests.find((r) => r.method === "POST" && r.path === "/api/tasks");
  const linked = requests.find((r) => r.method === "POST" && r.path === "/api/tasks/t1/issue");
  check(created && created.body.title === "로그인 오류" && linked && linked.body.number === "7", "creating the task links the issue to it");
  await until(() => document.querySelector('.task-card .task-number')?.textContent === "#7", "linked card");
  check(true, "the task card shows the linked issue");

  document.querySelector('[data-tab="issues"]').click();
  await until(() => !$("i-new").disabled, "send button");
  $("i-new").click();
  await until(() => !$("issue-attach").disabled, "attach enabled");
  const body = $("issue-body");
  body.value = "설명 문서"; body.setSelectionRange(3, 5);
  window.prompt = () => "https://example.com/spec";
  $("issue-link").click();
  check(body.value === "설명 [문서](https://example.com/spec)", "link wraps the selected text");
  window.prompt = () => "javascript:alert(1)";
  $("issue-link").click();
  check(/http/.test($("issue-error").textContent) && !body.value.includes("javascript:"), "only http(s) links are inserted");
  $("issue-error").textContent = "";

  let asked = 0;
  window.confirm = () => { asked++; return true; };
  body.setSelectionRange(body.value.length, body.value.length);
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "화면.png", { type: "image/png" }));
  body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  await until(() => body.value.includes("올리는 중"), "upload marker");
  check(document.querySelector('#issue-form button[value="ok"]').disabled, "sending waits while a file is uploading");
  await fetch("/fixture/release-upload", { method: "POST" });
  await until(() => body.value.includes("![화면.png]"), "uploaded markdown");
  check(!body.value.includes("올리는 중") && !document.querySelector('#issue-form button[value="ok"]').disabled, "uploaded image replaces the marker and sending is enabled again");
  check(asked === 1, "the first upload asks once where the file will be stored");
  const upload = (await fetch("/fixture/requests").then((r) => r.json())).find((r) => r.path === "/api/issues/attachments");
  check(upload.body.name === "화면.png" && upload.body.mimeType === "image/png" && upload.body.data === "iVBORw==" && upload.body.repo === "acme/widget", "the file is sent as base64 with the repository it belongs to");

  const drop = new DataTransfer();
  drop.items.add(new File(["x"], "fail.txt", { type: "text/plain" }));
  body.dispatchEvent(new DragEvent("drop", { dataTransfer: drop, bubbles: true, cancelable: true }));
  await until(() => /fail\.txt/.test($("issue-error").textContent), "upload failure");
  check(!body.value.includes("올리는 중") && asked === 1, "a failed upload removes its marker and does not ask again");
  $("issue-dialog").close();
  return checks;
})()`;

test("browser: team tasks filter shared work, start assigned work as a task, and attach files to new issues", { timeout: 60000 }, async (t) => {
  if (process.platform !== "win32" || !await fs.access(browserExecutable).then(() => true, () => false)) return t.skip("Installed Windows Chromium is required for browser integration");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-issues-browser-"));
  const requests = [];
  // 첨부 응답은 화면이 "올리는 중" 상태를 확인한 뒤 풀어 준다. 풀기 요청이 먼저 와도 기다리지 않는다.
  let releaseUpload;
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  const project = { path: "C:/fixture", name: "Fixture", claude: 0, codex: 0, registered: true };
  const agents = Object.fromEntries(["claude", "codex"].map((name) => [name, { path: "C:/fixture/" + name + ".cmd", version: "1.0.0", models: [], efforts: [], permissions: name === "claude" ? ["acceptEdits"] : ["workspace-write"] }]));
  const issue = (number, title, assignees, extra = {}) => ({ number, repo: "acme/widget", title, body: "", meta: { from: "carol" }, url: "https://github.com/acme/widget/issues/" + number,
    state: "open", stateReason: null, author: "carol", assignees, labels: ["agenthub"], comments: 0, updatedAt: "2026-10-17T00:00:00Z", link: null, ...extra });
  const shared = [issue(7, "로그인 오류", ["me"]), issue(8, "문서 정리", []), issue(9, "속도 개선", ["alice", "bob"])];
  // 위 담당자 me는 화면에 보이지 않게 alice로 바꾼다. 내 받은 작업은 #7 하나다.
  shared[0].assignees = ["alice"];
  const tasks = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/stream") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": ready\n\n"); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      requests.push({ method: req.method, path: url.pathname, search: url.search, body });
      if (url.pathname === "/fixture/requests") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(requests)); return; }
      if (url.pathname === "/fixture/release-upload") { releaseUpload?.(); res.end("{}"); return; }
      let value;
      if (url.pathname === "/api/status") value = { agents, projects: [project], cliOverrides: { claude: "", codex: "" }, cliAutoUpdate: false, linkConditions: [] };
      else if (url.pathname === "/api/account") value = { installed: true, connected: true, user: { login: "me", name: "", url: "https://github.com/me", avatarUrl: "" } };
      else if (url.pathname === "/api/issues/inbox") value = { issues: [] };
      else if (url.pathname === "/api/issues/context") value = { repo: "acme/widget", repositoryUrl: "https://github.com/acme/widget", private: true, hasIssues: true, viewer: "me", assignees: [{ login: "alice", name: "" }, { login: "bob", name: "" }, { login: "me", name: "" }] };
      else if (url.pathname === "/api/issues") value = url.searchParams.get("box") === "shared"
        ? { issues: shared, limited: false }
        : { issues: url.searchParams.get("box") === "inbox" ? [{ ...shared[0], assignees: ["me"] }] : [], limited: false };
      else if (url.pathname === "/api/issues/7") value = { repo: "acme/widget", viewer: "me", issue: { ...shared[0], assignees: ["me"], body: "버튼이 안 눌림" }, comments: [], commentsLimited: false, link: null };
      else if (url.pathname === "/api/issues/attachments") {
        if (body.name === "fail.txt") { res.statusCode = 400; res.end(JSON.stringify({ error: "첨부 실패" })); return; }
        await uploadGate;
        value = { ok: true, name: body.name, markdown: "![" + body.name + "](https://github.com/acme/widget/raw/agenthub-attachments/issues/x/" + encodeURIComponent(body.name) + ")" };
      }
      else if (url.pathname === "/api/tasks" && req.method === "POST") {
        const task = { id: "t1", projectPath: project.path, title: body.title, content: body.content, type: "feature", state: "working", branch: "feature/로그인-오류", baseBranch: "develop", targetBranch: "develop",
          gitflow: { main: "main", develop: "develop" }, sessionIds: [], createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z", cwd: "C:/fixture.agenthub/task-t1" };
        tasks.push(task); value = { task };
      }
      else if (url.pathname === "/api/tasks/t1/issue") { Object.assign(tasks[0], { issue: { repo: "acme/widget", number: Number(body.number), title: "로그인 오류", url: "https://github.com/acme/widget/issues/7", state: "open" } }); value = { task: tasks[0] }; }
      else if (url.pathname === "/api/tasks/t1/status") value = { dirty: 0, ahead: 0 };
      // 원본 폴더에서 만들기 전에 원본 폴더를 쓰고 있는지 묻는다.
      else if (url.pathname === "/api/tasks/in-place") value = { available: true };
      else if (url.pathname === "/api/tasks") value = { tasks };
      else if (url.pathname === "/api/tasks/context") value = { state: "current", settings: { main: "main", develop: "develop", featurePrefix: "feature/", hotfixPrefix: "hotfix/", releasePrefix: "release/" }, finishMode: "pr", freshness: { state: "current" } };
      else if (url.pathname === "/api/projects/all") value = [project];
      else if (url.pathname === "/api/graph-tabs") value = { tabs: [{ id: "tab-default", title: "기본", projectPath: project.path, order: 0 }], defaultTabId: "tab-default" };
      else if (url.pathname === "/api/commands") value = { shells: [], commands: [] };
      else if (url.pathname === "/api/limits") value = { claude: { windows: [] }, codex: { windows: [] } };
      else if (url.pathname === "/api/auth") value = { claude: false, codex: false };
      else if (url.pathname === "/api/update") value = { current: "0.0.0", desktop: false };
      else if (url.pathname === "/api/setup") value = { tools: [], jobs: {} };
      else if (url.pathname.startsWith("/api/") && req.method === "GET") value = [];
      else if (url.pathname.startsWith("/api/")) throw Error("Unexpected fixture request " + req.method + " " + req.url);
      else {
        const target = path.resolve(projectRoot, "public", "." + (url.pathname === "/" ? "/index.html" : url.pathname));
        if (!target.startsWith(path.resolve(projectRoot, "public") + path.sep)) throw Error("Unsafe fixture path");
        const content = await fs.readFile(target);
        res.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "text/html");
        res.end(content); return;
      }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const report = await runBrowser(temp, "http://127.0.0.1:" + server.address().port, SCENARIO);
    assert.ok(report.checks.length >= 15, JSON.stringify(report.checks));
    assert.deepEqual(report.errors.filter((error) => !/Failed to load resource/.test(error)), []);
    assert.ok(!requests.some((request) => request.method === "POST" && /\/(start|claim|comments|messages)$/.test(request.path)), "the scenario never starts a session or writes to the issue");
    assert.equal(requests.filter((request) => request.path === "/api/issues/attachments").length, 2);
  } finally {
    server.close();
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});
