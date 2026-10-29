// Parse report references without HTML or a DOM. Rendering and artifact cards share
// this parser so that a path shown in a card is the path its inline link opens.
import { mathAt } from "./math-syntax.js";
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico)$/i;
const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v|ogv)$/i;
const MARKDOWN_EXT = /\.(?:md|markdown|mdown)$/i;
const HTML_EXT = /\.(?:html?|xhtml)$/i;
const TEXT_EXT = /\.(?:txt|log|json|jsonl|csv|tsv|ya?ml|xml|svg|toml|ini|cfg|conf|js|mjs|cjs|jsx|ts|tsx|css|scss|py|sh|ps1|bat|cmd|c|h|cpp|hpp|cs|java|go|rs|sql|diff|patch)$/i;
const FILE_EXT = "(?:png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?|md|markdown|mdown|html?|xhtml|txt|log|jsonl?|csv|tsv|ya?ml|xml|toml|ini|cfg|conf|[cm]?js|jsx|tsx?|css|scss|py|sh|ps1|bat|cmd|cpp|hpp|cs|java|go|rs|sql|diff|patch|pdf|docx?|xlsx?|pptx?|zip|tar|gz|7z|mp[34]|wav|ogg|webm|mov|m4v|ogv)";
const FILE_END = "(?=$|[\\s)\\]},;!?·]|\\.(?=$|\\s))";
const ABSOLUTE_FILE = new RegExp(`^(?:[a-z]:[\\\\/]|\\\\\\\\[^\\\\/\\s]+[\\\\/]|/|\\.{1,2}[\\\\/])[^<>\\r\\n\"'|]*?\\.${FILE_EXT}(?::\\d+(?::\\d+)?)?${FILE_END}`, "i");
const RELATIVE_FILE = new RegExp(`^(?:[^\\s<>\"'()\\[\\],;:|/\\\\]+[\\\\/])+[^\\s<>\"'()\\[\\],;:|/\\\\]+\\.${FILE_EXT}(?::\\d+(?::\\d+)?)?${FILE_END}`, "i");
const MENTION_FILE = new RegExp(`^(?:[^\\s<>\"'\\[\\],;|]+\\.${FILE_EXT})(?::\\d+(?::\\d+)?)?${FILE_END}`, "i");
const SAFE_ATTACHMENT = /^\/api\/sessions\/[^/?#]+\/attachments\/[^/?#]+(?:\?[^#]*)?$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function basename(path) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function pathKind(path) {
  const name = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)$/, "");
  if (IMAGE_EXT.test(name)) return "image";
  if (VIDEO_EXT.test(name)) return "video";
  if (MARKDOWN_EXT.test(name)) return "markdown";
  if (HTML_EXT.test(name)) return "html";
  if (TEXT_EXT.test(name)) return "text";
  return "file";
}

export function isLocalPreviewUrl(value) {
  try {
    const url = new URL(value);
    return /^(?:http|https):$/.test(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase()) && !url.username && !url.password;
  } catch { return false; }
}

