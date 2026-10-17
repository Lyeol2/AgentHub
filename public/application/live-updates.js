import { connectEventStream } from "../shared/stream.js";
import { applySessionState, samePath } from "../shared/store.js";

export function connectLiveUpdates({ data, navigation, notifyQuestion, eventsList, appendEvent, scrollToBottom, selectSession, loadLimits, renderSessionList, renderProjectNav, renderDashboard, renderProjectSessions, projectTab, loadGit, loadTasks, renderState, loadSessions, loadProjects, currentProject, goDashboard, loadLinks, loadNodeGroups, loadGraphTabs, loadMessages, refreshBoard, applySetupJobs, loadStatus, loadAuth, loadSetup, loadCommands, loadSkills, refreshQueue, applyUpdate, loadAccount, issuesChanged, refreshRuns, notifyFlow, onSessionRemoved }) {
  const source = connectEventStream({ handlers: {
  event: (e) => {
    const { sessionId, event } = JSON.parse(e.data);
    if ((event.kind === "question" || event.kind === "permission") && event.status === "pending") notifyQuestion(sessionId, event);
    const s = data.current;
    if (s?.id !== sessionId || event.seq < s.events.length) return;
    s.events.push(event);
    const list = eventsList();
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    appendEvent(list, event);
    if (atBottom) scrollToBottom();
    if (event.kind === "status" || event.kind === "result") selectSession(sessionId); // CLI 세션 ID 등 메타 갱신
  },
  state: (e) => {
    const payload = JSON.parse(e.data);
    const { sessionId, state: next } = payload;
    const item = applySessionState(data, payload);
    // Codex 한도는 턴이 끝난 뒤 기록 파일에서 읽는다.
    if (item?.agent === "codex" && next !== "running") loadLimits();
    renderSessionList();
    renderProjectNav();
    if (navigation.view === "dashboard") renderDashboard();
    if (navigation.view === "project") renderProjectSessions();
    // 시작·종료 상태를 모두 반영해 노선도의 작업 중 표시를 갱신한다.
    if (navigation.view === "project" && projectTab() === "git" && item && samePath(item.projectPath, navigation.project)) loadGit();
    if (navigation.view === "project" && projectTab() === "tasks" && item && samePath(item.projectPath, navigation.project)) loadTasks?.(navigation.project, { localOnly: true });
    if (data.current?.id === sessionId) {
      renderState();
    }
  },
  sessions: loadSessions,
  // 세션이 지워졌다(작업 삭제 등). 그 세션을 보고 있던 화면을 닫는다.
  "session-removed": (e) => onSessionRemoved?.(JSON.parse(e.data)),
  // 다른 창에서 커밋·병합했다.
  git: (e) => {
    if (navigation.view === "project" && projectTab() === "git" && samePath(JSON.parse(e.data).projectPath, navigation.project)) loadGit();
    // Git 탭에서 커밋·푸시하면 작업 카드의 단계 표시도 바뀐다.
    if (navigation.view === "project" && projectTab() === "tasks" && samePath(JSON.parse(e.data).projectPath, navigation.project)) loadTasks?.(navigation.project, { localOnly: true });
  },
  tasks: (e) => {
    if (navigation.view === "project" && projectTab() === "tasks" && samePath(JSON.parse(e.data).projectPath, navigation.project)) loadTasks?.(navigation.project, { localOnly: true });
  },
  // 프로젝트를 더하거나 뺐다. 보고 있던 프로젝트가 빠졌으면 대시보드로 돌아간다.
  projects: async () => {
    await loadProjects();
    if (navigation.view === "project" && !currentProject()) goDashboard();
  },
  runs: () => refreshRuns?.(),
  notification: (e) => notifyFlow?.(JSON.parse(e.data)),
  links: loadLinks,
  "node-groups": () => navigation.view === "project" && loadNodeGroups?.(),
  "graph-tabs": (e) => {
    const event = JSON.parse(e.data);
    if (navigation.view === "project" && (!event.projectPath || samePath(event.projectPath, navigation.project))) loadGraphTabs?.(navigation.project, event);
  },
  messages: (e) => {
    if (samePath(JSON.parse(e.data).projectPath, navigation.project)) loadMessages();
  },
  board: (e) => {
    refreshBoard(JSON.parse(e.data).projectPath);
  },
  // 설치·로그인 진행 상황. 끝나면 CLI 경로·버전·로그인 상태를 다시 받는다.
  setup: (e) => {
    applySetupJobs(JSON.parse(e.data));
  },
  cli: () => Promise.all([loadStatus(), loadAuth(true), loadSetup()]),
  commands: () => navigation.view === "project" && loadCommands(),
  skills: (e) => {
    if (samePath(JSON.parse(e.data).projectPath, navigation.project)) loadSkills();
  },
  queue: (e) => refreshQueue(JSON.parse(e.data).sessionId),
  session: (e) => {
    const { sessionId } = JSON.parse(e.data);
    if (data.current?.id === sessionId) selectSession(sessionId);
  },
  limits: loadLimits,
  // GitHub 로그인이 끝났거나 팀 작업이 바뀌었다.
  account: () => loadAccount(true),
  issues: (e) => issuesChanged(JSON.parse(e.data)),
  update: (e) => {
    applyUpdate(JSON.parse(e.data));
  },
  // 연결이 끊겼다가 돌아오면 놓친 이벤트를 다시 받아 온다. 목록의 실행 상태도 그 사이 바뀌었을 수 있다.
  open: () => {
    loadSessions();
    refreshRuns?.();
    if (navigation.view === "project") { loadNodeGroups?.(); loadGraphTabs?.(); loadCommands(); loadLinks(); }
    if (data.current) selectSession(data.current.id);
    if (navigation.view === "project" && projectTab() === "tasks") loadTasks?.(navigation.project);
  },
  } });
  return source;
}
