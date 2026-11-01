import { el } from "../../shared/dom.js";

// 지침 글을 "앞부분 + ## 섹션" 덩어리로 나누고, 덩어리 단위로 비교해 항목별로 반영·버리기를 고르게 한다.
const norm = (s) => String(s ?? "").toLowerCase().replace(/^\d+[.)]\s*/, "").replace(/[\s·`*_]/g, "");

export function blocks(text) {
  const lines = String(text ?? "").replace(/\s+$/, "").split(/\r?\n/);
  const out = [{ key: "__preamble", title: "앞부분", lines: [] }];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) out.push({ key: norm(heading[1]), title: heading[1].trim(), lines: [line] });
    else out.at(-1).lines.push(line);
  }
  // 같은 제목이 두 번 나오면 키를 구분한다.
  const seen = new Map();
  for (const block of out) {
    const count = seen.get(block.key) ?? 0;
    seen.set(block.key, count + 1);
    if (count) block.key = `${block.key}#${count}`;
  }
  return out.filter((block, index) => index > 0 || block.lines.some((l) => l.trim()));
}
const joinBlock = (block) => block.lines.join("\n").replace(/\s+$/, "");

// 줄 단위 비교(LCS). [{ type: " " | "-" | "+", text }]
export function lineDiff(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 400_000) return [...a.map((text) => ({ type: "-", text })), ...b.map((text) => ({ type: "+", text }))];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: " ", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: "-", text: a[i++] });
    else out.push({ type: "+", text: b[j++] });
  }
  while (i < n) out.push({ type: "-", text: a[i++] });
  while (j < m) out.push({ type: "+", text: b[j++] });
  return out;
}

// items: [{ key, title, kind: "modify" | "add" | "remove", before, after, lines }]
export function diffItems(oldText, newText) {
  const before = blocks(oldText);
  const after = blocks(newText);
  const oldMap = new Map(before.map((b) => [b.key, b]));
  const newMap = new Map(after.map((b) => [b.key, b]));
  const items = [];
  for (const block of after) {
    const old = oldMap.get(block.key);
    if (!old) items.push({ key: block.key, title: block.title, kind: "add", before: null, after: block, lines: block.lines.map((text) => ({ type: "+", text })) });
    else if (joinBlock(old) !== joinBlock(block)) items.push({ key: block.key, title: block.title, kind: "modify", before: old, after: block, lines: lineDiff(old.lines, block.lines) });
  }
  for (const block of before) if (!newMap.has(block.key)) items.push({ key: block.key, title: block.title, kind: "remove", before: block, after: null, lines: block.lines.map((text) => ({ type: "-", text })) });
  return items;
}

// 고른 항목만 반영한 글. 새 글의 순서를 따르고, 지우지 않기로 한 옛 덩어리는 원래 앞에 있던 덩어리 뒤에 둔다.
export function applyItems(oldText, newText, items, accepted) {
  const before = blocks(oldText);
  const after = blocks(newText);
  const take = (key) => accepted.has(key);
  const removed = new Map(items.filter((i) => i.kind === "remove").map((i) => [i.key, i]));
  const out = [];
  const placed = new Set();
  const keepOldAfter = (key) => {
    // key 다음에 오던 옛 덩어리 중 새 글에 없는 것(지우기를 고르지 않은 것)을 이어 붙인다.
    let index = before.findIndex((b) => b.key === key);
    while (index >= 0 && before[index + 1] && removed.has(before[index + 1].key)) {
      const next = before[index + 1];
      if (!take(next.key)) { out.push(joinBlock(next)); }
      placed.add(next.key);
      index++;
    }
  };
  if (before[0] && removed.has(before[0].key) && !take(before[0].key)) { out.push(joinBlock(before[0])); placed.add(before[0].key); keepOldAfter(before[0].key); }
  for (const block of after) {
    const old = before.find((b) => b.key === block.key);
    const item = items.find((i) => i.key === block.key);
    if (!old) { if (item && take(block.key)) out.push(joinBlock(block)); }
    else out.push(joinBlock(item && take(block.key) ? block : old));
    if (old) keepOldAfter(old.key);
  }
  for (const block of before) if (removed.has(block.key) && !placed.has(block.key) && !take(block.key)) out.push(joinBlock(block));
  return out.filter((text) => text.trim()).join("\n\n") + "\n";
}

