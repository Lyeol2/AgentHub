import path from "node:path";

export const FLOW_NODE_KINDS = ["input", "repeat", "transform", "watch", "notify"];
export const FLOW_MEMBER_KINDS = ["command", "git", "task", "input", "repeat", "transform", "notify"];
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

// 새 흐름 노드가 아니면 null을 반환해 기존 명령 노드 검사를 이어 간다.
export function checkFlowNode(body, current = {}) {
  const kind = body.kind ?? current.kind;
  if (!FLOW_NODE_KINDS.includes(kind)) return null;
  const title = text(body.title ?? current.title, "이름", 100).trim();
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

export function renderTemplate(value, variables = {}) {
  return String(value ?? "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => outputText(readValue(variables, key.trim())));
}

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
