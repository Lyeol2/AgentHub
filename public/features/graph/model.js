export const CARD_W = 230;
export const CARD_H = 128; // 장착한 스킬 칩 한 줄을 포함한 높이(style.css의 .gcard와 같다)
export const GAP_X = 96;
export const GAP_Y = 24;
export const PAD = 20;
export const SVG_NS = "http://www.w3.org/2000/svg";
export const CARD_SIZE = { w: CARD_W, h: CARD_H };
// 명령 노드는 id가 "cmd-"로 시작한다(서버의 commands.mjs와 같다).
export const isCommandNode = (id) => id.startsWith("cmd-");
export const CMD_SIZE = { w: CARD_W, h: 108 }; // style.css의 .gcmd와 같다
export const nodeSize = (id) => (isCommandNode(id) ? CMD_SIZE : CARD_SIZE);

export function layoutGraph(sessions, links) {
  // 순환 연결은 만든 순서로 따라가다 되돌아가는 연결을 빼고 단계를 매긴다.
  const forward = new Set();
  const done = new Set();
  const onPath = new Set();
  const walk = (id) => {
    onPath.add(id);
    for (const l of links.filter((l) => l.from === id)) {
      if (onPath.has(l.to)) continue;
      forward.add(l);
      if (!done.has(l.to)) walk(l.to);
    }
    onPath.delete(id);
    done.add(id);
  };
  for (const s of sessions) if (!done.has(s.id)) walk(s.id);

  const level = new Map();
  const depth = (id) => {
    if (level.has(id)) return level.get(id);
    const parents = [...forward].filter((l) => l.to === id).map((l) => l.from);
    const value = parents.length ? Math.max(...parents.map((p) => depth(p) + 1)) : 0;
    level.set(id, value);
    return value;
  };
  const rows = new Map();
  const pos = new Map();
  for (const s of sessions) {
    const lv = depth(s.id);
    const row = rows.get(lv) ?? 0;
    rows.set(lv, row + 1);
    // graphPos: 옮긴 세션 카드 위치, pos: 옮긴 명령 노드 위치
    pos.set(s.id, s.graphPos ?? s.pos ?? { x: PAD + lv * (CARD_W + GAP_X), y: PAD + row * (CARD_H + GAP_Y) });
  }
  return pos;
}

export function edgePath(a, b, sa = CARD_SIZE, sb = CARD_SIZE) {
  const x1 = a.x + sa.w;
  const y1 = a.y + sa.h / 2;
  const x2 = b.x;
  const y2 = b.y + sb.h / 2;
  if (x2 < x1) {
    // 되돌아가는 연결은 카드 아래쪽끼리 잇는다.
    const sx = a.x + sa.w / 2;
    const tx = b.x + sb.w / 2;
    const sy = a.y + sa.h;
    const ty = b.y + sb.h;
    const low = Math.max(sy, ty) + 44;
    return { d: `M${sx},${sy} C${sx},${low} ${tx},${low} ${tx},${ty}`, mid: { x: (sx + tx) / 2, y: low - 11 } };
  }
  const dx = Math.max(48, (x2 - x1) / 2);
  return { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
}
