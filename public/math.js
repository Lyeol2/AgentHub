import katex from "./vendor/katex/katex.js";

const escapeHtml = (text) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function renderMath({ math, display = false, raw = math }) {
  const className = "md-math" + (display ? " md-math-display" : "");
  try {
    if (math.length > 20000) throw Error("수식이 너무 깁니다.");
    const html = katex.renderToString(math, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxExpand: 1000,
      maxSize: 20,
      macros: {},
    });
    return `<span class="${className}">${html}</span>`;
  } catch {
    return `<span class="${className} md-math-error" title="수식을 표시할 수 없습니다. 원문을 확인해 주세요."><code>${escapeHtml(raw)}</code></span>`;
  }
}
