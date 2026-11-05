// 작업 순서도: 요청(start)에서 가장 긴 경로 깊이로 줄을 정하고, 같은 줄은 부모 위치 평균으로 정렬해 위→아래로 그린다.
const NS = "http://www.w3.org/2000/svg";
const SIZE = { start: [120, 34], end: [120, 34], decision: [124, 66], step: [176, 48] };
const ROW = 70, COL = 220, PAD = 40;

const svg = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(key, value);
  node.append(...children.filter(Boolean));
  return node;
};
const clip = (text, max) => (String(text ?? "").length > max ? `${String(text).slice(0, max - 1)}…` : String(text ?? ""));

export function layoutFlow(flow) {
  const nodes = flow.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of flow.edges) out.get(e.from)?.push(e.to);
  // 뒤로 가는 선(되돌아가기)을 찾아 깊이 계산에서 뺀다.
  const start = nodes.find((n) => n.type === "start") ?? nodes[0];
  const state = new Map(), back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      if (state.get(to) === 1) back.add(`${id}>${to}`);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
  };
  visit(start.id);
  for (const n of nodes) if (!state.has(n.id)) visit(n.id);
  const forward = flow.edges.filter((e) => !back.has(`${e.from}>${e.to}`));
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of forward) if (depth.get(e.to) < depth.get(e.from) + 1) { depth.set(e.to, depth.get(e.from) + 1); changed = true; }
    if (!changed) break;
  }
  // 끝 칸은 맨 아래 줄
  const maxDepth = Math.max(...depth.values());
  for (const n of nodes) if (n.type === "end") depth.set(n.id, maxDepth);
  const rows = [];
  for (const n of nodes) (rows[depth.get(n.id)] ??= []).push(n);
  const x = new Map();
  rows.forEach((row, r) => {
    if (!row) return;
    if (r > 0) {
      const parentX = (id) => {
        const parents = forward.filter((e) => e.to === id).map((e) => x.get(e.from)).filter((v) => v !== undefined);
        return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : 0;
      };
      row.sort((a, b) => parentX(a.id) - parentX(b.id));
    }
    // 부모가 하나뿐인 칸은 부모 바로 아래, 나머지는 겹치지 않게 펼친다.
    const wanted = row.map((n) => {
      const parents = forward.filter((e) => e.to === n.id).map((e) => x.get(e.from)).filter((v) => v !== undefined);
      const siblings = parents.length === 1 ? forward.filter((e) => e.from === forward.find((f) => f.to === n.id).from).map((e) => e.to) : [];
      if (parents.length === 1 && siblings.length > 1) {
        const index = siblings.indexOf(n.id);
        return parents[0] + (index - (siblings.length - 1) / 2) * COL;
      }
      return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : 0;
    });
    for (let i = 1; i < wanted.length; i++) if (wanted[i] < wanted[i - 1] + COL) wanted[i] = wanted[i - 1] + COL;
    row.forEach((n, i) => x.set(n.id, wanted[i]));
  });
  const minX = Math.min(...x.values()), maxX = Math.max(...x.values());
  const pos = new Map(nodes.map((n) => {
    const [w, h] = SIZE[n.type] ?? SIZE.step;
    const cx = PAD + 100 + (x.get(n.id) - minX);
    const cy = PAD + depth.get(n.id) * ROW + 24;
    return [n.id, { cx, cy, w, h }];
  }));
  return { pos, back, byId, width: PAD * 2 + 200 + (maxX - minX) + 240, height: PAD * 2 + (maxDepth + 1) * ROW };
}

