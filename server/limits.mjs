// 구독 사용 한도. 두 CLI 모두 남은 한도를 묻는 공개 명령이 없으므로 CLI가 남긴 정보를 모은다.
// Claude: `claude -p` 스트림의 rate_limit_event를 받을 때마다 data/limits.json에 저장한다.
// Codex:  ~/.codex/sessions 기록의 token_count 이벤트에 담긴 rate_limits 중 가장 최근 값을 읽는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./config.mjs";

const LIMITS_PATH = path.join(DATA_DIR, "limits.json");
const CODEX_DIR = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const TAIL_BYTES = 512 * 1024;

// ── Claude ──────────────────────────────────────────────────────
function loadSaved() {
  try {
    return JSON.parse(fs.readFileSync(LIMITS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// 0~1 비율이나 0~100 퍼센트로 올 수 있는 사용률을 퍼센트로 맞춘다.
function percent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return value <= 1 ? Math.round(value * 1000) / 10 : Math.round(value * 10) / 10;
}

const toIso = (sec) => (typeof sec === "number" ? new Date(sec * 1000).toISOString() : null);

function save(saved) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LIMITS_PATH, JSON.stringify(saved, null, 2));
}

export function recordClaudeLimit(info) {
  const saved = loadSaved();
  const type = info.rateLimitType ?? "unknown";
  saved.claude ??= {};
  const prev = saved.claude[type];
  const resetsAt = toIso(info.resetsAt);
  let usedPercent = percent(info.utilization ?? info.usedPercent);
  // 실행 중 이벤트는 한도에 가까울 때만 사용률을 싣는다. 같은 기간이면 사용량 조회로 받은 값을 지우지 않는다.
  if (usedPercent === null && prev?.resetsAt === resetsAt) usedPercent = prev.usedPercent ?? null;
  saved.claude[type] = {
    status: info.status ?? null,
    usedPercent,
    resetsAt,
    isUsingOverage: !!info.isUsingOverage,
    observedAt: new Date().toISOString(),
  };
  save(saved);
}

// 로그인한 Claude 계정의 사용률. Claude Code의 /usage와 같은 곳(OAuth 사용량 API)에서 읽는다.
// 공개 문서가 없는 API라 실패하면 실행 중에 받은 값만 보여 준다. 토큰 갱신은 CLI가 하므로 만료된 토큰으로는 묻지 않는다.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_TTL = 60_000;
let usageCheckedAt = 0;
let usageError = null;

export async function refreshClaudeUsage({ fresh = false } = {}) {
  if (!fresh && Date.now() - usageCheckedAt < USAGE_TTL) return;
  usageCheckedAt = Date.now();
  let oauth;
  try {
    oauth = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, ".credentials.json"), "utf8")).claudeAiOauth;
  } catch {
    usageError = null; // 로그인하지 않았거나 API 키를 쓰는 경우
    return;
  }
  if (!oauth?.accessToken) return;
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    usageError = "로그인 토큰이 만료되어 사용률을 읽지 못했습니다. Claude 세션을 한 번 실행하면 갱신됩니다.";
    return;
  }
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`사용률 조회 실패 (HTTP ${res.status})`);
    const usage = await res.json();
    const saved = loadSaved();
    saved.claude ??= {};
    const now = new Date().toISOString();
    for (const type of Object.keys(CLAUDE_LABEL)) {
      const w = usage[type];
      if (typeof w?.utilization !== "number") continue;
      const usedPercent = Math.round(w.utilization * 10) / 10; // 이 API는 항상 퍼센트로 준다
      saved.claude[type] = {
        ...saved.claude[type],
        status: usedPercent >= 100 ? "rejected" : saved.claude[type]?.status ?? "allowed",
        usedPercent,
        resetsAt: w.resets_at ? new Date(w.resets_at).toISOString() : null,
        observedAt: now,
      };
    }
    saved.claudePlan = oauth.subscriptionType ?? saved.claudePlan ?? null;
    save(saved);
    usageError = null;
  } catch (err) {
    usageError = err.message;
  }
}

const CLAUDE_LABEL = {
  five_hour: "5시간",
  seven_day: "주간",
  seven_day_opus: "주간 (Opus)",
  seven_day_sonnet: "주간 (Sonnet)",
  overage: "추가 사용량",
};

function claudeLimits() {
  const all = loadSaved();
  const saved = all.claude ?? {};
  // 5시간 → 주간 → 나머지 순서로 보여 준다.
  const order = Object.keys(CLAUDE_LABEL);
  const rank = (type) => (order.includes(type) ? order.indexOf(type) : order.length);
  const windows = Object.entries(saved)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([type, w]) => ({ id: type, label: CLAUDE_LABEL[type] ?? type, ...w }));
  const observedAt = windows.map((w) => w.observedAt).sort().at(-1) ?? null;
  return { windows, observedAt, plan: all.claudePlan ?? null, error: usageError };
}

// ── Codex ───────────────────────────────────────────────────────
function recentRollouts(limit = 40) {
  const root = path.join(CODEX_DIR, "sessions");
  if (!fs.existsSync(root)) return [];
  // 날짜 폴더(YYYY/MM/DD)를 최신순으로 내려가며 파일을 모은다.
  const files = [];
  const desc = (dir) => fs.readdirSync(dir).sort().reverse();
  for (const y of desc(root)) {
    for (const m of desc(path.join(root, y))) {
      for (const d of desc(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        for (const name of fs.readdirSync(dir)) {
          if (name.endsWith(".jsonl")) files.push(path.join(dir, name));
        }
        if (files.length >= limit) break;
      }
      if (files.length >= limit) break;
    }
    if (files.length >= limit) break;
  }
  return files
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function tail(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function windowLabel(minutes) {
  if (minutes === 300) return "5시간";
  if (minutes === 10080) return "주간";
  if (minutes % 1440 === 0) return `${minutes / 1440}일`;
  if (minutes % 60 === 0) return `${minutes / 60}시간`;
  return `${minutes}분`;
}

function codexWindow(id, w) {
  if (!w) return null;
  return {
    id,
    label: windowLabel(w.window_minutes),
    usedPercent: typeof w.used_percent === "number" ? Math.round(w.used_percent * 10) / 10 : null, // Codex는 항상 퍼센트
    resetsAt: toIso(w.resets_at),
  };
}

function codexLimits() {
  for (const { file } of recentRollouts()) {
    let text;
    try {
      text = tail(file);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let msg;
      try {
        msg = JSON.parse(lines[i]);
      } catch {
        continue; // 잘린 첫 줄
      }
      const r = msg.payload?.rate_limits;
      if (!r || (!r.primary && !r.secondary)) continue;
      return {
        windows: [codexWindow("primary", r.primary), codexWindow("secondary", r.secondary)].filter(Boolean),
        plan: r.plan_type ?? null,
        limitReached: r.rate_limit_reached_type ?? null,
        observedAt: msg.timestamp ?? null,
      };
    }
  }
  return { windows: [], observedAt: null };
}

export function readLimits() {
  const result = {};
  for (const [agent, read] of [["claude", claudeLimits], ["codex", codexLimits]]) {
    try {
      result[agent] = read();
    } catch (err) {
      result[agent] = { windows: [], observedAt: null, error: err.message };
    }
  }
  return result;
}
