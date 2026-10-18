import { permissionLabel } from '../../shared/permissions.js';
import { createWorkbranchPicker, workBranchType } from '../../shared/workbranches.js';
import { createTaskAssistant } from './assistant.js';
import { createTaskFinisher } from './finish.js';
import { DEFAULT_GITFLOW, gitflowBranches } from '../../shared/gitflow.js';
import { buildTaskPipeline } from '../../shared/task-stage.js';
import { renderTaskPipeline, relativeTime } from './pipeline.js';
import { confirmAction } from '../../shared/confirm-dialog.js';
import { errorPanel, showError as showErrorToast } from '../../shared/error-report.js';
import { createTaskWorkspace } from './workspace.js';

const TASK_TYPES = { feature: '기능 개발·일반 수정', hotfix: '긴급 수정', release: '배포 준비' };
const GITFLOW_FIELDS = Object.keys(DEFAULT_GITFLOW);
const TASK_AGENTS = [['codex', 'Codex'], ['claude', 'Claude Code']];
// 새 작업을 만들 때 고른 설정을 기억해 다음 새 작업의 기본값으로 쓴다. 제목·이름·지침처럼 작업마다 다른 값은 두지 않는다.
const CREATE_PREFS_KEY = 'agenthub.newTask';
// 작업 목록 상태 필터. 진행 중은 작업·검토 대기, 완료는 반영·정리를 마친 작업이다.
const FILTER_KEY = 'agenthub.taskFilter';
const TASK_FILTERS = { all: () => true, active: task => !['merged', 'cleaned'].includes(task.state), done: task => ['merged', 'cleaned'].includes(task.state) };
const FILTER_EMPTY = { active: '진행 중인 작업이 없습니다', done: '완료한 작업이 없습니다' };

function loadCreatePrefs() {
  try { return JSON.parse(localStorage.getItem(CREATE_PREFS_KEY) ?? '{}') || {}; } catch { return {}; }
}

function saveCreatePrefs(prefs) {
  try { localStorage.setItem(CREATE_PREFS_KEY, JSON.stringify(prefs)); } catch { /* 저장하지 못해도 작업 생성에는 지장 없다. */ }
}

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

// 서버(taskBranchSlug)와 같은 규칙으로 제목에서 브랜치 이름을 만든다. 같은 이름이 있으면 서버가 -2, -3을 붙인다.
export function taskBranchSlug(title, max = 40) {
  const words = String(title ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9가-힣]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > max) { if (!slug) slug = word.slice(0, max); break; }
    slug = next;
  }
  return slug || 'work';
}

export function taskBranchFullName(type, version = '', settings = DEFAULT_GITFLOW, name = '', title = '') {
  const { prefix } = gitflowBranches(type, gitflowSettings(settings));
  const rest = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return `${prefix}${rest || (type === 'release' ? version || '<버전>' : title.trim() ? taskBranchSlug(title) : '<제목>')}`;
}

export function taskBranchPreview(type, version = '', settings = DEFAULT_GITFLOW, name = '', title = '') {
  const { base, target } = gitflowBranches(type, gitflowSettings(settings));
  return `${base}에서 ${taskBranchFullName(type, version, settings, name, title)} 생성 → ${target}으로 PR`;
}

