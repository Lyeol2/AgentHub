// settings: 프로젝트의 GitFlow 설정. 없으면 기본 접두어(hotfix/, release/)로 판단한다.
export function workBranchType(name = '', settings = {}) {
  if (name.startsWith(settings.hotfixPrefix || 'hotfix/')) return 'hotfix';
  if (name.startsWith(settings.releasePrefix || 'release/')) return 'release';
  return 'feature';
}

export function selectableWorkBranch(branch, owner) {
  if (!branch?.name || branch.original || branch.locked || branch.missing || ['main', 'develop'].includes(branch.name)) return false;
  const scoped = owner === 'task' ? branch.selectableForTask : branch.selectableForSession;
  return typeof scoped === 'boolean' ? scoped : branch.selectable !== false;
}

function unavailableReason(branch, owner) {
  if (branch.reason) return branch.reason;
  if (branch.original) return '원본 폴더에서 사용 중';
  if (branch.locked) return '잠긴 작업 폴더';
  if (branch.missing) return '작업 폴더를 찾을 수 없음';
  if (['main', 'develop'].includes(branch.name)) return '공통 기준 브랜치';
  if (owner === 'task' && branch.taskId) return '이미 작업에 연결됨';
  return '선택할 수 없음';
}

// Both creation dialogs use the same local-branch picker. A cancelled or changed
// dialog invalidates the request, while the server still validates every choice.
export function createWorkbranchPicker({ api, select, status, refresh, owner, getPath, isActive, onChange = () => {} }) {
  let request = 0;
  let path = null;
  let branches = [];
  let loaded = false;
  let loading = false;
  let error = '';

  function selected() {
    if (!loaded || loading || error || path !== getPath()) return null;
    return branches.find(branch => branch.name === select.value && selectableWorkBranch(branch, owner)) || null;
  }

  function validationError() {
    if (loading) return '작업 브랜치 목록을 불러오는 중입니다.';
    if (error) return error;
    if (!loaded || path !== getPath()) return '작업 브랜치 목록을 먼저 확인해 주세요.';
    if (!selected()) return '기존 작업 브랜치를 선택해 주세요.';
    return '';
  }

  function updateStatus() {
    const branch = selected();
    const available = branches.some(item => selectableWorkBranch(item, owner));
    if (status) {
      status.textContent = loading ? '작업 브랜치를 불러오고 있습니다…'
        : error ? error
        : branch ? branch.cwd ? `작업 폴더: ${branch.cwd}` : '선택한 브랜치에 전용 작업 폴더를 연결합니다.'
        : loaded && !available ? '선택할 수 있는 기존 작업 브랜치가 없습니다. 새 작업 브랜치를 만들어 주세요.'
        : loaded ? '기존 작업 브랜치를 선택해 주세요.' : '';
      status.dataset.state = error ? 'error' : 'idle';
    }
    if (refresh) refresh.disabled = loading;
    select.disabled = loading || !loaded || Boolean(error);
    select.setCustomValidity(validationError());
    onChange(branch);
  }

  function render(preferred = '') {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = loading ? '불러오는 중…' : '작업 브랜치 선택';
    select.replaceChildren(placeholder, ...branches.map(branch => {
      const option = document.createElement('option');
      option.value = branch.name;
      const allowed = selectableWorkBranch(branch, owner);
      option.disabled = !allowed;
      option.textContent = `${branch.name}${allowed ? branch.taskId ? ' · 연결된 작업' : '' : ` · ${unavailableReason(branch, owner)}`}`;
      return option;
    }));
    select.value = branches.some(branch => branch.name === preferred && selectableWorkBranch(branch, owner)) ? preferred : '';
    updateStatus();
  }

  function reset() {
    request++;
    path = null;
    branches = [];
    loaded = false;
    loading = false;
    error = '';
    render();
    select.setCustomValidity('');
  }

  async function load() {
    const projectPath = getPath();
    if (!projectPath || !isActive()) return;
    const token = ++request;
    const preferred = path === projectPath ? select.value : '';
    path = projectPath;
    loaded = false;
    loading = true;
    error = '';
    branches = [];
    render();
    try {
      const result = await api('GET', `/api/workbranches?path=${encodeURIComponent(projectPath)}`);
      if (token !== request || projectPath !== getPath() || !isActive()) return;
      branches = Array.isArray(result?.branches) ? result.branches : [];
      loaded = true;
    } catch (failure) {
      if (token !== request || projectPath !== getPath() || !isActive()) return;
      error = failure?.message || '작업 브랜치를 불러오지 못했습니다. 목록 새로고침을 눌러 주세요.';
    } finally {
      if (token === request && projectPath === getPath() && isActive()) {
        loading = false;
        render(preferred);
      }
    }
  }

  select.addEventListener('change', updateStatus);
  refresh?.addEventListener('click', () => { void load(); });
  return { load, reset, selected, validationError, ready: () => Boolean(selected()) };
}

