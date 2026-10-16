import { $ } from "./shared/dom.js";
import { createApiClient } from "./shared/api.js";
import { createStore } from "./shared/store.js";
import { refreshElapsedTimes } from "./shared/elapsed.js";
import { createModelControls } from "./shared/model-controls.js";
import { connectLiveUpdates } from "./application/live-updates.js";
import { createSettingsController } from "./features/settings/controller.js";
import { createProjectsController } from "./features/projects/controller.js";
import { createGitController } from "./features/git/controller.js";
import { createGraphController } from "./features/graph/controller.js";
import { createCommandsController } from "./features/commands/controller.js";
import { createSkillsController } from "./features/skills/controller.js";
import { createKnowledgeController } from "./features/knowledge/controller.js";
import { createSessionsController } from "./features/sessions/controller.js";
import { createCreationController } from "./features/creation/controller.js";
import { createTasksController } from "./features/tasks/controller.js";
import { createAccountController } from "./features/account/controller.js";
import { createIssuesController } from "./features/issues/controller.js";
import { createExecutionControls } from "./features/executions/controller.js";
import { createRecordsController } from "./features/records/controller.js";

const api = createApiClient();
const { data, navigation } = createStore();
const POPUP = new URLSearchParams(location.search).get("session") ?? new URLSearchParams(location.search).get("chat");
const openWindow = (query) => window.open(`/?${query}`, "_blank", "width=760,height=900");
const openSessionWindow = (id) => {
  const session = sessionById(id);
  if (session?.locked) return onSessionLocked(session);
  return openWindow(`session=${encodeURIComponent(id)}`);
};
const sessionOpener = (id) => (event) => {
  if (event.button === 1 || event.ctrlKey || event.shiftKey) openSessionWindow(id);
  else if (event.button === 0) selectSession(id);
};
const sessionById = (id) => data.sessions.find((session) => session.id === id);
const commandById = (id) => data.commands.find((command) => command.id === id);
const nodeTitle = (id) => (sessionById(id) ?? commandById(id))?.title ?? "?";
const { fillModels, fillEfforts } = createModelControls(() => data.status);
let sessionSelectionRevision = 0;
const cancelNodeCreation = () => { creation.cancelCreation(); commands.cancelCreation(); };

// ── 화면 전환 ───────────────────────────────────────────────────
function show(view) {
  navigation.viewRevision = (navigation.viewRevision ?? 0) + 1;
  tasks.invalidateProject?.();
  clearGraphTransientState();
  navigation.view = view;
  for (const name of ["dashboard", "project", "session", "chat"]) $(`view-${name}`).hidden = name !== view;
  $("nav-dashboard").classList.toggle("active", view === "dashboard");
  $("nav-chat").classList.toggle("active", view === "chat" && !data.current);
  renderProjectNav();
  renderSessionList();
}

function goDashboard() {
  data.current = null;
  navigation.project = null;
  show("dashboard");
  renderDashboard();
}

async function goProject(projectPath) {
  data.current = null;
  navigation.project = projectPath;
  show("project");
  await renderProject();
}

// 일반 채팅은 채팅 화면으로, 나머지는 세션 화면으로 연다.
async function selectSession(id) {
  const revision = ++sessionSelectionRevision;
  const viewRevision = navigation.viewRevision;
  const summary = sessionById(id);
  if (summary?.locked) return onSessionLocked(summary);
  let session;
  try {
    session = await api("GET", `/api/sessions/${id}`);
  } catch (err) {
    if (err.reason !== "locked" && err.status !== 423) throw err;
    if (summary) summary.locked = true;
    if (revision === sessionSelectionRevision && navigation.viewRevision === viewRevision) return onSessionLocked(summary ?? { id });
    return;
  }
  if (revision !== sessionSelectionRevision || navigation.viewRevision !== viewRevision) return;
  if (session.locked || sessionById(id)?.locked) return onSessionLocked(session);
  data.current = session;
  navigation.project = null;
  if (data.current.chat) {
    show("chat");
    renderChat();
  } else {
    show("session");
    renderSession();
  }
}

function onSessionLocked(session) {
  sessionSelectionRevision++;
  if (data.current && data.current.id !== session.id) return;
  data.current = null;
  for (const prefix of ["s", "c"]) {
    $(`${prefix}-events`).replaceChildren();
    $(`${prefix}-prompt`).value = "";
  }
  document.body.classList.remove("popup");
  if (session.projectPath) return goProject(session.projectPath);
  goDashboard();
}

// 보고 있던 세션이 지워졌다. 팝업 창이면 창을 닫고, 아니면 프로젝트(또는 채팅·대시보드) 화면으로 돌아간다.
function onSessionRemoved({ sessionId, projectPath }) {
  const current = data.current;
  if (current?.id !== sessionId) return;
  if (POPUP) { window.close(); return; }
  sessionSelectionRevision++;
  if (current.chat) openChat();
  else if (projectPath ?? current.projectPath) goProject(projectPath ?? current.projectPath);
  else goDashboard();
}

