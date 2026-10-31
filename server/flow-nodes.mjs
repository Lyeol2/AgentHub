import path from "node:path";
import { randomBytes } from "node:crypto";
import { checkGen3dNode } from "./gen3d.mjs";
import { checkFigcraftNode } from "./figcraft.mjs";
import { checkArtrefNode } from "./artref.mjs";

export const FLOW_NODE_KINDS = ["input", "repeat", "transform", "watch", "schedule", "notify", "webhook", "webhook-in", "gen3d", "figcraft", "artref"];
export const FLOW_MEMBER_KINDS = ["command", "git", "task", "input", "repeat", "transform", "notify", "webhook", "gen3d", "figcraft"];
export const WEBHOOK_METHODS = ["POST", "PUT", "PATCH", "GET", "DELETE"];
// 받는 쪽 주소에 들어가는 비밀 값. 노드를 만들 때(템플릿으로 추가할 때 포함) 새로 만든다.
export const newHookToken = () => randomBytes(24).toString("hex");
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BLOCKED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade"]);
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_TEXT = 20_000;
const DEFAULT_FIELDS = [{ key: "request", label: "요청", type: "textarea", required: true, defaultValue: "" }];

function boundedInteger(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}은 ${min}~${max} 사이 정수로 입력하세요.`);
  return number;
}

function text(value, label, max = MAX_TEXT) {
  const result = String(value ?? "");
  if (result.length > max) throw new Error(`${label}은 ${max.toLocaleString("en-US")}자까지 입력할 수 있습니다.`);
  return result;
}

export function checkWatchPaths(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error("감시 경로를 1~20개 입력하세요.");
  return [...new Set(value.map((item) => {
    if (typeof item !== "string") throw new Error("감시 경로는 프로젝트 기준 상대 경로로 입력하세요.");
    const raw = item.trim().replaceAll("\\", "/");
    const parts = raw.split("/");
    if (!raw || raw.length > 1024 || raw.includes("\0") || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)
      || parts.some((part) => part === ".." || [".git", "node_modules", "data"].includes(part.toLowerCase()))
      || /[*?\[\]{}]/.test(raw)) throw new Error("감시 경로는 .git, node_modules, data를 제외한 프로젝트 내부의 파일이나 폴더여야 합니다.");
    return path.posix.normalize(raw).replace(/\/$/, "") || ".";
  }))];
}

// 보내는 웹훅의 머리글. "이름: 값"을 한 줄에 하나씩 적는다. 값에는 {{input}} 같은 변수를 쓸 수 있다.
export function parseWebhookHeaders(value) {
  const lines = String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 20) throw new Error("머리글은 20개까지 입력할 수 있습니다.");
  return lines.map((line) => {
    const index = line.indexOf(":");
    const name = index > 0 ? line.slice(0, index).trim() : "";
    if (!HEADER_NAME.test(name)) throw new Error(`머리글은 "이름: 값" 형식으로 입력하세요: ${line.slice(0, 80)}`);
    if (BLOCKED_HEADERS.has(name.toLowerCase())) throw new Error(`${name} 머리글은 직접 정할 수 없습니다.`);
    return [name, line.slice(index + 1).trim()];
  });
}

function checkWebhookUrl(value) {
  const raw = String(value ?? "").trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error("보낼 주소를 http:// 또는 https://로 시작하는 URL로 입력하세요."); }
  if (!["http:", "https:"].includes(url.protocol) || raw.length > 2048) throw new Error("보낼 주소를 http:// 또는 https://로 시작하는 URL로 입력하세요.");
  return raw;
}

// 새 흐름 노드가 아니면 null을 반환해 기존 명령 노드 검사를 이어 간다.
export function checkFlowNode(body, current = {}) {
  const kind = body.kind ?? current.kind;
  if (!FLOW_NODE_KINDS.includes(kind)) return null;
  if (kind === "gen3d") return checkGen3dNode(body, current);
  if (kind === "figcraft") return checkFigcraftNode(body, current);
  if (kind === "artref") return checkArtrefNode(body, current);
  const title = text(body.title ?? current.title, "이름", 100).trim();
  if (kind === "schedule") {
    const scheduleMode = body.scheduleMode ?? current.scheduleMode ?? "once";
    if (!["once", "daily", "interval"].includes(scheduleMode)) throw new Error("예약 방식은 한 번·매일·일정 간격 중 하나입니다.");
    const fields = { kind, title: title || "시간 예약", scheduleMode,
      prompt: text(body.prompt ?? current.prompt ?? "예약된 작업을 시작하세요.", "요청") };
    // 선택한 방식의 설정만 검증하고 나머지는 기본값으로 정리한다.
    const runAt = body.runAt ?? current.runAt ?? "";
    const timeOfDay = body.timeOfDay ?? current.timeOfDay ?? "09:00";
    const intervalMinutes = body.intervalMinutes ?? current.intervalMinutes ?? 60;
    if (scheduleMode === "once") {
      const match = typeof runAt === "string" && runAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
      const date = new Date(runAt);
      if (!match || !Number.isFinite(date.getTime()) || Number(match[2]) < 1 || Number(match[2]) > 12
        || Number(match[3]) < 1 || Number(match[3]) > new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate()
        || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) {
        throw new Error("예약 날짜와 시각을 시간대가 포함된 올바른 날짜로 입력하세요.");
      }
      fields.runAt = date.toISOString();
    } else fields.runAt = "";
    if (scheduleMode === "daily" && (typeof timeOfDay !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay))) throw new Error("매일 실행할 시각을 HH:mm 형식으로 입력하세요.");
    fields.timeOfDay = scheduleMode === "daily" ? timeOfDay : "09:00";
    fields.intervalMinutes = scheduleMode === "interval" ? boundedInteger(intervalMinutes, 1, 10_080, "예약 간격(분)") : 60;
    renderTemplate(fields.prompt, { scheduledAt: "", triggeredAt: "" });
    return fields;
  }
  if (kind === "input") {
    const fields = body.fields ?? current.fields ?? DEFAULT_FIELDS;
    if (!Array.isArray(fields) || !fields.length || fields.length > 20) throw new Error("입력 항목을 1~20개 만드세요.");
    const used = new Set();
    const checked = fields.map((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) throw new Error("입력 항목 형식이 올바르지 않습니다.");
      const key = String(field.key ?? "").trim();
      if (!KEY.test(key) || UNSAFE_KEYS.has(key) || used.has(key.toLowerCase())) throw new Error("입력 키는 대소문자 구분 없이 중복되지 않는 영문·숫자·밑줄로 적고 영문이나 밑줄로 시작하세요.");
      if (key.toLowerCase() === "input_json") throw new Error("input_json은 전체 입력값 전달에 사용하는 예약 키입니다. 다른 입력 키를 사용하세요.");
      used.add(key.toLowerCase());
      const type = field.type ?? "text";
      if (!["text", "textarea", "number"].includes(type)) throw new Error("입력 형식은 한 줄·여러 줄·숫자 중 하나입니다.");
      if (field.required !== undefined && typeof field.required !== "boolean") throw new Error("필수 입력 여부가 올바르지 않습니다.");
      const defaultValue = field.defaultValue ?? "";
      if (type === "number" && defaultValue !== "" && (!['string', 'number'].includes(typeof defaultValue) || !Number.isFinite(Number(defaultValue)))) throw new Error(`"${key}"의 기본값을 숫자로 입력하세요.`);
      return { key, label: text(field.label ?? key, "입력 이름", 100).trim() || key, type, required: field.required ?? false,
        defaultValue: type === "number" && defaultValue !== "" ? Number(defaultValue) : text(defaultValue, "기본값") };
    });
    const defaultPrompt = checked.length === 1 ? `{{${checked[0].key}}}` : checked.map((field) => `${field.label}: {{${field.key}}}`).join("\n");
    return { kind, title: title || "입력 폼", fields: checked, prompt: text(body.prompt ?? current.prompt ?? defaultPrompt, "요청") };
  }
  if (kind === "notify") {
    const level = body.level ?? current.level ?? "info";
    if (!["info", "success", "error"].includes(level)) throw new Error("알림 종류는 정보·성공·실패 중 하나입니다.");
    const sound = body.sound ?? current.sound ?? false;
    if (typeof sound !== "boolean") throw new Error("알림 소리 설정이 올바르지 않습니다.");
    const nodeTitle = title || "알림";
    return { kind, title: nodeTitle, message: text(body.message ?? current.message ?? "{{input}}", "알림 메시지"),
      notificationTitle: text(body.notificationTitle ?? current.notificationTitle ?? (title || "AgentHub"), "알림 제목", 100).trim() || "AgentHub", level, sound };
  }
  if (kind === "webhook") {
    const method = String(body.method ?? current.method ?? "POST").toUpperCase();
    if (!WEBHOOK_METHODS.includes(method)) throw new Error("요청 방식은 POST·PUT·PATCH·GET·DELETE 중 하나입니다.");
    const bodyType = body.bodyType ?? current.bodyType ?? "json";
    if (!["json", "text"].includes(bodyType)) throw new Error("본문 형식은 JSON 또는 텍스트입니다.");
    const headers = text(body.headers ?? current.headers ?? "", "머리글", 8000);
    parseWebhookHeaders(headers);
    return { kind, title: title || "웹훅 보내기", url: checkWebhookUrl(body.url ?? current.url), method, headers, bodyType,
      body: text(body.body ?? current.body ?? '{"text": "{{input}}"}', "본문"),
      timeoutSec: boundedInteger(body.timeoutSec ?? current.timeoutSec ?? 30, 1, 120, "응답 대기 시간") };
  }
  if (kind === "webhook-in") {
    const enabled = body.enabled ?? current.enabled ?? true;
    if (typeof enabled !== "boolean") throw new Error("웹훅 받기 사용 여부가 올바르지 않습니다.");
    return { kind, title: title || "웹훅 받기", enabled,
      prompt: text(body.prompt ?? current.prompt ?? "웹훅 요청을 받았습니다.\n{{body}}", "요청") };
  }
  if (kind === "repeat") return { kind, title: title || "반복 제어",
    maxIterations: boundedInteger(body.maxIterations ?? current.maxIterations ?? 3, 1, 20, "최대 반복 횟수"),
    delayMs: boundedInteger(body.delayMs ?? current.delayMs ?? 0, 0, 60_000, "반복 대기 시간") };
  if (kind === "transform") {
    const transformMode = body.transformMode ?? current.transformMode ?? "json";
    if (!["json", "lines", "template"].includes(transformMode)) throw new Error("가공 방식은 JSON 경로·줄 추출·템플릿 중 하나입니다.");
    const expression = text(body.expression ?? current.expression, "추출 조건", 2000).trim();
    if (transformMode === "json") parseValuePath(expression);
    const template = text(body.template ?? current.template ?? "{{input}}", "템플릿");
    return { kind, title: title || "결과 가공", transformMode, expression, template };
  }
  return { kind, title: title || "파일 감시", watchPaths: checkWatchPaths(body.watchPaths ?? current.watchPaths ?? ["src"]),
    debounceMs: boundedInteger(body.debounceMs ?? current.debounceMs ?? 500, 100, 60_000, "변경 대기 시간"),
    prompt: text(body.prompt ?? current.prompt ?? "다음 파일이 변경되었습니다. 필요한 작업을 수행하세요.\n{{paths}}", "요청") };
}

function parseValuePath(expression) {
  const value = String(expression ?? "").trim().replace(/^\$\.?/, "");
  if (!value) return [];
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|\[\d+\])(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/.test(value)) throw new Error("JSON 경로는 tests.failures 또는 items[0].name 형식으로 입력하세요.");
  const parts = value.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) ?? [];
  if (parts.some((key) => UNSAFE_KEYS.has(key))) throw new Error("이 JSON 경로는 사용할 수 없습니다.");
  return parts;
}

function readValue(value, expression) {
  for (const key of parseValuePath(expression)) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error(`값을 찾을 수 없습니다: ${expression}`);
    value = value[key];
  }
  return value;
}

function outputText(value) {
  if (value === undefined) throw new Error("가공 결과가 없습니다.");
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

// escape는 넣는 값을 바꾼다. JSON 본문에서는 따옴표 안에 들어가도록 문자열 이스케이프를 한다.
export function renderTemplate(value, variables = {}, escape = (part) => part) {
  return String(value ?? "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => escape(outputText(readValue(variables, key.trim()))));
}
export const jsonStringEscape = (part) => JSON.stringify(part).slice(1, -1);

export function inputValues(node, values = {}) {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("입력값 형식이 올바르지 않습니다.");
  const variables = {};
  for (const field of node.fields) {
    let value = Object.hasOwn(values, field.key) ? values[field.key] : field.defaultValue ?? "";
    if (value === null || value === undefined) value = "";
    if (typeof value !== "string" && typeof value !== "number") throw new Error(`"${field.label}"에 문자나 숫자를 입력하세요.`);
    if (field.required && String(value).trim() === "") throw new Error(`"${field.label}"은 필수 입력입니다.`);
    if (field.type === "number" && value !== "") {
      value = Number(value);
      if (!Number.isFinite(value)) throw new Error(`"${field.label}"에 숫자를 입력하세요.`);
    } else value = text(value, field.label);
    Object.defineProperty(variables, field.key, { value, enumerable: true, configurable: true, writable: true });
  }
  return variables;
}

export function transformResult(node, input, variables = {}) {
  const source = String(input ?? "");
  if (node.transformMode === "template") return renderTemplate(node.template, { ...variables, input: source, output: source });
  if (node.transformMode === "lines") return source.split(/\r?\n/).filter((line) => node.expression ? line.includes(node.expression) : line.trim()).join("\n");
  let parsed;
  try { parsed = JSON.parse(source); }
  catch { throw new Error("입력 결과가 올바른 JSON 형식이 아닙니다."); }
  return outputText(readValue(parsed, node.expression));
}