/** Accept only explicit paths, web URLs, and the two supported AgentHub URIs. */
export function classifyReportTarget(value, { image = false, label, decodePath = false } = {}) {
  if (typeof value !== "string") return null;
  let target = value.trim();
  if (!target || CONTROL.test(target)) return null;
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  const mention = target.match(/^agenthub:\/\/(session|task)\/([^/?#\s]+)$/i);
  if (mention) {
    let id;
    try { id = decodeURIComponent(mention[2]); } catch { return null; }
    if (!/^[\p{L}\p{N}_.-]+$/u.test(id)) return null;
    return { [mention[1].toLowerCase() === "session" ? "sessionId" : "taskId"]: id, label: label || id, kind: mention[1].toLowerCase() };
  }
  if (/^https?:\/\//i.test(target)) {
    let url;
    try { url = new URL(target); } catch { return null; }
    if (!/^(?:http|https):$/.test(url.protocol) || url.username || url.password) return null;
    // Images supplied by an answer are loaded only after an explicit preview click.
    const kind = pathKind(url.pathname);
    const mediaKind = kind === "video" ? "video" : image || kind === "image" ? "image" : null;
    if (mediaKind && url.protocol !== "https:" && !isLocalPreviewUrl(target)) return null;
    return { url: target, label: label || target, kind: mediaKind || "web" };
  }
  if (image && SAFE_ATTACHMENT.test(target)) return { url: target, label: label || "첨부 이미지", kind: "image" };
  if (/^file:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (url.search || url.hash || url.username || url.password) return null;
      target = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname !== "localhost") target = `//${url.hostname}${target}`;
      else if (/^\/[a-z]:\//i.test(target)) target = target.slice(1);
    } catch { return null; }
  } else if (decodePath) {
    // Markdown destinations are URL-encoded. Plain filesystem paths stay literal.
    try { target = decodeURIComponent(target); } catch { /* A literal percent sign can be part of a filename. */ }
  }
  // Codex는 Windows 경로를 "/C:/…"처럼 앞에 /를 붙여 쓴다.
  if (/^[\\/][a-z]:[\\/]/i.test(target)) target = target.slice(1);
  if (CONTROL.test(target) || /[<>"'|]/.test(target)) return null;
  const absolute = /^(?:[a-z]:[\\/]|[\\/]|\.{1,2}[\\/])/i.test(target);
  // A colon is meaningful only as a drive letter or trailing line/column.
  const withoutLine = target.replace(/:\d+(?::\d+)?$/, "");
  if (/^[a-z][a-z\d+.-]*:/i.test(withoutLine) && !/^[a-z]:[\\/]/i.test(withoutLine)) return null;
  if (withoutLine.replace(/^[a-z]:/i, "").includes(":")) return null;
  if (!absolute && !/^(?:[^\\/<>:"'|]+[\\/])*[^\\/<>:"'|]+\.[a-z\d]{1,12}(?::\d+(?::\d+)?)?$/i.test(target)) return null;
  if (!absolute && /^(?:www\.)|^[\w-]+\.(?:com|org|net|dev|io)(?:\/|$)/i.test(target)) return null;
  if (!/[\p{L}\p{N}]/u.test(target)) return null;
  return { path: target, label: label || basename(target), kind: pathKind(target) };
}

function markdownAt(text, start) {
  const image = text[start] === "!";
  const open = start + Number(image);
  if (text[open] !== "[") return null;
  let close = open + 1, depth = 1;
  for (; close < text.length; close++) {
    if (text[close] === "\\" && /[\[\]]/.test(text[close + 1] || "")) { close++; continue; }
    if (text[close] === "[") depth++;
    if (text[close] === "]" && --depth === 0) break;
  }
  if (depth || text[close + 1] !== "(") return null;
  let end = close + 2;
  const targetStart = end;
  const windowsTarget = /^(?:[a-z]:[\\/]|\\\\)/i.test(text.slice(targetStart));
  depth = 1;
  let angled = text[end] === "<";
  for (; end < text.length; end++) {
    const char = text[end];
    if (char === "\n") return null;
    if (angled) { if (char === ">") angled = false; continue; }
    if (!windowsTarget && char === "\\" && /[()]/.test(text[end + 1] || "")) { end++; continue; }
    if (char === "(") depth++;
    if (char === ")" && --depth === 0) break;
  }
  if (depth) return null;
  let target = text.slice(targetStart, end).trim();
  if (target.startsWith("<")) {
    const angle = target.indexOf(">");
    if (angle < 0 || (target.slice(angle + 1).trim() && !/^["'][\s\S]*["']$/.test(target.slice(angle + 1).trim()))) return null;
    target = target.slice(1, angle);
  } else {
    // Standard optional titles are removed; unquoted spaces in local paths survive.
    target = target.replace(/\s+["'][^"']*["']$/, "");
    if (!/^[a-z]:[\\/]/i.test(target)) target = target.replace(/\\([()])/g, "$1");
  }
  const label = text.slice(open + 1, close).replace(/\\([\[\]])/g, "$1");
  return { start, end: end + 1, raw: text.slice(start, end + 1), target, label, image, reference: classifyReportTarget(target, { image, label, decodePath: true }) };
}

function codeAt(text, start) {
  if (text[start] !== "`") return null;
  const ticks = text.slice(start).match(/^`+/)[0];
  let end = text.indexOf(ticks, start + ticks.length);
  while (end >= 0 && (text[end - 1] === "`" || text[end + ticks.length] === "`")) end = text.indexOf(ticks, end + ticks.length);
  if (end < 0) return null;
  return { start, end: end + ticks.length, raw: text.slice(start, end + ticks.length), code: text.slice(start + ticks.length, end) };
}

export function trimUrl(value) {
  let url = value.replace(/[.,;!?·]+$/, "");
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
  }
  return url;
}

/** Tokens include code and rejected Markdown links to prevent reparsing their content. */
function suppliedReferences(references) {
  return references instanceof Map ? [...references].map(([label, path]) => ({ label, path })) : Array.isArray(references) ? references : [];
}

function suppliedReference(item) {
  if (!item || typeof item !== "object") return null;
  const target = item.path || item.url || (item.sessionId && `agenthub://session/${item.sessionId}`) || (item.taskId && `agenthub://task/${item.taskId}`);
  return classifyReportTarget(target, { label: typeof item.label === "string" ? item.label : undefined, image: item.kind === "image" });
}

export function tokenizeReportInline(source, { references = [] } = {}) {
  const text = String(source ?? "");
  const tokens = [];
  const aliases = suppliedReferences(references)
    .filter((item) => typeof item?.label === "string" && item.label && !CONTROL.test(item.label))
    .map((item) => ({ label: item.label.replace(/^@/, ""), reference: suppliedReference(item) }))
    .filter((item) => item.reference)
    .sort((a, b) => b.label.length - a.label.length);
  for (let i = 0; i < text.length;) {
    const code = codeAt(text, i);
    if (code) { tokens.push(code); i = code.end; continue; }
    const math = mathAt(text, i);
    if (math) { tokens.push(math); i = math.end; continue; }
    const markdown = markdownAt(text, i);
    if (markdown) { tokens.push(markdown); i = markdown.end; continue; }
    const previous = i ? text[i - 1] : "";
    // 웹 주소는 한글 바로 뒤에 붙어 있어도("여기https://…") 링크로 본다. 영문·숫자·경로 글자 뒤면 낱말 중간이다.
    const boundary = !previous || /[\s([{<>：:]/.test(previous)
      || (/^(?:https?:\/\/|www\.)/i.test(text.slice(i, i + 8)) && !/[A-Za-z0-9_./\\@-]/.test(previous));
    if (!boundary) { i++; continue; }
    // 마크다운 자동 링크 "<https://…>"는 괄호 없이 주소만 보인다.
    const angled = text[i] === "<" && text.slice(i).match(/^<(https?:\/\/[^\s<>"']+)>/i);
    if (angled) {
      const reference = classifyReportTarget(angled[1]);
      if (reference) { tokens.push({ start: i, end: i + angled[0].length, raw: angled[0], reference }); i += angled[0].length; continue; }
    }
    const mention = text[i] === "@";
    const start = i + Number(mention);
    const tail = text.slice(start);
    let value = null;
    if (mention) {
      const alias = aliases.find(({ label }) => [label, `"${label}"`, `'${label}'`, `<${label}>`].some((word) => tail.startsWith(word) && (!tail[word.length] || /[\s)\]},;.!?·]/.test(tail[word.length]))));
      if (alias) {
        const word = [alias.label, `"${alias.label}"`, `'${alias.label}'`, `<${alias.label}>`].find((word) => tail.startsWith(word) && (!tail[word.length] || /[\s)\]},;.!?·]/.test(tail[word.length])));
        tokens.push({ start: i, end: start + word.length, raw: text.slice(i, start + word.length), reference: alias.reference, mention: true });
        i = start + word.length;
        continue;
      }
    }
    if (mention && (tail[0] === '"' || tail[0] === "'" || tail[0] === "<")) {
      const delimiter = tail[0] === "<" ? ">" : tail[0];
      const close = tail.indexOf(delimiter, 1);
      if (close > 1) {
        const reference = classifyReportTarget(tail.slice(1, close));
        if (reference) {
          tokens.push({ start: i, end: start + close + 1, raw: text.slice(i, start + close + 1), reference, mention: true });
          i = start + close + 1;
          continue;
        }
      }
    }
    if (!mention && /^www\.[^.\s<>"']+\.[^\s<>"']+/i.test(tail)) {
      // "www.example.com"은 https 주소로 연다. 글에는 쓴 그대로 보인다.
      const web = trimUrl(tail.match(/^www\.[^\s<>"']+/i)[0]);
      const reference = classifyReportTarget(`https://${web}`, { label: web });
      if (reference) { tokens.push({ start: i, end: i + web.length, raw: web, reference }); i += web.length; continue; }
    }
    if (/^https?:\/\//i.test(tail)) value = trimUrl(tail.match(/^https?:\/\/[^\s<>"']+/i)[0]);
    else if (/^file:\/\//i.test(tail)) value = trimUrl(tail.match(/^file:\/\/[^\s<>"']+/i)[0]);
    else if (/^agenthub:\/\//i.test(tail)) value = tail.match(/^agenthub:\/\/(?:session|task)\/[^\s<>"'()[\],;!?]+/i)?.[0];
    else value = tail.match(ABSOLUTE_FILE)?.[0] || tail.match(RELATIVE_FILE)?.[0] || (mention && tail.match(MENTION_FILE)?.[0]);
    if (!value) { i++; continue; }
    const reference = classifyReportTarget(value);
    if (!reference) { i += value.length + Number(mention); continue; }
    tokens.push({ start: i, end: start + value.length, raw: text.slice(i, start + value.length), reference, mention });
    i = start + value.length;
  }
  return tokens;
}

function explicitStatus(text) {
  const found = new Set();
  const prefix = "(?:검증|테스트|QA|verification|tests?)\\s*(?:결과\\s*)?[:：-]?\\s*";
  // Require a stated result, rather than a desired/negated result such as
  // "검증 통과해야 함", "검증 통과하지 못함", or a filename containing "passed".
  const ending = "(?![\\p{L}\\p{N}_-]|\\s*(?:못|하지|안\\s|아님|예정|필요|목표|해야|하면|여부))";
  if (new RegExp(prefix + "(?:통과|성공|passed?)" + ending, "iu").test(text)) found.add("passed");
  if (new RegExp(prefix + "(?:실패|failed)" + ending, "iu").test(text)) found.add("failed");
  if (new RegExp(prefix + "(?:미실행|not[ -]run)" + ending, "iu").test(text)) found.add("not-run");
  return found.size === 1 ? [...found][0] : undefined;
}

function referenceKey(ref) {
  if (ref.path) {
    let path = ref.path.replace(/\\/g, "/").replace(/\/\.\//g, "/").replace(/^\.\//, "");
    if (/^[a-z]:\//i.test(path) || path.startsWith("//")) path = path.toLowerCase();
    return `path:${path}`;
  }
  return ref.url ? `url:${ref.url}` : ref.sessionId ? `session:${ref.sessionId}` : `task:${ref.taskId}`;
}

/** Collect references outside fenced/inline code, retaining only stated QA results. */
export function collectReportReferences(source, { references = [] } = {}) {
  const refs = new Map();
  const statuses = new Map();
  const add = (ref, status) => {
    if (!ref) return;
    const key = referenceKey(ref);
    const previous = refs.get(key);
    if (status) {
      if (!statuses.has(key)) statuses.set(key, new Set());
      statuses.get(key).add(status);
    }
    if (!previous) refs.set(key, { ...ref });
    else {
      if (ref.kind === "image") previous.kind = "image";
    }
    const values = statuses.get(key);
    if (values?.size === 1) refs.get(key).status = [...values][0];
    else delete refs.get(key).status;
  };
  let fence;
  const prose = [];
  for (const line of String(source ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const match = line.match(/^\s*(?:>\s*)*(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
      prose.push(" ".repeat(line.length));
      continue;
    }
    prose.push(fence ? " ".repeat(line.length) : line);
  }
  const text = prose.join("\n");
  const tokens = tokenizeReportInline(text, { references });
  const visible = tokens.reduceRight((text, token) => {
    const content = token.raw.replace(/[^\n]/g, " ");
    const label = token.label || "";
    return text.slice(0, token.start) + label + content.slice(label.length) + text.slice(token.end);
  }, text);
  for (const token of tokens) {
    if (!token.reference) continue;
    const line = visible.slice(visible.lastIndexOf("\n", token.start - 1) + 1, visible.indexOf("\n", token.end) < 0 ? visible.length : visible.indexOf("\n", token.end));
    add(token.reference, explicitStatus(line));
  }
  for (const item of suppliedReferences(references)) {
    if (!item || typeof item !== "object") continue;
    const ref = suppliedReference(item);
    add(ref, ["passed", "failed", "not-run"].includes(item.status) ? item.status : undefined);
  }
  return [...refs.values()];
}
