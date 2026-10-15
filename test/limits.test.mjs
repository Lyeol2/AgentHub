// Claude 사용 한도 기록. 실제 사용량 API는 부르지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-limits-"));
process.env.AGENTHUB_DATA = tmp;
const { recordClaudeLimit, sameWindow, createLimitsService } = await import("../server/limits.mjs");

test.after(() => {
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("limits: 초기화 시각이 조금 달라도 같은 기간으로 본다", () => {
  assert.equal(sameWindow("2026-10-15T11:50:00.000Z", "2026-10-15T11:50:00.316Z"), true);
  assert.equal(sameWindow("2026-10-15T11:50:00.000Z", "2026-10-15T16:50:00.000Z"), false);
  assert.equal(sameWindow(null, "2026-10-15T11:50:00.000Z"), false);
});

test("limits: 사용률 없는 실행 중 이벤트가 사용량 조회로 받은 값을 지우지 않는다", () => {
  const file = path.join(tmp, "limits.json");
  const resetsAt = "2026-10-15T11:50:00.316Z"; // 사용량 조회는 밀리초까지 준다.
  fs.writeFileSync(file, JSON.stringify({ claude: { five_hour: { status: "allowed", usedPercent: 37, resetsAt } } }));
  recordClaudeLimit({ rateLimitType: "five_hour", status: "allowed", resetsAt: Date.parse("2026-10-15T11:50:00Z") / 1000 });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claude.five_hour.usedPercent, 37);
  // 다음 기간으로 넘어가면 지난 사용률은 버린다.
  recordClaudeLimit({ rateLimitType: "five_hour", status: "allowed", resetsAt: Date.parse("2026-10-15T16:50:00Z") / 1000 });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claude.five_hour.usedPercent, null);
});


const epoch = Date.parse("2026-10-15T12:00:00Z");
const usageResponse = (usage, status = 200, retryAfter = null) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (name) => name === "retry-after" ? retryAfter : null },
  json: async () => usage,
});

function fixture(name, { response = () => usageResponse({ five_hour: { utilization: 23.5, resets_at: "2026-10-15T16:00:00Z" } }), clock = { now: epoch }, expiresAt = epoch + 60 * 60_000 } = {}) {
  const directory = path.join(tmp, name);
  const dataDir = path.join(directory, "data");
  const claudeDir = path.join(directory, "claude");
  const codexDir = path.join(directory, "codex");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "fixture-token-" + name, expiresAt, subscriptionType: "max",
  } }));
  const requests = [];
  const service = createLimitsService({
    dataDir, claudeDir, codexDir, now: () => clock.now,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return response(requests.length);
    },
  });
  return { service, directory, dataDir, claudeDir, codexDir, requests, clock };
}

test("limits: Hub마다 기록 경로와 TTL이 독립적이고 새로고침도 해당 Hub에만 적용된다", async () => {
  const first = fixture("first-ttl");
  const second = fixture("second-ttl");
  first.service.recordClaudeLimit({ rateLimitType: "seven_day", utilization: 0.4, resetsAt: epoch / 1000 + 86400 });
  assert.equal(first.service.readLimits().claude.windows[0].usedPercent, 40);
  assert.deepEqual(second.service.readLimits().claude.windows, []);
  assert.equal(fs.existsSync(path.join(second.dataDir, "limits.json")), false);
  await first.service.refreshClaudeUsage();
  await first.service.refreshClaudeUsage();
  assert.equal(first.requests.length, 1);
  await second.service.refreshClaudeUsage();
  assert.equal(second.requests.length, 1); // 앞 Hub의 TTL이 새 Hub의 첫 조회를 막지 않는다.
  assert.equal(first.requests[0].options.headers.Authorization, "Bearer fixture-token-first-ttl");
  assert.equal(second.requests[0].options.headers.Authorization, "Bearer fixture-token-second-ttl");
  assert.equal(first.service.readLimits().claude.plan, "max");
  assert.equal(second.service.readLimits().claude.windows[0].usedPercent, 23.5);
  await first.service.refreshClaudeUsage({ fresh: true });
  assert.equal(first.requests.length, 2);
  assert.equal(second.requests.length, 1);
  second.clock.now += 60_001;
  await second.service.refreshClaudeUsage();
  assert.equal(second.requests.length, 2);
});