// highlights: { stop: { id, warning }, after: [id], conflicts: [{ id, warning }] }
export function renderFlow(flow, { selected, highlights, onSelect }) {
  const { pos, back, width, height } = layoutFlow(flow);
  const after = new Set(highlights?.after ?? []);
  const conflict = new Map((highlights?.conflicts ?? []).map((c) => [c.id, c.warning]));
  const stopId = highlights?.stop?.id ?? null;
  const root = svg("svg", { class: "guide-flow-svg", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "작업 순서도" });
  root.append(svg("defs", {}, ...["line", "danger"].map((tone) => svg("marker", { id: `gf-arrow-${tone}`, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" }, svg("path", { d: "M0 0L10 5L0 10z", class: `gf-arrow ${tone}` })))));
  const edges = svg("g", { class: "gf-edges" });
  const labels = svg("g", { class: "gf-labels" });
  for (const edge of flow.edges) {
    const a = pos.get(edge.from), b = pos.get(edge.to);
    if (!a || !b) continue;
    const isBack = back.has(`${edge.from}>${edge.to}`);
    const dim = after.has(edge.to) || after.has(edge.from);
    const stopped = edge.from === stopId;
    let d, mid;
    if (isBack) {
      const side = Math.max(a.cx + a.w / 2, b.cx + b.w / 2) + 30;
      d = `M${a.cx + a.w / 2} ${a.cy}L${side} ${a.cy}L${side} ${b.cy}L${b.cx + b.w / 2} ${b.cy}`;
      mid = { x: side, y: (a.cy + b.cy) / 2 };
    } else {
      const sy = a.cy + a.h / 2, ty = b.cy - b.h / 2;
      if (Math.abs(a.cx - b.cx) < 1) { d = `M${a.cx} ${sy}L${b.cx} ${ty}`; mid = { x: a.cx, y: (sy + ty) / 2 }; }
      else if (flow.nodes.find((n) => n.id === edge.from)?.type === "decision") {
        // 분기: 마름모 옆 꼭짓점에서 가로로 나가 아래로
        const sx = a.cx + Math.sign(b.cx - a.cx) * a.w / 2;
        d = `M${sx} ${a.cy}L${b.cx} ${a.cy}L${b.cx} ${ty}`;
        mid = { x: (sx + b.cx) / 2, y: a.cy };
      } else {
        const my = ty - 14;
        d = `M${a.cx} ${sy}L${a.cx} ${my}L${b.cx} ${my}L${b.cx} ${ty}`;
        mid = { x: (a.cx + b.cx) / 2, y: my };
      }
    }
    edges.append(svg("path", { d, class: `gf-edge${isBack ? " back" : ""}${dim ? " dim" : ""}${stopped ? " stopped" : ""}`, "marker-end": `url(#gf-arrow-${stopped ? "danger" : "line"})` }));
    if (edge.label) {
      const w = Math.min(120, 16 + [...edge.label].length * 7.5);
      labels.append(svg("g", { class: "gf-label", transform: `translate(${mid.x - w / 2} ${mid.y - 9})` }, svg("rect", { width: w, height: 18, rx: 9 }), svg("text", { x: w / 2, y: 13, "text-anchor": "middle" }, clip(edge.label, 14))));
    }
  }
  const nodes = svg("g", { class: "gf-nodes" });
  flow.nodes.forEach((node, index) => {
    const p = pos.get(node.id);
    const x = p.cx - p.w / 2, y = p.cy - p.h / 2;
    const state = node.id === stopId ? " stop" : conflict.has(node.id) ? " conflict" : after.has(node.id) ? " dim" : "";
    const g = svg("g", { class: `gf-node ${node.type}${node.guess ? " guess" : ""}${state}${node.id === selected ? " selected" : ""}`, transform: `translate(${x} ${y})`, tabindex: "0", role: "button", "data-id": node.id, "aria-label": `${index + 1}번째 칸 ${node.title}` });
    if (node.type === "decision") {
      g.append(svg("path", { d: `M${p.w / 2} 0L${p.w} ${p.h / 2}L${p.w / 2} ${p.h}L0 ${p.h / 2}Z` }), svg("text", { x: p.w / 2, y: p.h / 2 + 5, "text-anchor": "middle", class: "gf-title" }, clip(node.title, 9)));
    } else if (node.type === "start" || node.type === "end") {
      g.append(svg("rect", { width: p.w, height: p.h, rx: p.h / 2 }), svg("text", { x: p.w / 2, y: p.h / 2 + 5, "text-anchor": "middle", class: "gf-title" }, clip(node.title, 10)));
    } else {
      const mark = node.id === stopId ? "⏸ " : conflict.has(node.id) ? "⚠ " : "";
      g.append(svg("rect", { width: p.w, height: p.h, rx: 7 }), svg("text", { x: 12, y: 20, class: "gf-title" }, `${mark}${clip(node.title, 12)}`), svg("text", { x: 12, y: 37, class: "gf-sub" }, clip(node.detail, 22)));
      if (node.guess) g.append(svg("g", { class: "gf-guess", transform: `translate(${p.w - 40} 6)` }, svg("rect", { width: 34, height: 16, rx: 8 }), svg("text", { x: 17, y: 12, "text-anchor": "middle" }, "추정")));
      else if (node.lines?.length) g.append(svg("text", { x: p.w - 8, y: 41, "text-anchor": "end", class: "gf-line" }, `↗ ${node.lines[0]}행`));
    }
    // 멈춤·충돌 설명 말풍선
    const bubble = node.id === stopId ? ["연결 작업은 여기서 사용자 승인을 기다립니다", "stop"] : conflict.has(node.id) ? ["연결 세션도 커밋·보고서를 만들려 합니다", "conflict"] : null;
    if (bubble) g.append(svg("g", { class: `gf-bubble ${bubble[1]}`, transform: `translate(${p.w + 10} ${p.h / 2 - 15})` }, svg("rect", { width: 150, height: 30, rx: 5 }), svg("text", { x: 8, y: 13 }, bubble[0].slice(0, 20)), svg("text", { x: 8, y: 25 }, clip(bubble[0].slice(20), 21))));
    const pick = () => onSelect?.(node.id);
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(); } });
    nodes.append(g);
  });
  root.append(edges, nodes, labels);
  return root;
}