export function createTasksController({
  api, data, navigation, getProjectPath = () => navigation?.project,
  fillModels = () => {}, fillEfforts = () => {}, selectSession = () => {},
  reloadData = async () => {}, openSetup = () => {}, showTasksTab = () => {},
}) {
  const $ = id => document.getElementById(id);
  const list = $('tasks-list');
  const createDialog = $('new-task-dialog');
  const createForm = $('new-task-form');
  const finishDialog = $('finish-task-dialog');
  const finishForm = $('finish-task-form');
  const settingsDialog = $('task-settings-dialog');
  const issueDialog = $('task-issue-dialog');
  const issueForm = $('task-issue-form');
  const settingsForm = $('task-settings-form');
  // 화면에서만 보여 줄 요청 오류. { message, reason }
  const taskErrors = new Map();
  const uncertainTasks = new Map();
  const uncertainCreates = new Set();
  const pendingTasks = new Set();
  const REVIEW_CHECK_MS = 3 * 60_000;
  const reviewChecks = new Map(); // 작업 ID → 마지막으로 PR 병합을 자동 확인한 시각
  const freshChecks = new Map(); // 작업 ID → 마지막으로 오래된 최신 확인 결과를 자동으로 다시 확인한 시각
  const mergedNotice = new Set(); // 자동 확인으로 병합을 알게 된 작업
  // 카드 단계 표시용 로컬 Git 상태. 작업 ID → GET /api/tasks/:id/status 결과
  const statuses = new Map();
  let statusGeneration = 0;
  let tasks = [];
  let projectPath = null;
  let context = null;
  let generation = 0;
  let projectEpoch = 0;
  let loading = false;
  let createBusy = false;
  let finishBusy = false;
  let createProject = null;
  let createTabId = null;
  let finishProject = null;
  let finishTaskId = null;
  let settings = gitflowSettings();
  let finishDefault = 'pr';
  let settingsProject = null;
  let settingsGeneration = 0;
  let settingsBusy = false;
  let settingsLoading = false;
  let settingsReadFailed = false;
  let issueTaskId = null;
  let issueBusy = false;
  // 팀 작업에서 시작한 새 작업이면 만든 뒤 연결할 이슈. { number, repo }
  let createIssue = null;
  let filter = (() => { try { const value = localStorage.getItem(FILTER_KEY); return TASK_FILTERS[value] ? value : 'all'; } catch { return 'all'; } })();
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
  const finisher = createTaskFinisher({ api, isCurrent: path => sameProject(path),
    onTask: task => { replaceTask(task); renderTasks(); },
    onBusy: (value, id) => { finishBusy = value; if (value) pendingTasks.add(id); else pendingTasks.delete(id); renderTasks(); },
    onError: (id, message, reason, extra = {}) => { if (message) taskErrors.set(id, { message, reason, ...extra }); else taskErrors.delete(id); },
    decorateError: (el, reason) => appendLogin(el, reason),
    onUnknown: (id, action) => uncertainTasks.set(id, action),
  });
  const taskAssistant = createTaskAssistant({ api, getStatus: () => data?.status, fillModels,
    getContext: () => ({ projectPath: createProject, tabId: createTabId, active: Boolean(createDialog?.open && sameProject(createProject) && createTabId === navigation?.graphTabId) }),
    onDraft: ({ agentChanged }) => { if (agentChanged) { if ($('task-model')) $('task-model').value = ''; updateAgentControls(); } updateCreatePreview(); },
    onState: () => updateCreateSubmit(),
  });

  // GitHub 로그인으로 풀 수 있는 오류에는 설정의 GitHub CLI 설치·로그인을 바로 연다.
  function appendLogin(parent, reason) {
    if (!['git-auth', 'git-auth-ssh', 'gh-auth', 'gh-missing', 'gh-permission'].includes(reason)) return;
    const button = node('button', 'ghost sm task-login', reason === 'gh-missing' ? 'GitHub CLI 설치' : 'GitHub 로그인');
    button.type = 'button';
    button.addEventListener('click', () => openSetup('gh', reason === 'gh-missing' ? 'install' : 'login'));
    parent.append(button);
  }

  function node(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value !== undefined) el.textContent = value;
    return el;
  }

  function showError(id, message = '', reason) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
    if (message) appendLogin(el, reason);
  }

  // 창 안의 오류 칸에 동작 · 원인 · 해결 방법 · 원문을 함께 보여 준다.
  function showErrorDetail(id, error, action) {
    const el = $(id);
    if (!el) return;
    const box = errorPanel(error, { action, rawLabel: 'Git 원문 보기' });
    appendLogin(box.querySelector('.error-report-actions') || box, error?.reason);
    el.replaceChildren(box);
    el.hidden = false;
  }

  function sameProject(path, epoch = projectEpoch) {
    return Boolean(epoch === projectEpoch && path && path === projectPath && path === getProjectPath());
  }

  // 원본 폴더 확인·재사용 폴더·Library 복사·폴더 열기
  const workspace = createTaskWorkspace({ api, node, getProjectPath: () => projectPath, requestError: error => requestError(error),
    taskNote: (id, value) => { taskErrors.set(id, value); renderTasks(); },
    onChange: ({ cardsOnly } = {}) => { if (cardsOnly) renderTasks(); else if (projectPath) void loadTasks(projectPath, { localOnly: true }); } });
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

  // 기준 정보 줄: 기준 브랜치 develop · 배포 브랜치 main · origin과 같음 · 방금 확인
  function renderContext() {
    const el = $('tasks-context');
    if (!el) return;
    el.replaceChildren();
    el.dataset.state = 'unknown';
    const branches = () => {
      el.append(node('span', 'tasks-context-label', '기준 브랜치'), node('strong', 'tasks-context-branch', settings.develop),
        node('span', 'tasks-context-label', '배포 브랜치'), node('strong', 'tasks-context-branch', settings.main));
    };
    if (!context) {
      branches();
      el.append(node('span', 'tasks-context-status', loading ? '원격 상태를 확인하고 있습니다…' : '원격 상태 확인 전'));
      return;
    }
    const freshness = context.freshness || {};
    const failed = context.error || context.state === 'error' || ['error', 'failed'].includes(freshness.state);
    const mainMissing = context.mainInDevelop === false || context.mainMissing === true;
    el.dataset.state = failed ? 'error' : mainMissing ? 'stale' : freshness.state || 'current';
    branches();
    const remote = context.remote || freshness.remote || 'origin';
    const checked = relativeTime(context.checkedAt || freshness.checkedAt);
    const status = failed ? '원격 확인 실패'
      : mainMissing ? `${settings.main} 변경을 ${settings.develop}에 반영해야 합니다`
      : context.needsSetup || context.needsDevelop || context.developExists === false ? `${settings.develop} 없음 · 첫 기능 작업 때 ${settings.main}에서 준비합니다`
      : `${remote}과 같음`;
    el.append(node('span', 'tasks-context-status', `${status}${checked ? ` · ${checked === '방금 전' ? '방금' : checked} 확인` : ''}`));
    const failure = typeof context.error === 'string' ? context.error : context.error?.message || freshness.error || '원격 저장소 연결을 확인해 주세요.';
    if (failed) el.append(node('span', 'tasks-context-detail', failure));
    if (Array.isArray(context.warnings)) for (const warning of context.warnings) {
      if (typeof warning === 'string' && warning && !(failed && warning === failure) && !mainMissing) el.append(node('span', 'tasks-context-detail', warning));
    }
    if (failed) appendLogin(el, context.reason);
  }

  function actionButton(label, action, task, { primary = false, disabled = false, reason = '' } = {}) {
    const button = node('button', primary ? 'primary sm' : 'ghost sm', label);
    button.type = 'button';
    button.dataset.taskAction = action;
    button.dataset.taskId = task.id;
    button.disabled = disabled || pendingTasks.has(task.id);
    if (disabled && reason) { button.title = reason; button.dataset.reason = reason; }
    return button;
  }

  // 오류 설명과 해결 방법, 펼쳐 볼 수 있는 git 원문을 함께 보여 준다.
  // 이 작업이 어느 폴더에서 일하는지(워크트리인지 원본 폴더인지)와 폴더가 실제로 있는지 보여 준다.
  function folderLine(task, status) {
    const kind = task.inPlace ? '원본 폴더' : task.ownsWorktree === false ? '기존 작업 폴더' : '워크트리';
    const cleaned = task.state === 'cleaned';
    const where = task.inPlace ? task.projectPath : task.cwd;
    const line = node('p', 'task-folder');
    line.title = where || '';
    line.append(node('span', 'task-folder-kind', kind), node('span', 'task-folder-path', where || '준비 중'));
    const flag = cleaned
      ? task.folderLeft ? '정리 후 폴더가 남음' : task.inPlace || task.ownsWorktree === false ? '' : '삭제됨'
      : status?.folder === false ? '폴더 없음' : '';
    if (flag) {
      const badge = node('span', 'task-folder-flag', flag);
      badge.dataset.warn = String(flag !== '삭제됨');
      line.append(badge);
    }
    return line;
  }

  // 공용 오류 표시로 동작 · 원인 · 해결 방법 · Git 원문을 보여 준다. 작업의 마지막 세션이 있으면 그 세션에 해결을 요청할 수 있다.
  function errorBlock(message, { reason, hint, raw, action } = {}, { sessionId = null, onClose = null } = {}) {
    const box = errorPanel({ message, reason, hint, raw }, { action, title: '작업 오류', sessionId, onClose, rawLabel: 'Git 원문 보기' });
    box.classList.add('task-inline-error');
    appendLogin(box.querySelector('.error-report-actions') || box, reason);
    return box;
  }

  // 화면에 보이는 작업의 로컬 Git 상태를 세 개씩 나눠 읽고 받은 대로 다시 그린다.
  async function loadStatuses(ids = tasks.map(task => task.id)) {
    const path = projectPath, epoch = projectEpoch, request = ++statusGeneration;
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          const result = await api('GET', `/api/tasks/${encodeURIComponent(id)}/status`);
          if (!sameProject(path, epoch)) return;
          if (result && typeof result === 'object') statuses.set(id, result);
          if (result?.freshness?.stale) void recheckFreshness(id);
        } catch { if (!sameProject(path, epoch)) return; statuses.delete(id); }
        if (request === statusGeneration || ids.length === 1) renderTasks();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // 저장된 최신 확인 결과가 오래됐거나 그 뒤로 작업 브랜치가 바뀌었으면 조용히 다시 확인한다.
  // 같은 작업은 몇 분에 한 번만 묻고, 실패하면 이전 결과를 그대로 둔다.
  async function recheckFreshness(id) {
    const task = getTask(id);
    if (!task || pendingTasks.has(id) || uncertainTasks.has(id) || task.pendingAction || !['working', 'review'].includes(task.state)) return;
    if (Date.now() - (freshChecks.get(id) || 0) < REVIEW_CHECK_MS) return;
    freshChecks.set(id, Date.now());
    const path = projectPath, epoch = projectEpoch;
    try {
      const result = await api('POST', `/api/tasks/${encodeURIComponent(id)}/freshness`, {});
      if (!sameProject(path, epoch) || !result?.checked || pendingTasks.has(id)) return;
      replaceTask(result.task);
      void loadStatuses([id]);
    } catch { /* 자동 확인 실패는 카드 오류로 남기지 않는다. 최신 상태 확인을 누르면 사유를 볼 수 있다. */ }
  }

  function renderTasks() {
    if (!list) return;
    // 상태를 받아 다시 그려도 보고 있던 카드나 버튼의 초점과 열린 메뉴를 잃지 않게 한다.
    const active = list.contains(document.activeElement) ? document.activeElement : null;
    const keep = active && { id: active.closest('[data-task-id]')?.dataset.taskId, card: active.classList.contains('task-card'), action: active.dataset.taskAction, label: active.textContent };
    const openMenu = list.querySelector('.task-more[open]')?.closest('.task-card')?.dataset.taskId;
    list.replaceChildren();
    list.setAttribute('aria-busy', String(loading));
    renderFilter();
    const shown = tasks.filter(TASK_FILTERS[filter]);
    if (!shown.length) {
      const empty = node('div', 'tasks-empty');
      empty.append(node('strong', '', loading ? '작업을 불러오고 있습니다…' : tasks.length ? FILTER_EMPTY[filter] : '아직 작업이 없습니다'));
      if (!loading && !tasks.length) empty.append(node('span', '', '새 작업을 만들면 브랜치와 작업 폴더가 자동으로 준비됩니다.'));
      list.append(empty);
      return;
    }
    for (const task of shown) {
      const flow = gitflowSettings({ ...task.gitflow, main: task.gitflow?.main ?? task.freshness?.main?.branch ?? DEFAULT_GITFLOW.main, develop: task.gitflow?.develop ?? task.freshness?.develop?.branch ?? DEFAULT_GITFLOW.develop });
      const ids = Array.isArray(task.sessionIds) ? task.sessionIds : [];
      const known = Array.isArray(data?.sessions);
      const connected = known ? data.sessions.filter(session => ids.includes(session.id) || session.taskId === task.id) : [];
      const sessionId = (connected.find(session => session.id === ids.at(-1)) || connected[0])?.id || (!known ? ids.at(-1) : null);
      const status = statuses.get(task.id) || null;
      const sessionCount = known ? connected.length : status?.sessions ?? ids.length;
      const running = known ? connected.filter(session => ['running', 'background'].includes(session.state)).length : status?.running ?? 0;
      const pipeline = buildTaskPipeline({ ...task, gitflow: flow }, status, {
        sessionId, sessions: sessionCount, running,
        uncertain: uncertainTasks.has(task.id), pending: pendingTasks.has(task.id),
      });
      const card = node('article', 'task-card');
      card.dataset.taskId = task.id;
      card.dataset.stage = pipeline.current;
      card.setAttribute('aria-label', task.title || '작업');
      card.setAttribute('aria-busy', String(pendingTasks.has(task.id)));
      const header = node('div', 'task-card-header');
      const heading = node('h3', 'task-title', task.title);
      if (task.issue?.number) heading.append(node('span', 'task-number', `#${task.issue.number}`));
      const state = node('span', 'task-state', pipeline.stateLabel);
      state.dataset.state = task.state;
      // 푸시 안 된 커밋·원본 폴더 브랜치 이탈처럼 놓치기 쉬운 상태는 제목 옆 배지로 알린다.
      const badges = node('div', 'task-badges');
      for (const item of pipeline.badges) {
        const badge = node('span', 'task-badge', item.label);
        badge.dataset.badge = item.id;
        badge.title = item.title || '';
        badges.append(badge);
      }
      badges.append(state);
      header.append(heading, badges);
      card.append(header);
      const meta = node('div', 'task-meta');
      meta.append(node('span', 'task-branch', `${task.branch || '브랜치 준비 중'} → ${pipeline.target}`));
      if (task.type && task.type !== 'feature') meta.append(node('span', '', TASK_TYPES[task.type] || task.type));
      if (task.version) meta.append(node('span', '', `버전 ${task.version}`));
      meta.append(node('span', '', `세션 ${sessionCount}개`));
      const updated = relativeTime(task.updatedAt || task.createdAt);
      if (updated) meta.append(node('span', 'task-updated', updated));
      card.append(meta);
      card.append(folderLine(task, status));
      workspace.decorate(card, task);
      if (task.issue) card.append(issueLine(task.issue));
      card.append(renderTaskPipeline(pipeline));
      // 상태 조회가 지금 HEAD로 다시 따진 결과가 있으면 저장된 결과보다 그것을 보여 준다.
      const fresh = status?.freshness || task.freshness;
      if (task.state !== 'cleaned' && fresh?.state && !['current', 'up-to-date'].includes(fresh.state)) {
        const freshness = node('div', 'task-freshness', describeTaskFreshness(fresh));
        freshness.dataset.state = fresh.state;
        const checked = timestamp(fresh.checkedAt);
        if (checked) freshness.append(node('span', '', ` · ${checked} 확인`));
        card.append(freshness);
      }
      // 버튼으로 풀 수 없는 상태는 해야 할 일을 글로 안내한다.
      if (pipeline.notice) {
        const notice = node('p', 'task-notice', pipeline.notice);
        notice.setAttribute('role', 'status');
        card.append(notice);
      }
      // 단계별 다음 동작. 할 수 없는 동작은 꺼 두고 이유를 바로 아래에 보여 준다.
      const actions = node('div', 'task-actions');
      const reasons = [];
      for (const item of pipeline.actions) {
        if (item.id === 'pull-link') {
          try {
            const url = new URL(item.url);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
            const link = node('a', 'task-link-button', item.label);
            link.href = url.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            actions.append(link);
          } catch { /* Invalid server-provided links are not rendered. */ }
          continue;
        }
        const button = actionButton(item.label, item.id, task, { primary: item.primary, disabled: item.disabled, reason: item.reason });
        if (item.id === 'open-session') button.dataset.sessionId = sessionId;
        actions.append(button);
        if (item.disabled && item.reason && !reasons.includes(item.reason)) reasons.push(item.reason);
      }
      const more = node('details', 'task-more');
      const moreSummary = node('summary', '', '⋯');
      moreSummary.setAttribute('aria-label', '다른 동작');
      moreSummary.title = '다른 동작';
      more.append(moreSummary);
      more.addEventListener('toggle', () => placeMenu(more));
      const secondary = node('div', 'task-more-menu');
      more.append(secondary);
      const blocked = uncertainTasks.has(task.id) || Boolean(task.pendingAction);
      if (task.state === 'working' || task.state === 'review') {
        secondary.append(actionButton(connected.length ? '세션 추가' : '새 세션', 'new-session', task, { disabled: blocked }));
        if (task.state === 'review') secondary.append(actionButton('PR 업데이트', 'finish', task, { disabled: blocked }));
      }
      if (task.state !== 'cleaned') secondary.append(actionButton('최신 상태 확인', 'refresh', task));
      secondary.append(...workspace.menu(task, actionButton));
      if (task.state === 'merged') {
        const unpushed = task.completion?.kind === 'local' && (task.completion.publishState !== 'done' || (task.completion.developHead && task.completion.developPublishState !== 'done'));
        if (unpushed) secondary.append(actionButton('대상 브랜치 푸시', 'push-target', task, { disabled: blocked }));
      }
      if (task.state !== 'cleaned') secondary.append(task.issue ? actionButton('이슈 연결 해제', 'unlink-issue', task) : actionButton('이슈 연결', 'link-issue', task));
      const remove = actionButton('작업 삭제', 'delete', task);
      remove.classList.add('danger');
      secondary.append(remove);
      actions.append(more);
      // 진행 중인 작업은 바로 그만둘 수 있다. 세션·폴더·브랜치(원격 포함)와 열린 PR까지 모두 정리한다.
      if (task.state === 'working' || task.state === 'review') {
        const abandon = actionButton('작업 그만두기', 'abandon', task, { disabled: blocked });
        abandon.classList.add('danger', 'task-abandon');
        abandon.title = '세션, 작업 폴더, 로컬·원격 브랜치를 지우고 열린 PR을 닫습니다.';
        actions.append(abandon);
      }
      card.append(actions);
      if (reasons.length) {
        const reasonEl = node('p', 'task-action-reason', reasons.join(' '));
        reasonEl.id = `task-reason-${task.id}`;
        for (const button of actions.querySelectorAll('button[data-reason]')) button.setAttribute('aria-describedby', reasonEl.id);
        card.append(reasonEl);
      }
      if (task.state === 'cleaned') card.append(node('p', 'task-note', task.inPlace
        ? `원본 폴더를 ${task.previousBranch || task.targetBranch} 브랜치로 되돌렸습니다. 작업과 PR 기록은 보관됩니다.`
        : task.worktreePreserved
        ? '작업 기록을 정리했습니다. 선택했던 기존 작업 폴더와 브랜치는 보존됩니다.'
        : task.parkedWorktree
        ? '작업 폴더를 재사용 대기 폴더로 남기고 로컬 브랜치를 정리했습니다. 다음 새 작업이 이 폴더를 씁니다.'
        : task.localBranchRemoved === false
          ? '작업 폴더를 정리했습니다. 로컬 브랜치와 작업·PR 기록은 보관됩니다.'
          : '작업 폴더와 로컬 브랜치를 정리했습니다. 작업과 PR 기록은 보관됩니다.'));
      if (task.cleanupWarning) card.append(node('p', 'task-note', typeof task.cleanupWarning === 'string' ? task.cleanupWarning : task.cleanupWarning.message || '정리 결과를 확인해 주세요.'));
      if (task.state === 'cleaned' && task.folderLeft) card.append(actionButton('남은 폴더 다시 지우기', 'cleanup', task, { primary: true }));
      if (mergedNotice.has(task.id) && task.state === 'merged')
        card.append(node('p', 'task-note', 'GitHub에서 PR 병합을 확인했습니다. 작업 폴더 정리를 눌러 마무리하세요.'));
      // 화면 오류는 문자열이거나 { message, reason, hint, raw }이다. 문자열이면 서버에 남은 같은 오류의 사유를 쓴다.
      const local = taskErrors.get(task.id);
      const localMessage = typeof local === 'string' ? local : local?.message;
      const fromServer = !local || local === task.error;
      const detail = local && typeof local === 'object' ? local : fromServer ? { reason: task.errorReason, hint: task.errorHint } : {};
      // 오류가 아닌 안내(예: 충돌 해결 요청을 보냄)는 일반 안내 줄로 보여 준다.
      if (local?.notice) card.append(node('p', 'task-note', local.message));
      const error = local?.notice ? '' : localMessage || task.error?.message || (typeof task.error === 'string' ? task.error : '') || (task.pendingAction ? '이전 요청의 결과를 확인하고 있습니다. 최신 확인으로 작업 상태를 확인해 주세요.' : '');
      // 화면에서만 생긴 오류는 닫을 수 있다. 서버에 남은 오류는 다음 작업이나 최신 확인으로 지워진다.
      if (error) card.append(errorBlock(error, detail, { sessionId, onClose: localMessage && !fromServer ? () => { taskErrors.delete(task.id); renderTasks(); } : null }));
      // 시간 초과 등으로 병합·리베이스가 중간에 멈춰 작업이 막혔으면 되돌릴 수 있게 한다.
      if (error && ['task-git-operation', 'task-recovery-required'].includes(detail.reason) && task.state !== 'cleaned')
        card.append(actionButton('진행 중인 Git 작업 취소', 'abort', task, { disabled: running > 0, reason: running > 0 ? '세션이 작업 중입니다.' : '' }));
      // 기준 반영 충돌은 작업 세션에 해결을 맡길 수 있다. 세션이 쉬고 있을 때만 보낸다.
      if (error && detail.reason === 'task-conflict' && sessionId && ['working', 'review'].includes(task.state)) {
        const ask = actionButton('세션에 충돌 해결 요청', 'resolve-conflict', task, { disabled: running > 0, reason: running > 0 ? '세션이 작업 중입니다.' : '' });
        ask.dataset.sessionId = sessionId;
        card.append(ask);
      }
      list.append(card);
    }
    const restored = keep?.id && [...list.querySelectorAll('.task-card')].find(item => item.dataset.taskId === keep.id);
    if (restored) {
      if (keep.card) { restored.tabIndex = -1; restored.focus({ preventScroll: true }); }
      else ([...restored.querySelectorAll('[data-task-action]')].find(item => item.dataset.taskAction === keep.action && item.textContent === keep.label)
        || restored.querySelector('summary'))?.focus({ preventScroll: true });
    }
    if (openMenu) [...list.querySelectorAll('.task-card')].find(item => item.dataset.taskId === openMenu)?.querySelector('.task-more')?.setAttribute('open', '');
  }

  function renderFilter() {
    for (const button of document.querySelectorAll('#tasks-filter [data-task-filter]')) {
      button.setAttribute('aria-pressed', String(button.dataset.taskFilter === filter));
      const count = button.querySelector('[data-task-count]');
      const n = tasks.filter(TASK_FILTERS[button.dataset.taskFilter]).length;
      if (count) count.textContent = n ? String(n) : '';
    }
  }

  function setFilter(value) {
    if (!TASK_FILTERS[value] || value === filter) return;
    filter = value;
    try { localStorage.setItem(FILTER_KEY, value); } catch { /* 필터를 기억하지 못해도 목록은 보인다. */ }
    renderTasks();
  }

  function pullLink(pull, label) {
    const link = node('a', 'task-pull-link', `${label} #${pull.number}`);
    try {
      const url = new URL(pull.url);
      if (url.protocol === 'https:') link.href = url.href;
    } catch { /* Invalid server-provided links are not rendered as links. */ }
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function issueLine(issue) {
    const line = node('p', 'task-issue');
    line.dataset.state = issue.state || 'unknown';
    const label = `이슈 #${issue.number} · ${issue.state === 'closed' ? '닫힘' : '열림'}`;
    let link = node('span', '', label);
    try {
      const url = new URL(issue.url);
      if (url.protocol === 'https:') { link = node('a', 'task-pull-link', label); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    } catch { /* Invalid server-provided links are not rendered as links. */ }
    line.append(link);
    if (issue.title) line.append(node('span', '', ` ${issue.title}`));
    if (issue.error) {
      line.append(node('span', 'task-issue-error', ` · 상태 확인 실패: ${issue.error}`));
      appendLogin(line, issue.errorReason);
    }
    return line;
  }

  function openIssue(task) {
    if (!task || pendingTasks.has(task.id) || issueBusy) return;
    issueTaskId = task.id;
    issueForm?.reset();
    $('task-issue-summary').textContent = `${task.title}\n${task.branch} → ${task.targetBranch}`;
    $('task-issue-title').value = task.title || '';
    updateIssueForm();
    showError('task-issue-error');
    issueDialog?.showModal();
    $('task-issue-number')?.focus();
  }

  function updateIssueForm() {
    const create = $('task-issue-mode')?.value === 'create';
    $('task-issue-number-row').hidden = create;
    $('task-issue-number').required = !create;
    $('task-issue-title-row').hidden = !create;
    $('task-issue-title').required = create;
    $('task-issue-submit').textContent = issueBusy ? '처리 중…' : create ? '만들고 연결' : '연결';
    $('task-issue-submit').disabled = issueBusy;
  }

  async function submitIssue(event) {
    event.preventDefault();
    const task = getTask(issueTaskId);
    if (!task || issueBusy || !sameProject(projectPath)) return;
    if (issueForm && !issueForm.reportValidity()) return;
    const create = $('task-issue-mode').value === 'create';
    const body = create ? { create: true, title: $('task-issue-title').value.trim() } : { number: $('task-issue-number').value.trim() };
    const path = projectPath, epoch = projectEpoch, id = task.id;
    issueBusy = true;
    pendingTasks.add(id);
    showError('task-issue-error');
    updateIssueForm();
    renderTasks();
    try {
      const result = await api('POST', `/api/tasks/${encodeURIComponent(id)}/issue`, body);
      if (sameProject(path, epoch)) { replaceTask(result.task); issueDialog?.close(); }
    } catch (error) {
      if (sameProject(path, epoch)) showError('task-issue-error', requestError(error), error.reason);
    } finally {
      issueBusy = false;
      pendingTasks.delete(id);
      updateIssueForm();
      if (sameProject(path, epoch)) renderTasks();
    }
  }

  async function unlinkIssue(task) {
    if (!task?.issue || pendingTasks.has(task.id)) return;
    if (!confirm(`이슈 #${task.issue.number} 연결을 해제할까요?\nGitHub 이슈와 이미 만든 PR은 그대로 둡니다.`)) return;
    const path = projectPath, epoch = projectEpoch, id = task.id;
    pendingTasks.add(id);
    taskErrors.delete(id);
    renderTasks();
    try {
      const result = await api('DELETE', `/api/tasks/${encodeURIComponent(id)}/issue`);
      if (sameProject(path, epoch)) replaceTask(result.task);
    } catch (error) {
      taskErrors.set(id, { message: requestError(error), reason: error.reason, hint: error.hint, raw: error.raw, action: '이슈 연결 해제' });
    } finally {
      pendingTasks.delete(id);
      if (sameProject(path, epoch)) renderTasks();
    }
  }

  function invalidateProject() {
    generation++;
    projectEpoch++;
    projectPath = null;
    tasks = [];
    statuses.clear();
    context = null;
    resetSettings();
    loading = false;
    if (createDialog?.open) createDialog.close();
    if (finishDialog?.open) finishDialog.close();
    if (issueDialog?.open) issueDialog.close();
    workspace.reset();
    updateToolbar();
  }

  function cancelCreation() {
    createProject = null;
    createTabId = null;
    workbranchPicker.reset();
    if (createDialog?.open) createDialog.close();
  }

  // GitHub에서 직접 병합한 PR도 알아차리도록, 탭을 열거나 목록을 다시 읽을 때 검토 대기 작업의 PR 상태를 확인한다.
  // 같은 작업은 몇 분에 한 번만 묻고, 실패해도 카드 오류로 남기지 않는다(최신 확인을 누르면 사유를 볼 수 있다).
  async function checkReviewTasks(path, request) {
    const due = tasks.filter(task => task.state === 'review' && !task.pendingAction && !pendingTasks.has(task.id)
      && Date.now() - (reviewChecks.get(task.id) || 0) > REVIEW_CHECK_MS);
    for (const task of due) reviewChecks.set(task.id, Date.now());
    const results = await Promise.allSettled(due.map(task => api('POST', `/api/tasks/${encodeURIComponent(task.id)}/refresh`, {})));
    if (request !== generation || !sameProject(path)) return;
    let changed = false;
    results.forEach(result => {
      const next = result.status === 'fulfilled' ? result.value?.task : null;
      if (!next) return;
      if (next.state === 'merged') mergedNotice.add(next.id);
      replaceTask(next);
      changed = true;
    });
    if (changed) renderTasks();
  }

  async function loadTasks(path = getProjectPath(), options = {}) {
    if (!path) { invalidateProject(); return; }
    const changed = path !== projectPath;
    const request = ++generation;
    projectPath = path;
    if (changed) {
      projectEpoch++;
      tasks = [];
      statuses.clear();
      context = null;
      resetSettings();
      if (createDialog?.open) createDialog.close();
      if (finishDialog?.open) finishDialog.close();
      if (issueDialog?.open) issueDialog.close();
    }
    loading = true;
    showError('tasks-error');
    updateToolbar();
    renderTasks();
    renderContext();
    const requests = [api('GET', `/api/tasks?path=${encodeURIComponent(path)}`)];
    // 최신 상태 확인을 누르면 서버가 방금 받은 fetch를 다시 쓰지 않고 새로 받는다.
    if (!options.localOnly) requests.push(api('GET', `/api/tasks/context?path=${encodeURIComponent(path)}${options.manual ? '&refresh=1' : ''}`));
    const results = await Promise.allSettled(requests);
    if (request !== generation || !sameProject(path)) return;
    const [taskResult, contextResult] = results;
    if (taskResult.status === 'fulfilled') {
      tasks = Array.isArray(taskResult.value?.tasks) ? taskResult.value.tasks : [];
      if (options.manual) {
        const targets = tasks.filter(task => task.state !== 'cleaned');
        const refreshed = await Promise.allSettled(targets.map(task => api('POST', `/api/tasks/${encodeURIComponent(task.id)}/refresh`, {})));
        if (request !== generation || !sameProject(path)) return;
        for (let index = 0; index < refreshed.length; index++) {
          const result = refreshed[index], id = targets[index].id;
          if (result.status === 'fulfilled') {
            replaceTask(result.value.task);
            if (!result.value.task?.pendingAction) uncertainTasks.delete(id);
            taskErrors.delete(id);
          } else taskErrors.set(id, { message: requestError(result.reason), reason: result.reason?.reason, hint: result.reason?.hint, raw: result.reason?.raw, action: '최신 확인' });
        }
      }
      if (options.manual && uncertainCreates.has(path)) {
        uncertainCreates.delete(path);
        showError('tasks-error', '작업 목록을 확인했습니다. 이미 생성된 작업이 없는지 확인한 뒤 새 작업을 만들어 주세요.');
      }
      if (!options.manual && !options.localOnly) void checkReviewTasks(path, request);
    } else showError('tasks-error', requestError(taskResult.reason), taskResult.reason?.reason);
    if (contextResult?.status === 'fulfilled') {
      context = contextResult.value?.context || contextResult.value;
      settings = gitflowSettings(contextResult.value?.settings || context?.settings);
      finishDefault = contextResult.value?.finishMode || 'pr';
    }
    else if (contextResult) context = { error: requestError(contextResult.reason), reason: contextResult.reason?.reason, freshness: { state: 'error' } };
    loading = false;
    updateToolbar();
    renderTasks();
    renderContext();
    updateCreatePreview();
    if (taskResult.status === 'fulfilled') { void loadStatuses(); void workspace.load(path); }
  }

  function resetSettings() {
    settingsGeneration++;
    settings = gitflowSettings();
    finishDefault = 'pr';
    settingsProject = null;
    settingsBusy = false;
    settingsLoading = false;
    settingsReadFailed = false;
    if (settingsDialog?.open) settingsDialog.close();
  }

  function updateSettingsControls() {
    for (const key of GITFLOW_FIELDS) if ($(`task-settings-${key}`)) $(`task-settings-${key}`).disabled = settingsBusy || settingsLoading || settingsReadFailed;
    if ($('task-settings-finishMode')) $('task-settings-finishMode').disabled = settingsBusy || settingsLoading || settingsReadFailed;
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
    if ($('task-settings-finishMode')) $('task-settings-finishMode').value = finishDefault;
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
      finishDefault = result.finishMode || 'pr';
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
      const result = await api('PUT', `/api/tasks/settings?path=${encodeURIComponent(path)}`, { settings: value, finishMode: $('task-settings-finishMode')?.value || 'pr' });
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
    // 어느 폴더에서 일하게 되는지 세부 설정을 펼치지 않아도 보이게 한다.
    if ($('task-worktree-hint')) {
      const project = getProjectPath() || '';
      const folder = $('task-worktree-name')?.value.trim() || 'task-<작업ID>';
      $('task-worktree-hint').textContent = existing
        ? (selected?.cwd ? `선택한 브랜치의 작업 폴더에서 이어 작업합니다: ${selected.cwd}` : '선택한 브랜치의 작업 폴더를 새로 열어 작업합니다.')
        : inPlace
          ? `원본 폴더(${project})를 새 작업 브랜치로 바꿔 작업합니다. 이 폴더를 쓰는 다른 세션도 바뀐 브랜치를 보게 됩니다. 원본 폴더를 이미 쓰고 있으면 워크트리를 만들지 묻습니다.`
          : `별도 폴더 ${project ? project.replace(/[\\/]+$/, '') + '.agenthub' : '<프로젝트>.agenthub'}${project.includes('\\') ? '\\' : '/'}${folder}에서 작업합니다. 원본 폴더와 브랜치는 그대로입니다.`;
    }
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
      : taskBranchPreview(type, $('task-version')?.value.trim(), settings, $('task-branch-name')?.value.trim(), $('task-title')?.value || '');
    // 세부 설정을 펼치지 않아도 만들어질 브랜치 이름을 보여 준다.
    if ($('task-branch-summary')) $('task-branch-summary').textContent = existing
      ? selected ? `브랜치 ${selected.name} 이어서 사용` : '기존 작업 브랜치를 세부 설정에서 고르세요'
      : `브랜치 ${taskBranchFullName(type, $('task-version')?.value.trim(), settings, $('task-branch-name')?.value.trim(), $('task-title')?.value || '')} · 세부 설정에서 바꿀 수 있습니다`;
    if ($('task-gitflow-summary')) $('task-gitflow-summary').textContent = `기준: ${settings.main} / ${settings.develop}`;
    workspace.updateCreate({ existing, inPlace });
    if ($('task-create-hint')) $('task-create-hint').textContent = inPlace
      ? `원격 ${settings.main}과 기준 브랜치를 확인한 뒤 원본 폴더를 새 작업 브랜치로 바꾸고 세션을 연결합니다. 원본 폴더에 커밋하지 않은 변경이 없어야 하며, 정리하면 원래 브랜치로 돌아갑니다.`
      : `원격 ${settings.main}과 기준 브랜치를 확인한 뒤 작업 브랜치·폴더·세션을 연결합니다.`;
  }

  function updateCreateSubmit() {
    const existing = $('task-workbranch-mode')?.value === 'existing';
    if ($('task-create-submit')) $('task-create-submit').disabled = createBusy || settingsBusy || taskAssistant.busy() || !taskAssistant.ready() || uncertainCreates.has(createProject) || (existing && !workbranchPicker.ready()) || !hasAgent();
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

  // 저장된 값이 지금 목록에 있을 때만 고른다. 없어진 선택지는 기본값으로 둔다.
  function selectIfPresent(id, value) {
    const select = $(id);
    if (select && typeof value === 'string' && [...select.options].some(option => option.value === value)) select.value = value;
  }

  // CLI 실행 파일과 버전을 확인한 AI만 담당 AI로 고를 수 있다.
  function fillAgentOptions() {
    const select = $('task-agent');
    if (!select) return;
    const agents = data?.status?.agents ?? {};
    const available = TASK_AGENTS.filter(([agent]) => agents[agent]?.path && agents[agent]?.version);
    select.replaceChildren(...(available.length ? available : [['', '사용할 수 있는 AI CLI가 없습니다']]).map(([value, label]) => {
      const option = node('option', '', label); option.value = value; return option;
    }));
    select.disabled = !available.length;
  }

  function hasAgent() {
    return Boolean($('task-agent')?.value);
  }

  // 프로젝트 설정의 새 작업 기본값(AI·권한·워크트리 사용). 프로젝트 목록에 함께 온다.
  function projectDefaults(path = getProjectPath()) {
    const norm = value => String(value ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    return data?.projects?.find(project => norm(project.path) === norm(path))?.settings?.defaults ?? {};
  }

  // 프로젝트 기본값 → 지난번 선택 → 기존 기본값 순으로 고른다.
  function applyCreatePrefs() {
    const prefs = loadCreatePrefs();
    const defaults = projectDefaults();
    fillAgentOptions();
    // 워크트리 사용도 기억한다. 원본 폴더를 골랐는데 이미 쓰고 있으면 만들 때 워크트리로 진행할지 묻는다.
    const worktree = defaults.isolate != null ? (defaults.isolate ? 'create' : 'none') : prefs.worktree === 'create' ? 'create' : 'none';
    if ($('task-worktree')) $('task-worktree').value = worktree;
    if (prefs.type !== 'release') selectIfPresent('task-type', prefs.type);
    selectIfPresent('task-agent', prefs.agent);
    selectIfPresent('task-agent', defaults.agent);
    updateAgentControls();
    const agent = $('task-agent')?.value;
    if (prefs.agent === agent) selectIfPresent('task-permission', prefs.permission);
    selectIfPresent('task-permission', defaults.permission?.[agent]);
    if ($('task-model') && typeof prefs.model === 'string') $('task-model').value = prefs.model;
    if ($('task-effort')) {
      fillEfforts('task-effort', $('task-agent')?.value || 'codex', $('task-model')?.value);
      selectIfPresent('task-effort', prefs.effort);
    }
  }

  // prefill: 팀 작업에서 시작할 때 채울 { title, content, issue }. 사용자가 확인한 뒤 만든다.
  function openNewTask(prefill = null) {
    const path = getProjectPath();
    if (!path || path !== projectPath || createBusy || settingsBusy || uncertainCreates.has(path)) return false;
    createProject = path;
    createTabId = navigation?.graphTabId;
    createIssue = prefill?.issue ?? null;
    createForm?.reset();
    workbranchPicker.reset();
    showError('task-create-error');
    applyCreatePrefs();
    workspace.resetCreate();
    void workspace.prepareCreate(path);
    taskAssistant.open();
    if ($('task-create-heading')) $('task-create-heading').textContent = createIssue ? `새 작업 · 이슈 #${createIssue.number}` : '새 작업';
    if (prefill) {
      if ($('task-title')) $('task-title').value = prefill.title ?? '';
      if ($('task-content')) $('task-content').value = prefill.content ?? '';
      taskAssistant.useManual();
    }
    updateCreatePreview();
    updateCreateSubmit();
    if (!hasAgent()) showError('task-create-error', '확인된 AI CLI가 없습니다. 설정에서 Codex나 Claude Code CLI를 설치하거나 경로를 지정해 주세요.');
    createDialog?.showModal();
    (prefill ? $('task-title') : $('task-assistant-prompt') || $('task-title'))?.focus();
    return true;
  }

  // 팀 작업 탭에서 맡은 작업을 새 작업으로 시작한다. 작업 탭으로 옮겨 새 작업 창을 채워 연다.
  async function startFromIssue({ projectPath: path, title, content, issue }) {
    if (!path || !issue?.number) return;
    showTasksTab();
    if (path !== projectPath || !tasks.length) await loadTasks(path, { localOnly: true });
    if (!sameProject(path)) return;
    if (tasks.some(task => task.state !== 'cleaned' && task.issue?.number === issue.number && task.issue.repo?.toLowerCase() === issue.repo?.toLowerCase())) {
      const linked = tasks.find(task => task.issue?.number === issue.number);
      throw Error(`이슈 #${issue.number}은 이미 "${linked.title}" 작업에 연결되어 있습니다. 작업 탭에서 이어서 진행하세요.`);
    }
    if (!openNewTask({ title, content, issue })) throw Error('지금은 새 작업을 만들 수 없습니다. 작업 탭에서 진행 중인 요청이 끝난 뒤 다시 시도하세요.');
  }

  async function createTask(event) {
    event.preventDefault();
    if (createBusy || settingsBusy || taskAssistant.busy() || !taskAssistant.ready() || !sameProject(createProject) || createTabId !== navigation?.graphTabId || uncertainCreates.has(createProject)) return;
    const existing = $('task-workbranch-mode')?.value === 'existing';
    if (existing && !workbranchPicker.ready()) {
      showError('task-create-error', workbranchPicker.validationError());
      return;
    }
    if (!hasAgent()) return;
    if (createForm && !createForm.checkValidity()) {
      if ($('task-create-advanced')) $('task-create-advanced').open = true;
      createForm.reportValidity();
      return;
    }
    const path = createProject;
    const tabId = createTabId;
    const epoch = projectEpoch;
    const title = $('task-title')?.value.trim();
    if (!title) { showError('task-create-error', '작업 제목을 입력해 주세요.'); return; }
    const payload = {
      projectPath: path, title, type: $('task-type')?.value || 'feature',
      ...(tabId ? { tabId } : {}),
      agent: $('task-agent')?.value || 'codex',
      permission: $('task-permission')?.value || 'workspace-write',
      content: $('task-content')?.value.trim() || '', acceptance: $('task-acceptance')?.value.trim() || '',
      requestId: taskAssistant.creationId(),
    };
    if (existing) payload.workBranch = workbranchPicker.selected().name;
    else if (payload.type === 'release') payload.version = $('task-version')?.value.trim();
    if (!existing && $('task-worktree')?.value === 'none') payload.worktree = false;
    const chosenWorktree = payload.worktree === false ? 'none' : 'create';
    if (!existing && $('task-branch-name')?.value.trim()) payload.branchName = $('task-branch-name').value.trim();
    if (!existing && payload.worktree !== false && $('task-worktree-name')?.value.trim()) payload.worktreeName = $('task-worktree-name').value.trim();
    if ($('task-model')?.value.trim()) payload.model = $('task-model').value.trim();
    if ($('task-effort')?.value) payload.effort = $('task-effort').value;
    if ($('task-role')?.value.trim()) payload.role = $('task-role').value.trim();
    Object.assign(payload, workspace.createPayload(payload));
    createBusy = true;
    taskAssistant.setCreating(true);
    showError('task-create-error');
    const submit = $('task-create-submit');
    if (submit) { submit.disabled = true; submit.textContent = '브랜치와 세션 준비 중…'; }
    updateToolbar();
    try {
      // 원본 폴더를 이미 쓰고 있으면 워크트리를 만들어 진행할지 묻는다.
      if (payload.worktree === false) {
        const inPlace = await api('GET', `/api/tasks/in-place?path=${encodeURIComponent(path)}`);
        if (!sameProject(path, epoch)) return;
        if (!inPlace.available) {
          const answer = await confirmAction({ title: '원본 폴더를 이미 쓰고 있습니다', subject: title, warnings: [inPlace.message],
            changes: [`워크트리(별도 작업 폴더 ${path.replace(/[\\/]+$/, '')}.agenthub 아래)를 만들어 이 작업을 진행합니다.`],
            keeps: ['원본 폴더와 지금 브랜치'], confirmLabel: '워크트리로 만들기' });
          if (!answer.ok || !sameProject(path, epoch)) return;
          delete payload.worktree;
          if ($('task-worktree')) $('task-worktree').value = 'create';
          updateCreatePreview();
        }
      }
      const result = await api('POST', '/api/tasks', payload);
      saveCreatePrefs({
        ...loadCreatePrefs(),
        // 원본 폴더를 이미 써서 이번만 워크트리로 바꿨어도 사용자가 고른 값을 기억한다.
        ...(existing ? {} : { worktree: chosenWorktree, type: payload.type }),
        agent: payload.agent, permission: payload.permission, model: payload.model || '', effort: payload.effort || '',
      });
      // 팀 작업에서 시작했으면 그 이슈를 작업에 연결한다. 연결에 실패해도 작업은 남기고 카드에 알린다.
      const issue = createIssue;
      let issueError = null;
      if (issue && !result.task?.issue) {
        try { result.task = (await api('POST', `/api/tasks/${encodeURIComponent(result.task.id)}/issue`, { number: String(issue.number) })).task; }
        catch (error) { issueError = { message: `작업은 만들었지만 이슈 #${issue.number}을 연결하지 못했습니다: ${requestError(error)}`, reason: error.reason }; }
      }
      await reloadSessions();
      if (sameProject(path, epoch)) {
        replaceTask(result.task);
        if (issueError) taskErrors.set(result.task.id, issueError);
        if (result.startError) taskErrors.set(result.task.id, { message: typeof result.startError === 'string' ? result.startError : result.startError.message || '작업은 만들어졌지만 시작하지 못했습니다. 세션에서 확인해 주세요.' });
        renderTasks();
        createDialog?.close();
        const sessionId = result.session?.id || result.task?.sessionIds?.at(-1);
        if (sessionId && tabId === navigation?.graphTabId) {
          await selectSession(sessionId);
          // 첫 요청은 바로 보내지 않고 입력창에 채워 둔다. 사용자가 확인한 뒤 보낸다.
          if (data?.current?.id === sessionId && !result.reused) fillPrompt([payload.title, payload.content, payload.acceptance ? `완료 기준:\n${payload.acceptance}` : ''].filter(Boolean).join('\n\n'));
        }
      }
    } catch (error) {
      if (error.outcomeUnknown) uncertainCreates.add(path);
      if (sameProject(path, epoch)) showErrorDetail('task-create-error', error.outcomeUnknown ? { message: unknownMessage('작업 생성') } : error, '작업 생성');
    } finally {
      createBusy = false;
      taskAssistant.setCreating(false);
      if (submit) { submit.disabled = uncertainCreates.has(path); submit.textContent = '만들기'; }
      updateToolbar();
    }
  }

  // 스크롤 영역 아래쪽에 자리가 없으면 메뉴를 위로 펼친다.
  function placeMenu(more) {
    more.classList.remove('up');
    if (!more.open) return;
    const menu = more.querySelector('.task-more-menu');
    const area = more.closest('.tab-panel') || document.documentElement;
    const bottom = Math.min(area.getBoundingClientRect().bottom, innerHeight);
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > bottom && more.getBoundingClientRect().top - rect.height - 4 >= Math.max(area.getBoundingClientRect().top, 0)) more.classList.add('up');
  }

  function fillPrompt(text) {
    const input = $('s-prompt');
    if (!input || input.value.trim()) return;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  function openFinish(task, options = {}) {
    if (!task || pendingTasks.has(task.id) || uncertainTasks.has(task.id) || task.pendingAction || finishBusy) return;
    finishTaskId = task.id;
    finishProject = projectPath;
    finisher.open(task, options);
  }

  const finishTask = event => finisher.submit(event);

  // 되돌리기 어려운 작업 동작 전에 바뀌는 것과 남는 것을 보여 주고 확인을 받는다.
  async function confirmTaskAction(action, task) {
    const develop = task.gitflow?.develop || DEFAULT_GITFLOW.develop, main = task.gitflow?.main || DEFAULT_GITFLOW.main;
    if (action === 'cleanup' && task.state === 'cleaned') return true; // 정리 뒤 남은 폴더만 다시 지운다.
    if (action === 'cleanup') {
      const changes = [], keeps = ['작업·대화 기록', `원격 브랜치 ${task.remote || 'origin'}/${task.branch}`, task.pull?.number ? `PR #${task.pull.number}` : ''];
      if (task.inPlace) changes.push(`원본 폴더를 ${task.previousBranch || task.targetBranch} 브랜치로 되돌립니다.`);
      else if (task.ownsWorktree === false) keeps.push(`기존 작업 폴더 ${task.cwd}`);
      else changes.push(workspace.reuseOn() ? `작업 폴더를 지우지 않고 재사용 대기 폴더로 남깁니다(자리가 없거나 옮길 수 없으면 삭제): ${task.cwd}` : `작업 폴더를 삭제합니다: ${task.cwd}`);
      if (task.ownsBranch === false) keeps.push(`기존 로컬 브랜치 ${task.branch}`);
      else changes.push(`로컬 브랜치 ${task.branch}를 삭제합니다.`);
      return (await confirmAction({ title: '작업 폴더 정리', subject: task.title, changes, keeps,
        warnings: ['커밋하지 않은 변경이나 게시하지 않은 커밋이 있으면 정리를 멈춥니다.'], confirmLabel: '정리', danger: true })).ok;
    }
    if (action === 'push-target') {
      const completion = task.completion || {};
      const changes = [completion.publishState !== 'done' ? `${task.targetBranch} → ${task.remote}/${task.targetBranch}${completion.targetHead ? ` (${completion.targetHead.slice(0, 7)})` : ''}` : '',
        completion.developHead && completion.developPublishState !== 'done' ? `${develop} → ${task.remote}/${develop} (${completion.developHead.slice(0, 7)})` : ''];
      return (await confirmAction({ title: '대상 브랜치 푸시', subject: task.title, changes, keeps: ['강제 푸시는 하지 않습니다. 원격이 앞서 있으면 거절됩니다.'], confirmLabel: '푸시' })).ok;
    }
    if (action === 'backup') {
      return (await confirmAction({ title: '원격에 백업', subject: task.title,
        changes: [`작업 브랜치 ${task.branch} → ${task.remote || 'origin'}/${task.branch}`],
        keeps: [`대상 브랜치 ${task.targetBranch}와 PR (만들거나 바꾸지 않습니다)`, '강제 푸시는 하지 않습니다. 원격이 앞서 있으면 거절됩니다.'], confirmLabel: '푸시' })).ok;
    }
    if (action === 'abort') {
      return (await confirmAction({ title: '진행 중인 Git 작업 취소', subject: task.title,
        changes: [`작업 폴더에서 멈춘 병합·리베이스를 취소하고 시작 전 커밋으로 되돌립니다: ${task.cwd}`],
        keeps: ['이미 만든 커밋과 브랜치', 'Git 잠금 파일(index.lock)은 지우지 않습니다.'],
        warnings: ['병합 중에 직접 고친 내용은 사라집니다.'], confirmLabel: '취소하고 되돌리기', danger: true })).ok;
    }
    if (action === 'develop') {
      const local = task.completion?.kind === 'local';
      return (await confirmAction({ title: `${develop}에 역반영`, subject: task.title,
        changes: [local ? `${task.branch}를 로컬 ${develop}에 병합합니다.` : `GitHub에 ${main} → ${develop} 반영 PR을 만듭니다.`],
        keeps: [local ? '충돌하면 병합을 취소하고 실행 전 상태로 되돌립니다.' : '이미 열린 반영 PR이 있으면 그 PR을 연결합니다.'],
        confirmLabel: local ? '병합' : 'PR 만들기' })).ok;
    }
    return true;
  }

  // 기준 반영이 충돌로 취소됐을 때 작업 세션에 대상 브랜치를 병합하고 충돌을 해결하도록 요청한다.
  async function askConflict(task, sessionId) {
    if (!sessionId || pendingTasks.has(task.id)) return;
    const local = taskErrors.get(task.id);
    const files = (local && typeof local === 'object' ? local.conflicts : null) || [];
    const prompt = [`작업 브랜치에 ${task.remote || 'origin'}/${task.targetBranch}의 최신 변경을 병합하다 충돌이 나서 AgentHub가 병합을 취소했습니다.`,
      `git fetch 후 ${task.remote || 'origin'}/${task.targetBranch}를 이 브랜치에 병합하고, 충돌을 양쪽 의도를 살려 해결한 뒤 테스트하고 병합 커밋을 만들어 주세요.`,
      files.length ? `충돌 파일: ${files.join(', ')}` : ''].filter(Boolean).join('\n');
    if (!confirm(`작업 세션에 다음 요청을 보낼까요?\n\n${prompt}`)) return;
    try {
      await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { prompt });
      taskErrors.set(task.id, { notice: true, message: '세션에 충돌 해결을 요청했습니다. 세션이 병합을 마치면 최신 상태 확인을 눌러 주세요.' });
    } catch (error) { taskErrors.set(task.id, { message: requestError(error), reason: error.reason, hint: error.hint, action: '세션에 충돌 해결 요청' }); }
    renderTasks();
  }

  async function runTaskAction(action, task) {
    if (!task || pendingTasks.has(task.id)) return;
    if (!['refresh', 'abort'].includes(action) && (uncertainTasks.has(task.id) || task.pendingAction)) return;
    const confirmed = await confirmTaskAction(action, task);
    if (!confirmed) return;
    if (!sameProject(projectPath) || pendingTasks.has(task.id)) return;
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
      if (sameProject(path, epoch)) void loadStatuses([id]);
    } catch (error) {
      if (error.outcomeUnknown && action !== 'refresh') uncertainTasks.set(id, action);
      const label = action === 'abort' ? '진행 중인 Git 작업 취소' : action === 'cleanup' ? '작업 폴더 정리' : action === 'sync' ? '기준 변경 반영' : action === 'develop' ? '개발 브랜치 반영' : action === 'push-target' ? '대상 브랜치 푸시' : action === 'backup' ? '원격에 백업' : '최신 확인';
      taskErrors.set(id, error.outcomeUnknown ? { message: unknownMessage(label), action: label } : { message: requestError(error), reason: error.reason, hint: error.hint, raw: error.raw, conflicts: error.conflicts, action: label });
    } finally {
      pendingTasks.delete(id);
      if (sameProject(path, epoch)) renderTasks();
    }
  }

  // 작업 삭제 확인 내용. 지우는 것과 남는 것을 함께 알린다.
  function deleteSummary(task, sessionCount) {
    const changes = [], keeps = ['원격 브랜치와 PR'];
    if (sessionCount) changes.push(`연결된 세션 ${sessionCount}개를 멈추고 삭제합니다. 열려 있는 세션 화면도 닫힙니다.`);
    changes.push('작업 카드와 작업 기록을 지웁니다.');
    if (task.state === 'cleaned') keeps.push('이미 정리한 작업이라 폴더는 없습니다.');
    else if (task.inPlace) keeps.push('원본 폴더 (원본 폴더에서 한 작업)');
    else if (task.ownsWorktree === false) keeps.push(`선택했던 기존 작업 폴더 ${task.cwd}`);
    else changes.push(workspace.reuseOn() ? `작업 폴더에 변경이 없으면 재사용 대기 폴더로 남기고, 아니면 지웁니다: ${task.cwd}` : `작업 폴더를 지웁니다: ${task.cwd}`);
    return { changes, keeps };
  }

  // 작업을 지운다. 실행 중인 세션이나 커밋하지 않은 변경이 있으면 그 자리에서 계속할지 묻는다.
  async function deleteTask(task) {
    if (!task || pendingTasks.has(task.id)) return;
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const ids = Array.isArray(task.sessionIds) ? task.sessionIds : [];
    const sessionCount = sessions.filter(session => ids.includes(session.id) || session.taskId === task.id).length;
    const branchChoice = task.state !== 'cleaned' && task.ownsBranch !== false && task.branch;
    const answer = await confirmAction({ title: '작업 삭제', subject: task.title, ...deleteSummary(task, sessionCount),
      checkbox: branchChoice ? { label: `로컬 브랜치 ${task.branch}도 지우기 · 게시하지 않은 커밋은 되돌릴 수 없습니다`, checked: false } : null,
      confirmLabel: '삭제', danger: true });
    if (!answer.ok || pendingTasks.has(task.id)) return;
    const query = new URLSearchParams();
    if (branchChoice && answer.checked) query.set('branch', 'delete');
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
          const again = error.reason === 'running' ? (await confirmAction({ title: '실행 중인 세션 멈추고 삭제', subject: task.title,
              changes: ['실행 중인 세션을 멈춥니다. 진행 중이던 응답은 끝까지 받지 못합니다.', '작업을 삭제합니다.'], confirmLabel: '멈추고 삭제', danger: true })).ok
            : error.reason === 'task-dirty' ? (await confirmAction({ title: '커밋하지 않은 변경 버리기', subject: task.title,
              changes: ['작업 폴더의 커밋하지 않은 변경을 버리고 폴더를 지웁니다.'], warnings: [error.message, '버린 변경은 되돌릴 수 없습니다.'],
              confirmLabel: '변경 버리고 삭제', danger: true })).ok
            : null;
          if (again === null) throw error;
          if (!again) return;
          query.set('force', '1');
        }
      }
      uncertainTasks.delete(id);
      if (sameProject(path, epoch)) tasks = tasks.filter(item => item.id !== id);
      await reloadSessions();
      if (result?.warning) showErrorToast({ message: result.warning }, { action: '작업 삭제 마무리' });
    } catch (error) {
      taskErrors.set(id, { message: requestError(error), reason: error.reason, hint: error.hint, raw: error.raw, action: '작업 삭제' });
    } finally {
      pendingTasks.delete(id);
      if (sameProject(path, epoch)) renderTasks();
    }
  }

  // 작업 그만두기 확인 내용. 원격까지 지우므로 무엇이 사라지는지 모두 보여 준다.
  function abandonSummary(task, sessionCount) {
    const changes = [], keeps = [];
    if (sessionCount) changes.push(`연결된 세션 ${sessionCount}개를 멈추고 삭제합니다.`);
    if (task.inPlace) changes.push(`원본 폴더를 ${task.previousBranch || task.targetBranch} 브랜치로 되돌립니다.`);
    else if (task.ownsWorktree === false) keeps.push(`선택했던 기존 작업 폴더 ${task.cwd}`);
    else changes.push(`작업 폴더를 지웁니다: ${task.cwd}`);
    if (task.ownsBranch === false) keeps.push(`기존 브랜치 ${task.branch} (로컬·원격)`);
    else changes.push(`로컬 브랜치 ${task.branch}를 지웁니다.`, `원격 브랜치 ${task.remote || 'origin'}/${task.branch}가 있으면 지웁니다.`);
    if (task.pull?.number && task.pull.state === 'OPEN') changes.push(`열린 PR #${task.pull.number}을 닫습니다.`);
    if (task.issue?.number) changes.push(`이슈 #${task.issue.number}에서 내 담당을 해제합니다. 이슈는 닫지 않습니다.`);
    changes.push('작업 카드와 작업 기록을 지웁니다.');
    return { changes, keeps };
  }

  async function abandonTask(task) {
    if (!task || pendingTasks.has(task.id)) return;
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const ids = Array.isArray(task.sessionIds) ? task.sessionIds : [];
    const sessionCount = sessions.filter(session => ids.includes(session.id) || session.taskId === task.id).length;
    const answer = await confirmAction({ title: '작업 그만두기', subject: task.title, ...abandonSummary(task, sessionCount),
      warnings: ['게시하지 않은 커밋과 원격 브랜치는 되돌릴 수 없습니다.'], confirmLabel: '그만두기', danger: true });
    if (!answer.ok || pendingTasks.has(task.id)) return;
    const path = projectPath, epoch = projectEpoch, id = task.id;
    pendingTasks.add(id);
    taskErrors.delete(id);
    renderTasks();
    try {
      let result, force = false;
      for (;;) {
        try { result = await api('POST', `/api/tasks/${encodeURIComponent(id)}/abandon`, { force }); break; }
        catch (error) {
          if (force) throw error;
          const again = error.reason === 'running' ? (await confirmAction({ title: '실행 중인 세션 멈추고 그만두기', subject: task.title,
              changes: ['실행 중인 세션을 멈춥니다. 진행 중이던 응답은 끝까지 받지 못합니다.'], confirmLabel: '멈추고 그만두기', danger: true })).ok
            : error.reason === 'task-dirty' ? (await confirmAction({ title: '커밋하지 않은 변경 버리기', subject: task.title,
              changes: ['작업 폴더의 커밋하지 않은 변경을 버립니다.'], warnings: [error.message, '버린 변경은 되돌릴 수 없습니다.'],
              confirmLabel: '변경 버리고 그만두기', danger: true })).ok
            : null;
          if (again === null) throw error;
          if (!again) return;
          force = true;
        }
      }
      uncertainTasks.delete(id);
      if (sameProject(path, epoch)) tasks = tasks.filter(item => item.id !== id);
      await reloadSessions();
      if (result?.warning) showErrorToast({ message: result.warning }, { action: '작업 그만두기 마무리' });
    } catch (error) {
      taskErrors.set(id, error.outcomeUnknown ? { message: unknownMessage('작업 그만두기'), action: '작업 그만두기' } : { message: requestError(error), reason: error.reason, hint: error.hint, raw: error.raw, action: '작업 그만두기' });
      if (sameProject(path, epoch)) void loadTasks(path, { localOnly: true });
    } finally {
      pendingTasks.delete(id);
      if (sameProject(path, epoch)) renderTasks();
    }
  }

  async function newSession(task) {
    if (!task || pendingTasks.has(task.id) || uncertainTasks.has(task.id) || task.pendingAction) return;
    const path = projectPath;
    const tabId = navigation?.graphTabId;
    const epoch = projectEpoch;
    pendingTasks.add(task.id);
    taskErrors.delete(task.id);
    renderTasks();
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const ids = Array.isArray(task.sessionIds) ? task.sessionIds : [];
    const previous = sessions.find(session => session.id === ids.at(-1)) || sessions.find(session => session.taskId === task.id);
    const agent = previous?.agent || task.agent || 'codex';
    const payload = { agent, permission: previous?.permission || task.permission || (agent === 'claude' ? 'acceptEdits' : 'workspace-write'), ...(tabId ? { tabId } : {}) };
    for (const key of ['model', 'effort', 'role']) {
      const value = previous?.[key] ?? task[key];
      if (value) payload[key] = value;
    }
    try {
      const result = await api('POST', `/api/tasks/${encodeURIComponent(task.id)}/session`, payload);
      await reloadSessions();
      if (sameProject(path, epoch)) {
        replaceTask(result.task);
        if (result.session?.id && tabId === navigation?.graphTabId) await selectSession(result.session.id);
      }
    } catch (error) {
      if (error.outcomeUnknown) uncertainTasks.set(task.id, 'session');
      taskErrors.set(task.id, error.outcomeUnknown ? { message: unknownMessage('세션 생성'), action: '세션 추가' } : { message: requestError(error), reason: error.reason, hint: error.hint, raw: error.raw, action: '세션 추가' });
    } finally {
      pendingTasks.delete(task.id);
      if (sameProject(path, epoch)) renderTasks();
    }
  }

  $('tasks-new')?.addEventListener('click', () => openNewTask());
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
  $('task-worktree-name')?.addEventListener('input', updateCreatePreview);
  $('task-branch-name')?.addEventListener('input', updateCreatePreview);
  $('task-title')?.addEventListener('input', updateCreatePreview);
  $('task-agent')?.addEventListener('change', () => { if ($('task-model')) $('task-model').value = ''; updateAgentControls(); });
  $('task-model')?.addEventListener('change', () => { if ($('task-effort')) fillEfforts('task-effort', $('task-agent')?.value || 'codex', $('task-model').value); });
  createForm?.addEventListener('submit', createTask);
  createForm?.addEventListener('invalid', (event) => {
    const advanced = $('task-create-advanced');
    if (advanced?.contains(event.target)) advanced.open = true;
  }, true);
  finishForm?.addEventListener('submit', finishTask);
  createDialog?.addEventListener('cancel', event => { if (createBusy) event.preventDefault(); });
  createDialog?.addEventListener('close', () => { workbranchPicker.reset(); taskAssistant.close(); if (!createBusy) createIssue = null; });
  finishDialog?.addEventListener('cancel', event => { if (finishBusy) event.preventDefault(); });
  $('task-create-cancel')?.addEventListener('click', () => { if (!createBusy) createDialog?.close(); });
  $('task-finish-cancel')?.addEventListener('click', () => { if (!finishBusy) finishDialog?.close(); });
  document.querySelectorAll('[data-task-dialog-close]').forEach(button => button.addEventListener('click', () => {
    const dialog = button.closest('dialog');
    if ((dialog === createDialog && createBusy) || (dialog === finishDialog && finishBusy) || (dialog === issueDialog && issueBusy)) return;
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
    if (action === 'merge') { openFinish(task, { merge: true }); return; }
    if (action === 'delete') { void deleteTask(task); return; }
    if (action === 'abandon') { void abandonTask(task); return; }
    if (action === 'link-issue') { openIssue(task); return; }
    if (action === 'unlink-issue') { void unlinkIssue(task); return; }
    if (action === 'resolve-conflict') { void askConflict(task, button.dataset.sessionId); return; }
    if (workspace.handles(action)) { taskErrors.delete(task.id); void workspace.run(action, task, { setError: value => { taskErrors.set(task.id, value); renderTasks(); }, setPending: on => { if (on) pendingTasks.add(task.id); else pendingTasks.delete(task.id); renderTasks(); } }); return; }
    if (['refresh', 'sync', 'backup', 'cleanup', 'push-target', 'develop', 'abort'].includes(action)) void runTaskAction(action, task);
  });
  $('tasks-filter')?.addEventListener('click', event => {
    const button = event.target.closest('[data-task-filter]');
    if (button) setFilter(button.dataset.taskFilter);
  });
  issueForm?.addEventListener('submit', submitIssue);
  // 작업 탭을 열어 둔 동안에도 검토 대기 작업의 병합을 주기적으로 확인한다.
  setInterval(() => { if (projectPath && !loading && isTasksVisible()) void checkReviewTasks(projectPath, generation); }, REVIEW_CHECK_MS);
  $('task-issue-mode')?.addEventListener('change', updateIssueForm);
  updateToolbar();

  // 작업 만들기 진행 단계(원격 확인 → 작업 폴더 → 세션). 만드는 중인 같은 프로젝트의 버튼 글자로 보여 준다.
  function taskProgress({ projectPath: path, requestId, step } = {}) {
    const submit = $('task-create-submit');
    const key = value => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!createBusy || !submit || !step || key(path) !== key(createProject)) return;
    if (requestId && taskAssistant.creationId() && requestId !== taskAssistant.creationId()) return;
    submit.textContent = `${step}…`;
  }

  return {
    loadTasks, invalidateProject, renderTasks, cancelCreation, startFromIssue, taskProgress,
    async openReference(id, path = getProjectPath()) {
      await loadTasks(path, { localOnly: true });
      if (!sameProject(path)) return;
      // 필터에 가려진 작업을 열 때는 전체로 바꿔 보여 준다.
      const target = getTask(id);
      if (target && !TASK_FILTERS[filter](target)) setFilter('all');
      const card =[...(list?.querySelectorAll('.task-card') || [])].find(item => item.dataset.taskId === id);
      if (!card) throw Error('작업을 찾을 수 없습니다.');
      card.tabIndex = -1;
      card.focus({ preventScroll: true });
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    refreshIfVisible(path = getProjectPath()) { if (path === getProjectPath() && isTasksVisible()) void loadTasks(path); },
  };
}
