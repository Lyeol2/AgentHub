// 작업 카드의 GitFlow 진행 단계와 다음 동작을 계산한다. 화면 요소 없이 동작해 단위 테스트할 수 있다.
// task: 서버의 작업 기록, status: GET /api/tasks/:id/status 결과(없으면 null), ctx: 화면이 아는 세션·요청 상태.
import { gitflowBranches, DEFAULT_GITFLOW } from './gitflow.js';

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
  const names = { ...DEFAULT_GITFLOW, ...task.gitflow };
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
  // 상태 조회가 지금 HEAD로 다시 따진 최신 여부가 있으면 저장된 결과보다 그것을 쓴다.
  const live = status?.freshness;
  const behind = active && (live ? live.state === 'needs-update' : BEHIND_STATES.includes(task.freshness?.state) || status?.behind === true);
  // main→develop 미반영은 작업 브랜치에서 풀 수 없다. 기준 반영 대신 해야 할 일을 안내한다.
  const mainMissing = active && task.type !== 'hotfix' && Boolean(live ? live.mainMissing : task.freshness?.mainMissing);
  const remoteAhead = active && status?.remoteAhead === true;
  const offBranch = !['cleaned'].includes(state) && status?.offBranch === true;
  const branchMissing = offBranch && status?.branchMissing === true;
  const unpushed = active && !offBranch ? Number(status?.unpushed) || 0 : 0;
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
    { key: 'base', kind: 'ref', label: base, state: behind ? 'warn' : 'done', sub: mainMissing ? `${names.main} 미반영` : behind ? '새 변경 있음' : '' },
    { key: 'branch', label: '브랜치 만들기', sub: task.branch || '준비 중', state: branchMissing ? 'warn' : task.provisioning ? 'current' : 'done' },
    // 브랜치만 만들고 폴더 준비가 끝나지 않았으면 폴더 단계는 아직 끝나지 않았다.
    { key: 'folder', label: '작업 폴더', sub: offBranch ? (branchMissing ? '브랜치 없음' : '다른 브랜치') : folderMissing ? '폴더 없음' : task.provisioning ? '준비 중' : folderLabel(task),
      state: offBranch || folderMissing ? 'warn' : task.provisioning ? 'todo' : 'done' },
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
  // 같은 작업의 세션 여러 개가 함께 실행될 수 있다. Git을 바꾸는 동작은 모두 끝난 뒤 한다.
  const runReason = running > 1 ? `세션 ${running}개가 작업 중입니다. 모두 끝난 뒤 진행하세요.` : running > 0 ? '세션이 작업 중입니다. 끝난 뒤 진행하세요.' : '';
  const actions = [];
  const add = (id, label, options = {}) => {
    const reason = options.reason || '';
    actions.push({ id, label, primary: !!options.primary, disabled: !!reason, reason });
  };
  if (ctx.sessionId) add('open-session', finished ? '대화 기록' : '세션 열기');
  // 버튼으로 풀 수 없는 상태는 해야 할 일을 notice로 알린다.
  const developGuide = `${names.main}의 변경이 ${names.develop}에 아직 없습니다. 작업 브랜치에서는 풀 수 없으니 Git 탭에서 ${names.main}을 ${names.develop}에 병합해 푸시하거나 ${names.main} → ${names.develop} PR을 병합한 뒤 '반영 후 다시 확인'을 누르세요.`;
  const offGuide = branchMissing
    ? `작업 브랜치 ${task.branch}가 로컬에 없고 원본 폴더는 ${status?.currentBranch || '다른 브랜치'}에 있습니다. 원본 폴더의 Git 작업은 막지 않습니다. 더 진행할 것이 없으면 '기록만 정리'로 작업 기록을 지우세요.`
    : active
      ? `원본 폴더가 ${status?.currentBranch || '다른 브랜치'}에 있어 이 작업은 대기 중입니다. 원본 폴더에서는 한 번에 한 작업만 진행합니다. 이어 하려면 '이 작업으로 전환'을 누르세요. 커밋하지 않은 변경이 있거나 세션이 실행 중이면 전환하지 않습니다.`
      : `원본 폴더가 작업 브랜치(${task.branch})를 벗어나 ${status?.currentBranch || '다른 브랜치'}에 있습니다. 원본 폴더의 Git 작업은 막지 않습니다.`;
  const notice = offBranch ? offGuide : mainMissing ? developGuide : '';
  const syncLabel = remoteAhead && !behind ? '원격 변경 합치기' : '기준 반영';
  const dirtyReason = dirty > 0 ? '커밋하지 않은 변경이 있습니다. 먼저 커밋하세요.' : '';
  if (offBranch) {
    if (pull?.url) actions.push({ id: 'pull-link', label: finished ? 'PR 보기' : 'PR 열기', url: pull.url, primary: false, disabled: false, reason: '' });
    if (branchMissing) add('delete', '기록만 정리', { primary: true, reason: waitReason || runReason });
    else if (active) add('activate', '이 작업으로 전환', { primary: true, reason: waitReason || runReason });
    else if (state === 'merged') add('cleanup', '작업 폴더 정리', { primary: true, reason: waitReason || runReason });
  } else if (state === 'working') {
    // 완료 여부를 모르는 PR 생성 뒤에도 연결된 PR은 바로 열어 볼 수 있다.
    if (pull?.url) actions.push({ id: 'pull-link', label: 'PR 열기', url: pull.url, primary: false, disabled: false, reason: '' });
    add('finish', '변경 보기', { reason: waitReason || (folderMissing ? '작업 폴더가 없습니다.' : '') });
    if (unpushed > 0) add('backup', '원격에 백업', { reason: waitReason || (folderMissing ? '작업 폴더가 없습니다.' : '') });
    if (mainMissing) {
      if (remoteAhead) add('sync', '원격 변경 합치기', { reason: waitReason || runReason || dirtyReason });
      add('refresh', '반영 후 다시 확인', { primary: true, reason: waitReason });
      add('finish', '마무리', { reason: `${names.main}의 변경을 ${names.develop}에 먼저 반영해야 합니다.` });
    } else if (behind || remoteAhead) add('sync', syncLabel, { primary: true, reason: waitReason || runReason || dirtyReason });
    else add('finish', '마무리', { primary: true, reason: waitReason || (folderMissing ? '작업 폴더가 없습니다.' : '') || runReason
      || (status && !dirty && !commits ? '아직 변경이 없습니다. 세션에서 작업을 진행하세요.' : '') });
  } else if (state === 'review') {
    if (pull?.url) actions.push({ id: 'pull-link', label: 'PR 열기', url: pull.url, primary: false, disabled: false, reason: '' });
    if (mainMissing) {
      if (remoteAhead) add('sync', '원격 변경 합치기', { reason: waitReason || runReason });
      add('refresh', '반영 후 다시 확인', { primary: true, reason: waitReason });
      add('merge', '병합 검토', { reason: `${names.main}의 변경을 ${names.develop}에 먼저 반영해야 합니다.` });
    } else {
      if (behind || remoteAhead) add('sync', syncLabel, { primary: true, reason: waitReason || runReason });
      add('merge', '병합 검토', { primary: !(behind || remoteAhead), reason: waitReason || runReason
        || (behind ? `${target}의 새 변경을 먼저 반영하세요.` : remoteAhead ? '원격 작업 브랜치의 새 커밋을 먼저 합치세요.' : '') });
    }
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
  // 카드 머리에 붙일 짧은 경고. 이 컴퓨터에만 있는 커밋과 원본 폴더의 브랜치 이탈을 알린다.
  const badges = [];
  if (unpushed > 0) badges.push({ id: 'unpushed', label: `푸시 안 됨 ${unpushed}개`, title: '이 컴퓨터에만 있는 커밋입니다. 원격에 백업으로 작업 브랜치만 올려 둘 수 있습니다.' });
  if (offBranch) badges.push({ id: 'off-branch', label: branchMissing ? '작업 브랜치 없음' : active ? '대기 중 · 원본 폴더는 다른 브랜치' : '원본 폴더가 작업 브랜치에서 벗어남', title: notice });
  return { current, base, target, behind, mainMissing, notice, badges, nodes, actions, stateLabel: TASK_STATE_LABELS[state] || '상태 확인 필요' };
}
