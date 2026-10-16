import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createHub } from "../server/bootstrap.mjs";
import { checkFlowNode, renderTemplate, jsonStringEscape } from "../server/flow-nodes.mjs";
import { createHookRateLimit } from "../server/webhooks.mjs";

// 웹훅 보내기가 요청을 보낼 대상. /fail은 500으로 답한다.
async function target(t) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url === "/fail") res.writeHead(500, { "Content-Type": "text/plain" }).end("broken");
    else res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { received, url: (pathname) => `http://127.0.0.1:${server.address().port}${pathname}` };
}

async function hub(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenthub-webhook-"));
  const projectPath = path.join(root, "project");
  await mkdir(projectPath);
  const instance = createHub({ dataDir: path.join(root, "data"), port: 0, warmup: false });
  if (instance.runner) instance.runner.send = () => { throw new Error("Webhook fixture must not run an agent"); };
  await instance.start();
  t.after(async () => { await instance.shutdown(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${instance.port}`;
  async function api(method, pathname, body) {
    const response = await fetch(`${base}/api${pathname}`, { method, headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json().catch(() => null);
    assert.equal(response.ok, true, `${method} ${pathname}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  const hook = (token, init = {}) => fetch(`${base}/hooks/${token}`, { method: "POST", ...init });
  const node = async (id) => (await api("GET", `/commands?path=${encodeURIComponent(projectPath)}`)).commands.find((item) => item.id === id);
  return { projectPath, api, hook, node };
}

async function until(check) {
  const end = Date.now() + 8000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("Timed out waiting for webhook flow");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("webhook nodes: a received request starts the flow and its payload is sent onward as escaped JSON", async (t) => {
  const out = await target(t);
  const h = await hub(t);
  const receiver = await h.api("POST", "/commands", { projectPath: h.projectPath, kind: "webhook-in", prompt: 'PR {{payload.action}} "{{event}}"' });
  assert.match(receiver.hookToken, /^[0-9a-f]{48}$/);
  const sender = await h.api("POST", "/commands", { projectPath: h.projectPath, kind: "webhook", url: out.url("/ok"),
    headers: "X-Action: {{payload.action}}", body: '{"text": "{{input}}"}' });
  await h.api("POST", "/links", { from: receiver.id, to: sender.id });

  const response = await h.hook(receiver.hookToken, { body: JSON.stringify({ action: "opened" }), headers: { "Content-Type": "application/json", "X-GitHub-Event": "pull_request" } });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).ok, true);
  await until(() => out.received.length === 1);
  assert.equal(out.received[0].method, "POST");
  assert.equal(out.received[0].headers["x-action"], "opened");
  assert.match(out.received[0].headers["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(out.received[0].body), { text: 'PR opened "pull_request"' });
  const sent = await until(async () => { const value = await h.node(sender.id); return value.lastRun?.ok ? value : null; });
  assert.equal(sent.lastRun.httpStatus, 200);
  assert.equal(sent.lastRun.outputText, '{"ok":true}');
  assert.equal((await h.node(receiver.id)).lastRun.ok, true);
});

test("webhook nodes: receiving rejects unknown, browser, non-POST, disabled and rotated addresses", async (t) => {
  const h = await hub(t);
  const receiver = await h.api("POST", "/commands", { projectPath: h.projectPath, kind: "webhook-in" });
  assert.equal((await h.hook("0".repeat(48))).status, 404);
  assert.equal((await h.hook(receiver.hookToken, { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await h.hook(receiver.hookToken, { method: "GET" })).status, 405);
  assert.equal((await h.hook(receiver.hookToken, { body: "plain text" })).status, 202);

  await h.api("PUT", `/commands/${receiver.id}`, { enabled: false });
  assert.equal((await h.hook(receiver.hookToken, { body: "{}" })).status, 404);
  const rotated = await h.api("PUT", `/commands/${receiver.id}`, { enabled: true, regenerateToken: true });
  assert.notEqual(rotated.hookToken, receiver.hookToken);
  assert.equal((await h.hook(receiver.hookToken, { body: "{}" })).status, 404);
  assert.equal((await h.hook(rotated.hookToken, { body: "{}" })).status, 202);

  // 요청 템플릿에 없는 값을 쓰면 흐름을 시작하지 않고 400으로 알린다.
  await h.api("PUT", `/commands/${receiver.id}`, { prompt: "{{payload.missing}}" });
  assert.equal((await h.hook(rotated.hookToken, { body: "{}" })).status, 400);
  assert.equal((await h.node(receiver.id)).state, "error");
});

test("webhook nodes: a failing response marks the send node failed with its status", async (t) => {
  const out = await target(t);
  const h = await hub(t);
  const sender = await h.api("POST", "/commands", { projectPath: h.projectPath, kind: "webhook", url: out.url("/fail"), method: "PUT", bodyType: "text", body: "hello {{input}}" });
  await h.api("POST", `/commands/${sender.id}/run`, {});
  const failed = await until(async () => { const value = await h.node(sender.id); return value.lastRun ? value : null; });
  assert.equal(failed.state, "error");
  assert.equal(failed.lastRun.ok, false);
  assert.equal(failed.lastRun.httpStatus, 500);
  assert.match(failed.lastRun.outputText, /^HTTP 500/);
  assert.equal(out.received[0].method, "PUT");
  assert.equal(out.received[0].body, "hello ");
});

test("webhook nodes: settings validate URLs, headers and JSON escaping", () => {
  assert.throws(() => checkFlowNode({ kind: "webhook", url: "ftp://example.test" }), /http/);
  assert.throws(() => checkFlowNode({ kind: "webhook", url: "https://example.test", headers: "no colon" }), /이름: 값/);
  assert.throws(() => checkFlowNode({ kind: "webhook", url: "https://example.test", headers: "Host: other" }), /Host/);
  assert.throws(() => checkFlowNode({ kind: "webhook", url: "https://example.test", method: "TRACE" }), /요청 방식/);
  assert.equal(checkFlowNode({ kind: "webhook-in" }).enabled, true);
  assert.equal(checkFlowNode({ kind: "webhook-in", hookToken: "a".repeat(48) }).hookToken, undefined);
  assert.deepEqual(JSON.parse(renderTemplate('{"text": "{{input}}"}', { input: 'quote " and\nline' }, jsonStringEscape)), { text: 'quote " and\nline' });
  const allow = createHookRateLimit(2, 1000);
  assert.deepEqual([allow("n", 0), allow("n", 10), allow("n", 20), allow("n", 1500)], [true, true, false, true]);
});
