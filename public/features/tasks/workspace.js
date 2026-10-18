// 작업 탭의 작업 폴더 도구: 원본 폴더에서 작업 결과 확인, 재사용 대기 폴더, 유니티 Library 복사, 폴더·유니티 열기.
import { confirmAction } from '../../shared/confirm-dialog.js';

const ACTIONS = ['ws-preview', 'ws-preview-end', 'ws-open-folder', 'ws-open-unity'];
const COPY_POLL_MS = 1500;

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

const short = sha => typeof sha === 'string' ? sha.slice(0, 7) : '';

// 원본 폴더 확인 상태를 한 줄 제목과 주의 문구로 바꾼다.
export function describePreview(preview) {
  if (!preview) return null;
  const title = `원본 폴더에서 "${preview.title}" 작업 결과를 확인하는 중 · ${preview.branch} @ ${short(preview.head)}`;
  const back = preview.originalBranch ? `확인을 끝내면 ${preview.originalBranch} 브랜치로 돌아갑니다.` : `확인을 끝내면 확인 전 커밋(${short(preview.originalHead)})으로 돌아갑니다.`;
  const notes = [];
  if (preview.moved) notes.push({ warn: true, text: `원본 폴더가 ${preview.current?.branch ? `${preview.current.branch} 브랜치` : '다른 커밋'}로 바뀌었습니다. 확인 끝내기를 누르면 확인 상태만 지웁니다.` });
  else if (preview.dirty) notes.push({ warn: true, text: '확인하는 동안 원본 폴더에 변경이 생겼습니다. 커밋하거나 되돌려야 원래 브랜치로 돌아갈 수 있습니다.' });
  if (preview.outdated) notes.push({ warn: true, text: `작업에 새 커밋(${short(preview.taskHead)})이 있습니다. 최신 결과로 다시 보세요.` });
  if (preview.taskUncommitted) notes.push({ text: '작업 폴더에서 커밋하지 않은 변경은 원본 폴더에 보이지 않습니다. 필요하면 세션에 커밋을 요청하세요.' });
  if (preview.taskMissing) notes.push({ text: '작업 폴더가 없어 다시 보기는 할 수 없습니다.' });
  return { title, back, notes };
}