const folderName = cwd => String(cwd || '').replace(/[\/]+$/, '').split(/[\/]/).pop() || cwd;

// 새 작업이 이어받을 기존 워크트리를 고른다. 고른 폴더는 새 작업 브랜치로 바뀌며, 서버가 다시 확인한다.
export function createWorktreePicker({ api, select, status, refresh, getPath, isActive, onChange = () => {} }) {
  let request = 0;
  let path = null;
  let worktrees = [];
  let loaded = false;
  let loading = false;
  let error = '';

  function selected() {
    if (!loaded || loading || error || path !== getPath()) return null;
    return worktrees.find(item => item.cwd === select.value && item.selectableForTask) || null;
  }

  function validationError() {
    if (loading) return '워크트리 목록을 불러오는 중입니다.';
    if (error) return error;
    if (!loaded || path !== getPath()) return '워크트리 목록을 먼저 확인해 주세요.';
    if (!selected()) return '작업할 워크트리를 선택해 주세요.';
    return '';
  }

  function updateStatus() {
    const item = selected();
    const available = worktrees.some(entry => entry.selectableForTask);
    if (status) {
      status.textContent = loading ? '워크트리를 불러오고 있습니다…'
        : error ? error
        : item ? `${item.cwd}${item.branch ? ` · 지금 브랜치 ${item.branch}` : ''}${item.taskTitle ? ` · 병합한 작업 "${item.taskTitle}"의 폴더를 이어받습니다` : ''}`
        : loaded && !available ? '고를 수 있는 워크트리가 없습니다. 워크트리 만들기를 선택해 주세요.'
        : loaded ? '작업할 워크트리를 선택해 주세요.' : '';
      status.dataset.state = error ? 'error' : 'idle';
    }
    if (refresh) refresh.disabled = loading;
    select.disabled = loading || !loaded || Boolean(error);
    select.setCustomValidity(isActive() ? validationError() : '');
    onChange(item);
  }

  function render(preferred = '') {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = loading ? '불러오는 중…' : '워크트리 선택';
    select.replaceChildren(placeholder, ...worktrees.map(item => {
      const option = document.createElement('option');
      option.value = item.cwd;
      option.disabled = !item.selectableForTask;
      option.textContent = `${folderName(item.cwd)} · ${item.branch || '브랜치 없음'}${item.selectableForTask ? '' : ` · ${item.reason || '선택할 수 없음'}`}`;
      option.title = item.cwd;
      return option;
    }));
    select.value = worktrees.some(item => item.cwd === preferred && item.selectableForTask) ? preferred : '';
    updateStatus();
  }

  function reset() {
    request++;
    path = null;
    worktrees = [];
    loaded = false;
    loading = false;
    error = '';
    render();
    select.setCustomValidity('');
  }

  async function load() {
    const projectPath = getPath();
    if (!projectPath || !isActive()) return;
    const token = ++request;
    const preferred = path === projectPath ? select.value : '';
    path = projectPath;
    loaded = false;
    loading = true;
    error = '';
    worktrees = [];
    render();
    try {
      const result = await api('GET', `/api/workbranches?path=${encodeURIComponent(projectPath)}`);
      if (token !== request || projectPath !== getPath() || !isActive()) return;
      worktrees = Array.isArray(result?.worktrees) ? result.worktrees : [];
      loaded = true;
    } catch (failure) {
      if (token !== request || projectPath !== getPath() || !isActive()) return;
      error = failure?.message || '워크트리를 불러오지 못했습니다. 목록 새로고침을 눌러 주세요.';
    } finally {
      if (token === request && projectPath === getPath() && isActive()) {
        loading = false;
        render(preferred);
      }
    }
  }

  select.addEventListener('change', updateStatus);
  refresh?.addEventListener('click', () => { void load(); });
  return { load, reset, selected, validationError, ready: () => Boolean(selected()) };
}
