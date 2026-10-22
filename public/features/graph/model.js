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
  if (sessions.every((node) => node.graphPos || node.pos)) return new Map(sessions.map((node) => [node.id, node.graphPos ?? node.pos]));
  // 순환 연결은 만든 순서로 따라가다 되돌아가는 연결을 빼고 단계를 매긴다.
  const outgoing = new Map(), forward = new Map(), order = [];
  for (const link of links) {
    if (!outgoing.has(link.from)) outgoing.set(link.from, []);
    outgoing.get(link.from).push(link);
  }
  const done = new Set();
  const onPath = new Set();
  // Explicit DFS frames preserve cycle-breaking order without exhausting the JS stack.
  for (const node of sessions) {
    if (done.has(node.id)) continue;
    const stack = [{ id: node.id, index: 0 }];
    onPath.add(node.id);
    while (stack.length) {
      const frame = stack.at(-1), edges = outgoing.get(frame.id) ?? [];
      if (frame.index === edges.length) {
        onPath.delete(frame.id); done.add(frame.id); order.push(frame.id); stack.pop();
        continue;
      }
      const link = edges[frame.index++];
      if (onPath.has(link.to)) continue;
      if (!forward.has(link.from)) forward.set(link.from, []);
      forward.get(link.from).push(link.to);
      if (!done.has(link.to)) { onPath.add(link.to); stack.push({ id: link.to, index: 0 }); }
    }
  }
  const level = new Map();
  for (const id of order.reverse()) for (const to of forward.get(id) ?? []) level.set(to, Math.max(level.get(to) ?? 0, (level.get(id) ?? 0) + 1));
  const rows = new Map();
  const pos = new Map();
  for (const s of sessions) {
    const lv = level.get(s.id) ?? 0;
    const row = rows.get(lv) ?? 0;
    rows.set(lv, row + 1);
    // graphPos: 옮긴 세션 카드 위치, pos: 옮긴 명령 노드 위치
    pos.set(s.id, s.graphPos ?? s.pos ?? { x: PAD + lv * (CARD_W + GAP_X), y: PAD + row * (CARD_H + GAP_Y) });
  }
  return pos;
}

export function edgePath(a, b, sa = CARD_SIZE, sb = CARD_SIZE, sourceY = null) {
  const x1 = a.x + sa.w;
  const y1 = a.y + (sourceY ?? sa.h / 2);
  const x2 = b.x;
  const y2 = b.y + sb.h / 2;
  if (x2 < x1) {
    // 되돌아가는 연결은 카드 아래쪽끼리 잇는다.
    const sx = sourceY === null ? a.x + sa.w / 2 : x1;
    const tx = b.x + sb.w / 2;
    const sy = sourceY === null ? a.y + sa.h : y1;
    const ty = b.y + sb.h;
    const low = Math.max(sy, ty) + 44;
    return { d: `M${sx},${sy} C${sourceY === null ? sx : sx + 44},${low} ${tx},${low} ${tx},${ty}`, mid: { x: (sx + tx) / 2, y: low - 11 } };
  }
  const dx = Math.max(48, (x2 - x1) / 2);
  return { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
}
