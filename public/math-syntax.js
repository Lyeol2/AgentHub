// DOM이나 렌더러 없이 수식 구간을 구분한다. 파일 참조 수집에도 같은 규칙을 쓴다.
export function isEscaped(text, index) {
  let slashes = 0;
  while (index > 0 && text[--index] === "\\") slashes++;
  return slashes % 2 === 1;
}

export function mathAt(text, start) {
  const first = text[start];
  if (first !== "$" && !(first === "\\" && (text[start + 1] === "[" || text[start + 1] === "("))) return null;
  if (isEscaped(text, start)) return null;
  let open, close, display;
  if (text.startsWith("$$", start)) { open = close = "$$"; display = true; }
  else if (text.startsWith("\\[", start)) { open = "\\["; close = "\\]"; display = true; }
  else if (text.startsWith("\\(", start)) { open = "\\("; close = "\\)"; display = false; }
  else if (first === "$" && text[start - 1] !== "$" && text[start + 1] && !/\s/.test(text[start + 1])) {
    open = close = "$"; display = false;
  } else return null;

  let braces = 0;
  for (let i = start + open.length; i < text.length; i++) {
    if (open === "$" && text[i] === "\n") return null;
    // TeX 주석 안의 닫는 기호는 구분자로 보지 않는다.
    if (text[i] === "%") {
      const newline = text.indexOf("\n", i);
      if (newline < 0 || open === "$") return null;
      i = newline;
      continue;
    }
    if (braces === 0 && text.startsWith(close, i)) {
      if (open === "$" && (/\s/.test(text[i - 1]) || /[\d$]/.test(text[i + 1] ?? ""))) return null;
      const math = text.slice(start + open.length, i);
      if (!math.trim()) return null;
      const end = i + close.length;
      return { start, end, raw: text.slice(start, end), math, display };
    }
    if (open[0] === "\\" && text.startsWith(open, i)) return null;
    // 이스케이프 문자를 한 쌍씩 넘겨 긴 역슬래시 구간도 한 번만 훑는다.
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "{") braces++;
    else if (text[i] === "}") braces = Math.max(0, braces - 1);
  }
  return null;
}
