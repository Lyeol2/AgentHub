// 초안 생성은 작업 생성과 분리한다. 대화·편집 내용은 이 대화상자 안에서만 유지한다.
export function createTaskAssistant({ api, getContext, getStatus, fillModels, onDraft = () => {}, onState = () => {} }) {
  const $ = (id) => document.getElementById(id);
  const prompt = $('task-assistant-prompt');
  if (!prompt) return { open() {}, close() {}, setCreating() {}, useManual() {}, ready: () => true, busy: () => false, creationId: () => undefined };
  const fields = { title: 'task-title', content: 'task-content', acceptance: 'task-acceptance', agent: 'task-agent', type: 'task-type', version: 'task-version', branchName: 'task-branch-name', worktreeName: 'task-worktree-name' };
  let history = [], generation = 0, planning = false, creating = false, ready = false, mode = 'ai', requestId;
  const current = (context) => {
    const next = getContext();
    return next.active && context.projectPath === next.projectPath && context.tabId === next.tabId;
  };
  const readDraft = () => Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, $(id)?.value.trim() || '']));
  const error = (message = '') => { $('task-assistant-error').textContent = message; $('task-assistant-error').hidden = !message; };
  function sync() {
    const busy = planning || creating;
    $('task-assistant-panel').hidden = mode !== 'ai';
    $('task-create-draft').hidden = !ready;
    $('task-create-draft').disabled = busy;
    $('task-create-submit').hidden = !ready;
    $('task-create-ai').setAttribute('aria-pressed', String(mode === 'ai'));
    $('task-create-manual').setAttribute('aria-pressed', String(mode === 'manual'));
    for (const id of ['task-create-ai', 'task-create-manual', 'task-assistant-agent', 'task-assistant-model']) $(id).disabled = busy;
    prompt.disabled = busy;
    $('task-assistant-send').disabled = busy || !prompt.value.trim();
    $('task-assistant-send').textContent = history.length ? '초안 수정' : '초안 만들기';
    $('task-assistant-status').textContent = planning ? 'AI가 초안을 정리하고 있습니다…' : '';
    onState();
  }
  function showConversation() {
    const log = $('task-assistant-messages');
    log.replaceChildren(...history.map((message) => {
      const item = document.createElement('p');
      item.className = `task-assistant-message ${message.role}`;
      const author = document.createElement('strong');
      author.textContent = message.role === 'user' ? '나' : '작업 도우미';
      const content = document.createElement('span');
      content.textContent = message.content;
      item.append(author, content);
      return item;
    }));
    log.hidden = !history.length;
    log.scrollTop = log.scrollHeight;
  }
  function setMode(next) {
    if (planning || creating) return;
    mode = next;
    if (mode === 'manual') ready = true;
    sync();
    (mode === 'ai' ? prompt : $('task-title')).focus();
  }
  function updateProvider() {
    const agent = $('task-assistant-agent').value;
    if (getStatus()?.agents?.[agent]) fillModels('task-assistant-models', agent);
  }
  function open() {
    generation++;
    history = []; planning = false; creating = false; ready = false; mode = 'ai';
    requestId = globalThis.crypto.randomUUID();
    prompt.value = '';
    $('task-create-advanced').open = false;
    const agents = getStatus()?.agents;
    $('task-assistant-agent').value = agents?.codex?.path ? 'codex' : agents?.claude?.path ? 'claude' : 'codex';
    $('task-assistant-model').value = '';
    updateProvider(); error(); showConversation(); sync();
  }
  function close() { generation++; planning = false; creating = false; history = []; ready = false; error(); showConversation(); sync(); }
  async function ask() {
    const request = prompt.value.trim();
    const context = getContext();
    if (!request || request.length > 4000 || planning || creating || !context.active) return;
    const mine = ++generation;
    planning = true;
    error(); sync();
    try {
      const result = await api('POST', '/api/task-assistant/plan', {
        projectPath: context.projectPath, ...(context.tabId ? { tabId: context.tabId } : {}),
        prompt: request, history: history.slice(-12), draft: readDraft(),
        agent: $('task-assistant-agent').value, model: $('task-assistant-model').value.trim(),
      });
      if (mine !== generation || !current(context)) return;
      if (!result.draft || typeof result.draft.title !== 'string' || typeof result.draft.content !== 'string') throw Error('초안을 읽지 못했습니다. 다시 요청하거나 직접 작성하세요.');
      const previousAgent = $('task-agent').value;
      // 작업 폴더 이름을 정했으면 워크트리를 만들어 진행한다.
      if (result.draft.worktreeName && $('task-workbranch-mode').value !== 'existing' && $('task-worktree')?.value === 'none') {
        $('task-worktree').value = 'create';
        onDraft({ agentChanged: false });
      }
      for (const [key, id] of Object.entries(fields)) {
        const field = $(id);
        if (!field || (field.disabled && ['type', 'version', 'branchName', 'worktreeName'].includes(key))) continue;
        if (typeof result.draft[key] === 'string') field.value = result.draft[key];
      }
      // release로 변경한 뒤 활성화될 버전도 함께 적용한다.
      if ($('task-workbranch-mode').value !== 'existing' && typeof result.draft.version === 'string') $('task-version').value = result.draft.version;
      onDraft({ agentChanged: previousAgent !== $('task-agent').value });
      history.push({ role: 'user', content: request }, { role: 'assistant', content: result.summary || '초안을 정리했습니다. 내용을 확인해 주세요.' });
      ready = true;
      prompt.value = '';
      prompt.placeholder = '수정할 내용을 이어서 적어 주세요 · 예: 모바일 화면도 포함해 줘';
      showConversation();
    } catch (failure) {
      if (mine === generation && current(context)) error(failure.message || '초안을 만들지 못했습니다. 다시 시도하거나 직접 작성하세요.');
    } finally {
      if (mine === generation) { planning = false; sync(); if (current(context)) prompt.focus(); }
    }
  }
  $('task-create-ai').addEventListener('click', () => setMode('ai'));
  $('task-create-manual').addEventListener('click', () => setMode('manual'));
  $('task-assistant-send').addEventListener('click', () => void ask());
  $('task-assistant-agent').addEventListener('change', () => { $('task-assistant-model').value = ''; updateProvider(); });
  prompt.addEventListener('input', sync);
  prompt.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault(); void ask();
  });
  // 내용을 미리 채워 연 창은 초안 도우미 대신 직접 작성으로 바로 확인하게 한다.
  return { open, close, useManual: () => setMode('manual'), ready: () => ready, busy: () => planning, creationId: () => requestId, setCreating(value) { creating = value; sync(); } };
}
