// 작업 카드의 GitFlow 진행 단계와 다음 동작을 계산한다. 화면 요소 없이 동작해 단위 테스트할 수 있다.
// task: 서버의 작업 기록, status: GET /api/tasks/:id/status 결과(없으면 null), ctx: 화면이 아는 세션·요청 상태.
import { gitflowBranches } from './gitflow.js';

export const TASK_STATE_LABELS = { working: '진행 중', review: '검토 대기', merged: '완료', cleaned: '정리됨' };

const BEHIND_STATES = ['needs-update', 'behind', 'stale', 'diverged'];

function folderLabel(task) {
  if (task.inPlace) return '원본 폴더';
  const cwd = String(task.cwd || '').replace(/[\\/]+$/, '');
  const name = cwd.split(/[\\/]/).pop();
  if (!name) return '준비 중';
  return task.ownsWorktree === false ? name : `.agenthub/${name}`;
}

function pullClosed(pull) {
  return pull && String(pull.state || '').toUpperCase() === 'CLOSED';
}

export function buildTaskPipeline(task, status = null, ctx = {}) {
  const flow = gitflowBranches(task.type || 'feature', task.gitflow || {});
  const base = task.baseBranch || flow.base;
  const target = task.targetBranch || flow.target;
  const local = task.finishMode === 'local' || task.completion?.kind === 'local';
  const state = task.state;
  const active = state === 'working' || state === 'review';
  const finished = state === 'merged' || state === 'cleaned';
  const sessions = ctx.sessions ?? status?.sessions ?? 0;
  const running = ctx.running ?? status?.running ?? 0;
  const dirty = status?.dirty ?? null;
  const commits = status?.commits ?? null;
  const behind = active && (BEHIND_STATES.includes(task.freshness?.state) || status?.behind === true);
  const blocked = Boolean(ctx.uncertain || task.pendingAction);
  const pending = Boolean(ctx.pending);
  const folderMissing = active && status?.folder === false;

  // 현재 단계. 작업 → 커밋 → PR(또는 대상 반영) → 대상 브랜치 순서로 진행한다.
  let current;
  if (finished) current = 'target';
  else if (state === 'review') current = 'pr';
  else if (running > 0) current = 'work';
  else if (dirty > 0) current = 'commit';
  else if (commits > 0) current = 'pr';
  else current = 'work';
  const order = ['branch', 'folder', 'work', 'commit', 'pr', 'target'];
  const reached = (key) => order.indexOf(key) < order.indexOf(current);
  const nodeState = (key) => key === current ? 'current' : reached(key) ? 'done' : 'todo';

  const workSub = `세션 ${sessions}개${running ? ' · 실행 중' : ''}`;
  const commitSub = commits > 0 && !dirty ? `${commits}개${status?.shortHead ? ` · ${status.shortHead}` : ''}`
    : dirty > 0 ? `변경 ${dirty}개 · 커밋 전`
    : finished || state === 'review' ? (status?.shortHead ? `${commits ?? '?'}개 · ${status.shortHead}` : '커밋됨')
    : '아직 없음';
  const pull = task.pull;
  const prSub = local
    ? (finished ? '반영됨' : `→ ${target}`)
    : pull?.number
      ? `#${pull.number} ${finished ? '병합됨' : pullClosed(pull) ? '닫힘' : '검토 대기'}`
      : status?.pushed && commits > 0 ? '푸시됨 · PR 전' : `→ ${target}`;

  const nodes = [
    { key: 'base', kind: 'ref', label: base, state: behind ? 'warn' : 'done', sub: behind ? '새 변경 있음' : '' },
    { key: 'branch', label: '브랜치 만들기', sub: task.branch || '준비 중', state: task.provisioning ? 'current' : 'done' },
    { key: 'folder', label: '작업 폴더', sub: folderMissing ? '폴더 없음' : folderLabel(task), state: folderMissing ? 'warn' : 'done' },
    { key: 'work', label: '작업', sub: workSub, state: nodeState('work') },
    { key: 'commit', label: '커밋', sub: commitSub, state: nodeState('commit') },
    { key: 'pr', label: local ? '대상 반영' : 'Pull Request', sub: prSub, state: pullClosed(pull) && !finished ? 'warn' : nodeState('pr') },
    { key: 'target', kind: 'ref', label: target, state: finished ? 'done' : 'todo', edge: '병합' },
  ];
  nodes[1].edge = '분기';
  const localUnpushed = finished && local && task.completion && task.completion.publishState !== 'done';
  if (localUnpushed) Object.assign(nodes.at(-1), { state: 'warn', sub: '푸시 전' });
  if (flow.backMerge && flow.backMerge !== target) {
    const pendingBack = finished && task.developPending !== false;
    nodes.push({ key: 'back', kind: 'ref', label: flow.backMerge, edge: '역반영',
      state: !finished ? 'todo' : pendingBack ? 'warn' : 'done', sub: pendingBack ? '반영 필요' : '' });
  }

  // 다음 동작. 할 수 없는 동작은 꺼 두고 이유를 함께 돌려준다.
  const waitReason = blocked ? '이전 요청의 결과를 모릅니다. 최신 상태 확인을 먼저 눌러 주세요.' : pending ? '요청을 처리하고 있습니다.' : '';
  const runReason = running > 0 ? '세션이 작업 중입니다. 끝난 뒤 진행하세요.' : '';
  const actions = [];
  const add = (id, label, options = {}) => {
    const reason = options.reason || '';
    actions.push({ id, label, primary: !!options.primary, disabled: !!reason, reason });
  };
  if (ctx.sessionId) add('open-session', finished ? '대화 기록' : '세션 열기');
  if (state === 'working') {
    // 완료 여부를 모르는 PR 생성 뒤에도 연결된 PR은 바로 열어 볼 수 있다.
    if (pull?.url) actions.push({ id: 'pull-link', label: 'PR 열기', url: pull.url, primary: false, disabled: false, reason: '' });
    add('finish', '변경 보기', { reason: waitReason || (folderMissing ? '작업 폴더가 없습니다.' : '') });
    if (behind) add('sync', '기준 반영', { primary: true, reason: waitReason || runReason || (dirty > 0 ? '커밋하지 않은 변경이 있습니다. 먼저 커밋하세요.' : '') });
    else add('finish', '마무리', { primary: true, reason: waitReason || (folderMissing ? '작업 폴더가 없습니다.' : '') || runReason
      || (status && !dirty && !commits ? '아직 변경이 없습니다. 세션에서 작업을 진행하세요.' : '') });
  } else if (state === 'review') {
    if (pull?.url) actions.push({ id: 'pull-link', label: 'PR 열기', url: pull.url, primary: false, disabled: false, reason: '' });
    if (behind) add('sync', '기준 반영', { primary: true, reason: waitReason || runReason });
    add('merge', '병합 검토', { primary: !behind, reason: waitReason || runReason || (behind ? `${target}의 새 변경을 먼저 반영하세요.` : '') });
  } else if (finished) {
    if (pull?.url) actions.push({ id: 'pull-link', label: 'PR 보기', url: pull.url, primary: false, disabled: false, reason: '' });
    if (state === 'merged') {
      const backPending = flow.backMerge && flow.backMerge !== target && task.developPending !== false;
      if (backPending && !local && task.developPull?.state === 'OPEN' && task.developPull.url)
        actions.push({ id: 'pull-link', label: `${flow.backMerge} 반영 PR`, url: task.developPull.url, primary: false, disabled: false, reason: '' });
      else if (backPending) add('develop', local ? `${flow.backMerge}에 반영` : `${flow.backMerge} 반영 PR 만들기`, { primary: true, reason: waitReason });
      add('cleanup', '작업 폴더 정리', { primary: !backPending,
        reason: waitReason || runReason || (backPending ? `${flow.backMerge}에도 반영해야 정리할 수 있습니다.` : '') });
    }
  }
  return { current, base, target, behind, nodes, actions, stateLabel: TASK_STATE_LABELS[state] || '상태 확인 필요' };
}