// 지금 보이는 대화 목록(채팅 화면이면 채팅 쪽)
const eventsList = () => $(navigation.view === "chat" ? "c-events" : "s-events");

const loadProjects = (...args) => projects.loadProjects(...args);
const renderProjectNav = (...args) => projects.renderProjectNav(...args);
const currentProject = (...args) => projects.currentProject(...args);
const renderLinkConditions = (...args) => graph.renderLinkConditions(...args);
const loadGit = (...args) => git.loadGit(...args);
const loadTasks = (...args) => tasks.loadTasks(...args);
const loadLinks = (...args) => graph.loadLinks(...args);
const loadNodeGroups = (...args) => graph.loadNodeGroups(...args);
const renderGraph = (...args) => graph.renderGraph(...args);
const loadMessages = (...args) => graph.loadMessages(...args);
const loadCommands = (...args) => commands.loadCommands(...args);
const loadSkills = (...args) => skills.loadSkills(...args);
const openSessionMenu = (...args) => sessions.openSessionMenu(...args);
const openNew = (...args) => creation.openNew(...args);
const openSetup = (...args) => settings.openSetup(...args);
const projectTab = (...args) => projects.projectTab(...args);
const loadSessions = async (...args) => {
  await projects.loadSessions(...args);
  const current = data.current && sessionById(data.current.id);
  if (current?.locked) await onSessionLocked(current);
};
const commandNode = (...args) => commands.commandNode(...args);
const runCommand = (...args) => commands.runCommand(...args);
const stopCommand = (...args) => commands.stopCommand(...args);
const removeCommand = (...args) => commands.removeCommand(...args);
const openCommandDialog = (...args) => commands.openCommandDialog(...args);
const openCommandOutput = (...args) => commands.openCommandOutput(...args);
const skillChips = (...args) => skills.skillChips(...args);
const openSkillsManager = (...args) => skills.openSkillsManager(...args);
const renderFlow = (...args) => sessions.renderFlow(...args);
const restartSession = (...args) => sessions.restartSession(...args);
const toggleSessionLock = (...args) => sessions.toggleSessionLock(...args);
const connectCreatedGraphNode = (...args) => graph.connectCreatedGraphNode(...args);
const drawEdges = (...args) => graph.drawEdges(...args);
const highlightSessions = (...args) => graph.highlightSessions(...args);
const loadStatus = (...args) => settings.loadStatus(...args);
const openEquipDialog = (...args) => skills.openEquipDialog(...args);
const clearSelection = (...args) => graph.clearSelection(...args);
const sortedProjects = (...args) => projects.sortedProjects(...args);
const openChat = (...args) => sessions.openChat(...args);
const openSettings = (...args) => settings.openSettings(...args);
const notifyQuestion = (...args) => sessions.notifyQuestion(...args);
const appendEvent = (...args) => sessions.appendEvent(...args);
const scrollToBottom = (...args) => sessions.scrollToBottom(...args);
const loadLimits = (...args) => settings.loadLimits(...args);
const renderSessionList = (...args) => projects.renderSessionList(...args);
const renderDashboard = (...args) => projects.renderDashboard(...args);
const renderProjectSessions = (...args) => projects.renderProjectSessions(...args);
const renderState = (...args) => sessions.renderState(...args);
const refreshBoard = (...args) => knowledge.refreshBoard(...args);
const applySetupJobs = (...args) => settings.applySetupJobs(...args);
const loadAuth = (...args) => settings.loadAuth(...args);
const loadSetup = (...args) => settings.loadSetup(...args);
const refreshQueue = (...args) => sessions.refreshQueue(...args);
const applyUpdate = (...args) => settings.applyUpdate(...args);

const saveGroupTemplate = (...args) => executions.saveTemplate(...args);
const openGroupTemplates = (...args) => executions.openTemplates(...args);
const clearExecutionControls = (...args) => executions.clear(...args);
const clearGraphTransientState = (...args) => graph.clearGraphTransientState(...args);
const renderProject = (...args) => projects.renderProject(...args);
const renderSession = (...args) => sessions.renderSession(...args);
const renderChat = (...args) => sessions.renderChat(...args);
const loadUpdate = (...args) => settings.loadUpdate(...args);
const loadIssues = (...args) => issues.activate(...args);
const renderIssueCount = (...args) => issues.renderTabCount(...args);
const sendSessionToTeam = (...args) => issues.sendSession(...args);
const pullIssues = (...args) => issues.pullIssues(...args);
const showProjectTab = (...args) => projects.showProjectTab(...args);
const loadAccount = (...args) => account.loadAccount(...args);
const issuesChanged = (...args) => issues.changed(...args);

