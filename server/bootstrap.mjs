// Composition root: imports define capabilities; createHub assembles one isolated
// instance and start()/shutdown() explicitly own sockets, timers and listeners.
import fs from "node:fs";
import path from "node:path";
import { ROOT, DATA_DIR, loadConfig, saveConfig } from "./config.mjs";
import { SessionStore } from "./store.mjs";
import { Runner } from "./runner.mjs";
import { LinkStore } from "./links.mjs";
import { CommandStore } from "./commands.mjs";
import { NodeGroupStore, createNodeGroupService } from "./node-groups.mjs";
import { GraphTabStore, createGraphTabService } from "./graph-tabs.mjs";
import { Chain } from "./chain.mjs";
import { RunHistoryStore } from "./run-history.mjs";
import { createRunService } from "./application/runs.mjs";
import { createGroupTemplateService } from "./application/group-templates.mjs";
import { Mailbox, createBoardStore } from "./messages.mjs";
import { createMessagingService } from "./application/messaging.mjs";
import { McpTokens, createMessagingTools } from "./mcp.mjs";
import { Setup } from "./setup.mjs";
import { CliAutoUpdater } from "./cli-auto-update.mjs";
import { askOnce, selectOneShotAgent } from "./one-shot.mjs";
import { CodexMcpProbe } from "./codex-mcp-probe.mjs";
import { createTaskAssistantService } from "./application/task-assistant.mjs";
import { HttpError } from "./application/errors.mjs";
import { locateCli } from "./cli.mjs";
import { discoverProjects, useDiscoverCache, flushDiscoverCache } from "./discover.mjs";
import { createLimitsService } from "./limits.mjs";
import { createSessionService } from "./application/sessions.mjs";
import { createProjectService } from "./application/projects.mjs";
import { projectUnityMode } from "./project-settings.mjs";
import { createWorkflowService } from "./application/workflows.mjs";
import { createCommandService } from "./application/commands.mjs";
import { createSkillService } from "./application/skills.mjs";
import { createGitService } from "./application/git.mjs";
import { createTaskService } from "./application/tasks.mjs";
import { createSystemService } from "./application/system.mjs";
import { createAccountService } from "./application/account.mjs";
import { createIssueService } from "./application/issues.mjs";
import { FileIssueLinkStore } from "./infrastructure/persistence/issue-links.mjs";
import { createTurnLifecycle } from "./application/lifecycle.mjs";
import { createHttpServer } from "./transport/http.mjs";
import { createApiHandler } from "./transport/api.mjs";
import { createFlowAssistantService } from "./application/flow-assistant.mjs";
import { createMcpHandler } from "./transport/mcp.mjs";
import { createEventStream } from "./transport/sse.mjs";