export function createTaskWorkspace({ api, node, getProjectPath, requestError = error => error?.message || String(error), onChange = () => {}, taskNote = () => {} }) {
  const $ = id => document.getElementById(id);
  const banner = $('tasks-preview');
  const dialog = $('task-workspace-dialog');
  let info = null, path = null, request = 0, busy = false, poll = null, error = null, actionError = null; // error: 읽기 실패, actionError: 상단 표시에서 누른 버튼의 실패

  const sameProject = value => value && value === getProjectPath();
  async function load(target = getProjectPath(), { library = false } = {}) {
    if (!target) { reset(); return null; }
    const id = ++request;
    if (target !== path) { info = null; path = target; }
    try {
      const result = await api('GET', `/api/tasks/workspace?path=${encodeURIComponent(target)}${library ? '&library=1' : ''}`);
      if (id !== request || !sameProject(target)) return info;
      info = result; error = null;
    } catch (failure) { if (id === request && sameProject(target)) error = requestError(failure); }
    render();
    schedulePoll();
    return info;
  }
  function reset() { request++; info = null; path = null; error = null; actionError = null; clearTimeout(poll); poll = null; render(); }
  // Library 복사가 진행 중인 동안만 진행률을 다시 읽는다.
  function schedulePoll() {
    clearTimeout(poll); poll = null;
    if (info?.copies && Object.keys(info.copies).length) poll = setTimeout(async () => {
      const before = Object.keys(info?.copies || {}).length;
      await load(path);
      if (Object.keys(info?.copies || {}).length !== before) onChange();
      else onChange({ cardsOnly: true });
    }, COPY_POLL_MS);
  }

  function render() {
    if (banner) {
      const view = describePreview(info?.preview);
      banner.hidden = !view;
      banner.replaceChildren();
      if (view) {
        banner.append(node('strong', 'tasks-preview-title', view.title), node('span', 'tasks-preview-back', view.back));
        for (const note of view.notes) { const line = node('p', 'tasks-preview-note', note.text); if (note.warn) line.dataset.warn = 'true'; banner.append(line); }
        const actions = node('div', 'task-actions');
        if (!info.preview.taskMissing) actions.append(button('최신 결과로 다시 보기', 'ws-preview', info.preview.taskId, { primary: !!info.preview.outdated }));
        actions.append(button('확인 끝내기', 'ws-preview-end', info.preview.taskId, { primary: !info.preview.outdated }));
        banner.append(actions);
      }
      const shown = actionError || error;
      if (shown && !banner.hidden) banner.append(node('p', 'error', shown));
    }
    if (dialog?.open) renderDialog();
  }
  function button(label, action, taskId, { primary = false } = {}) {
    const item = node('button', primary ? 'primary sm' : 'ghost sm', label);
    item.type = 'button';
    item.dataset.taskAction = action;
    if (taskId) item.dataset.taskId = taskId;
    item.disabled = busy;
    return item;
  }

  const previewing = task => info?.preview?.taskId === task.id;
  const unityReady = () => !!info?.unity?.editor;
  const reuseOn = () => !!info?.settings?.reuse;
  // 카드에 원본 확인 중 표시, Library 복사 상태, 재사용 폴더로 만든 작업임을 붙인다.
  function decorate(card, task) {
    if (previewing(task)) {
      const badge = node('p', 'task-preview-badge', info.preview.outdated ? '원본 폴더에서 확인 중 · 새 커밋 있음' : '원본 폴더에서 확인 중');
      card.append(badge);
    }
    const copy = info?.copies?.[task.id];
    if (copy) {
      const done = copy.total ? ` ${formatBytes(copy.copied)} / ${formatBytes(copy.total)}` : '';
      const line = node('p', 'task-note task-library-copy', copy.state === 'sizing' ? 'Library 크기 확인 중…' : `원본 Library 복사 중${done}`);
      if (copy.total) { const bar = node('progress', ''); bar.max = copy.total; bar.value = Math.min(copy.copied, copy.total); line.append(bar); }
      card.append(line);
    } else if (task.state !== 'cleaned' && task.libraryCopy && ['failed', 'skipped'].includes(task.libraryCopy.state)) {
      card.append(node('p', 'task-note', task.libraryCopy.error || 'Library를 복사하지 못했습니다. 유니티가 열 때 다시 임포트합니다.'));
    }
    if (task.state !== 'cleaned' && task.reusedWorktree) card.append(node('p', 'task-note', '재사용 대기 폴더로 준비한 작업 폴더입니다. 무시 파일(Library 등)이 남아 있어 유니티가 빨리 열립니다.'));
  }
  // ⋯ 메뉴에 넣을 버튼
  function menu(task, actionButton) {
    if (task.state === 'cleaned') return [];
    const items = [actionButton('작업 폴더 열기', 'ws-open-folder', task)];
    if (info?.unity && unityReady()) items.push(actionButton('유니티로 열기', 'ws-open-unity', task));
    if (!task.inPlace) items.push(actionButton(previewing(task) ? '최신 결과로 다시 보기' : '원본에서 확인', 'ws-preview', task));
    if (previewing(task)) items.push(actionButton('확인 끝내기', 'ws-preview-end', task));
    return items;
  }

  const handles = action => ACTIONS.includes(action);
  // setNote: 확인 끝내기가 남긴 안내(상단 표시가 사라지므로 작업 카드에 보여 준다)
  async function run(action, task, { setError = value => { actionError = [value.message, value.hint].filter(Boolean).join('\n'); }, setNote = value => taskNote(task.id, value), setPending } = {}) {
    if (busy) return;
    actionError = null;
    const target = getProjectPath();
    if (action === 'ws-preview' && !previewing(task)) {
      const source = info?.source || target;
      const answer = await confirmAction({ title: '원본 폴더에서 결과 확인', subject: task.title,
        changes: [`원본 폴더(${source})를 이 작업의 마지막 커밋으로 바꿉니다. 브랜치 없이(detached) 꺼내므로 열려 있는 유니티·편집기에서 바로 볼 수 있습니다.`,
          info?.preview ? `지금 확인 중인 "${info.preview.title}" 대신 이 작업을 봅니다.` : ''].filter(Boolean),
        keeps: ['작업 폴더와 작업 브랜치', info?.preview?.originalBranch ? `확인 끝내기로 ${info.preview.originalBranch} 브랜치로 돌아갑니다.` : '확인 끝내기로 지금 브랜치로 돌아갑니다.'],
        warnings: ['작업 폴더에서 커밋하지 않은 변경은 보이지 않습니다. 필요하면 세션에 커밋을 요청하세요.', '원본 폴더에 커밋하지 않은 변경이 있으면 시작하지 않습니다.'],
        confirmLabel: '원본에서 확인' });
      if (!answer.ok || !sameProject(target)) return;
    }
    busy = true; setPending?.(true); render();
    try {
      if (action === 'ws-preview') await api('POST', `/api/tasks/${encodeURIComponent(task.id)}/preview`, {});
      else if (action === 'ws-preview-end') {
        const result = await api('POST', `/api/tasks/preview/end?path=${encodeURIComponent(target)}`, {});
        if (result?.note) setNote?.({ message: result.note });
      }
      else await api('POST', `/api/tasks/${encodeURIComponent(task.id)}/open`, { target: action === 'ws-open-unity' ? 'unity' : 'folder' });
    } catch (failure) {
      setError?.({ message: requestError(failure), reason: failure.reason, hint: failure.hint });
    } finally {
      busy = false; setPending?.(false);
      if (sameProject(target) && action.startsWith('ws-preview')) await load(target);
      else render();
      onChange();
    }
  }

  // ── 새 작업 창: 유니티 프로젝트에 새 워크트리를 만들 때 Library 복사 선택 ──
  async function prepareCreate(target) {
    const result = await load(target, { library: true });
    if (sameProject(target)) updateCreate();
    return result;
  }
  let createState = { existing: false, inPlace: true };
  function updateCreate(state = createState) {
    createState = state;
    const row = $('task-library-row'), label = $('task-library-label'), hint = $('task-library-hint');
    if (!row) return;
    const worktree = !state.existing && !state.inPlace;
    const reusable = reuseOn() && (info?.pool || []).some(folder => folder.clean);
    row.hidden = !worktree || !info?.unity || reusable || !info?.library?.exists;
    const size = info?.library?.bytes;
    if (label) label.textContent = `원본의 Library 폴더 복사${Number.isFinite(size) ? ` (약 ${formatBytes(size)})` : ''} · 백그라운드로 복사해 유니티 첫 임포트를 줄입니다`;
    if (hint) {
      hint.hidden = !worktree || !reusable;
      hint.textContent = reusable ? '재사용 대기 폴더를 새 작업 폴더로 씁니다. 그 폴더의 Library가 남아 있어 유니티가 빨리 열립니다.' : '';
    }
    const box = $('task-copy-library');
    if (box && !row.dataset.touched) box.checked = info?.settings?.copyLibrary !== false;
  }
  function createPayload(payload) {
    const row = $('task-library-row');
    return payload.worktree === false || payload.workBranch || !row || row.hidden ? {} : { copyLibrary: !!$('task-copy-library')?.checked };
  }

  // ── 작업 폴더 설정 창 ──
  function renderDialog() {
    const list = $('task-workspace-pool');
    if ($('task-workspace-reuse')) $('task-workspace-reuse').checked = reuseOn();
    if ($('task-workspace-copy')) $('task-workspace-copy').checked = info?.settings?.copyLibrary !== false;
    if ($('task-workspace-copy-row')) $('task-workspace-copy-row').hidden = !info?.unity;
    if ($('task-workspace-unity')) $('task-workspace-unity').textContent = info?.unity
      ? `유니티 프로젝트 ${info.unity.version || ''} · ${info.unity.editor ? '에디터를 찾았습니다' : '에디터를 찾지 못해 "유니티로 열기"를 숨깁니다'}`
      : '유니티 프로젝트가 아닙니다. 재사용은 기본으로 꺼져 있습니다.';
    if (!list) return;
    const folders = info?.pool || [];
    list.replaceChildren(...(folders.length ? folders.map(folder => {
      const item = node('li', 'task-workspace-folder');
      item.append(node('span', 'task-folder-path', folder.dir),
        node('span', 'task-folder-flag', !folder.registered ? 'Git 등록 없음' : folder.clean ? `대기 중 · ${short(folder.head)}` : '변경 있음 · 재사용 안 함'));
      const remove = node('button', 'ghost sm danger', '삭제');
      remove.type = 'button';
      remove.dataset.reuseName = folder.name;
      remove.disabled = busy;
      item.append(remove);
      return item;
    }) : [node('li', 'hint', '재사용 대기 폴더가 없습니다.')]));
  }
  async function openDialog() {
    if (!dialog) return;
    $('task-workspace-error').textContent = '';
    dialog.showModal();
    renderDialog();
    await load(getProjectPath());
  }
  async function saveSetting(key, value) {
    const target = getProjectPath();
    try { await api('PUT', `/api/tasks/workspace?path=${encodeURIComponent(target)}`, { [key]: value }); }
    catch (failure) { $('task-workspace-error').textContent = requestError(failure); }
    await load(target);
  }
  async function removeFolder(name) {
    const target = getProjectPath();
    const answer = await confirmAction({ title: '재사용 대기 폴더 삭제', subject: name, changes: ['폴더와 그 안의 무시 파일(Library 등)을 지웁니다.'], confirmLabel: '삭제', danger: true });
    if (!answer.ok) return;
    busy = true; renderDialog();
    try { await api('DELETE', `/api/tasks/workspace/reuse/${encodeURIComponent(name)}?path=${encodeURIComponent(target)}`); }
    catch (failure) { $('task-workspace-error').textContent = requestError(failure); }
    finally { busy = false; await load(target); }
  }
  // 상단 확인 중 표시의 버튼. 오류는 그 자리에 보여 준다.
  banner?.addEventListener('click', event => {
    const item = event.target.closest('[data-task-action]');
    if (!item || item.disabled || !info?.preview) return;
    void run(item.dataset.taskAction, { id: info.preview.taskId, title: info.preview.title });
  });
  $('tasks-workspace')?.addEventListener('click', () => { void openDialog(); });
  $('task-workspace-reuse')?.addEventListener('change', event => { void saveSetting('reuse', event.target.checked); });
  $('task-workspace-copy')?.addEventListener('change', event => { void saveSetting('copyLibrary', event.target.checked); });
  $('task-workspace-close')?.addEventListener('click', () => dialog?.close());
  $('task-workspace-pool')?.addEventListener('click', event => { const name = event.target.closest('[data-reuse-name]')?.dataset.reuseName; if (name && !busy) void removeFolder(name); });
  $('task-copy-library')?.addEventListener('change', () => { if ($('task-library-row')) $('task-library-row').dataset.touched = '1'; });

  return { load, reset, render, decorate, menu, handles, run, reuseOn, prepareCreate, updateCreate, createPayload,
    resetCreate() { if ($('task-library-row')) delete $('task-library-row').dataset.touched; } };
}
