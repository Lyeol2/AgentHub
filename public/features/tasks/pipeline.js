// 작업 카드의 GitFlow 단계 노선. buildTaskPipeline 결과를 화면 요소로 그리기만 한다.
const STATE_TEXT = { done: '완료', current: '현재 단계', todo: '대기', warn: '확인 필요' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderTaskPipeline(pipeline) {
  const list = el('ol', 'task-pipeline');
  list.setAttribute('aria-label', 'GitFlow 진행 단계');
  pipeline.nodes.forEach((item, index) => {
    if (index > 0) {
      const edge = el('li', 'task-pipe-edge');
      edge.setAttribute('aria-hidden', 'true');
      edge.dataset.state = item.state === 'todo' || (item.kind === 'ref' && item.state !== 'done') ? 'todo' : 'done';
      if (item.edge) edge.append(el('span', 'task-pipe-edge-label', item.edge));
      list.append(edge);
    }
    const step = el('li', item.kind === 'ref' ? 'task-pipe-ref' : 'task-pipe-step');
    step.dataset.step = item.key;
    step.dataset.state = item.state;
    if (item.state === 'current') step.setAttribute('aria-current', 'step');
    if (item.kind === 'ref') {
      step.append(el('span', 'task-pipe-dot'), el('span', 'task-pipe-ref-name', item.label));
      if (item.sub) step.append(el('span', 'task-pipe-sub', item.sub));
    } else {
      const title = el('span', 'task-pipe-title');
      title.append(el('span', 'task-pipe-mark'), document.createTextNode(item.label));
      step.append(title, el('span', 'task-pipe-sub', item.sub || ''));
    }
    step.title = `${item.label}${item.sub ? ` · ${item.sub}` : ''} · ${STATE_TEXT[item.state] || ''}`;
    list.append(step);
  });
  const wrap = el('div', 'task-pipeline-wrap');
  wrap.append(list);
  return wrap;
}

// "8분 전"처럼 짧게 표시한다. 하루가 넘으면 날짜를 쓴다.
export function relativeTime(value, now = Date.now()) {
  const time = new Date(value).getTime();
  if (!value || Number.isNaN(time)) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return '방금 전';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  if (seconds < 172800) return '어제';
  return new Date(time).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
}
