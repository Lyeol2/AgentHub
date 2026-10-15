// 순서가 보장된 Git 기록을 행 단위 SVG 연결 정보로 바꾼다.
// lane은 왼쪽부터 0, color는 화면 팔레트에 사용할 0~5 인덱스다.
const COLOR_COUNT = 6;

export function layoutGitGraph(commits = []) {
  let active = [];
  let colorIndex = 0;
  let lanes = 0;
  const nextColor = () => colorIndex++ % COLOR_COUNT;
  const rows = [];

  for (const commit of commits) {
    const incoming = active;
    const existingLane = incoming.findIndex((line) => line.hash === commit.hash);
    const lane = existingLane < 0 ? incoming.length : existingLane;
    const color = existingLane < 0 ? nextColor() : incoming[existingLane].color;
    const parents = [...new Set((commit.parents || []).filter(Boolean))];
    const outgoing = incoming.filter((_, index) => index !== existingLane);

    // 첫 부모는 현재 노선을 이어받고, 나머지 부모는 별도 노선을 연다.
    // 이미 기다리는 부모는 기존 노선에 합류해 중복 lane을 만들지 않는다.
    for (const [index, hash] of parents.entries()) {
      if (outgoing.some((line) => line.hash === hash)) continue;
      const line = { hash, color: index === 0 ? color : nextColor(), ...(commit.work ? { dashed: true } : {}) };
      if (index === 0) outgoing.splice(Math.min(lane, outgoing.length), 0, line);
      else outgoing.push(line);
    }

    const segments = [];
    if (existingLane >= 0) {
      segments.push({ fromLane: lane, toLane: lane, from: "top", to: "node", color, ...(incoming[existingLane].dashed ? { dashed: true } : {}) });
    }
    for (const [index, line] of incoming.entries()) {
      if (index === existingLane) continue;
      segments.push({
        fromLane: index,
        toLane: outgoing.findIndex((next) => next.hash === line.hash),
        from: "top",
        to: "bottom",
        color: line.color,
        ...(line.dashed ? { dashed: true } : {}),
      });
    }
    for (const [index, hash] of parents.entries()) {
      const toLane = outgoing.findIndex((line) => line.hash === hash);
      segments.push({
        fromLane: lane,
        toLane,
        from: "node",
        to: "bottom",
        color: index === 0 ? color : outgoing[toLane].color,
        ...(commit.work ? { dashed: true } : {}),
      });
    }

    rows.push({ commit, lane, color, segments, continuation: outgoing.length > 0 });
    lanes = Math.max(lanes, incoming.length, outgoing.length, lane + 1);
    active = outgoing;
  }

  return { rows, lanes };
}

// 실제 커밋과 구분할 작업 노드를 만든다.
export function gitWorkRows(data) {
  const rows = [];
  for (const b of data.branches) {
    const dirty = b.current ? data.files.length + data.moreFiles : b.dirty;
    if (!dirty && b.sessionState !== "running") continue;
    rows.push({ hash: "work:" + b.name, parents: b.tip ? [b.tip] : [], refs: [b.name], branch: b, work: true,
      subject: b.sessionState === "running" ? "작업 중" : "커밋 전 변경", dirty: dirty || 0 });
  }
  // 브랜치에 붙지 않은 HEAD도 실제 커밋에서 이어야 한다. 전체 그래프 첫 행은 다른 브랜치일 수 있다.
  if (!data.branches.some((b) => b.current) && data.files.length) {
    const head = data.commits[0]?.hash;
    rows.unshift({ hash: "work:HEAD", parents: head ? [head] : [], refs: [data.branch], branch: { name: data.branch, current: true }, work: true, subject: head ? "커밋 전 변경" : "첫 커밋 전", dirty: data.files.length + data.moreFiles });
  }
  return rows;
}