export function createHub(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? DATA_DIR);
  const config = options.config == null ? loadConfig(dataDir) : structuredClone(options.config);
  useDiscoverCache(path.join(dataDir, "discover-cache.json"));
  config.cli ??= { claude: "", codex: "" };
  config.cliAutoUpdate ??= true;
  config.projects ??= [];
  config.hiddenProjects ??= [];
  config.hiddenSessions ??= [];
  config.skillLayout ??= {};
  config.gitflow ??= {};
  config.account ??= { hidden: false };

  let port = Number(options.port ?? process.env.PORT ?? config.port ?? 4517);
  const deps = options.deps ?? {};
  const persistConfig = deps.saveConfig ?? ((value) => saveConfig(value, dataDir));
  const store = deps.store ?? new SessionStore({ dataDir });
  let setup;
  const runner = deps.runner ?? new Runner(store, { isUpdating: (tool) => setup?.isUpdating?.(tool) ?? false });
  const links = deps.links ?? new LinkStore({ dataDir });
  const commands = deps.commands ?? new CommandStore({ dataDir });
  const runHistory = deps.runHistory ?? new RunHistoryStore({ dataDir });
  for (const link of links.list()) {
    if (link.pending?.flow?.id && ["interrupted", "stopped"].includes(runHistory.get(link.pending.flow.id)?.status)) links.update(link, { pending: null });
  }
  const nodeGroups = deps.nodeGroups ?? new NodeGroupStore({ dataDir });
  const board = deps.board ?? createBoardStore({ dataDir });
  const limits = deps.limits ?? createLimitsService({ dataDir });
  const events = deps.events ?? createEventStream();
  const notify = (...args) => events.broadcast(...args);
  const cliPaths = deps.cliPaths ?? (() => ({
    claude: locateCli("claude", config.cli.claude),
    codex: locateCli("codex", config.cli.codex),
  }));
  const oneShotRuns = new Map();
  const isCliBusy = (tool) => (runner.running?.size ?? 0) > 0
    || store.list().some((session) => runner.isRunning(session.id))
    || [...(chain.runs?.values() ?? [])].some((run) => run.kind !== "schedule")
    || (oneShotRuns.get(tool) ?? 0) > 0;
  setup = deps.setup ?? new Setup({
    cliPath: (tool) => tool === "gh" ? locateCli("gh", "") : cliPaths()[tool],
    isBusy: isCliBusy,
  });
  const ask = async (request) => {
    const paths = request.cliPaths();
    const tool = request.agent !== undefined ? selectOneShotAgent(paths, request.agent) : paths.claude ? "claude" : paths.codex ? "codex" : null;
    if (tool && setup.isUpdating?.(tool)) throw new HttpError(409, `${tool} CLI 업데이트 중입니다. 완료한 뒤 다시 시도하세요.`);
    if (tool) oneShotRuns.set(tool, (oneShotRuns.get(tool) ?? 0) + 1);
    try { return await (deps.ask ?? askOnce)({ ...request, cliPaths: () => paths }); }
    finally { if (tool) oneShotRuns.set(tool, oneShotRuns.get(tool) - 1); }
  };
  // Never let integration/browser tests update the developer's installed CLIs.
  const cliAutoUpdater = options.cliAutoUpdate === false ? null : deps.cliAutoUpdater
    ?? (process.env.NODE_TEST_CONTEXT ? null : new CliAutoUpdater({ setup, enabled: () => config.cliAutoUpdate !== false,
      isBusy: isCliBusy, logger: deps.logger ?? console }));
  const mcpTokens = deps.mcpTokens ?? new McpTokens();
  const mcpDir = path.join(dataDir, "mcp");
  const chatDir = path.join(dataDir, "chat");
  const version = options.version ?? JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  let sessions;
  let projects;
  let workflows;
  let tasks;
  let nodeGroupService;
  let updater = null;
  let updateListener = null;
  const graphTabStore = deps.graphTabs ?? new GraphTabStore({ dataDir });
  const graphTabs = createGraphTabService({ tabs: graphTabStore, store, commands, groups: nodeGroups, projects: () => projects, notify });

  const chain = deps.chain ?? new Chain({
    store, runner, links, commands, cliPaths, history: runHistory,
    autoTurnEnd: false,
    tasks: () => tasks,
    compose: (...args) => sessions.composeInput(...args),
    notify: (kind, sessionId) => {
      if (["links", "commands", "sessions"].includes(kind)) notify(kind, {});
      else if (["runs", "notification"].includes(kind)) notify(kind, sessionId ?? {});
      else if (kind === "git") notify("git", { projectPath: sessionId });
      else notify("queue", { sessionId });
    },
  });
  const mailbox = deps.mailbox ?? new Mailbox({
    dataDir, store, runner, chain, links, notify,
    autoTurnEnd: false,
    sessions: (projectPath) => projects.projectSessions(projectPath),
  });
  projects = createProjectService({
    config, store, runner, links, commands, chain, board, notify, graphTabs,
    saveConfig: persistConfig,
    sessions: () => sessions,
    tasks: () => tasks,
    nodeGroups: () => nodeGroupService,
  });
  nodeGroupService = createNodeGroupService({ groups: nodeGroups, store, commands, links, projects, graphTabs, notify });
  // 받은 작업(이슈)과 세션의 연결. 세션을 다시 만들거나 지울 때도 함께 고친다.
  const issueLinks = deps.issueLinks ?? new FileIssueLinkStore({ dataDir });
  sessions = createSessionService({
    config, dataDir, store, runner, links, chain, mailbox, mcpTokens, mcpDir, chatDir, cliPaths, notify, projects, commands, graphTabs, issueLinks,
    saveConfig: persistConfig,
    workflows: () => workflows,
    tasks: () => tasks,
    nodeGroups: () => nodeGroupService,
  });
  workflows = createWorkflowService({ store, runner, links, commands, chain, projects, sessions, graphTabs, nodeGroups: nodeGroupService, notify });
  tasks = createTaskService({ dataDir, config, saveConfig: persistConfig, store, runner, sessions, projects, graphTabs, notify, github: deps.github });
  const services = {
    sessions,
    projects,
    workflows,
    tasks,
    nodeGroups: nodeGroupService,
    graphTabs,
    runs: createRunService({ history: runHistory, chain, projects, notify }),
    groupTemplates: createGroupTemplateService({ dataDir, store, commands, links, nodeGroups: nodeGroupService, projects, sessions, graphTabs, notify }),
    commands: createCommandService({ commands, chain, links, store, projects, cliPaths, graphTabs, nodeGroups: () => nodeGroupService, ask, notify }),
    skills: createSkillService({ config, projects, sessions, saveConfig: persistConfig, notify }),
    git: createGitService({ sessions, projects, runner, notify, tasks: () => tasks, config }),
    system: createSystemService({
      config, setup, cliPaths, limits, saveConfig: persistConfig, version,
      getUpdater: () => updater,
    }),
    messaging: createMessagingService({ mailbox, board, projects, notify }),
    account: deps.account ?? createAccountService({ config, setup, saveConfig: persistConfig }),
  };
  services.flowAssistant = createFlowAssistantService({ store, commands, links, projects, sessions, graphTabs, commandService: services.commands,
    workflowService: workflows, cliPaths, ask, notify });
  services.taskAssistant = createTaskAssistantService({ projects, graphTabs, cliPaths, config, ask });
  services.issues = deps.issues ?? createIssueService({
    config, store, sessions, notify,
    links: issueLinks,
    logger: deps.logger ?? console,
  });

  // 꺼진 사용자 Codex MCP 서버는 세션 실행에서 빼 연결 재시도·오류를 막는다.
  const mcpProbe = deps.mcpProbe ?? new CodexMcpProbe();
  runner.unreachableMcp = () => mcpProbe.unreachable();
  // 프로젝트 설정의 "유니티 사용"(실행 전 확인·허용·끔)을 세션 실행 인자와 권한 응답에 반영한다.
  runner.unityMode = (session) => projectUnityMode(config, session.projectPath);

  // Resolve the MCP URL lazily, after an ephemeral port has been assigned.
  // 설정 파일은 내용이 바뀌었거나 지워졌을 때만 다시 쓴다(요청마다 디스크에 쓰지 않는다).
  const mcpWritten = new Map(); // 설정 파일 → 마지막으로 쓴 내용
  runner.mcp = (session) => {
    const url = `http://127.0.0.1:${port}/mcp/${mcpTokens.token(session.id)}`;
    const configFile = path.join(mcpDir, `${session.id}.json`);
    const content = JSON.stringify({
      mcpServers: { agenthub: { type: "http", url } },
    }, null, 2);
    if (mcpWritten.get(configFile) !== content || !fs.existsSync(configFile)) {
      fs.mkdirSync(mcpDir, { recursive: true });
      fs.writeFileSync(configFile, content);
      mcpWritten.set(configFile, content);
    }
    return { url, configFile };
  };
  const tools = createMessagingTools({ mailbox, board, notify });
  const handleApi = createApiHandler({ services, events });
  const handleMcp = createMcpHandler({ tokens: mcpTokens, store, tools, version });
  const server = createHttpServer({
    getPort: () => port,
    publicDir: options.publicDir ?? path.join(ROOT, "public"),
    handleApi,
    handleMcp,
    receiveHook: (token, request) => services.commands.receiveHook(token, request),
  });

  const listeners = [];
  const listen = (emitter, name, listener) => {
    emitter.on(name, listener);
    listeners.push(() => emitter.off(name, listener));
  };
  listen(runner, "event", (sessionId, event) => {
    notify("event", { sessionId, event });
    if (event.status === "pending" && ["question", "permission"].includes(event.kind)) {
      const session = store.get(sessionId);
      chain.controls?.wait(session, chain.flowFor?.(session), event.questions ? JSON.stringify(event.questions, null, 2) : event.text ?? "응답 대기");
      chain.workflow?.settle();
      notify("sessions", {});
    }
  });
  listen(runner, "state", (sessionId, state, runningStartedAt) => {
    notify("state", { sessionId, state, runningStartedAt });
  });
  // 실행 중 진행 표시(시작 단계·마지막 출력 시각·답 대기), 쓰는 중인 글, 이미 남긴 이벤트의 상태 변경
  listen(runner, "activity", (sessionId, activity) => notify("activity", { sessionId, ...activity }));
  listen(runner, "draft", (sessionId, draft) => notify("draft", { sessionId, ...draft }));
  listen(runner, "eventUpdate", (sessionId, seq, patch) => notify("event-update", { sessionId, seq, patch }));
  // 지금 작업에 반영하지 못한 추가 요청을 대기열 앞으로 되돌린다. 사용자가 쓴 요청은 보낼 때 다시 /스킬·@참조를 풀어 쓴다.
  listen(runner, "requeue", (session, items) => chain.requeue?.(session, items.map(({ text, meta }) => ({ text, meta: meta?.from ? meta : { user: true, ...meta } }))));
  listen(setup, "change", (jobs) => notify("setup", jobs));
  listen(setup, "finished", (tool, job) => {
    notify("cli", {});
    if (!closed && job?.kind === "update") {
      for (const session of store.list()) if (session.agent === tool) chain.flush(session);
      chain.workflow?.settle();
    }
    if (tool === "gh") {
      services.account.forget?.();
      notify("account", {});
    }
  });
  listen(runner, "limit", (agent, info) => {
    if (agent === "claude") limits.recordClaudeLimit(info);
    notify("limits", {});
  });
  const onTurnEnd = createTurnLifecycle({ runner, mailbox, sessions, workflows, chain, notify, issues: services.issues });
  const logger = deps.logger ?? console;
  listen(runner, "turnEnd", (session, ok) => {
    onTurnEnd(session, ok).catch((err) => logger.error(err));
  });

  let starting = null;
  let stopping = null;
  let closed = false;
  let warmupTimer = null;

  function start() {
    if (closed) return Promise.reject(new Error("종료한 서버는 다시 시작할 수 없습니다."));
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const onError = (err) => {
        starting = null;
        reject(err);
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        port = server.address().port;
        if (!closed) events.start();
        if (!closed) chain.workflow?.restoreSchedules?.();
        if (!closed) cliAutoUpdater?.start();
        if (!closed) mcpProbe.start();
        if (!closed) logger.log?.(`AgentHub: http://127.0.0.1:${port}`);
        if (!closed && options.warmup !== false) {
          warmupTimer = setTimeout(() => {
            warmupTimer = null;
            (deps.discoverProjects ?? discoverProjects)();
          }, 200);
          warmupTimer.unref();
        }
        resolve(hub);
      });
    });
    return starting;
  }

  function setUpdater(next) {
    if (updater && updateListener) updater.off("state", updateListener);
    updater = next;
    updateListener = null;
    if (updater) {
      updateListener = (state) => notify("update", state);
      updater.on("state", updateListener);
    }
  }

  function shutdown() {
    if (stopping) return stopping;
    closed = true;
    clearTimeout(warmupTimer);
    warmupTimer = null;
    cliAutoUpdater?.dispose();
    mcpProbe.stop();
    events.close();
    for (const remove of listeners) remove();
    setUpdater(null);
    runner.stopAll();
    chain.dispose?.();
    mailbox.dispose?.();
    store.flushAll();
    flushDiscoverCache();
    // A listen() call may still be binding its socket. Let it settle before
    // closing, so a late listening callback cannot resurrect a stopped hub.
    const started = starting ?? Promise.resolve();
    stopping = started.catch(() => {}).then(() => new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeIdleConnections?.();
    }));
    return stopping;
  }

  const hub = {
    config, dataDir, store, runner, links, commands, nodeGroups, runHistory, chain, mailbox, board, limits, setup,
    mcpTokens, server, services, events, cliAutoUpdater,
    get port() { return port; },
    start,
    shutdown,
    setUpdater,
  };
  return hub;
}
