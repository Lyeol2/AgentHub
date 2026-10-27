import { confirmAction } from '../../shared/confirm-dialog.js';
import { DEFAULT_GITFLOW } from '../../shared/gitflow.js';
// Commit, explicitly update, and publish/merge are separate actions.
export function createTaskFinisher({ api, isCurrent, onTask, onBusy, onError, onUnknown, decorateError = () => {} }) {
  const $ = id => document.getElementById(id);
  const dialog = $('finish-task-dialog');
  const drafts = new Map();
  let task, project, review, generation = 0, loading = false, busy = false, merging = false, uncertain = false;
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const active = (serial) => serial === generation && dialog?.open && task && isCurrent(project);
  const mode = () => $('task-finish-mode')?.value || 'pr';
  const selected = () => [...($('task-finish-files')?.querySelectorAll('input:checked') || [])].map(input => input.value);
  const behind = () => review?.task?.freshness?.behind || (mode() === 'local' && review?.localBehind);
  const blockedBase = () => mode() === 'local' && task?.type !== 'hotfix' && review?.task?.freshness?.mainMissing;
  // main→develop 미반영은 작업 브랜치에서 풀 수 없으므로 실제로 해야 할 일을 알린다.
  const developGuide = () => { const { main, develop } = { ...DEFAULT_GITFLOW, ...task?.gitflow };
    return `${main}의 변경이 ${develop}에 아직 없습니다. Git 탭에서 ${main}을 ${develop}에 병합해 푸시하거나 ${main} → ${develop} PR을 병합한 뒤 다시 확인을 누르세요. 현재 변경은 아래에서 커밋할 수 있습니다.`; };
  function message(text = '', reason, hint = '') {
    const el = $('task-finish-error');
    el.textContent = text; el.hidden = !text;
    if (text && hint) { const tip = document.createElement('span'); tip.className = 'task-error-hint'; tip.textContent = hint; el.append(tip); }
    if (text) decorateError(el, reason);
  }
  function saveDraft() {
    if (!task) return;
    drafts.set(task.id, { message: $('task-finish-message').value, description: $('task-finish-description').value,
      verification: $('task-finish-verification').value, mode: mode(), head: review?.head });
  }
  function render() {
    if (!task) return;
    const dirty = Boolean(review?.files?.length), needsSync = Boolean(behind());
    $('task-finish-heading').textContent = merging ? '리뷰 머지' : '리뷰 체인지';
    $('task-finish-summary').textContent = `${task.title}\n${task.branch} → ${task.targetBranch}\n${task.cwd || ''}`;
    $('task-finish-mode').disabled = busy || merging || Boolean(task.pull);
    $('task-finish-commit-fields').hidden = !dirty || merging;
    $('task-finish-message').required = dirty && !merging;
    $('task-finish-push-row').hidden = mode() !== 'local' || merging;
    $('task-finish-merge-method-row').hidden = !merging;
    $('task-finish-verify-row').hidden = dirty || !review;
    $('task-finish-description').disabled = merging;
    $('task-finish-verification').disabled = merging;
    const steps = $('task-finish-steps');
    steps.replaceChildren();
    for (const [text, done] of [['커밋', !!review && !dirty], [merging ? '머지 PR' : mode() === 'local' ? '머지 투 타깃' : task.pull ? '업데이트 PR' : '크리에이트 PR', false]]) {
      const step = el('span', `${done ? '✓ ' : ''}${text}`); step.dataset.done = String(done);
      // 아직 끝나지 않은 첫 단계가 지금 할 일이다.
      if (!done && review && !steps.querySelector('[aria-current]')) step.setAttribute('aria-current', 'step');
      steps.append(step);
    }
    const hint = loading ? '작업 폴더와 기준 브랜치를 확인하고 있습니다…' : !review ? '변경 목록을 확인한 뒤 진행할 수 있습니다.'
      : blockedBase() ? developGuide()
      : merging && dirty ? '커밋하지 않은 변경이 있습니다. 업데이트 PR에서 커밋·푸시한 뒤 다시 검토하세요.'
      : dirty ? `${review.files.length}개 변경 중 선택한 파일만 커밋합니다. 나머지 변경이 남으면 반영을 진행하지 않습니다.`
      : needsSync && mode() === 'local' ? '로컬 병합은 대상 브랜치 최신화가 필요합니다. 별도 업데이트 버튼으로 반영하고 다시 검증하세요.'
      : merging ? `PR #${task.pull?.number}을 ${task.targetBranch}에 병합합니다. GitHub의 검사와 리뷰 조건을 확인합니다.`
      : mode() === 'local' ? `${task.targetBranch} 로컬 브랜치에 병합합니다. 작업 폴더 정리는 반영이 끝난 뒤 선택합니다.`
      : '현재 커밋을 게시하고 PR을 만듭니다. PR 생성 후에는 리뷰 대기 상태가 됩니다.';
    $('task-finish-hint').textContent = hint + (needsSync && mode() === 'pr' ? ` ${task.targetBranch}에 새 변경이 있습니다. 최신화는 선택 사항이며, PR 병합 시 GitHub 정책에 따라 필요할 수 있습니다.` : '');
    if (merging && task.pull) {
      const pull = task.pull;
      const checks = pull.checks;
      const checkStatus = pull.checksError ? '조회 실패' : checks?.total ? `통과 ${checks.passed} · 대기 ${checks.pending} · 실패 ${checks.failed}` : '없음 또는 확인 필요';
      $('task-finish-hint').textContent += ` 병합 상태: ${pull.mergeStateStatus || '확인 필요'} · 검사: ${checkStatus} · 리뷰: ${pull.reviewDecision || '요구 없음 또는 확인 필요'}${pull.mergeable === false ? ' · 충돌 있음' : ''}${pull.isDraft ? ' · 초안 PR' : ''}. 실제 병합 시 GitHub 조건을 다시 확인합니다.`;
    }
    const submit = $('task-finish-submit');
    submit.textContent = merging ? '머지 PR' : mode() === 'local' ? '머지 투 타깃' : task.pull ? '업데이트 PR' : '크리에이트 PR';
    submit.title = merging || mode() === 'local' ? `${task.branch} → ${task.targetBranch}` : `${task.branch} → ${task.remote || 'origin'}/${task.branch}`;
    submit.disabled = busy || loading || !review || uncertain || Boolean(task.pendingAction) || (blockedBase() && !dirty)
      || dirty || (mode() === 'local' && needsSync) || !$('task-finish-verified').checked;
    const commit = $('task-finish-commit'), sync = $('task-finish-sync');
    commit.hidden = !dirty || merging;
    commit.disabled = busy || loading || !review || uncertain || Boolean(task.pendingAction) || !selected().length;
    sync.hidden = !review;
    sync.textContent = `업데이트 프롬 ${task.targetBranch}`;
    sync.title = `${task.remote || 'origin'}/${task.targetBranch} → ${task.branch}`;
    sync.disabled = busy || loading || uncertain || Boolean(task.pendingAction) || dirty;
    $('task-finish-refresh').disabled = busy || loading;
    $('task-finish-cancel').disabled = busy;
    $('task-finish-files').querySelectorAll('input,button').forEach(control => { control.disabled = busy; });
  }
  async function load() {
    if (!task) return;
    const serial = ++generation, id = task.id;
    loading = true; review = null; render();
    try {
      const value = await api('GET', `/api/tasks/${encodeURIComponent(id)}/review`);
      if (!active(serial)) return;
      review = value; task = value.task; onTask(task);
      if (drafts.get(task.id)?.head && drafts.get(task.id).head !== review.head) $('task-finish-verification').value = '';
      $('task-finish-verified').checked = false;
      const files = $('task-finish-files'); files.replaceChildren();
      for (const file of value.files || []) {
        const row = el('div', null, 'task-review-file');
        const label = el('label'); const check = el('input'); check.type = 'checkbox'; check.value = file.path; check.checked = true;
        check.addEventListener('change', render); label.append(check, el('span', `${file.label || '변경'} · ${file.path}`));
        const view = el('button', '변경 보기', 'ghost sm'); view.type = 'button';
        view.addEventListener('click', () => void showDiff(file.path)); row.append(label, view); files.append(row);
      }
      $('task-finish-diff').hidden = true;
      const commits = $('task-finish-commits'); commits.replaceChildren();
      for (const commit of value.commits || []) commits.append(el('li', `${commit.hash.slice(0, 8)} ${commit.subject}`));
      $('task-finish-commit-count').textContent = `기준 브랜치에 없는 커밋 ${(value.commits || []).length}개`;
    } catch (error) { if (active(serial)) message(error.message, error.reason); }
    finally { if (active(serial)) { loading = false; render(); } }
  }
  async function showDiff(file) {
    const serial = generation, id = task.id;
    const diff = $('task-finish-diff'); diff.hidden = false; diff.textContent = '변경을 불러오고 있습니다…';
    try {
      const result = await api('GET', `/api/tasks/${encodeURIComponent(id)}/diff?file=${encodeURIComponent(file)}`);
      if (!active(serial)) return;
      if (result.token !== review?.token) { review = null; message('파일이 변경됐습니다. 다시 확인을 눌러 목록을 갱신하세요.'); render(); return; }
      diff.textContent = `${file}\n\n${result.diff || '(텍스트 변경 없음)'}`;
    } catch (error) { if (active(serial)) diff.textContent = error.message; }
  }
  async function submit(event) {
    event.preventDefault();
    const button = event.submitter || $('task-finish-submit');
    if (!task || !review || !isCurrent(project) || busy || loading || button.disabled || button.hidden) return;
    const action = button.id === 'task-finish-commit' ? 'commit' : button.id === 'task-finish-sync' ? 'sync' : merging ? 'merge' : 'finish';
    const dirty = review.files.length > 0;
    const id = task.id, serial = generation;
    saveDraft();
    const body = { expectedHead: review.head, reviewToken: review.token, mode: mode(), message: $('task-finish-message').value.trim(),
      description: $('task-finish-description').value.trim(), verification: $('task-finish-verification').value.trim() };
    if (dirty) body.files = selected();
    if (action === 'finish') { body.expectedTargetHead = review.localTargetHead; body.push = mode() === 'local' && $('task-finish-push').checked; }
    if (action === 'merge') { body.expectedPullHead = task.pull?.headRefOid; body.method = $('task-finish-merge-method').value; }
    if (action === 'sync') {
      const answer = await confirmAction({ title: `업데이트 프롬 ${task.targetBranch}`, subject: task.title,
        changes: [`${task.remote || 'origin'}/${task.targetBranch} → ${task.branch}`, `원격 작업 브랜치 ${task.remote || 'origin'}/${task.branch}의 추가 커밋도 함께 합칩니다.`, ...(mode() === 'local' ? [`로컬 ${task.targetBranch}의 추가 커밋도 합칩니다.`] : [])],
        keeps: ['대상 브랜치와 PR은 변경하지 않습니다.'], warnings: ['작업 브랜치의 파일과 커밋이 바뀔 수 있습니다. 반영 후 다시 검증하세요.'], confirmLabel: '업데이트' });
      if (!answer.ok || !active(serial) || busy) return;
    }
    // 병합은 대상 브랜치를 바꾸므로 무엇이 합쳐지는지 요약해 한 번 더 확인한다.
    if (action === 'merge' || (action === 'finish' && mode() === 'local')) {
      const select = $('task-finish-merge-method');
      const commits = review.commits?.length ?? 0;
      const answer = await confirmAction({
        title: action === 'merge' ? 'PR 병합' : '대상 브랜치에 반영', subject: task.title,
        changes: [
          action === 'merge' ? `PR #${task.pull?.number}: ${task.branch} → ${task.targetBranch}` : `로컬 ${task.targetBranch}에 ${task.branch}를 병합합니다.`,
          `합쳐지는 커밋 ${commits}${commits >= 100 ? '개 이상' : '개'}`,
          action === 'merge' ? `병합 방식: ${select?.selectedOptions?.[0]?.textContent || body.method}` : body.push ? `병합 후 ${task.targetBranch}를 원격에 푸시합니다.` : '',
        ],
        keeps: [`작업 브랜치 ${task.branch}와 작업 폴더 (정리는 따로 합니다)`],
        confirmLabel: action === 'merge' ? '머지 PR' : '머지 투 타깃',
      });
      if (!answer.ok || !active(serial) || busy) return;
    }
    busy = true; onBusy(true, id); message(); render();
    try {
      const result = await api('POST', `/api/tasks/${encodeURIComponent(id)}/${action}`, body);
      if (!active(serial)) return;
      task = result.task; onTask(task); onError(id, '');
      if (action === 'commit' || action === 'sync') {
        if (action === 'sync') $('task-finish-verification').value = '';
        await load();
      } else { dialog.close(); drafts.delete(id); }
    } catch (error) {
      const text = error.outcomeUnknown ? '완료 여부를 확인하지 못했습니다. 중복 실행을 막기 위해 작업 카드의 최신 확인으로 결과를 먼저 확인하세요.' : error.message;
      const reason = error.outcomeUnknown ? undefined : error.reason;
      const hint = error.outcomeUnknown ? '' : error.hint || '';
      onError(id, text, reason, { hint, raw: error.outcomeUnknown ? undefined : error.raw });
      if (error.outcomeUnknown) { uncertain = true; onUnknown(id, action); }
      if (active(serial)) message(text, reason, hint);
      // A local merge may have finished before publishing failed. Reflect that state.
      try {
        const value = await api('GET', `/api/tasks?path=${encodeURIComponent(project)}`);
        const current = value.tasks?.find(item => item.id === id);
        if (current && active(serial)) {
          task = current; onTask(current);
          if (['merged', 'cleaned'].includes(current.state)) dialog.close();
        }
      } catch {}
    } finally { busy = false; onBusy(false, id); if (dialog?.open && isCurrent(project)) render(); }
  }
  // close 이벤트가 늦게 도착해 이미 다시 연 검토 창의 요청을 무효화하지 않도록 한다.
  dialog?.addEventListener('close', () => { if (dialog.open) return; saveDraft(); generation++; loading = false; review = null; });
  $('task-finish-mode')?.addEventListener('change', () => { $('task-finish-verified').checked = false; render(); });
  $('task-finish-verified')?.addEventListener('change', render);
  $('task-finish-refresh')?.addEventListener('click', () => { message(); void load(); });
  return {
    submit,
    open(value, { merge = false } = {}) {
      if (busy) return;
      task = value; project = value.projectPath; merging = merge; uncertain = false; review = null;
      $('finish-task-form').reset();
      const draft = drafts.get(value.id);
      $('task-finish-message').value = draft?.message ?? `${value.type === 'hotfix' ? 'fix' : value.type === 'release' ? 'chore' : 'feat'}: ${value.title}`;
      $('task-finish-description').value = draft?.description ?? value.description ?? value.content ?? '';
      $('task-finish-verification').value = draft?.verification ?? value.verification ?? '';
      $('task-finish-mode').value = value.pull ? 'pr' : draft?.mode ?? value.finishMode ?? 'pr';
      $('task-finish-files').replaceChildren(); $('task-finish-commits').replaceChildren();
      message(); dialog?.showModal(); render(); void load();
    },
  };
}