// Compose independent features through explicit commands and shared server snapshots.
const settings = createSettingsController({
  api, goDashboard, loadProjects, renderProjectNav, currentProject, renderLinkConditions, data, navigation
});
const projects = createProjectsController({
  sessionOpener, api, goDashboard, goProject, selectSession, loadGit, loadIssues, renderIssueCount, loadTasks, loadLinks, renderGraph, loadMessages, loadCommands, loadSkills, openSessionMenu, toggleSessionLock, openNew, data, navigation
});
const git = createGitController({
  api, selectSession, openSetup, currentProject, projectTab, pullIssues, navigation
});
const graph = createGraphController({
  openSessionWindow, api, goProject, selectSession, loadSessions, sessionById, commandById, nodeTitle, loadCommands, commandNode, runCommand, stopCommand, removeCommand, openCommandDialog, openCommandOutput, skillChips, openSkillsManager, renderFlow, restartSession, toggleSessionLock, openSessionMenu, openNew, cancelNodeCreation, saveGroupTemplate, openGroupTemplates, clearExecutionControls, data, navigation
});
const commands = createCommandsController({
  api, loadLinks, renderGraph, connectCreatedGraphNode, commandById, data, navigation,
  history: graph.history, nodeSnapshot: graph.nodeSnapshot, recordNodesRemoved: graph.recordNodesRemoved,
});
const skills = createSkillsController({
  api, loadSessions, sessionById, renderGraph, highlightSessions, data, navigation
});
const knowledge = createKnowledgeController({
  api, currentProject
});
const sessions = createSessionsController({
  POPUP, openWindow, openSessionWindow, api, show, goDashboard, goProject, selectSession, onSessionLocked, eventsList, loadStatus, loadSessions, sessionById, loadLinks, openEquipDialog, sendSessionToTeam, fillModels, fillEfforts, clearSelection, data, navigation
});
const account = createAccountController({
  api, openSetup, onChange: () => issues?.accountChanged(),
});
const issues = createIssuesController({
  api, account: () => account.account(), connectAccount: () => account.connect(), goProject, showProjectTab, projectTab, selectSession, navigation
});
createRecordsController({ api, loadSessions, selectSession, data, navigation });
const creation = createCreationController({
  api, loadStatus, loadSessions, loadProjects, sortedProjects, connectCreatedGraphNode, fillModels, fillEfforts, openChat, openSettings, data, navigation
});
const tasks = createTasksController({
  api, data, navigation, loadStatus, loadSessions, loadProjects, fillModels, fillEfforts, selectSession,
  getProjectPath: () => navigation.project,
  reloadData: () => Promise.all([loadSessions(), loadProjects()]),
});

const executions = createExecutionControls({
  api, navigation, refreshGraph: async (projectPath) => {
    await Promise.all([loadSessions(), loadCommands(projectPath), loadLinks()]);
    if (navigation.view === "project") renderGraph();
  },
});

// 첫 로딩 중에 목록이 먼저 그려지면 사용자가 프로젝트·세션을 누를 수 있다. 그랬으면 대시보드로 되돌리지 않는다.
const bootView = navigation.viewRevision;
const bootSelection = sessionSelectionRevision;
await Promise.all([loadStatus(), loadSessions(), loadLimits(), loadUpdate(), loadProjects(), loadLinks(), loadAccount()]);
if (POPUP) {
  document.body.classList.add("popup");
  if (POPUP === "new") openChat();
  else await selectSession(POPUP).catch(openChat);
} else if (navigation.viewRevision === bootView && sessionSelectionRevision === bootSelection) goDashboard();

const stream = connectLiveUpdates({
  data, navigation, notifyQuestion, eventsList, appendEvent, scrollToBottom, selectSession, loadLimits, renderSessionList, renderProjectNav, renderDashboard, renderProjectSessions, projectTab, loadGit, loadTasks, renderState, loadSessions, loadProjects, currentProject, goDashboard, loadLinks, loadNodeGroups, loadMessages, refreshBoard, applySetupJobs, loadStatus, loadAuth, loadSetup, loadCommands, loadSkills, refreshQueue, applyUpdate, loadAccount, issuesChanged, refreshRuns: executions.refreshRuns, notifyFlow: executions.notify, onSessionRemoved
});
loadAuth();
loadSetup();
const refreshTimers = () => refreshElapsedTimes(data, commands.commandNodeFoot);
const timers = [
  setInterval(loadAuth, 5 * 60_000),
  setInterval(loadProjects, 120_000),
  setInterval(refreshTimers, 1000),
];
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshTimers(); });
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return; // Back/forward cache pauses and resumes the existing window.
  stream.close();
  timers.forEach(clearInterval);
});
