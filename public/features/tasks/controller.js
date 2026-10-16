import { permissionLabel } from '../../shared/permissions.js';
import { createWorkbranchPicker, workBranchType } from '../../shared/workbranches.js';

const TASK_STATES = { working: '작업 중', review: '리뷰 대기', merged: '병합 완료', cleaned: '정리 완료' };
const TASK_TYPES = { feature: '기능 개발·일반 수정', hotfix: '긴급 수정', release: '배포 준비' };
const DEFAULT_GITFLOW = { main: 'main', develop: 'develop', featurePrefix: 'feature/', hotfixPrefix: 'hotfix/', releasePrefix: 'release/' };
const GITFLOW_FIELDS = Object.keys(DEFAULT_GITFLOW);

function gitflowSettings(value) {
  return Object.fromEntries(GITFLOW_FIELDS.map(key => [key, typeof value?.[key] === 'string' ? value[key] : DEFAULT_GITFLOW[key]]));
}

export function describeTaskFreshness(freshness) {
  if (!freshness) return '최신 상태 확인 전';
  if (freshness.state === 'current' || freshness.state === 'up-to-date') return '최신 상태';
  if (['needs-update', 'stale', 'behind'].includes(freshness.state)) return '최신 변경 반영 필요';
  if (freshness.state === 'error' || freshness.state === 'failed') return '최신 상태 확인 실패';
  if (freshness.state === 'diverged') return '브랜치 변경 확인 필요';
  return '최신 상태 확인 필요';
}

export function taskBranchPreview(type, version = '', settings = DEFAULT_GITFLOW, name = '') {
  const flow = gitflowSettings(settings);
  const base = type === 'hotfix' ? flow.main : flow.develop;
  const target = type === 'feature' ? flow.develop : flow.main;
  const prefix = flow[`${type}Prefix`] ?? `${type}/`;
  const branch = `${prefix}${name || (type === 'release' ? version || '<버전>' : '<작업ID>-<이름>')}`;
  return `${base}에서 ${branch} 생성 → ${target}으로 PR`;
}

