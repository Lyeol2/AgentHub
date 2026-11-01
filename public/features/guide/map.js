// 지침 지도: 노드를 종류별 열로 놓고(루트·CLAUDE → 하위 지침 → 문서 → 스킬 → 주입 안내 → 세션 역할) 선으로 잇는다.
const NS = "http://www.w3.org/2000/svg";
const W = 180, H = 46, GAP_Y = 18, COL = 230, PAD = 40;
const COLUMN = { claude: 0, root: 0, nested: 1, doc: 2, skill: 3, inject: 4, role: 5 };
export const KIND_LABEL = { root: "루트 지침", claude: "CLAUDE.md", nested: "하위 지침", doc: "링크된 문서", skill: "스킬", inject: "AgentHub 주입 안내", role: "세션 역할" };
const ICON = { root: "▣", claude: "◆", nested: "▣", doc: "▤", skill: "⚡", inject: "⧉", role: "👤" };

const svg = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(key, value);
  node.append(...children.filter(Boolean));
  return node;
};
const clip = (text, max) => (String(text ?? "").length > max ? `${String(text).slice(0, max - 1)}…` : String(text ?? ""));

export function layoutMap(data, { hideDim = false } = {}) {
  const visible = data.nodes.filter((node) => !(hideDim && node.orphan));
  const ids = new Set(visible.map((n) => n.id));
  const columns = new Map();
  for (const node of visible) {
    const col = COLUMN[node.kind] ?? 2;
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col).push(node);
  }
  // 문서 열: 링크된 문서 → 깨진 링크 → 참조 없음 순서
  const rank = (n) => (n.kind === "claude" ? 0 : n.kind === "root" ? 1 : n.orphan ? 4 : n.broken ? 3 : 2);
  for (const list of columns.values()) list.sort((a, b) => rank(a) - rank(b));
  const used = [...columns.keys()].sort((a, b) => a - b);
  const tallest = Math.max(...[...columns.values()].map((list) => list.length), 1);
  const height = tallest * (H + GAP_Y) - GAP_Y;
  const pos = new Map();
  used.forEach((col, index) => {
    const list = columns.get(col);
    const top = PAD + 24 + (height - (list.length * (H + GAP_Y) - GAP_Y)) / 2;
    list.forEach((node, i) => pos.set(node.id, { x: PAD + index * COL, y: top + i * (H + GAP_Y) }));
  });
  const edges = data.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes: visible, edges, pos, width: PAD * 2 + Math.max(used.length - 1, 0) * COL + W, height: PAD * 2 + 24 + height };
}

export function renderMap(data, { hideDim, zoom = 1, selected, onSelect }) {
  const { nodes, edges, pos, width, height } = layoutMap(data, { hideDim });
  const root = svg("svg", { class: "guide-map-svg", width: Math.round(width * zoom), height: Math.round(height * zoom), viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "지침 지도" });
  root.append(svg("defs", {},
    ...["accent", "line", "warn", "danger", "orch"].map((tone) => svg("marker", { id: `gm-arrow-${tone}`, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" },
      svg("path", { d: "M0 0L10 5L0 10z", class: `gm-arrow ${tone}` })))));
  const layer = svg("g", { class: "gm-edges" });
  const labels = svg("g", { class: "gm-labels" });
  for (const edge of edges) {
    const a = pos.get(edge.from), b = pos.get(edge.to);
    let d, mid;
    if (Math.abs(a.x - b.x) < 1) {
      // 같은 열(CLAUDE.md → AGENTS.md): 세로선
      const [top, bottom] = a.y < b.y ? [a, b] : [b, a];
      d = `M${top.x + W / 2} ${top.y + H}L${bottom.x + W / 2} ${bottom.y}`;
      mid = { x: top.x + W / 2, y: (top.y + H + bottom.y) / 2 };
    } else {
      const sx = a.x + W, sy = a.y + H / 2, tx = b.x, ty = b.y + H / 2;
      const back = tx < sx;
      const c = back ? 60 : Math.max(40, (tx - sx) / 2);
      d = back ? `M${a.x} ${sy}C${a.x - c} ${sy} ${b.x + W + c} ${ty} ${b.x + W} ${ty}` : `M${sx} ${sy}C${sx + c} ${sy} ${tx - c} ${ty} ${tx} ${ty}`;
      mid = { x: back ? (a.x + b.x + W) / 2 : (sx + tx) / 2, y: (sy + ty) / 2 };
    }
    const tone = edge.broken ? "danger" : edge.kind === "import" ? "accent" : edge.kind === "conditional" ? "warn" : edge.kind === "inject" ? "orch" : "line";
    const active = selected && (edge.from === selected || edge.to === selected);
    layer.append(svg("path", { d, class: `gm-edge ${edge.kind}${edge.broken ? " broken" : ""}${active ? " active" : ""}`, "marker-end": `url(#gm-arrow-${tone})` }));
    if (edge.label && edge.kind !== "skill") {
      const w = Math.min(140, 14 + [...edge.label].length * 7.5);
      labels.append(svg("g", { class: `gm-label ${edge.broken ? "broken" : edge.kind}`, transform: `translate(${mid.x - w / 2} ${mid.y - 9})` },
        svg("rect", { width: w, height: 18, rx: 9 }), svg("text", { x: w / 2, y: 13, "text-anchor": "middle" }, clip(edge.label, 18))));
    }
  }
  root.append(layer);
  const group = svg("g", { class: "gm-nodes" });
  for (const node of nodes) {
    const p = pos.get(node.id);
    const g = svg("g", { class: `gm-node ${node.kind}${node.broken ? " broken" : ""}${node.orphan ? " orphan" : ""}${node.id === selected ? " selected" : ""}`, transform: `translate(${p.x} ${p.y})`, tabindex: "0", role: "button", "data-id": node.id, "aria-label": `${node.title} · ${KIND_LABEL[node.kind] ?? ""}` },
      svg("rect", { width: W, height: H, rx: 7 }),
      svg("text", { x: 12, y: 19, class: "gm-title" }, `${ICON[node.kind] ?? "·"} ${clip(node.title, 20)}`),
      svg("text", { x: 12, y: 36, class: "gm-sub" }, clip(node.sub || node.readers, 28)));
    if (node.kind === "claude" || (node.kind === "nested" && /CLAUDE\.md$/i.test(node.id))) g.append(svg("g", { class: "gm-tag claude", transform: `translate(${W - 74} -9)` }, svg("rect", { width: 66, height: 17, rx: 8.5 }), svg("text", { x: 33, y: 12.5, "text-anchor": "middle" }, "Claude 전용")));
    if (node.kind === "nested" && /AGENTS\.md$/i.test(node.id)) g.append(svg("g", { class: "gm-tag codex", transform: `translate(${W - 74} -9)` }, svg("rect", { width: 66, height: 17, rx: 8.5 }), svg("text", { x: 33, y: 12.5, "text-anchor": "middle" }, "Codex 전용")));
    if (node.kind === "root" && node.readers?.startsWith("Codex")) g.append(svg("g", { class: "gm-tag codex", transform: `translate(${W - 74} -9)` }, svg("rect", { width: 66, height: 17, rx: 8.5 }), svg("text", { x: 33, y: 12.5, "text-anchor": "middle" }, "Codex만")));
    const pick = () => onSelect?.(node.id);
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(); } });
    group.append(g);
  }
  root.append(group, labels);
  return root;
}
