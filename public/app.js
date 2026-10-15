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

const api = createApiClient();
const { data, navigation } = createStore();
const POPUP = new URLSearchParams(location.search).get("session") ?? new URLSearchParams(location.search).get("chat");
const openWindow = (query) => window.open(`/?${query}`, "_blank", "width=760,height=900");
const openSessionWindow = (id) => openWindow(`session=${encodeURIComponent(id)}`);
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
  const request = ++sessionSelectionRevision;
  const viewRevision = navigation.viewRevision;
  const session = await api("GET", `/api/sessions/${id}`);
  if (request !== sessionSelectionRevision || viewRevision !== navigation.viewRevision) return;
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

// 지금 보이는 대화 목록(채팅 화면이면 채팅 쪽)
const eventsList = () => $(navigation.view === "chat" ? "c-events" : "s-events");

const loadProjects = (...args) => projects.loadProjects(...args);
const renderProjectNav = (...args) => projects.renderProjectNav(...args);
const currentProject = (...args) => projects.currentProject(...args);
const renderLinkConditions = (...args) => graph.renderLinkConditions(...args);
const loadGit = (...args) => git.loadGit(...args);
const loadTasks = (...args) => tasks.loadTasks(...args);
const loadLinks = (...args) => graph.loadLinks(...args);
const renderGraph = (...args) => graph.renderGraph(...args);
const loadMessages = (...args) => graph.loadMessages(...args);
const loadCommands = (...args) => commands.loadCommands(...args);
const loadSkills = (...args) => skills.loadSkills(...args);
const renderHub = (...args) => knowledge.renderHub(...args);
const openSessionMenu = (...args) => sessions.openSessionMenu(...args);
const openNew = (...args) => creation.openNew(...args);
const openSetup = (...args) => settings.openSetup(...args);
const projectTab = (...args) => projects.projectTab(...args);
const loadSessions = (...args) => projects.loadSessions(...args);
const commandNode = (...args) => commands.commandNode(...args);
const runCommand = (...args) => commands.runCommand(...args);
const stopCommand = (...args) => commands.stopCommand(...args);
const removeCommand = (...args) => commands.removeCommand(...args);
const openCommandDialog = (...args) => commands.openCommandDialog(...args);
const skillChips = (...args) => skills.skillChips(...args);
const openSkillsManager = (...args) => skills.openSkillsManager(...args);
const renderFlow = (...args) => sessions.renderFlow(...args);
const restartSession = (...args) => sessions.restartSession(...args);
const connectCreatedGraphNode = (...args) => graph.connectCreatedGraphNode(...args);
const drawEdges = (...args) => graph.drawEdges(...args);
const highlightSessions = (...args) => graph.highlightSessions(...args);
const loadStatus = (...args) => settings.loadStatus(...args);
const openEquipDialog = (...args) => skills.openEquipDialog(...args);
const clearSelection = (...args) => graph.clearSelection(...args);
const sortedProjects = (...args) => projects.sortedProjects(...args);
const loadHub = (...args) => knowledge.loadHub(...args);
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

const clearGraphTransientState = (...args) => graph.clearGraphTransientState(...args);
const renderProject = (...args) => projects.renderProject(...args);
const renderSession = (...args) => sessions.renderSession(...args);
const renderChat = (...args) => sessions.renderChat(...args);
const loadUpdate = (...args) => settings.loadUpdate(...args);

// Compose independent features through explicit commands and shared server snapshots.
const settings = createSettingsController({
  api, goDashboard, loadProjects, renderProjectNav, currentProject, renderLinkConditions, data, navigation
});
const projects = createProjectsController({
  sessionOpener, api, goDashboard, goProject, selectSession, loadGit, loadTasks, loadLinks, renderGraph, loadMessages, loadCommands, loadSkills, renderHub, openSessionMenu, openNew, data, navigation
});
const git = createGitController({
  api, selectSession, openSetup, currentProject, projectTab, navigation
});
const graph = createGraphController({
  openSessionWindow, api, goProject, selectSession, loadSessions, sessionById, commandById, nodeTitle, loadCommands, commandNode, runCommand, stopCommand, removeCommand, openCommandDialog, skillChips, openSkillsManager, renderFlow, restartSession, openSessionMenu, openNew, cancelNodeCreation, data, navigation
});
const commands = createCommandsController({
  api, loadLinks, renderGraph, connectCreatedGraphNode, commandById, data, navigation
});
const skills = createSkillsController({
  api, loadSessions, sessionById, renderGraph, highlightSessions, data, navigation
});
const knowledge = createKnowledgeController({
  api, loadSessions, loadProjects, currentProject, loadLinks, data, navigation
});
const sessions = createSessionsController({
  POPUP, openWindow, openSessionWindow, api, show, goDashboard, goProject, selectSession, eventsList, loadStatus, loadSessions, sessionById, loadLinks, openEquipDialog, fillModels, fillEfforts, clearSelection, data, navigation
});
const creation = createCreationController({
  api, loadStatus, loadSessions, loadProjects, sortedProjects, connectCreatedGraphNode, loadHub, fillModels, fillEfforts, openChat, openSettings, data, navigation
});
const tasks = createTasksController({
  api, data, navigation, loadStatus, loadSessions, loadProjects, fillModels, fillEfforts, selectSession,
  getProjectPath: () => navigation.project,
  reloadData: () => Promise.all([loadSessions(), loadProjects()]),
});

// 첫 로딩 중에 목록이 먼저 그려지면 사용자가 프로젝트·세션을 누를 수 있다. 그랬으면 대시보드로 되돌리지 않는다.
const bootView = navigation.viewRevision;
const bootSelection = sessionSelectionRevision;
await Promise.all([loadStatus(), loadSessions(), loadLimits(), loadUpdate(), loadProjects(), loadLinks()]);
if (POPUP) {
  document.body.classList.add("popup");
  if (POPUP === "new") openChat();
  else await selectSession(POPUP).catch(openChat);
} else if (navigation.viewRevision === bootView && sessionSelectionRevision === bootSelection) goDashboard();

const stream = connectLiveUpdates({
  data, navigation, notifyQuestion, eventsList, appendEvent, scrollToBottom, selectSession, loadLimits, renderSessionList, renderProjectNav, renderDashboard, renderProjectSessions, projectTab, loadGit, loadTasks, renderState, loadSessions, loadProjects, currentProject, goDashboard, loadLinks, loadMessages, refreshBoard, applySetupJobs, loadStatus, loadAuth, loadSetup, loadCommands, loadSkills, refreshQueue, applyUpdate
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