export function createTasksController({
  api, data, navigation, getProjectPath = () => navigation?.project,
  fillModels = () => {}, fillEfforts = () => {}, selectSession = () => {},
  reloadData = async () => {},
}) {
  const $ = id => document.getElementById(id);
  const list = $('tasks-list');
  const createDialog = $('new-task-dialog');
  const createForm = $('new-task-form');
  const finishDialog = $('finish-task-dialog');
  const finishForm = $('finish-task-form');
  const settingsDialog = $('task-settings-dialog');
  const settingsForm = $('task-settings-form');
  const taskErrors = new Map();
  const uncertainTasks = new Map();
  const uncertainCreates = new Set();
  const pendingTasks = new Set();
  let tasks = [];
  let projectPath = null;
  let context = null;
  let generation = 0;
  let projectEpoch = 0;
  let loading = false;
  let createBusy = false;
  let finishBusy = false;
  let createProject = null;
  let finishProject = null;
  let finishTaskId = null;
  let settings = gitflowSettings();
  let settingsProject = null;
  let settingsGeneration = 0;
  let settingsBusy = false;
  let settingsLoading = false;
  let settingsReadFailed = false;
  const workbranchPicker = createWorkbranchPicker({
    api, owner: 'task', select: $('task-workbranch'), status: $('task-workbranch-status'), refresh: $('task-workbranch-refresh'),
    getPath: () => createProject,
    isActive: () => Boolean(createDialog?.open && sameProject(createProject) && $('task-workbranch-mode')?.value === 'existing'),
    onChange: branch => {
      if (branch && $('task-type')) $('task-type').value = workBranchType(branch.name, settings);
      updateCreatePreview();
      updateCreateSubmit();
    },
  });

  function node(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value !== undefined) el.textContent = value;
    return el;
  }

  function showError(id, message = '') {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  function sameProject(path, epoch = projectEpoch) {
    return Boolean(epoch === projectEpoch && path && path === projectPath && path === getProjectPath());
  }

  function isTasksVisible() {
    const panel = $('tab-tasks');
    return Boolean(panel && !panel.hidden && panel.getClientRects().length);
  }

  function requestError(error) {
    return error?.message || '요청을 처리하지 못했습니다. 잠시 후 다시 확인해 주세요.';
  }

  function unknownMessage(action) {
    return `${action} 결과를 아직 확인할 수 없습니다. 중복 실행을 막기 위해 먼저 최신 확인을 눌러 결과를 확인해 주세요.`;
  }

  function timestamp(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function updateToolbar() {
    if ($('tasks-new')) $('tasks-new').disabled = !projectPath || loading || createBusy || settingsBusy || uncertainCreates.has(projectPath);
    if ($('tasks-refresh')) $('tasks-refresh').disabled = !projectPath || loading;
    if ($('tasks-refresh')) $('tasks-refresh').textContent = loading ? '확인 중…' : '최신 확인';
    for (const id of ['tasks-settings', 'task-create-settings']) {
      if ($(id)) $(id).disabled = !projectPath || loading || createBusy || settingsBusy || settingsLoading;
    }
    updateCreateSubmit();
  }

  function renderContext() {
    const el = $('tasks-context');
    if (!el) return;
    el.replaceChildren();
    el.dataset.state = 'unknown';
    if (!context) {
      el.append(node('span', '', loading ? `${settings.main}과 ${settings.develop} 기준을 확인하고 있습니다…` : `${settings.main}과 ${settings.develop} 기준 확인 전`));
      return;
    }
    const freshness = context.freshness || {};
    const failed = context.error || context.state === 'error' || ['error', 'failed'].includes(freshness.state);
    const mainMissing = context.mainInDevelop === false;
    el.dataset.state = failed ? 'error' : mainMissing ? 'stale' : freshness.state || 'current';
    el.append(node('strong', '', failed ? `${settings.main} 최신 확인 실패` : mainMissing ? `${settings.main} 변경을 ${settings.develop}에 반영해야 합니다` : `${settings.main} 최신 확인 완료`));
    if (failed) el.append(node('span', '', typeof context.error === 'string' ? context.error : context.error?.message || freshness.error || '원격 저장소 연결을 확인해 주세요.'));
    else if (context.needsSetup || context.needsDevelop || context.developExists === false) {
      el.append(node('span', '', `첫 기능 작업을 만들 때 최신 ${settings.main}을 기준으로 ${settings.develop}을 준비합니다.`));
    } else if (!mainMissing) {
      el.append(node('span', '', 'GitFlow 기준으로 작업을 시작할 수 있습니다.'));
    }
    const checked = timestamp(context.checkedAt || freshness.checkedAt);
    if (checked) el.append(node('span', '', `${checked} 확인`));
    if (Array.isArray(context.warnings)) for (const warning of context.warnings) {
      if (typeof warning === 'string' && warning) el.append(node('span', '', warning));
    }
  }

  function actionButton(label, action, task, { primary = false, disabled = false } = {}) {
    const button = node('button', primary ? 'primary sm' : 'ghost sm', label);
    button.type = 'button';
    button.dataset.taskAction = action;
    button.dataset.taskId = task.id;
    button.disabled = disabled || pendingTasks.has(task.id);
    return button;
  }

  function renderTasks() {
    if (!list) return;
    list.replaceChildren();
    list.setAttribute('aria-busy', String(loading));
    if (!tasks.length) {
      const empty = node('div', 'tasks-empty');
      empty.append(node('strong', '', loading ? '작업을 불러오고 있습니다…' : '아직 작업이 없습니다'));
      if (!loading) empty.append(node('span', '', '새 작업을 만들면 브랜치와 작업 폴더가 자동으로 준비됩니다.'));
      list.append(empty);
      return;
    }
    for (const task of tasks) {
      const flow = gitflowSettings({ ...task.gitflow, main: task.gitflow?.main ?? task.freshness?.main?.branch ?? DEFAULT_GITFLOW.main, develop: task.gitflow?.develop ?? task.freshness?.develop?.branch ?? DEFAULT_GITFLOW.develop });
      const card = node('article', 'task-card');
      card.dataset.taskId = task.id;
      card.setAttribute('aria-label', task.title || '작업');
      card.setAttribute('aria-busy', String(pendingTasks.has(task.id)));
      const header = node('div', 'task-card-header');
      const state = node('span', 'task-state', TASK_STATES[task.state] || '상태 확인 필요');
      state.dataset.state = task.state;
      header.append(node('h3', 'task-title', task.title), state);
      card.append(header);
      const meta = node('div', 'task-meta');
      meta.append(node('span', '', TASK_TYPES[task.type] || task.type || '작업'));
      meta.append(node('span', 'task-branch', `${task.branch || '브랜치 준비 중'} → ${task.targetBranch || (task.type === 'feature' ? flow.develop : flow.main)}`));
      card.append(meta);
      if (task.state !== 'cleaned') {
        const freshness = node('div', 'task-freshness', describeTaskFreshness(task.freshness));
        freshness.dataset.state = task.freshness?.state || 'unknown';
        const checked = timestamp(task.freshness?.checkedAt);
        if (checked) freshness.append(node('span', '', ` · ${checked} 확인`));
        card.append(freshness);
      }
      const actions = node('div', 'task-actions');
      const ids = Array.isArray(task.sessionIds) ? task.sessionIds : [];
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      const connected = sessions.filter(session => ids.includes(session.id) || session.taskId === task.id);
      const sessionId = (connected.find(session => session.id === ids.at(-1)) || connected[0])?.id || (!Array.isArray(data?.sessions) ? ids.at(-1) : null);
      if (sessionId) {
        const open = actionButton(task.state === 'cleaned' || task.state === 'merged' ? '대화 기록' : '세션 열기', 'open-session', task);
        open.dataset.sessionId = sessionId;
        actions.append(open);
      }
      if (task.state === 'working' || task.state === 'review') {
        actions.append(actionButton(connected.length ? '세션 추가' : '새 세션', 'new-session', task, { disabled: uncertainTasks.has(task.id) || Boolean(task.pendingAction) }));
        actions.append(actionButton(task.state === 'review' ? 'PR 업데이트' : '작업 마무리', 'finish', task, { primary: true, disabled: uncertainTasks.has(task.id) || Boolean(task.pendingAction) }));
      }
      if (task.pull?.url) {
        try {
          const url = new URL(task.pull.url);
          if (url.protocol === 'https:' || url.protocol === 'http:') {
            const link = node('a', 'task-pull-link', `PR #${task.pull.number || ''}${task.pull.state === 'CLOSED' || task.pull.state === 'closed' ? ' · 닫힘' : ''}`);
            link.href = url.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            actions.append(link);
          }
        } catch { /* Invalid server-provided links are not rendered. */ }
      }
      if (task.state !== 'cleaned') actions.append(actionButton('최신 확인', 'refresh', task));
      if ((task.state === 'working' || task.state === 'review') && ['needs-update', 'behind', 'stale', 'diverged'].includes(task.freshness?.state)) {
        actions.append(actionButton('기준 변경 반영', 'sync', task, { disabled: uncertainTasks.has(task.id) || Boolean(task.pendingAction) }));
      }
      if (task.state === 'merged') actions.append(actionButton('작업 폴더 정리', 'cleanup', task, { disabled: uncertainTasks.has(task.id) || Boolean(task.pendingAction) }));
      const remove = actionButton('작업 삭제', 'delete', task);
      remove.classList.add('danger');
      actions.append(remove);
      card.append(actions);
      if (task.state === 'merged' && task.type !== 'feature') card.append(node('p', 'task-note', `${flow.develop}에도 반영되어야 작업 폴더를 정리할 수 있습니다.`));
      if (task.state === 'cleaned') card.append(node('p', 'task-note', task.inPlace
        ? `원본 폴더를 ${task.previousBranch || task.targetBranch} 브랜치로 되돌렸습니다. 작업과 PR 기록은 보관됩니다.`
        : task.worktreePreserved
        ? '작업 기록을 정리했습니다. 선택했던 기존 작업 폴더와 브랜치는 보존됩니다.'
        : task.localBranchRemoved === false
          ? '작업 폴더를 정리했습니다. 로컬 브랜치와 작업·PR 기록은 보관됩니다.'
          : '작업 폴더와 로컬 브랜치를 정리했습니다. 작업과 PR 기록은 보관됩니다.'));
      if (task.cleanupWarning) card.append(node('p', 'task-note', typeof task.cleanupWarning === 'string' ? task.cleanupWarning : task.cleanupWarning.message || '정리 결과를 확인해 주세요.'));
      const error = taskErrors.get(task.id) || task.error?.message || (typeof task.error === 'string' ? task.error : '') || (task.pendingAction ? '이전 요청의 결과를 확인하고 있습니다. 최신 확인으로 작업 상태를 확인해 주세요.' : '');
      if (error) {
        const errorEl = node('p', 'task-inline-error', error);
        errorEl.setAttribute('role', 'alert');
        card.append(errorEl);
      }
      list.append(card);
    }
  }

  function invalidateProject() {
    generation++;
    projectEpoch++;
    projectPath = null;
    tasks = [];
    context = null;
    resetSettings();
    loading = false;
    if (createDialog?.open) createDialog.close();
    if (finishDialog?.open) finishDialog.close();
    updateToolbar();
  }

  async function loadTasks(path = getProjectPath(), options = {}) {
    if (!path) { invalidateProject(); return; }
    const changed = path !== projectPath;
    const request = ++generation;
    projectPath = path;
    if (changed) {
      projectEpoch++;
      tasks = [];
      context = null;
      resetSettings();
      if (createDialog?.open) createDialog.close();
      if (finishDialog?.open) finishDialog.close();
    }
    loading = true;
    showError('tasks-error');
    updateToolbar();
    renderTasks();
    renderContext();
    const requests = [api('GET', `/api/tasks?path=${encodeURIComponent(path)}`)];
    if (!options.localOnly) requests.push(api('GET', `/api/tasks/context?path=${encodeURIComponent(path)}`));
    const results = await Promise.allSettled(requests);
    if (request !== generation || !sameProject(path)) return;
    const [taskResult, contextResult] = results;
    if (taskResult.status === 'fulfilled') {
      tasks = Array.isArray(taskResult.value?.tasks) ? taskResult.value.tasks : [];
      if (options.manual && uncertainCreates.has(path)) {
        uncertainCreates.delete(path);
        showError('tasks-error', '작업 목록을 확인했습니다. 이미 생성된 작업이 없는지 확인한 뒤 새 작업을 만들어 주세요.');
      }
    } else showError('tasks-error', requestError(taskResult.reason));
    if (contextResult?.status === 'fulfilled') {
      context = contextResult.value?.context || contextResult.value;
      settings = gitflowSettings(contextResult.value?.settings || context?.settings);
    }
    else if (contextResult) context = { error: requestError(contextResult.reason), freshness: { state: 'error' } };
    loading = false;
    updateToolbar();
    renderTasks();
    renderContext();
    updateCreatePreview();
  }

  function resetSettings() {
    settingsGeneration++;
    settings = gitflowSettings();
    settingsProject = null;
    settingsBusy = false;
    settingsLoading = false;
    settingsReadFailed = false;
    if (settingsDialog?.open) settingsDialog.close();
  }

  function updateSettingsControls() {
    for (const key of GITFLOW_FIELDS) if ($(`task-settings-${key}`)) $(`task-settings-${key}`).disabled = settingsBusy || settingsLoading || settingsReadFailed;
    if ($('task-settings-save')) {
      $('task-settings-save').disabled = settingsBusy || settingsLoading || settingsReadFailed;
      $('task-settings-save').textContent = settingsBusy ? '저장 중…' : '저장';
    }
    if ($('task-settings-cancel')) $('task-settings-cancel').disabled = settingsBusy;
    if ($('task-settings-status')) $('task-settings-status').textContent = settingsLoading ? '프로젝트 설정을 불러오고 있습니다…' : '';
    updateToolbar();
  }

  function fillSettingsForm() {
    for (const key of GITFLOW_FIELDS) if ($(`task-settings-${key}`)) $(`task-settings-${key}`).value = settings[key];
  }

  async function openSettings() {
    const path = getProjectPath();
    if (!sameProject(path) || loading || createBusy || settingsBusy || settingsLoading) return;
    const epoch = projectEpoch;
    const request = ++settingsGeneration;
    settingsProject = path;
    settingsLoading = true;
    settingsReadFailed = false;
    showError('task-settings-error');
    fillSettingsForm();
    updateSettingsControls();
    settingsDialog?.showModal();
    try {
      const result = await api('GET', `/api/tasks/settings?path=${encodeURIComponent(path)}`);
      if (request !== settingsGeneration || !sameProject(path, epoch) || !settingsDialog?.open) return;
      settings = gitflowSettings(result.settings);
      fillSettingsForm();
      renderContext();
      updateCreatePreview();
    } catch (error) {
      if (request === settingsGeneration && sameProject(path, epoch)) {
        settingsReadFailed = true;
        showError('task-settings-error', requestError(error));
      }
    } finally {
      if (request === settingsGeneration && sameProject(path, epoch)) {
        settingsLoading = false;
        updateSettingsControls();
        if (!settingsReadFailed) $('task-settings-main')?.focus();
      }
    }
  }

  function closeSettings() {
    if (settingsBusy) return;
    settingsGeneration++;
    settingsLoading = false;
    settingsDialog?.close();
    updateToolbar();
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (settingsBusy || settingsLoading || settingsReadFailed || !sameProject(settingsProject)) return;
    if (settingsForm && !settingsForm.reportValidity()) return;
    const path = settingsProject;
    const epoch = projectEpoch;
    const request = ++settingsGeneration;
    const value = Object.fromEntries(GITFLOW_FIELDS.map(key => [key, $(`task-settings-${key}`)?.value.trim() ?? '']));
    settingsBusy = true;
    showError('task-settings-error');
    updateSettingsControls();
    try {
      const result = await api('PUT', `/api/tasks/settings?path=${encodeURIComponent(path)}`, { settings: value });
      if (request !== settingsGeneration || !sameProject(path, epoch)) return;
      settings = gitflowSettings(result.settings);
      settingsDialog?.close();
      updateCreatePreview();
      await loadTasks(path);
    } catch (error) {
      if (request === settingsGeneration && sameProject(path, epoch)) showError('task-settings-error', requestError(error));
    } finally {
      if (request === settingsGeneration && sameProject(path, epoch)) {
        settingsBusy = false;
        updateSettingsControls();
      }
    }
  }

  function getTask(id) { return tasks.find(task => task.id === id); }

  function replaceTask(task) {
    if (!task?.id) return;
    const index = tasks.findIndex(item => item.id === task.id);
    if (index === -1) tasks.unshift(task);
    else tasks[index] = task;
  }

  async function reloadSessions() {
    try { await reloadData(); } catch { /* The task result remains visible if session list refresh fails. */ }
  }

  function updateCreatePreview() {
    const existing = $('task-workbranch-mode')?.value === 'existing';
    const selected = workbranchPicker.selected();
    if ($('task-workbranch-row')) $('task-workbranch-row').hidden = !existing;
    if ($('task-workbranch')) $('task-workbranch').required = existing;
    if ($('task-type')) $('task-type').disabled = existing;
    // 기존 작업 브랜치는 그 브랜치의 작업 폴더를 쓰므로 워크트리 여부를 고르지 않는다.
    if ($('task-worktree-row')) $('task-worktree-row').hidden = existing;
    const inPlace = !existing && $('task-worktree')?.value === 'none';
    const type = $('task-type')?.value || 'feature';
    // 새 브랜치일 때만 브랜치 이름을, 워크트리를 만들 때만 작업 폴더 이름을 정할 수 있다.
    if ($('task-branch-name-row')) $('task-branch-name-row').hidden = existing;
    if ($('task-branch-name')) $('task-branch-name').disabled = existing;
    if ($('task-branch-prefix')) $('task-branch-prefix').textContent = settings[`${type}Prefix`] ?? `${type}/`;
    if ($('task-worktree-name-row')) $('task-worktree-name-row').hidden = existing || inPlace;
    if ($('task-worktree-name')) $('task-worktree-name').disabled = existing || inPlace;
    const isRelease = type === 'release' && !existing;
    const versionField = $('task-version-row') || $('task-version')?.closest('label');
    if (versionField) versionField.hidden = !isRelease;
    if ($('task-version')) {
      $('task-version').required = isRelease;
      $('task-version').disabled = !isRelease;
    }
    if ($('task-branch-preview')) $('task-branch-preview').textContent = existing
      ? selected ? `${selected.name}에서 작업 → ${workBranchType(selected.name, settings) === 'feature' ? settings.develop : settings.main}으로 PR` : '기존 작업 브랜치를 선택하면 작업 유형과 PR 대상을 맞춥니다.'
      : taskBranchPreview(type, $('task-version')?.value.trim(), settings, $('task-branch-name')?.value.trim());
    if ($('task-gitflow-summary')) $('task-gitflow-summary').textContent = `기준: ${settings.main} / ${settings.develop}`;
    if ($('task-create-hint')) $('task-create-hint').textContent = inPlace
      ? `원격 ${settings.main}과 기준 브랜치를 확인한 뒤 원본 폴더를 새 작업 브랜치로 바꾸고 세션을 연결합니다. 원본 폴더에 커밋하지 않은 변경이 없어야 하며, 정리하면 원래 브랜치로 돌아갑니다.`
      : `원격 ${settings.main}과 기준 브랜치를 확인한 뒤 작업 브랜치·폴더·세션을 연결합니다.`;
  }

  function updateCreateSubmit() {
    const existing = $('task-workbranch-mode')?.value === 'existing';
    if ($('task-create-submit')) $('task-create-submit').disabled = createBusy || settingsBusy || uncertainCreates.has(createProject) || (existing && !workbranchPicker.ready());
  }

  function updateAgentControls() {
    const agent = $('task-agent')?.value || 'codex';
    fillModels('task-models', agent);
    const permission = $('task-permission');
    if (permission) {
      const defaults = agent === 'claude'
        ? [['acceptEdits', '파일 수정 허용'], ['default', '매번 확인'], ['bypassPermissions', '전체 권한']]
        : [['workspace-write', '작업 폴더 수정'], ['read-only', '읽기 전용'], ['danger-full-access', '전체 권한']];
      const supported = data?.status?.agents?.[agent]?.permissions;
      const labels = new Map(defaults);
      for (const mode of ['auto-review', 'danger-full-access']) labels.set(mode, permissionLabel(mode));
      const options = Array.isArray(supported) ? supported.map(option => {
        if (typeof option === 'string') return [option, labels.get(option) || option];
        const value = option.value || option.id || option.name;
        return [value, option.label || labels.get(value) || option.name || value];
      }).filter(([value]) => value) : defaults;
      permission.replaceChildren(...options.map(([value, label]) => { const option = node('option', '', label); option.value = value; return option; }));
      const preferred = agent === 'claude' ? 'acceptEdits' : 'workspace-write';
      permission.value = options.some(([value]) => value === preferred) ? preferred : options[0]?.[0] || '';
    }
    if ($('task-effort')) fillEfforts('task-effort', agent, $('task-model')?.value);
  }

  function openNewTask() {
    const path = getProjectPath();
    if (!path || path !== projectPath || createBusy || settingsBusy || uncertainCreates.has(path)) return;
    createProject = path;
    createForm?.reset();
    workbranchPicker.reset();
    showError('task-create-error');
    updateCreatePreview();
    updateAgentControls();
    updateCreateSubmit();
    createDialog?.showModal();
    $('task-title')?.focus();
  }

  async function createTask(event) {
    event.preventDefault();
    if (createBusy || settingsBusy || !sameProject(createProject) || uncertainCreates.has(createProject)) return;
    const existing = $('task-workbranch-mode')?.value === 'existing';
    if (existing && !workbranchPicker.ready()) {
      showError('task-create-error', workbranchPicker.validationError());
      return;
    }
    if (createForm && !createForm.reportValidity()) return;
    const path = createProject;
    const epoch = projectEpoch;
    const title = $('task-title')?.value.trim();
    if (!title) { showError('task-create-error', '작업 제목을 입력해 주세요.'); return; }
    const payload = {
      projectPath: path, title, type: $('task-type')?.value || 'feature',
      agent: $('task-agent')?.value || 'codex',
      permission: $('task-permission')?.value || 'workspace-write',
    };
    if (existing) payload.workBranch = workbranchPicker.selected().name;
    else if (payload.type === 'release') payload.version = $('task-version')?.value.trim();
    if (!existing && $('task-worktree')?.value === 'none') payload.worktree = false;
    if (!existing && $('task-branch-name')?.value.trim()) payload.branchName = $('task-branch-name').value.trim();
    if (!existing && payload.worktree !== false && $('task-worktree-name')?.value.trim()) payload.worktreeName = $('task-worktree-name').value.trim();
    if ($('task-model')?.value.trim()) payload.model = $('task-model').value.trim();
    if ($('task-effort')?.value) payload.effort = $('task-effort').value;
    if ($('task-role')?.value.trim()) payload.role = $('task-role').value.trim();
    createBusy = true;
    showError('task-create-error');
    const submit = $('task-create-submit');
    if (submit) { submit.disabled = true; submit.textContent = '브랜치와 세션 준비 중…'; }
    updateToolbar();
    try {
      const result = await api('POST', '/api/tasks', payload);
      await reloadSessions();
      if (sameProject(path, epoch)) {
        replaceTask(result.task);
        renderTasks();
        createDialog?.close();
        const sessionId = result.session?.id || result.task?.sessionIds?.at(-1);
        if (sessionId) await selectSession(sessionId);
      }
    } catch (error) {
      if (error.outcomeUnknown) uncertainCreates.add(path);
      if (sameProject(path, epoch)) showError('task-create-error', error.outcomeUnknown ? unknownMessage('작업 생성') : requestError(error));
    } finally {
      createBusy = false;
      if (submit) { submit.disabled = uncertainCreates.has(path); submit.textContent = '작업 만들기'; }
      updateToolbar();
    }
  }

  function openFinish(task) {
    if (!task || pendingTasks.has(task.id) || uncertainTasks.has(task.id) || task.pendingAction || finishBusy) return;
    finishTaskId = task.id;
    finishProject = projectPath;
    finishForm?.reset();
    if ($('task-finish-message')) $('task-finish-message').value = `${task.type === 'hotfix' ? 'fix' : task.type === 'release' ? 'chore' : 'feat'}: ${task.title}`;
    if ($('task-finish-summary')) $('task-finish-summary').textContent = `${task.title}\n${task.branch} → ${task.targetBranch}\n이 작업 폴더의 변경 사항을 커밋하고 원격에 게시한 뒤 PR을 만듭니다. 작업을 마치고 검증 결과를 확인해 주세요.`;
    showError('task-finish-error');
    if ($('task-finish-submit')) $('task-finish-submit').disabled = false;
    finishDialog?.showModal();
    $('task-finish-message')?.focus();
  }

  async function finishTask(event) {
    event.preventDefault();
    if (finishBusy || !sameProject(finishProject) || !finishTaskId || uncertainTasks.has(finishTaskId)) return;
    if (finishForm && !finishForm.reportValidity()) return;
    const task = getTask(finishTaskId);
    if (!task) return;
    if (task.pendingAction || !['working', 'review'].includes(task.state)) {
      showError('task-finish-error', '작업 상태가 변경되었습니다. 대화상자를 닫고 최신 상태를 확인해 주세요.');
      return;
    }
    const message = $('task-finish-message')?.value.trim();
    if (!message) { showError('task-finish-error', '커밋 메시지를 입력해 주세요.'); return; }
    const id = task.id;
    const path = finishProject;
    const epoch = projectEpoch;
    finishBusy = true;
    pendingTasks.add(id);
    const submit = $('task-finish-submit');
    if (submit) { submit.disabled = true; submit.textContent = '커밋·게시·PR 처리 중…'; }
    showError('task-finish-error');
    renderTasks();
    try {
      const result = await api('POST', `/api/tasks/${encodeURIComponent(id)}/finish`, {
        message, description: $('task-finish-description')?.value.trim() || '', verification: $('task-finish-verification')?.value.trim() || '',
      });
      if (sameProject(path, epoch)) {
        replaceTask(result.task);
        taskErrors.delete(id);
        finishDialog?.close();
      }
    } catch (error) {
      if (error.outcomeUnknown) uncertainTasks.set(id, 'finish');
      const message = error.outcomeUnknown ? unknownMessage('커밋·게시·PR 생성') : requestError(error);
      taskErrors.set(id, message);
      if (sameProject(path, epoch)) showError('task-finish-error', message);
    } finally {
      finishBusy = false;
      pendingTasks.delete(id);
      if (submit) { submit.disabled = uncertainTasks.has(id); submit.textContent = '커밋·게시·PR 만들기'; }
      if (sameProject(path, epoch)) renderTasks();
    }
  }

  async function runTaskAction(action, task) {
    if (!task || pendingTasks.has(task.id)) return;
    if (action !== 'refresh' && (uncertainTasks.has(task.id) || task.pendingAction)) return;
    const path = projectPath;
    const epoch = projectEpoch;
    const id = task.id;
    pendingTasks.add(id);
    taskErrors.delete(id);
    renderTasks();
    try {
      const result = await api('POST', `/api/tasks/${encodeURIComponent(id)}/${action}`, {});
      if (action === 'refresh' && !result.task?.pendingAction) uncertainTasks.delete(id);
      if (sameProject(path, epoch)) {
        replaceTask(result.task);
        if (finishTaskId === id && !finishBusy) {
          if ($('task-finish-submit')) $('task-finish-submit').disabled = Boolean(result.task?.pendingAction);
          if (!result.task?.pendingAction) showError('task-finish-error');
        }
      }
      if (action === 'cleanup' || action === 'refresh') await reloadSessions();
    } catch (error) {
      if (error.outcomeUnknown && action !== 'refresh') uncertainTasks.set(id, action);
      const label = action === 'cleanup' ? '작업 폴더 정리' : action === 'sync' ? '기준 변경 반영' : '최신 확인';
      taskErrors.set(id, error.outcomeUnknown ? unknownMessage(label) : requestError(error));
    } finally {
      pendingTasks.delete(id);
      if (sameProject(path, epoch)) renderTasks();
    }
  }

  // 작업 삭제 확인 문구. 지우는 것과 남는 것을 함께 알린다.
  function deleteSummary(task, sessionCount) {
    const lines = [`"${task.title}" 작업을 삭제할까요?`, ''];
    if (sessionCount) lines.push(`연결된 세션 ${sessionCount}개를 멈추고 삭제합니다. 열려 있는 세션 화면도 닫힙니다.`);
    if (task.state === 'cleaned') lines.push('이미 정리한 작업이라 작업 기록만 지웁니다.');
    else if (task.inPlace) lines.push('원본 폴더에서 한 작업이라 폴더는 그대로 둡니다.');
    else if (task.ownsWorktree === false) lines.push(`선택했던 기존 작업 폴더는 보존합니다.\n${task.cwd}`);
    else lines.push(`작업 폴더를 지웁니다.\n${task.cwd}`);
    lines.push('원격 브랜치와 PR은 남습니다.');
    return lines.join('\n');
  }

  // 작업을 지운다. 실행 중인 세션이나 커밋하지 않은 변경이 있으면 그 자리에서 계속할지 묻는다.
  async function deleteTask(task) {
    if (!task || pendingTasks.has(task.id)) return;
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const ids = Array.isArray(task.sessionIds) ? task.sessionIds : [];
    const sessionCount = sessions.filter(session => ids.includes(session.id) || session.taskId === task.id).length;
    if (!confirm(deleteSummary(task, sessionCount))) return;
    const query = new URLSearchParams();
    if (task.state !== 'cleaned' && task.ownsBranch !== false && task.branch
      && confirm(`로컬 브랜치 ${task.branch}도 지울까요?\n\n확인: 브랜치를 지웁니다. 게시하지 않은 커밋은 되돌릴 수 없습니다.\n취소: 브랜치는 남겨 둡니다.`)) query.set('branch', 'delete');
    const path = projectPath;
    const epoch = projectEpoch;
    const id = task.id;
    pendingTasks.add(id);
    taskErrors.delete(id);
    renderTasks();
    try {
      let result;
      for (;;) {
        try { result = await api('DELETE', `/api/tasks/${encodeURIComponent(id)}?${query}`); break; }
        catch (error) {
          if (query.has('force')) throw error;
          const again = error.reason === 'running' ? confirm('실행 중인 세션이 있습니다. 실행을 멈추고 삭제할까요?')
            : error.reason === 'task-dirty' ? confirm(`${error.message}\n\n변경 사항을 버리고 작업 폴더를 지울까요? 되돌릴 수 없습니다.`)
            : null;
          if (again === null) throw error;
          if (!again) return;
          query.set('force', '1');
        }
      }
      uncertainTasks.delete(id);
      if (sameProject(path, epoch)) tasks = tasks.filter(item => item.id !== id);
      await reloadSessions();
      if (result?.warning) alert(result.warning);
    } catch (error) {
      taskErrors.set(id, requestError(error));
    } finally {
      pendingTasks.delete(id);
      if (sameProject(path, epoch)) renderTasks();
    }
  }

  async function newSession(task) {
    if (!task || pendingTasks.has(task.id) || uncertainTasks.has(task.id) || task.pendingAction) return;
    const path = projectPath;
    const epoch = projectEpoch;
    pendingTasks.add(task.id);
    taskErrors.delete(task.id);
    renderTasks();
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const ids = Array.isArray(task.sessionIds) ? task.sessionIds : [];
    const previous = sessions.find(session => session.id === ids.at(-1)) || sessions.find(session => session.taskId === task.id);
    const agent = previous?.agent || task.agent || 'codex';
    const payload = { agent, permission: previous?.permission || task.permission || (agent === 'claude' ? 'acceptEdits' : 'workspace-write') };
    for (const key of ['model', 'effort', 'role']) {
      const value = previous?.[key] ?? task[key];
      if (value) payload[key] = value;
    }
    try {
      const result = await api('POST', `/api/tasks/${encodeURIComponent(task.id)}/session`, payload);
      await reloadSessions();
      if (sameProject(path, epoch)) {
        replaceTask(result.task);
        if (result.session?.id) await selectSession(result.session.id);
      }
    } catch (error) {
      if (error.outcomeUnknown) uncertainTasks.set(task.id, 'session');
      taskErrors.set(task.id, error.outcomeUnknown ? unknownMessage('세션 생성') : requestError(error));
    } finally {
      pendingTasks.delete(task.id);
      if (sameProject(path, epoch)) renderTasks();
    }
  }

  $('tasks-new')?.addEventListener('click', openNewTask);
  $('tasks-settings')?.addEventListener('click', () => { void openSettings(); });
  $('task-create-settings')?.addEventListener('click', () => { void openSettings(); });
  settingsForm?.addEventListener('submit', saveSettings);
  $('task-settings-cancel')?.addEventListener('click', closeSettings);
  settingsDialog?.addEventListener('cancel', event => { event.preventDefault(); closeSettings(); });
  $('tasks-refresh')?.addEventListener('click', () => { void loadTasks(getProjectPath(), { manual: true }); });
  $('task-type')?.addEventListener('change', updateCreatePreview);
  $('task-workbranch-mode')?.addEventListener('change', () => {
    if ($('task-workbranch-mode').value === 'existing') void workbranchPicker.load();
    else workbranchPicker.reset();
    updateCreatePreview();
    updateCreateSubmit();
  });
  $('task-version')?.addEventListener('input', updateCreatePreview);
  $('task-worktree')?.addEventListener('change', updateCreatePreview);
  $('task-branch-name')?.addEventListener('input', updateCreatePreview);
  $('task-agent')?.addEventListener('change', () => { if ($('task-model')) $('task-model').value = ''; updateAgentControls(); });
  $('task-model')?.addEventListener('change', () => { if ($('task-effort')) fillEfforts('task-effort', $('task-agent')?.value || 'codex', $('task-model').value); });
  createForm?.addEventListener('submit', createTask);
  finishForm?.addEventListener('submit', finishTask);
  createDialog?.addEventListener('cancel', event => { if (createBusy) event.preventDefault(); });
  createDialog?.addEventListener('close', () => workbranchPicker.reset());
  finishDialog?.addEventListener('cancel', event => { if (finishBusy) event.preventDefault(); });
  $('task-create-cancel')?.addEventListener('click', () => { if (!createBusy) createDialog?.close(); });
  $('task-finish-cancel')?.addEventListener('click', () => { if (!finishBusy) finishDialog?.close(); });
  document.querySelectorAll('[data-task-dialog-close]').forEach(button => button.addEventListener('click', () => {
    const dialog = button.closest('dialog');
    if ((dialog === createDialog && createBusy) || (dialog === finishDialog && finishBusy)) return;
    dialog?.close();
  }));
  list?.addEventListener('click', event => {
    const button = event.target.closest('[data-task-action]');
    if (!button || button.disabled || !sameProject(projectPath)) return;
    const task = getTask(button.dataset.taskId);
    if (!task) return;
    const action = button.dataset.taskAction;
    if (action === 'open-session') { void selectSession(button.dataset.sessionId); return; }
    if (action === 'new-session') { void newSession(task); return; }
    if (action === 'finish') { openFinish(task); return; }
    if (action === 'delete') { void deleteTask(task); return; }
    if (['refresh', 'sync', 'cleanup'].includes(action)) void runTaskAction(action, task);
  });
  updateToolbar();

  return {
    loadTasks, invalidateProject, renderTasks,
    refreshIfVisible(path = getProjectPath()) { if (path === getProjectPath() && isTasksVisible()) void loadTasks(path); },
  };
}