test("limits: 한 Hub의 429 backoff와 오류가 다른 Hub의 조회를 막거나 표시되지 않는다", async () => {
  const clock = { now: epoch };
  const first = fixture("first-backoff", {
    clock,
    response: (count) => count === 1
      ? usageResponse(null, 429, "120")
      : usageResponse({ five_hour: { utilization: 51, resets_at: "2026-10-15T16:00:00Z" } }),
  });
  const second = fixture("second-backoff", { clock });
  await first.service.refreshClaudeUsage();
  assert.match(first.service.readLimits().claude.error, /2분 뒤/);
  await second.service.refreshClaudeUsage();
  assert.equal(second.requests.length, 1);
  assert.equal(second.service.readLimits().claude.error, null);
  await first.service.refreshClaudeUsage({ fresh: true });
  assert.equal(first.requests.length, 1); // 강제 새로고침도 backoff는 지킨다.
  clock.now += 60_001;
  await second.service.refreshClaudeUsage();
  await first.service.refreshClaudeUsage({ fresh: true });
  assert.equal(second.requests.length, 2);
  assert.equal(first.requests.length, 1);
  clock.now += 60_001;
  await first.service.refreshClaudeUsage();
  assert.equal(first.requests.length, 2);
  assert.equal(first.service.readLimits().claude.error, null);
  assert.equal(first.service.readLimits().claude.windows[0].usedPercent, 51);
  assert.equal(second.service.readLimits().claude.windows[0].usedPercent, 23.5);
});

test("limits: retry-after가 없으면 5분 대기하고 만료된 OAuth 토큰은 API에 보내지 않는다", async () => {
  const blocked = fixture("fallback-backoff", { response: () => usageResponse(null, 429) });
  await blocked.service.refreshClaudeUsage();
  assert.match(blocked.service.readLimits().claude.error, /5분 뒤/);
  blocked.clock.now += 299_999;
  await blocked.service.refreshClaudeUsage({ fresh: true });
  assert.equal(blocked.requests.length, 1);
  blocked.clock.now += 2;
  await blocked.service.refreshClaudeUsage();
  assert.equal(blocked.requests.length, 2);
  const expired = fixture("expired", { expiresAt: epoch - 1 });
  await expired.service.refreshClaudeUsage();
  assert.equal(expired.requests.length, 0);
  assert.match(expired.service.readLimits().claude.error, /만료/);
});

test("limits: API 실패에도 실행 중 기록은 유지하며 오류는 인스턴스마다 관리한다", async () => {
  const failed = fixture("http-failed", { response: () => usageResponse(null, 503) });
  const healthy = fixture("http-healthy");
  failed.service.recordClaudeLimit({ rateLimitType: "five_hour", utilization: 0.8, resetsAt: epoch / 1000 + 3600 });
  await failed.service.refreshClaudeUsage();
  await healthy.service.refreshClaudeUsage();
  assert.match(failed.service.readLimits().claude.error, /HTTP 503/);
  assert.equal(failed.service.readLimits().claude.windows[0].usedPercent, 80);
  assert.equal(healthy.service.readLimits().claude.error, null);
  fs.rmSync(path.join(failed.claudeDir, ".credentials.json"));
  await failed.service.refreshClaudeUsage({ fresh: true });
  assert.equal(failed.service.readLimits().claude.error, null);
  assert.equal(failed.requests.length, 1);
});

test("limits: 지정한 Codex 기록만 읽고 각 파일의 마지막 유효 한도 이벤트를 고른다", () => {
  const first = fixture("codex-first");
  const second = fixture("codex-second");
  function writeRollout(world, percent, timestamp, extra = "") {
    const directory = path.join(world.codexDir, "sessions", "2026", "10", "15");
    fs.mkdirSync(directory, { recursive: true });
    const message = (usedPercent) => JSON.stringify({ timestamp, payload: { rate_limits: {
      primary: { used_percent: usedPercent, window_minutes: 300, resets_at: epoch / 1000 + 3600 },
      secondary: { used_percent: 9.876, window_minutes: 10080, resets_at: epoch / 1000 + 86400 },
      plan_type: "pro", rate_limit_reached_type: "none",
    } } });
    fs.writeFileSync(path.join(directory, "rollout.jsonl"), '잘린 "rate_limits"\n' + message(1) + "\n" + message(percent) + "\n" + extra);
  }
  writeRollout(first, 72.34, "2026-10-15T11:59:00Z", '{"rate_limits":');
  writeRollout(second, 15, "2026-10-15T12:00:00Z");
  const firstRead = first.service.readLimits().codex;
  const secondRead = second.service.readLimits().codex;
  assert.deepEqual(firstRead.windows.map((window) => [window.label, window.usedPercent]), [["5시간", 72.3], ["주간", 9.9]]);
  assert.equal(firstRead.observedAt, "2026-10-15T11:59:00Z");
  assert.equal(firstRead.plan, "pro");
  assert.equal(firstRead.limitReached, "none");
  assert.equal(secondRead.windows[0].usedPercent, 15);
});
