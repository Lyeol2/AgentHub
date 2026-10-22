import { connectEventStream } from "../shared/stream.js";
import { applySessionState, samePath, indexById } from "../shared/store.js";
import { applySessionRead } from "../shared/session-read.js";
import { createFrameTask } from "../shared/frame-task.js";

export function connectLiveUpdates({ data, navigation, notifyQuestion, eventsList, appendEvent, scrollToBottom, selectSession, loadLimits, renderSessionList, renderProjectNav, renderDashboard, renderProjectSessions, projectTab, loadGit, loadTasks, renderState, loadSessions, loadProjects, currentProject, goDashboard, loadLinks, loadNodeGroups, loadGraphTabs, loadMessages, refreshBoard, applySetupJobs, loadStatus, loadAuth, loadSetup, loadCommands, loadSkills, refreshQueue, applyUpdate, loadAccount, issuesChanged, refreshRuns, notifyFlow, onSessionRemoved, refreshSessionMeta, applyActivity, markOutput, sessionStateChanged, updateEvent, appendDraft, taskProgress, applySubtasks, readCurrent }) {
  const changedProjects = new Set();
  let unknownProject = false;
  const renderTask = createFrameTask(() => {
    renderSessionList();
    renderProjectNav();
    if (navigation.view === "dashboard") renderDashboard();
    if (navigation.view === "project" && (unknownProject || [...changedProjects].some((path) => samePath(path, navigation.project)))) renderProjectSessions();
    changedProjects.clear(); unknownProject = false;
  });
  function renderReadState(sessionId) {
    const session = indexById(data.sessions).get(sessionId);
    if (!session) unknownProject = true;
    else if (session.projectPath) changedProjects.add(session.projectPath);
    renderTask.schedule();
  }
  const source = connectEventStream({ handlers: {
  event: (e) => {
    const { sessionId, event } = JSON.parse(e.data);
    if ((event.kind === "question" || event.kind === "permission") && event.status === "pending") notifyQuestion(sessionId, event);
    if (event.kind === "result") {
      applySessionRead(data, sessionId, { lastResultSeq: event.seq });
      renderReadState(sessionId);
    }
    const s = data.current;
    if (s?.id !== sessionId || event.seq < s.events.length) return;
    s.events.push(event);
    markOutput?.(sessionId);
    const list = eventsList();
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    appendEvent(list, event);
    if (atBottom) scrollToBottom();
    // CLI 세션 ID·사용량 등 세션 정보만 다시 받는다. 기록은 이미 이어 붙였으므로 다시 그리지 않는다.
    if (event.kind === "status" || event.kind === "result") (refreshSessionMeta ?? selectSession)(sessionId);
    if (event.kind === "result") void readCurrent?.();
  },
  "session-read": (e) => {
    const { sessionId, ...state } = JSON.parse(e.data);
    applySessionRead(data, sessionId, state);
    renderReadState(sessionId);
  },
  // 실행 중 진행 표시(시작 단계·마지막 출력 시각·답 대기)
  activity: (e) => {
    const { sessionId, ...activity } = JSON.parse(e.data);
    applyActivity?.(sessionId, activity);
  },
  // 답을 쓰는 중인 글. 기록에는 남지 않고 최종 답변이 오면 사라진다.
  draft: (e) => {
    const { sessionId, draftId, text } = JSON.parse(e.data);
    if (data.current?.id !== sessionId || !text) return;
    markOutput?.(sessionId);
    const list = eventsList();
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    appendDraft?.(list, draftId, text);
    if (atBottom) scrollToBottom();
  },
  // 이미 받은 이벤트의 상태가 바뀌었다(실행 중에 붙인 요청의 반영 여부).
  "event-update": (e) => {
    const { sessionId, seq, patch } = JSON.parse(e.data);
    const s = data.current;
    if (s?.id !== sessionId) return;
    if (s.events[seq]?.seq === seq) Object.assign(s.events[seq], patch);
    else Object.assign(s.events.find((event) => event.seq === seq) ?? {}, patch);
    updateEvent?.(eventsList(), seq, patch);
  },
  // 하위 작업(서브에이전트·백그라운드 명령)이 바뀌었다. 보고 있는 세션은 패널만 고치고, 개수가 바뀌면 목록·그래프 배지를 다시 그린다.
  subtasks: (e) => {
    const payload = JSON.parse(e.data);
    if (!applySubtasks?.(payload)) return;
    renderReadState(payload.sessionId);
  },
  // 작업 만들기 진행 단계(원격 확인 → 작업 폴더 → 세션)
  "task-progress": (e) => taskProgress?.(JSON.parse(e.data)),
  state: (e) => {
    const payload = JSON.parse(e.data);
    const { sessionId, state: next } = payload;
    const item = applySessionState(data, payload);
    sessionStateChanged?.(sessionId, next);
    // Codex 한도는 턴이 끝난 뒤 기록 파일에서 읽는다.
    if (item?.agent === "codex" && next !== "running") loadLimits();
    renderReadState(sessionId);
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
  return { close() { renderTask.cancel(); source.close(); } };
}