// 비교 창: 항목마다 반영/버리기. 고르지 않은 항목은 반영하지 않는다.
export function openDiffDialog({ title = "AI 초안 검토", oldText, newText, warnings = [], applyLabel = "편집기에 적용", note = "고르지 않은 항목은 반영하지 않습니다", defaultAccept = false }) {
  return new Promise((resolve) => {
    const items = diffItems(oldText, newText);
    if (!items.length) { resolve({ text: oldText, unchanged: true }); return; }
    const choice = new Map(items.map((item) => [item.key, defaultAccept ? "accept" : null]));
    const dialog = el("dialog", { class: "guide-diff-dialog", "aria-label": title });
    const summary = el("span", { class: "muted guide-diff-summary" });
    const list = el("div", { class: "guide-diff-list" });
    const newBlocks = blocks(newText);
    // 새 글의 경고 줄 → 그 줄이 들어 있는 덩어리
    const lineOf = (key) => {
      let line = 1;
      for (const block of newBlocks) { if (block.key === key) return [line, line + block.lines.length - 1]; line += block.lines.length; }
      return null;
    };
    const render = () => {
      const counts = { accept: 0, reject: 0, none: 0 };
      for (const value of choice.values()) counts[value ?? "none"]++;
      summary.textContent = `바뀌는 곳 ${items.length} · 반영 ${counts.accept} / 버리기 ${counts.reject} / 미정 ${counts.none}`;
      list.replaceChildren(...items.map((item) => {
        const value = choice.get(item.key);
        const range = item.after ? lineOf(item.key) : null;
        const warning = range && warnings.find((w) => w.level === "conflict" && w.line >= range[0] && w.line <= range[1]);
        const pick = (next) => () => { choice.set(item.key, choice.get(item.key) === next ? null : next); render(); };
        const lines = compact(item.lines);
        return el("section", { class: `guide-diff-item ${item.kind}${value ? ` ${value}` : ""}`, "data-key": item.key },
          el("header", {},
            el("strong", {}, item.title),
            el("span", { class: `guide-diff-kind ${item.kind}` }, { modify: "수정", add: "추가", remove: "삭제" }[item.kind]),
            el("span", { class: "spacer" }),
            el("button", { type: "button", class: `sm ${value === "accept" ? "primary" : "ghost"}`, onclick: pick("accept") }, "반영"),
            el("button", { type: "button", class: `sm ghost${value === "reject" ? " danger-outline" : ""}`, onclick: pick("reject") }, "버리기")),
          item.kind === "remove" && value === "reject" ? null : el("pre", { class: "guide-diff-lines mono" }, ...lines.map((line) =>
            el("div", { class: `guide-diff-line ${line.type === "+" ? "add" : line.type === "-" ? "del" : line.type === "…" ? "gap" : ""}` },
              el("span", { class: "guide-diff-sign" }, line.type === " " ? "" : line.type), line.text))),
          warning ? el("p", { class: "guide-diff-warn" }, `⚠ ${warning.title} — ${warning.quote}`) : null);
      }));
    };
    const finish = (value) => { dialog.close(); dialog.remove(); resolve(value); };
    dialog.append(
      el("header", { class: "guide-diff-head" }, el("h3", {}, title), summary, el("span", { class: "spacer" }),
        el("button", { type: "button", class: "ghost sm", onclick: () => { for (const item of items) choice.set(item.key, "accept"); render(); } }, "모두 반영"),
        el("button", { type: "button", class: "ghost sm", onclick: () => { for (const item of items) choice.set(item.key, "reject"); render(); } }, "모두 버리기")),
      list,
      el("footer", { class: "guide-diff-foot" }, el("span", { class: "muted" }, note), el("span", { class: "spacer" }),
        el("button", { type: "button", class: "ghost", onclick: () => finish(null) }, "취소"),
        el("button", { type: "button", class: "primary", "data-apply": "", onclick: () => {
          const accepted = new Set([...choice].filter(([, v]) => v === "accept").map(([k]) => k));
          finish({ text: applyItems(oldText, newText, items, accepted), accepted: accepted.size });
        } }, applyLabel)));
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
    document.body.append(dialog);
    render();
    dialog.showModal();
  });
}

// 바뀌지 않은 줄이 길게 이어지면 앞뒤 1줄만 남기고 줄인다.
function compact(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== " ") { out.push(lines[i]); continue; }
    let j = i;
    while (j < lines.length && lines[j].type === " ") j++;
    const run = lines.slice(i, j);
    if (run.length > 3) out.push(...(i > 0 ? [run[0]] : []), { type: "…", text: `… ${run.length - (i > 0 ? 1 : 0) - (j < lines.length ? 1 : 0)}줄 같음` }, ...(j < lines.length ? [run.at(-1)] : []));
    else out.push(...run);
    i = j - 1;
  }
  return out;
}
