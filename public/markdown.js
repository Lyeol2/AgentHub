// 에이전트 답변의 마크다운을 HTML로 바꾼다.
// 원문은 먼저 모두 이스케이프하고, 허용한 문법(제목·굵게·기울임·코드·목록·표·인용·링크·구분선)만 태그로 만든다.
// 기본 링크는 http(s)만 허용한다. 세션 답변은 로컬 파일과 언급을 안전한 참조 링크로 표시한다.

import { tokenizeReportInline, isLocalPreviewUrl } from "./report-references.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

// 한 줄 안의 문법. 코드 조각은 먼저 빼 두어 안쪽이 다른 문법으로 바뀌지 않게 한다.
function emphasis(html) {
  return html
    .replace(/\*\*(?=\S)(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)(.+?)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_]+?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)(.+?)~~/g, "<del>$1</del>");
}

function inline(value, options = {}) {
  const text = String(value).replace(/\u0000/g, "\ufffd");
  const stored = [];
  const placeholder = (html) => `\u0000${stored.push(html) - 1}\u0000`;
  const plain = (value) => escapeHtml(value).replace(/\n/g, "<br>");
  let html = "", last = 0;
  for (const token of tokenizeReportInline(text, options)) {
    html += plain(text.slice(last, token.start));
    last = token.end;
    if ("code" in token) {
      html += placeholder(`<code>${escapeHtml(token.code)}</code>`);
      continue;
    }
    const ref = token.reference;
    if (!ref) { html += placeholder(escapeHtml(token.raw)); continue; }
    const label = emphasis(escapeHtml((token.mention ? "@" : "") + ref.label));
    if (options.sessionId && (ref.path || ref.sessionId || ref.taskId || ref.kind === "image" || (ref.url && isLocalPreviewUrl(ref.url)))) {
      const attr = ref.path ? ["path", ref.path] : ref.sessionId ? ["session", ref.sessionId] : ref.taskId ? ["task", ref.taskId] : ["url", ref.url];
      html += placeholder(`<a href="#" class="report-ref" data-report-${attr[0]}="${escapeHtml(attr[1])}"${ref.kind === "image" ? ' data-report-image="true"' : ""}>${label}</a>`);
    } else if (ref.url && /^https?:\/\//i.test(ref.url) && !token.image) {
      html += placeholder(`<a href="${escapeHtml(ref.url)}" target="_blank" rel="noreferrer">${label}</a>`);
    } else html += placeholder(escapeHtml(token.raw));
  }
  html += plain(text.slice(last));
  return emphasis(html).replace(/\u0000(\d+)\u0000/g, (_, i) => stored[i]);
}

const isTableStart = (lines, i) => lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]);

function startsBlock(lines, i) {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line) || isTableStart(lines, i);
}

const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function table(lines, start, options) {
  const aligns = cells(lines[start + 1]).map((c) => {
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.endsWith(":")) return "right";
    return c.startsWith(":") ? "left" : "";
  });
  const cell = (tag, text, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(text, options)}</${tag}>`;
  const head = cells(lines[start]).map((c, k) => cell("th", c, k)).join("");
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
    rows.push(`<tr>${cells(lines[i]).map((c, k) => cell("td", c, k)).join("")}</tr>`);
    i++;
  }
  return [`<div class="md-table"><table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`, i];
}

// 들여쓰기로 중첩한 목록. 항목 사이의 빈 줄 하나는 같은 목록으로 본다.
function list(lines, start, options) {
  const first = lines[start].match(LIST);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      const next = lines[i + 1]?.match(LIST);
      if (next && next[1].length >= indent) {
        i++;
        continue;
      }
      break;
    }
    const m = lines[i].match(LIST);
    if (!m) {
      // 들여 쓴 줄은 앞 항목에 이어 붙인다.
      if (items.length && /^\s{2,}/.test(lines[i])) {
        items[items.length - 1] += `<br>${inline(lines[i].trim(), options)}`;
        i++;
        continue;
      }
      break;
    }
    if (m[1].length < indent) break;
    if (m[1].length > indent) {
      const [html, next] = list(lines, i, options);
      if (items.length) items[items.length - 1] += html;
      else items.push(html);
      i = next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
    items.push(task ? `<input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${inline(task[2], options)}` : inline(m[3], options));
    i++;
  }
  const tag = ordered ? "ol" : "ul";
  const startNo = ordered ? parseInt(first[2], 10) : 1;
  const attr = ordered && startNo !== 1 ? ` start="${startNo}"` : "";
  return [`<${tag}${attr}>${items.map((x) => `<li>${x}</li>`).join("")}</${tag}>`, i];
}

export function renderMarkdown(src, options = {}) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++; // 닫는 줄
      const lang = fence[2] ? ` class="lang-${escapeHtml(fence[2])}"` : "";
      out.push(`<pre><code${lang}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const n = heading[1].length;
      out.push(`<h${n}>${inline(heading[2], options)}</h${n}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (isTableStart(lines, i)) {
      const [html, next] = table(lines, i, options);
      out.push(html);
      i = next;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(body.join("\n"), options)}</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      const [html, next] = list(lines, i, options);
      out.push(html);
      i = next;
      continue;
    }
    // 문단: 빈 줄이나 다른 블록이 나올 때까지. 줄바꿈은 그대로 살린다.
    const para = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++]);
    out.push(`<p>${inline(para.join("\n"), options)}</p>`);
  }
  return out.join("");
}
