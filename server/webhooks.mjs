// 웹훅 노드: 흐름의 결과를 다른 서비스로 보내거나(웹훅 보내기), 바깥에서 온 요청으로 흐름을 시작한다(웹훅 받기).
import { timingSafeEqual } from "node:crypto";
import { jsonStringEscape, parseWebhookHeaders, renderTemplate } from "./flow-nodes.mjs";

const RESPONSE_MAX = 200_000; // 다음 노드에 넘기는 응답 본문
export const HOOK_BODY_MAX = 1_000_000;
const HOOK_RATE = 60; // 노드 하나가 1분에 받을 수 있는 요청 수

// 웹훅을 한 번 보낸다. 2xx 응답이면 성공이다. 결과: { ok, status, statusText, text }
export async function sendWebhook(node, variables, { signal, fetch: fetchImpl = globalThis.fetch } = {}) {
  const headers = new Headers();
  for (const [name, value] of parseWebhookHeaders(node.headers)) headers.set(name, renderTemplate(value, variables).replace(/[\r\n]+/g, " "));
  let body;
  if (["POST", "PUT", "PATCH"].includes(node.method)) {
    if (node.bodyType === "json") {
      body = renderTemplate(node.body, variables, jsonStringEscape);
      try { JSON.parse(body); }
      catch { throw new Error('보낼 본문이 올바른 JSON이 아닙니다. 값은 자동으로 이스케이프되므로 "{{input}}"처럼 따옴표 안에 쓰세요.'); }
    } else body = renderTemplate(node.body, variables);
    if (!headers.has("content-type")) headers.set("content-type", node.bodyType === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, (node.timeoutSec ?? 30) * 1000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(node.url, { method: node.method, headers, body, signal: controller.signal, redirect: "follow" });
    const text = (await response.text()).slice(0, RESPONSE_MAX);
    return { ok: response.ok, status: response.status, statusText: response.statusText, text };
  } catch (error) {
    if (signal?.aborted) throw new Error("요청을 중지했습니다.");
    if (timedOut) throw new Error(`응답이 ${node.timeoutSec ?? 30}초 안에 오지 않았습니다.`);
    throw new Error(`요청을 보내지 못했습니다: ${error.cause?.message ?? error.message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// 받은 요청을 흐름 변수로 바꾼다. JSON 본문이면 {{payload.필드}}로 꺼내 쓸 수 있다.
export function hookVariables({ method = "POST", body = "", query = {}, headers = {} } = {}) {
  let payload = {};
  try {
    const parsed = body.trim() ? JSON.parse(body) : {};
    if (parsed && typeof parsed === "object") payload = parsed;
  } catch { /* JSON이 아닌 본문은 {{body}}로만 쓴다. */ }
  const event = headers["x-github-event"] ?? headers["x-gitlab-event"] ?? headers["x-event-type"] ?? "";
  return { body, payload, method, query, event: String(event), receivedAt: new Date().toISOString() };
}

// 주소의 비밀 값으로 웹훅 받기 노드를 찾는다. 비교 시간으로 값을 추측하지 못하게 한다.
export function findHookNode(commands, token) {
  if (!/^[0-9a-f]{48}$/.test(token ?? "")) return null;
  const wanted = Buffer.from(token);
  return commands.find((node) => node.kind === "webhook-in" && typeof node.hookToken === "string"
    && node.hookToken.length === token.length && timingSafeEqual(Buffer.from(node.hookToken), wanted)) ?? null;
}

// 노드마다 최근 1분 동안 받은 요청 수를 센다.
export function createHookRateLimit(limit = HOOK_RATE, windowMs = 60_000) {
  const hits = new Map();
  return (id, now = Date.now()) => {
    const recent = (hits.get(id) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= limit) { hits.set(id, recent); return false; }
    recent.push(now);
    hits.set(id, recent);
    return true;
  };
}
