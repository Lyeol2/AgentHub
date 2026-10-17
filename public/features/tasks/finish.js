// One review dialog owns the next step: commit → integrate → verify → publish/merge.
export function createTaskFinisher({ api, isCurrent, onTask, onBusy, onError, onUnknown }) {
  const $ = id => document.getElementById(id);
  const dialog = $('finish-task-dialog');
  const drafts = new Map();
  let task, project, review, generation = 0, loading = false, busy = false, merging = false, uncertain = false;
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const active = (serial) => serial === generation && dialog?.open && task && isCurrent(project);
  const mode = () => $('task-finish-mode')?.value || 'pr';
  const selected = () => [...($('task-finish-files')?.querySelectorAll('input:checked') || [])].map(input => input.value);
  const behind = () => review?.task?.freshness?.behind || (mode() === 'local' && review?.localBehind);
  const blockedBase = () => task?.type !== 'hotfix' && review?.task?.freshness?.mainMissing;
  function message(text = '') { $('task-finish-error').textContent = text; $('task-finish-error').hidden = !text; }
  function saveDraft() {
    if (!task) return;
    drafts.set(task.id, { message: $('task-finish-message').value, description: $('task-finish-description').value,
      verification: $('task-finish-verification').value, mode: mode() });
  }
  function render() {
    if (!task) return;
    const dirty = Boolean(review?.files?.length), needsSync = Boolean(behind());
    $('task-finish-heading').textContent = merging ? 'PR 병합 검토' : '변경 검토 및 반영';
    $('task-finish-summary').textContent = `${task.title}\n${task.branch} → ${task.targetBranch}\n${task.cwd || ''}`;
    $('task-finish-mode').disabled = busy || merging || Boolean(task.pull);
    $('task-finish-commit-fields').hidden = !dirty;
    $('task-finish-message').required = dirty;
    $('task-finish-push-row').hidden = mode() !== 'local' || merging;
    $('task-finish-merge-method-row').hidden = !merging;
    $('task-finish-verify-row').hidden = dirty || needsSync || !review;
    $('task-finish-description').disabled = merging;
    $('task-finish-verification').disabled = merging;
    const steps = $('task-finish-steps');
    steps.replaceChildren();
    for (const [text, done] of [['변경 커밋', !!review && !dirty], ['기준 반영', !!review && !needsSync && !blockedBase()], [merging ? 'PR 병합' : mode() === 'local' ? '대상 브랜치 반영' : 'PR 만들기', false]]) {
      const step = el('span', `${done ? '✓ ' : ''}${text}`); step.dataset.done = String(done); steps.append(step);
    }
    const hint = loading ? '작업 폴더와 기준 브랜치를 확인하고 있습니다…' : !review ? '변경 목록을 확인한 뒤 진행할 수 있습니다.'
      : blockedBase() ? '배포 브랜치 변경을 개발 브랜치에 먼저 반영하세요. 현재 변경은 아래에서 커밋할 수 있습니다.'
      : dirty ? `${review.files.length}개 변경 중 선택한 파일만 커밋합니다. 나머지 변경이 남으면 반영을 진행하지 않습니다.`
      : needsSync ? '기준 브랜치의 새 변경을 먼저 반영합니다. 반영 후 검증 결과를 다시 확인하세요.'
      : merging ? `PR #${task.pull?.number}을 ${task.targetBranch}에 병합합니다. GitHub의 검사와 리뷰 조건을 확인합니다.`
      : mode() === 'local' ? `${task.targetBranch} 로컬 브랜치에 병합합니다. 작업 폴더 정리는 반영이 끝난 뒤 선택합니다.`
      : '현재 커밋을 게시하고 PR을 만듭니다. PR 생성 후에는 리뷰 대기 상태가 됩니다.';
    $('task-finish-hint').textContent = hint;
    const submit = $('task-finish-submit');
    submit.textContent = busy ? '처리 중…' : dirty ? '선택 파일 커밋' : needsSync ? '기준 변경 반영' : merging ? 'PR 병합' : mode() === 'local' ? '대상 브랜치에 반영' : task.pull ? 'PR 업데이트' : '게시하고 PR 만들기';
    submit.disabled = busy || loading || !review || uncertain || Boolean(task.pendingAction) || (blockedBase() && !dirty)
      || (dirty && !selected().length) || (!dirty && !needsSync && !$('task-finish-verified').checked);
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
    } catch (error) { if (active(serial)) message(error.message); }
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
    if (!task || !review || !isCurrent(project) || busy || loading || $('task-finish-submit').disabled) return;
    const dirty = review.files.length > 0, needsSync = behind();
    const action = dirty ? 'commit' : needsSync ? 'sync' : merging ? 'merge' : 'finish';
    const id = task.id, serial = generation;
    saveDraft();
    const body = { expectedHead: review.head, reviewToken: review.token, mode: mode(), message: $('task-finish-message').value.trim(),
      description: $('task-finish-description').value.trim(), verification: $('task-finish-verification').value.trim() };
    if (dirty) body.files = selected();
    if (action === 'finish') { body.expectedTargetHead = review.localTargetHead; body.push = mode() === 'local' && $('task-finish-push').checked; }
    if (action === 'merge') { body.expectedPullHead = task.pull?.headRefOid; body.method = $('task-finish-merge-method').value; }
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
      onError(id, text);
      if (error.outcomeUnknown) { uncertain = true; onUnknown(id, action); }
      if (active(serial)) message(text);
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
  dialog?.addEventListener('close', () => { saveDraft(); generation++; loading = false; review = null; });
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
