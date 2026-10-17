import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { summary as storedSummary, useProjectFolder } from "../store.mjs";
import { AGENTS } from "../runner.mjs";
import { isGitRepo, createWorktree, validateWorktreeName, removeWorktree, headCommit, diffSince, changedFiles } from "../git.mjs";
import { AGENT_NAME, handoverText, mapPermission } from "../handover.mjs";
import { discoverSessions, loadHistory, deleteSessionRecords } from "../discover.mjs";
import { ROLE_MAX, withRole } from "../role.mjs";
import { orchestratorInput } from "../orchestrator.mjs";
import { QUESTION_GUIDE, answerPrompt, hasAnswer } from "../question.mjs";
import { listSkills, withSkills } from "../skills.mjs";
import { MESSAGE_GUIDE } from "../policies/messaging.mjs";
import { HttpError } from "./errors.mjs";
import { assertSessionGitContext } from "../git-context.mjs";
import { AttachmentStore, isImageAttachment, publicAttachment } from "../attachments.mjs";
import { unsupportedChatAttachment } from "../attachment-input.mjs";
import { resolveSessionArtifact, readSessionArtifact, readSessionArtifactContent, validateArtifactReferences } from "../session-artifacts.mjs";
import { exportSession } from "../session-export.mjs";
import { exportBundle, isBundleName, BUNDLE_MAX_BYTES, recordReadText } from "../session-bundle.mjs";
import { expandPrompt, planRequest, projectFiles, rankFiles } from "../prompt-refs.mjs";
import { parseRecord, listRecords as listRecords_, readRecord, readRecordImage, recordLimitText, RECORD_MAX_BYTES } from "../session-import.mjs";

// 남이 준 기록 파일에서 그대로 되살리지 않는 권한: 확인 없이 명령을 실행하거나 승인을 자동으로 넘긴다.
const ELEVATED_PERMISSIONS = new Set(["bypassPermissions", "danger-full-access", "auto-review"]);

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const MODEL_PATTERN = /^[\w.\-:[\]]{1,64}$/;

export function createSessionService({
  config, dataDir, store, runner, chain, links, mailbox, mcpTokens, mcpDir, chatDir,
  cliPaths, notify: broadcast, saveConfig, projects, workflows, tasks, commands = null, nodeGroups, graphTabs
}) {
  const { ensureProject, projectSessions } = projects;
  const summary = (session) => ({ ...storedSummary(session), ...(graphTabs && !session.chat ? { tabId: graphTabs.tabFor(session) } : {}) });
  const attachments = new AttachmentStore({ dataDir: dataDir ?? path.dirname(mcpDir) });
  const applyPlan = (...args) => workflows().applyPlan(...args);
  function checkModel(model) {
    model = String(model ?? "").trim();
    if (model && !MODEL_PATTERN.test(model)) throw new HttpError(400, "모델 이름 형식이 올바르지 않습니다.");
    return model;
  }

  function checkEffort(agent, effort) {
    effort = String(effort ?? "").trim();
    if (effort && !AGENTS[agent].efforts().includes(effort)) throw new HttpError(400, "추론 강도가 올바르지 않습니다.");
    return effort;
  }

  function getSession(id) {
    const session = store.get(id);
    if (!session) throw new HttpError(404, "세션이 없습니다.");
    return session;
  }

  // 실행 중으로 남아 있는데 실제로 도는 CLI가 없으면(중간에 실행이 끊긴 경우) 중단된 것으로 고친다.
  // 그대로 두면 화면에서 중지·삭제 버튼이 막혀 지울 수 없는 세션이 된다.
  function settleState(session) {
    if (session.state === "running" && !runner.isRunning(session.id)) runner.setState(session, "interrupted");
    return session;
  }

  const cliSessionIds = (session) => [...new Set([...(session.cliSessionIds ?? []), session.agentSessionId].filter(Boolean))];

  // 프로젝트 화면의 기록 목록에서 숨긴다. 기록 파일은 그대로 둔다.
  function hideRecords(ids) {
    const fresh = ids.filter((id) => !config.hiddenSessions.includes(id));
    if (!fresh.length) return;
    config.hiddenSessions.push(...fresh);
    saveConfig(config);
  }

  // CLI에 실제로 넘길 내용. 오케스트레이터에는 지휘 규칙과 세션 상태를 함께 넣는다.
  // AI를 바꾼 뒤 새 대화의 첫 요청에는 이전 AI의 진행 상황을 붙인다. 새 대화가 시작되면(아래 turnEnd) 지운다.
  // expand: 사용자가 쓴 요청이면 /스킬과 @참조를 풀어 쓴다(다른 세션에서 넘어온 글은 그대로 둔다).
  // 읽힌 기록(pendingReads)은 다음 요청 하나에만 붙인다.
  // keepMode: 일시중지 재개·질문의 답은 앞 턴의 계획 모드를 잇는다. 그 밖의 요청은 /plan일 때만 계획 모드다.
  function composeInput(session, prompt, { expand = false, keepMode = false } = {}) {
    tasks?.()?.assertSession?.(session);
    if (!keepMode) {
      if (expand && !session.chat && planRequest(prompt)) session.planTurn = true;
      else delete session.planTurn;
    }
    let input = composeBase(session, expand ? expandPrompt(session, prompt) : prompt);
    if (session.pendingReads?.length) {
      input = `${session.pendingReads.map((r) => r.text).join("\n\n")}\n\n${input}`;
      delete session.pendingReads;
    }
    return session.handover && !session.agentSessionId ? `${session.handover}\n\n${input}` : input;
  }

  async function switchAgent(session, body) {
    const agent = String(body.agent);
    if (!AGENTS[agent]) throw new HttpError(400, "agent는 claude 또는 codex입니다.");
    if (runner.isRunning(session.id)) throw new HttpError(409, "실행 중에는 AI를 바꿀 수 없습니다. 끝나거나 일시중지한 뒤 바꾸세요.");
    const permission = body.permission ?? mapPermission(session.permission, agent, { orchestrator: session.kind === "orchestrator" }) ?? undefined;
    const options = checkSessionOptions({ agent, model: body.model ?? "", effort: body.effort ?? "", permission, chat: session.chat });
    const carry = body.carry !== false && session.events.some((e) => e.kind === "user");
    if (carry) {
      const files = session.baseCommit ? await changedFiles(session.cwd, session.baseCommit).catch(() => "") : "";
      session.handover = handoverText(session, files);
      // 바꾸기 전 AI 이름·모델로 적는다.
    } else {
      delete session.handover;
    }
    const from = AGENT_NAME[session.agent];
    Object.assign(session, options);
    session.agentSessionId = null;
    session.compactions = 0;
    session.context = null;
    delete session.roleChanged;
    // 새 대화의 첫 요청에 역할을 통째로 붙인다.
    runner.append(session, {
      kind: "status",
      text: `AI를 ${from}에서 ${AGENT_NAME[agent]}(으)로 바꿨습니다. ${carry ? "지금까지의 진행 상황을 다음 요청에 함께 넘깁니다." : "이전 대화는 넘기지 않고 새로 시작합니다."}`,
    });
  }

  function composeBase(session, prompt) {
    if (!session.chat) chain.assertGitAvailable?.(session);
    if (session.chat) {
      // 일반 채팅의 안내 문구는 새 대화의 첫 요청에만 붙인다(Codex는 시스템 프롬프트를 바꿀 수 없다).
      const input = withRole(session, prompt);
      const intro = AGENTS[session.agent].CHAT_INTRO;
      return intro && !session.agentSessionId ? `${intro}\n\n${input}` : input;
    }
    let input = withSkills(session, session.kind !== "orchestrator" ? withRole(session, prompt) : orchestratorInput(session, prompt, {
      sessions: projectSessions(session.projectPath).filter((item) => !graphTabs || graphTabs.tabFor(item) === graphTabs.tabFor(session)),
    }));
    // 이전 버전의 원본 전용 안내를 받은 CLI 대화에도 현재 작업 폴더를 다시 알린다.
    if (!session.agentSessionId || session.projectFolderGuide !== "optional-worktree") {
      session.projectFolderGuide = "optional-worktree";
      const folder = session.worktree
        ? `이 세션은 분리한 작업 폴더(${session.cwd}), 브랜치 ${session.worktree.branch}에서 작업한다. 프로젝트 원본 폴더는 ${session.projectPath}이다. 다른 세션의 작업 폴더를 직접 수정하지 않는다.`
        : `이 세션은 프로젝트 원본 폴더(${session.projectPath})에서 작업한다. 같은 폴더를 쓰는 세션과 같은 파일을 고칠 때는 겹치지 않게 조율한다.`;
      input = `[AgentHub 작업 폴더]\n${folder} 다른 작업 폴더가 필요하면 사용자가 AgentHub에서 워크트리를 선택하고 이름을 지정해 세션을 만든다.\n\n${input}`;
    }
    // 세션 사이 소통 규칙도 CLI 대화마다 한 번 붙인다.
    if (!session.agentSessionId || !session.messageGuide) {
      session.messageGuide = true;
      input = `${MESSAGE_GUIDE}\n\n${input}`;
    }
    // Claude는 실행 중에 질문 도구로 직접 묻는다. 질문 블록 규칙은 그런 통로가 없는 CLI(Codex)에만 붙인다.
    if (AGENTS[session.agent].interactive) return input;
    // CLI 대화마다 한 번 붙인다. 가져온 세션처럼 이미 대화가 있어도 아직 안 붙였으면 붙인다.
    if (session.agentSessionId && session.askGuide) return input;
    session.askGuide = true;
    return `${QUESTION_GUIDE}\n\n${input}`;
  }

  // 세션에 이은 스킬을 바꾼다. 대화 중에 바꾸면 다음 요청에 바뀐 목록을 다시 알린다.
  // 작업 폴더를 분리한 Claude 세션은 원래 프로젝트의 스킬 폴더가 작업 폴더 밖이므로 읽을 수 있게 열어 준다.
  // 개인 스킬은 Claude가 Skill 도구로 저절로 불러오므로 열지 않는다.
  function setSessionSkills(session, names) {
    const skills = listSkills(session.projectPath);
    const known = new Set(skills.map((s) => s.name));
    const next = [...new Set((Array.isArray(names) ? names : []).map(String))].filter((n) => known.has(n));
    if (next.join() === (session.skills ?? []).join()) return;
    if (session.agentSessionId) session.skillsChanged = true;
    session.skills = next;
    if (session.agent !== "claude" || samePath(session.cwd, session.projectPath)) return;
    const dirs = skills
      .filter((s) => next.includes(s.name) && s.scope !== "personal")
      .map((s) => path.dirname(path.dirname(s.file)));
    if (dirs.length) session.addDirs = [...new Set([...(session.addDirs ?? []), ...dirs])];
  }

  // 스킬이 없어진 세션에서는 그 스킬 연결을 뺀다(개인 스킬은 모든 프로젝트의 세션을 본다).
  function dropMissingSkills(name) {
    for (const s of store.list()) {
      if (!s.skills?.includes(name) || listSkills(s.projectPath).some((k) => k.name === name)) continue;
      setSessionSkills(s, s.skills.filter((n) => n !== name));
      store.touch(s);
    }
  }

  function checkSessionOptions({ agent, model = "", effort = "", permission, chat = false }) {
    if (!AGENTS[agent]) throw new HttpError(400, "agent는 claude 또는 codex입니다.");
    model = checkModel(model);
    effort = checkEffort(agent, effort);
    if (chat) permission = AGENTS[agent].CHAT_PERMISSION;
    permission ??= agent === "claude" ? "acceptEdits" : "workspace-write";
    if (!AGENTS[agent].PERMISSION_MODES.includes(permission)) throw new HttpError(400, "권한 모드가 올바르지 않습니다.");
    return { agent, model, effort, permission };
  }

  // chat: 프로젝트 없이 빈 폴더에서 도구 없이 대화만 하는 일반 채팅(project는 null).
  // 기본은 원본 폴더다. isolate:true와 사용자가 지정한 이름이 있을 때만 새 worktree를 만든다.
  // 두 번째 인수는 재생성할 때 기존 작업 폴더를 이어 쓰는 내부 전용 값이다.
  async function createSession({ project, title, role, roleName, orchestrator, createdBy, connectFrom, tabId, chat, isolate = false, worktreeName, ...options }, { worktree: existingWorktree = null, taskId = null } = {}) {
    chat = !!chat;
    const resolvedTabId = !chat && graphTabs ? graphTabs.resolve(project.path, tabId, connectFrom ?? createdBy) : null;
    if (chat && orchestrator) throw new HttpError(400, "일반 채팅은 오케스트레이터로 만들 수 없습니다.");
    const { agent, model, effort, permission } = checkSessionOptions({ ...options, chat });
    if (isolate === true && chat) throw new HttpError(400, "일반 채팅은 워크트리를 사용할 수 없습니다.");
    let name;
    if (isolate === true) {
      try {
        name = validateWorktreeName(worktreeName);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }
    if (chat) {
      fs.mkdirSync(chatDir, { recursive: true });
      project = { name: "일반 채팅", path: null };
    }
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const git = chat ? false : await isGitRepo(project.path);
    let worktree = existingWorktree;
    if (isolate === true) {
      if (!git) throw new HttpError(400, "워크트리는 Git 저장소에서만 사용할 수 있습니다.");
      try {
        worktree = await createWorktree(project.path, name);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }
    const cwd = chat ? chatDir : worktree?.dir ?? project.path;

    const now = new Date().toISOString();
    const session = {
      id,
      title: String(title ?? "").trim() || (chat ? "새 채팅" : `${agent} 세션`),
      role: String(role ?? "").trim().slice(0, ROLE_MAX),
      roleName: String(roleName ?? "").trim().slice(0, 100),
      kind: orchestrator ? "orchestrator" : "worker",
      createdBy: createdBy ?? null, // 이 세션을 만든 오케스트레이터
      agent,
      chat,
      locked: false,
      model,
      effort,
      permission,
      projectName: project.name,
      projectPath: project.path,
      ...(resolvedTabId ? { tabId: resolvedTabId } : {}),
      cwd,
      worktree,
      ...(taskId ? { taskId } : {}),
      baseCommit: git ? await headCommit(cwd) : null,
      agentSessionId: null,
      state: "idle",
      runningStartedAt: null,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    store.add(session);
    return session;
  }

  // ── 일시중지·재개 ─────────────────────────────────────────────
  // 일시중지: 실행 중이면 턴을 멈추되 CLI 대화와 대기열은 그대로 둔다. 쉬고 있으면 넘어오는 작업을 쌓아 두기만 한다.
  // 재개: 턴 중간에 멈췄으면 같은 대화에 이어서 하라고 보내고, 그다음 쌓인 작업을 차례로 보낸다.

  const INTERRUPTED_NOTE = "[사용자가 앞의 작업을 중간에 일시중지했다. 멈춘 곳까지의 상태를 확인하고 이어서 판단한다]";
  const RESUME_PROMPT = "일시중지했던 작업을 재개한다. 멈춘 곳부터 이어서 진행한다.";

  // 일시중지를 풀고, 턴 중간에 멈췄었는지 돌려준다.
  function clearPause(session) {
    if (!session.paused) return false;
    const midTurn = !!session.pausedMidTurn;
    delete session.paused;
    delete session.pausedMidTurn;
    return midTurn;
  }

  function pauseSession(session) {
    if (session.paused) throw new HttpError(409, "이미 일시중지한 세션입니다.");
    session.paused = true;
    if (runner.isRunning(session.id)) {
      session.pausedMidTurn = true;
      runner.interrupt(session);
      // 끝나면 runner가 "paused" 상태로 바꾼다.
    } else {
      runner.append(session, { kind: "status", text: "일시중지했습니다. 넘어오는 작업은 재개할 때까지 쌓아 둡니다." });
      runner.setState(session, "paused");
    }
  }

  function resumeSession(session) {
    if (!session.paused) throw new HttpError(409, "일시중지한 세션이 아닙니다.");
    if (runner.isRunning(session.id)) throw new HttpError(409, "아직 멈추는 중입니다. 잠시 뒤에 다시 시도하세요.");
    if (session.pausedMidTurn) {
      // 흐름 단계는 이어서 센다. 재개한 턴이 끝나면 연결·대기열도 평소처럼 이어진다.
      clearPause(session);
      startTurn(session, RESUME_PROMPT, session.chainDepth ?? 0, {}, { keepMode: true });
      return;
    }
    clearPause(session);
    runner.append(session, { kind: "status", text: "재개했습니다." });
    runner.setState(session, "idle");
    chain.flush(session);
  }

  // 사용자가 직접 보낸 요청은 새 흐름(0단계)이다. 흐름 중간의 질문에 답한 것처럼 같은 흐름을 잇는 요청은 depth를 넘긴다.
  function startTurn(session, prompt, depth = 0, meta = {}, { expand = false, keepMode = false } = {}) {
    if (runner.isRunning(session.id)) throw new HttpError(409, "이 세션은 이미 실행 중입니다.");
    chain.setFlow?.(session, depth > 0 ? chain.flowFor?.(session) ?? chain.newFlow?.() : chain.newFlow?.());
    session.chainDepth = depth;
    delete session.awaitingReply;
    // 사용자가 직접 이어 가면 다른 세션의 답을 기다리지 않는다.
    // 일시중지 중에 직접 보내면 재개한 것으로 본다. 턴 중간에 멈췄으면 CLI에 그 사실을 알린다.
    const interrupted = clearPause(session);
    const input = interrupted ? `${INTERRUPTED_NOTE}\n\n${prompt}` : prompt;
    try {
      chain.beginSession?.(session, prompt, { meta, depth, cwd: session.cwd });
      runner.send(session, prompt, cliPaths()[session.agent], composeInput(session, input, { expand, keepMode }), meta);
    } catch (err) {
      chain.controls?.fail(session, chain.flowFor?.(session), err);
      chain.workflow?.settle();
      throw new HttpError(409, err.message);
    }
  }


  // 세션 묶음 노드의 세션 목록에서 지우거나(to 없음) 재생성한 세션으로 바꾼다.
  function replaceGroupMember(id, to = null) {
    let changed = false;
    for (const group of commands?.list() ?? []) {
      if (group.kind !== "group" || !group.members?.includes(id)) continue;
      const members = group.members.flatMap((m) => m === id ? (to ? [to] : []) : [m]);
      commands.update(group, { members: [...new Set(members)] });
      changed = true;
    }
    if (changed) broadcast("commands", {});
  }

  function cleanupSession(session, { deleteRecords = false } = {}) {
    links.removeForSession(session.id);
    replaceGroupMember(session.id);
    chain.queue.delete(session.id);
    mailbox.removeForSession(session.id);
    mcpTokens.forget(session.id);
    fs.rmSync(path.join(mcpDir, `${session.id}.json`), { force: true });
    let records = { deleted: 0, errors: [] };
    if (!session.chat) {
      const ids = cliSessionIds(session);
      if (deleteRecords) records = deleteSessionRecords(ids);
      hideRecords(ids);
    }
    try { attachments.remove(session.id); } catch (err) { records.errors.push(`첨부 파일 정리 실패: ${err.message}`); }
    return records;
  }

  async function create(body) {
    if (body.workBranch !== undefined) {
      if (body.isolate === true) throw new HttpError(400, "새 작업 브랜치 생성과 기존 브랜치 선택 중 하나만 지정하세요.");
      const session = await tasks().createBranchSession(body);
      broadcast("sessions", {});
      return session;
    }
    const session = await createSession({ ...body, project: body.chat ? null : ensureProject(body.projectPath) });
    broadcast("sessions", {});
    return summary(session);
  }

  async function importSession(body) {
    const project = ensureProject(body.projectPath);
    const tabId = graphTabs?.resolve(project.path, body.tabId, body.connectFrom);
    const existing = store.list().find((s) => cliSessionIds(s).includes(body.agentSessionId));
    if (existing) return summary(existing);
    const found = discoverSessions(project.path).find((s) => s.agent === body.agent && s.agentSessionId === body.agentSessionId);
    if (!found) throw new HttpError(404, "세션 기록을 찾지 못했습니다.");
    const cwd = found.cwd || project.path;
    const git = await isGitRepo(project.path);
    const now = new Date().toISOString();
    const history = loadHistory(found);
    const session = {
      id: `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      title: found.title || `${found.agent} 세션`,
      agent: found.agent, model: "",
      permission: found.agent === "claude" ? "acceptEdits" : "workspace-write",
      projectName: project.name, projectPath: project.path, cwd, worktree: null,
      ...(tabId ? { tabId } : {}),
      baseCommit: git ? await headCommit(project.path) : null,
      agentSessionId: found.agentSessionId, cliSessionIds: [found.agentSessionId],
      imported: true, locked: false, state: "idle", runningStartedAt: null,
      createdAt: now, updatedAt: now,
      compactions: history.compactions, context: history.context, events: history.events,
    };
    useProjectFolder(session);
    store.add(session);
    broadcast("sessions", {});
    return summary(session);
  }

  function detail(id) {
    const session = getSession(id);
    if (session.locked) throw new HttpError(423, "잠긴 세션입니다. 좌물쇠를 눌러 잠금을 해제하세요.", "locked");
    return { ...settleState(session), ...(graphTabs && !session.chat ? { tabId: graphTabs.tabFor(session) } : {}), queue: chain.list(session.id), canInject: !!AGENTS[session.agent].interactive || AGENTS[session.agent].transport === "app-server" };
  }

  function sendMessage(id, body) {
    const session = getSession(id);
    const files = attachments.resolveAll(id, body.attachments);
    if (session.chat && files.some(unsupportedChatAttachment)) throw new HttpError(400, "일반 채팅은 이미지와 64 KiB 이하의 UTF-8 텍스트 파일을 지원합니다. 더 큰 텍스트나 PDF·압축 파일 등 바이너리 파일은 파일 읽기가 가능한 프로젝트 세션에 첨부하세요.");
    const prompt = String(body.prompt ?? "").trim() || (files.length ? (files.every(isImageAttachment) ? "첨부한 이미지를 확인해 주세요." : "첨부한 파일을 확인해 주세요.") : "");
    if (!prompt) throw new HttpError(400, "내용이나 파일을 입력하세요.");
    const references = validateArtifactReferences(session, body.references, prompt, artifactOptions(id));
    const meta = { ...(files.length ? { attachments: files } : {}), ...(references.length ? { references } : {}) };
    if (runner.isRunning(session.id)) {
      if (body.mode === "steer" && runner.canInject(session)) {
        runner.inject(session, prompt, meta, expandPrompt(session, prompt));
        return { injected: true };
      }
      chain.enqueue(session, prompt, { user: true, ...meta }, 0);
      return { queued: true };
    }
    startTurn(session, prompt, 0, meta, { expand: true });
    return { ok: true };
  }

  // 작성창의 @ 자동 완성: 세션 작업 폴더의 파일·폴더를 이름으로 찾는다.
  async function files(id, query) {
    const session = getSession(id);
    if (session.chat || !session.cwd || !fs.existsSync(session.cwd)) return { files: [] };
    return { files: rankFiles(await projectFiles(session.cwd), String(query ?? "").slice(0, 200)) };
  }

  function uploadAttachment(id, body) {
    getSession(id);
    return attachments.save(id, body);
  }

  function attachmentContent(id, imageId) {
    getSession(id);
    const image = attachments.resolve(id, imageId);
    return { bytes: fs.readFileSync(image.path), mimeType: image.mimeType, name: image.name };
  }

  function artifactOptions(id) {
    return {
      resolveAttachment: (attachment) => attachments.resolve(id, attachment.id),
      validateEntityReference(kind, targetId) {
        const session = getSession(id);
        const target = kind === "session" ? store.get(targetId) : tasks?.()?.get?.(targetId);
        if (!target) throw new HttpError(404, "참조한 세션이나 작업을 찾지 못했습니다.");
        if (Boolean(session.projectPath) !== Boolean(target.projectPath) || (session.projectPath && !samePath(session.projectPath, target.projectPath))) throw new HttpError(403, "같은 프로젝트의 세션과 작업만 참조할 수 있습니다.");
      },
    };
  }

  function artifact(id, filePath, { summary = false } = {}) {
    if (summary) {
      const { realPath, ...result } = resolveSessionArtifact(getSession(id), filePath, artifactOptions(id));
      return result;
    }
    return readSessionArtifact(getSession(id), filePath, artifactOptions(id));
  }

  function artifactContent(id, filePath) {
    return readSessionArtifactContent(getSession(id), filePath, artifactOptions(id));
  }

  function artifactPreview(id, filePath) {
    const result = artifact(id, filePath);
    if (typeof result.previewHtml !== "string") throw new HttpError(415, result.truncated ? "HTML 미리보기는 512 KiB 이하의 파일을 지원합니다." : "HTML 파일만 화면으로 미리 볼 수 있습니다.");
    return result.previewHtml;
  }

  // format: "markdown"(기본, 사람이 읽는 문서) | "agenthub"(다른 세션에서 불러오거나 읽힐 수 있는 .agenthub 파일)
  async function exportRecord(id, { format = "markdown" } = {}) {
    const session = getSession(id);
    if (!["agenthub", "markdown"].includes(format)) throw new HttpError(400, "format은 agenthub 또는 markdown입니다.");
    try {
      const snapshot = structuredClone(session);
      if (format === "agenthub") {
        const result = await exportBundle(snapshot, { readAttachment: (attachment) => fs.readFileSync(attachments.resolve(id, attachment.id).path) });
        const omitted = result.omittedAttachments ? ` 첨부 ${result.omittedAttachments}개는 크기 제한으로 이름만 남겼습니다.` : "";
        runner.append(session, { kind: "status", text: `세션을 ${result.relativePath}에 내보냈습니다.${omitted}` });
        return { path: result.path, relativePath: result.relativePath, fileName: result.fileName, format };
      }
      const result = await exportSession(snapshot, { resolveAttachment: (image) => attachments.resolve(id, image.id).path });
      runner.append(session, { kind: "status", text: `작업 기록을 ${result.relativePath}에 내보냈습니다.` });
      return { path: result.path, relativePath: result.relativePath, fileName: result.fileName, format: "markdown" };
    } catch (err) {
      throw new HttpError(err.code === "EXPORT_PROJECT_REQUIRED" ? 400 : 409, `작업 기록을 내보내지 못했습니다: ${err.message}`);
    }
  }

  // ── 기록 가져오기 ───────────────────────────────────────────────
  // 내보낸 기록 문서를 찾는 곳: 프로젝트 원본, 그리고 세션을 고르면 그 세션의 작업 폴더(워크트리)
  function recordFolders(projectPath, sessionId) {
    const project = path.resolve(String(projectPath ?? ""));
    const folders = [{ location: "project", dir: project }];
    if (sessionId) {
      const session = getSession(sessionId);
      if (session.cwd && !session.chat && !samePath(session.cwd, project)) folders.push({ location: "session", dir: session.cwd });
    }
    return folders;
  }

  async function listRecords({ projectPath, sessionId }) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const groups = await Promise.all(recordFolders(projectPath, sessionId).map(async ({ location, dir }) =>
      (await listRecords_(dir).catch(() => [])).map((record) => ({ ...record, location }))));
    return groups.flat();
  }

  // 업로드한 내용(content, 예전 화면은 markdown)이나 docs/agenthub의 파일 이름으로 기록을 읽는다.
  async function readSource(project, body) {
    try {
      const uploaded = typeof body.content === "string" ? body.content : typeof body.markdown === "string" ? body.markdown : null;
      if (uploaded !== null) {
        const name = String(body.fileName ?? "기록 문서").replace(/[\x00-\x1f]/g, "").slice(0, 200);
        const limit = isBundleName(name) ? BUNDLE_MAX_BYTES : RECORD_MAX_BYTES;
        if (Buffer.byteLength(uploaded) > limit) throw Object.assign(new Error(recordLimitText(name)), { code: "IMPORT_TOO_LARGE" });
        return { content: uploaded, folder: null, name };
      }
      const folder = recordFolders(project.path, body.sessionId).find((f) => f.location === (body.location ?? "project"));
      if (!folder) throw Object.assign(new Error("기록 위치가 올바르지 않습니다."), { code: "IMPORT_PATH" });
      const read = await readRecord(folder.dir, body.fileName);
      return { ...read, name: body.fileName };
    } catch (err) {
      throw new HttpError(err.code === "IMPORT_MISSING" ? 404 : 400, err.message);
    }
  }

  function parseSource(source) {
    try { return parseRecord(source.content, source.name); }
    catch (err) { throw new HttpError(400, err.message); }
  }

  async function importRecord(body = {}) {
    const project = ensureProject(body.projectPath);
    const source = await readSource(project, body);
    const parsed = parseSource(source);
    const bundle = parsed.format === "agenthub";
    const agent = body.agent ?? parsed.meta.agent ?? "claude";
    // .agenthub 파일은 같은 AI면 모델·추론 강도·권한·역할까지 되살린다. 이 PC에 없는 값이면 기본값을 쓴다.
    // 파일은 남이 준 것일 수 있으므로 확인 없이 실행하는 권한은 되살리지 않는다.
    const same = bundle && agent === parsed.meta.agent;
    const filePermission = same && !ELEVATED_PERMISSIONS.has(parsed.meta.permission) ? parsed.meta.permission : undefined;
    let options = { agent, permission: body.permission ?? filePermission, model: same ? parsed.meta.model ?? "" : "", effort: same ? parsed.meta.effort : "" };
    try { checkSessionOptions(options); }
    catch { options = { agent, permission: body.permission }; }
    const session = await createSession({
      project, ...options, tabId: body.tabId, connectFrom: body.connectFrom,
      ...(bundle ? { role: parsed.meta.role, roleName: parsed.meta.roleName } : {}),
      title: String(body.title ?? "").trim() || parsed.title || "가져온 기록",
    });
    if (bundle && parsed.meta.skills.length) setSessionSkills(session, parsed.meta.skills);
    // 이미지는 문서 옆 .assets에서 읽어 이 세션의 첨부로 다시 저장한다. 업로드한 문서는 이미지 파일이 없다.
    // .agenthub 파일은 첨부 데이터를 담고 있으므로 이미지 외 파일도 되살린다.
    let missingImages = 0;
    const now = new Date().toISOString();
    for (const [seq, { images, files, ...event }] of parsed.events.entries()) {
      const attached = [];
      for (const file of files ?? []) {
        try {
          if (!file.data) throw new Error("missing");
          attached.push(publicAttachment(attachments.save(session.id, file)));
        } catch {
          missingImages++;
        }
      }
      for (const image of images ?? []) {
        const file = source.folder ? await readRecordImage(source.folder, image.href) : null;
        try {
          if (!file) throw new Error("missing");
          attached.push(publicAttachment(attachments.save(session.id, { name: image.name, mimeType: file.mimeType, data: file.bytes.toString("base64") })));
        } catch {
          missingImages++;
        }
      }
      session.events.push({ ...event, seq, ts: event.ts ?? now, ...(attached.length ? { attachments: attached } : {}) });
    }
    session.importedFrom = { name: source.name, sessionId: parsed.meta.sessionId, exportedAt: parsed.meta.exportedAt, at: now };
    if (body.carry !== false && session.events.some((e) => e.kind === "user")) session.handover = handoverText(session, "", { importedFrom: source.name });
    runner.append(session, { kind: "status", text: `작업 기록 ${source.name}에서 ${parsed.events.length}건을 가져왔습니다.`
      + (session.handover ? " 첫 요청에 기록을 붙여 이어서 작업합니다." : "")
      + (missingImages ? ` 첨부 ${missingImages}개는 찾지 못해 빠졌습니다.` : "") });
    store.touch(session);
    broadcast("sessions", {});
    return summary(session);
  }

  // 기록 읽히기: 다른 세션의 기록(.agenthub·.md)을 이 세션의 다음 요청 앞에 붙여 AI가 읽게 한다.
  // 세션 기록에는 상태 줄만 남기고, 붙일 글은 다음 요청을 보낼 때 한 번만 넘긴다.
  const READ_MAX = 3;
  async function readRecordInto(id, body = {}) {
    const session = getSession(id);
    if (session.chat) throw new HttpError(400, "일반 채팅에는 기록을 읽힐 수 없습니다.");
    const project = ensureProject(session.projectPath);
    const source = await readSource(project, { ...body, sessionId: id });
    const parsed = parseSource(source);
    const reads = (session.pendingReads ?? []).filter((r) => r.name !== source.name);
    if (reads.length >= READ_MAX) throw new HttpError(409, `다음 요청에 붙일 기록은 ${READ_MAX}개까지입니다. 요청을 보낸 뒤 더 읽히세요.`);
    session.pendingReads = [...reads, { name: source.name, text: recordReadText(source.name, parsed) }];
    runner.append(session, { kind: "status", text: `기록 ${source.name}("${parsed.title}", ${parsed.events.length}건)을 읽혔습니다. 다음 요청에 함께 보냅니다.` });
    store.touch(session);
    broadcast("session", { sessionId: id });
    return { ok: true, title: parsed.title, events: parsed.events.length, pending: session.pendingReads.map((r) => r.name) };
  }

  function queueAction(id, itemId, action) {
    const session = getSession(id);
    const found = chain.list(session.id).find((item) => item.id === itemId);
    if (!found) throw new HttpError(404, "대기열에 없는 요청입니다.");
    if (action === "delete") {
      chain.take(id, itemId);
      return { ok: true };
    }
    if (!["steer", "send"].includes(action)) throw new HttpError(400, "action은 steer 또는 send입니다.");
    if (action === "steer" && !runner.canInject(session)) throw new HttpError(409, "실행 중이며 요청 추가를 지원하는 세션에만 붙일 수 있습니다.");
    if (action === "send" && runner.isRunning(id)) throw new HttpError(409, "실행 중입니다. 끝나면 차례로 보냅니다.");
    const item = chain.take(id, itemId);
    if (!chain.canDeliver(session, item)) throw new HttpError(409, "보낸 세션과의 활성 연결이 없어 메시지를 전달할 수 없습니다.");
    if (action === "steer") runner.inject(session, item.text, item.meta, item.meta.user ? expandPrompt(session, item.text) : item.text);
    else {
      if (clearPause(session) || session.state === "paused") runner.setState(session, "idle");
      chain.enqueue(session, item.text, item.meta, item.depth);
    }
    return { ok: true };
  }

  async function update(id, body) {
    const session = getSession(id);
    if (body.tabId !== undefined && graphTabs) {
      const targetId = graphTabs.resolve(session.projectPath, body.tabId);
      if (targetId !== graphTabs.tabFor(session)) throw new HttpError(400, "세션은 탭 이동 메뉴로 옮기세요.");
    }
    if (body.locked !== undefined && typeof body.locked !== "boolean") throw new HttpError(400, "locked는 true 또는 false여야 합니다.");
    if (body.agent !== undefined && body.agent !== session.agent) await switchAgent(session, body);
    if (body.title !== undefined) session.title = String(body.title).trim() || session.title;
    if (body.roleName !== undefined) session.roleName = String(body.roleName ?? "").trim().slice(0, 100);
    if (body.model !== undefined) session.model = checkModel(body.model);
    if (body.effort !== undefined) session.effort = checkEffort(session.agent, body.effort);
    if (body.permission !== undefined && !session.chat) {
      if (!AGENTS[session.agent].PERMISSION_MODES.includes(body.permission)) throw new HttpError(400, "권한 모드가 올바르지 않습니다.");
      session.permission = body.permission;
    }
    if (body.role !== undefined) {
      const role = String(body.role).trim().slice(0, ROLE_MAX);
      if (role !== (session.role ?? "") && session.agentSessionId) session.roleChanged = true;
      session.role = role;
    }
    if (body.graphPos !== undefined) {
      const { x, y } = body.graphPos ?? {};
      session.graphPos = Number.isFinite(x) && Number.isFinite(y) ? { x: Math.max(0, x), y: Math.max(0, y) } : null;
    }
    if (body.skills !== undefined && !session.chat) setSessionSkills(session, body.skills);
    if (body.locked !== undefined) session.locked = body.locked;
    store.touch(session);
    if (body.locked !== undefined) store.flush(session.id);
    broadcast("sessions", {});
    return summary(session);
  }

  async function decidePlan(id, planId, body) {
    const session = getSession(id);
    const event = session.events.find((e) => e.kind === "plan" && e.planId === planId);
    if (!event) throw new HttpError(404, "계획이 없습니다.");
    if (event.status !== "pending") throw new HttpError(409, "이미 처리한 계획입니다.");
    if (body.action === "approve") {
      try {
        event.result = await applyPlan(session, event.raw);
        event.status = "applied";
      } catch (err) {
        throw new HttpError(400, `계획을 실행하지 못했습니다: ${err.message}`);
      }
    } else if (body.action === "reject") {
      event.status = "rejected";
      const reason = String(body.reason ?? "").trim();
      if (reason) chain.enqueue(session, `[계획 거절] ${reason}\n계획을 고쳐 다시 제안하라.`, {}, 0);
    } else throw new HttpError(400, "action은 approve 또는 reject입니다.");
    store.touch(session);
    broadcast("session", { sessionId: id });
    return event;
  }

  function answerQuestion(id, questionId, { answers }) {
    const session = getSession(id);
    const event = session.events.find((e) => e.kind === "question" && e.questionId === questionId);
    if (!event) throw new HttpError(404, "질문이 없습니다.");
    if (event.status !== "pending") throw new HttpError(409, "이미 답했거나 지나간 질문입니다.");
    if (!hasAnswer(answers)) throw new HttpError(400, "답을 고르거나 적으세요.");
    if (event.live) {
      try {
        runner.answer(event.questionId, { answers });
      } catch (err) {
        throw new HttpError(409, err.message);
      }
      chain.controls?.continue(session);
      chain.workflow?.settle();
      broadcast("session", { sessionId: id });
      broadcast("sessions", {});
      return event;
    }
    if (runner.isRunning(id)) throw new HttpError(409, "이 세션은 이미 실행 중입니다.");
    event.status = "answered";
    event.answers = answers;
    try {
      startTurn(session, answerPrompt(event.questions, answers), session.chainDepth ?? 0, {}, { keepMode: true });
    } catch (err) {
      event.status = "pending";
      delete event.answers;
      throw err;
    }
    broadcast("session", { sessionId: id });
    return event;
  }

  function answerPermission(id, permissionId, { decision, message }) {
    const session = getSession(id);
    if (!["allow", "always", "deny"].includes(decision)) throw new HttpError(400, "decision은 allow, always, deny 중 하나입니다.");
    if (!runner.hasPrompt(permissionId, id)) throw new HttpError(409, "이미 답했거나 끝난 요청입니다.");
    const event = runner.answer(permissionId, { decision, message: String(message ?? "").trim().slice(0, 2000) });
    chain.controls?.continue(session);
    chain.workflow?.settle();
    broadcast("session", { sessionId: id });
    broadcast("sessions", {});
    return event;
  }

  async function stop(id) {
    const session = getSession(id);
    if (session.paused && !runner.isRunning(id)) {
      clearPause(session);
      runner.setState(session, "idle");
      await chain.onTurnEnd(session, null);
      runner.append(session, { kind: "status", text: "일시중지를 풀고 중지했습니다." });
      return { stopped: true };
    }
    return { stopped: runner.stop(session) };
  }

  function pause(id) {
    const session = getSession(id);
    pauseSession(session);
    return summary(session);
  }

  function resume(id) {
    const session = getSession(id);
    resumeSession(session);
    return summary(session);
  }

  function restart(id) {
    const session = getSession(id);
    try {
      runner.restart(session);
    } catch (err) {
      throw new HttpError(409, err.message);
    }
    broadcast("sessions", {});
    broadcast("session", { sessionId: id });
    return summary(session);
  }

  function recreate(id) {
    const session = getSession(id);
    const taskService = tasks?.();
    // Recreating a task session must serialize with task deletion and Git operations.
    return session.taskId && taskService?.withSessionLock
      ? taskService.withSessionLock(session.taskId, () => recreateSession(id))
      : recreateSession(id);
  }

  async function recreateSession(id) {
    const session = getSession(id);
    if (runner.isRunning(id)) throw new HttpError(409, "실행 중인 세션은 재생성할 수 없습니다. 먼저 중지하세요.", "running");
    if (session.gitContext) {
      try { assertSessionGitContext(session); }
      catch (error) { throw new HttpError(409, error.message, "git-context"); }
    }
    if (session.worktree && !fs.existsSync(session.worktree.dir)) throw new HttpError(409, session.taskId || session.worktree.shared
      ? "작업 폴더가 없습니다. 작업 탭에서 상태를 확인하세요. 대화 기록은 보관되며 작업 폴더 복구 또는 새 작업이 필요합니다."
      : "워크트리 폴더가 없습니다. 서버를 다시 시작해 원본 폴더로 전환한 뒤 재생성하세요.");
    const created = await createSession({
      project: session.chat ? null : ensureProject(session.projectPath),
      title: session.title, role: session.role, roleName: session.roleName,
      orchestrator: session.kind === "orchestrator", createdBy: session.createdBy,
      ...(graphTabs && !session.chat ? { tabId: graphTabs.tabFor(session) } : {}),
      chat: session.chat, agent: session.agent, model: session.model, effort: session.effort, permission: session.permission,
    }, { worktree: session.worktree, taskId: session.taskId });
    Object.assign(created, {
      baseCommit: session.baseCommit ?? created.baseCommit, graphPos: session.graphPos ?? null,
      locked: !!session.locked,
      previousCwd: session.previousCwd, previousWorktree: session.previousWorktree,
      ...(session.gitContext ? { gitContext: structuredClone(session.gitContext) } : {}),
    });
    store.touch(created);
    tasks?.()?.replaceSession?.(id, created.id);
    for (const link of links.list()) {
      if (link.from === id) links.update(link, { from: created.id, pending: null });
      if (link.to === id) links.update(link, { to: created.id, pending: null });
    }
    replaceGroupMember(id, created.id);
    nodeGroups?.()?.replaceNode(id, created.id);
    for (const other of store.list()) {
      if (other.createdBy !== id) continue;
      other.createdBy = created.id;
      store.touch(other);
    }
    store.remove(id);
    try { attachments.remove(id); } catch (err) { runner.append(created, { kind: "log", text: `이전 첨부 파일 정리 실패: ${err.message}` }); }
    if (!session.chat) hideRecords(cliSessionIds(session));
    broadcast("sessions", {});
    broadcast("links", {});
    return summary(created);
  }

  async function diff(id) {
    const session = getSession(id);
    if (!session.baseCommit) throw new HttpError(400, "git 저장소가 아닙니다.");
    return diffSince(session.cwd, session.baseCommit);
  }

  async function remove(id, { force = false, removeWorktree: removeFolder = false, deleteRecords = false } = {}) {
    const session = getSession(id);
    if (removeFolder && (session.taskId || session.worktree?.shared)) throw new HttpError(409, "공유하는 작업 브랜치의 폴더는 세션 삭제와 함께 지울 수 없습니다. 작업 탭에서 정리 상태를 확인하세요.", "task-worktree");
    if (runner.isRunning(id)) {
      if (!force) throw new HttpError(409, "실행 중인 세션입니다.", "running");
      runner.stop(session);
    }
    if (session.worktree && removeFolder) {
      try {
        await removeWorktree(session.projectPath, session.worktree.dir);
      } catch (err) {
        throw new HttpError(409, `작업 폴더를 지우지 못했습니다(커밋하지 않은 변경이 있을 수 있음): ${err.message}`, "worktree");
      }
    }
    try {
      store.remove(id);
    } catch (err) {
      throw new HttpError(500, `세션 파일을 지우지 못했습니다: ${err.message}`);
    }
    const records = cleanupSession(session, { deleteRecords });
    nodeGroups?.()?.pruneNode(id);
    tasks?.()?.detachSession?.(id);
    // 이 세션을 열어 둔 화면·팝업 창이 닫히도록 알린다.
    broadcast("session-removed", { sessionId: id, projectPath: session.projectPath ?? null });
    broadcast("sessions", {});
    broadcast("links", {});
    return { ok: true, records };
  }

  return {
    list: () => store.list().map((s) => summary(settleState(s))), detail,
    create, importSession, update, sendMessage, files, readRecordInto, uploadAttachment, attachmentContent, artifact, artifactContent, artifactPreview, exportRecord, listRecords, importRecord, queueAction, decidePlan, answerQuestion, answerPermission,
    stop, pause, resume, restart, recreate, diff, remove,
    getSession, createSession, composeInput, startTurn, checkSessionOptions, setSessionSkills,
    dropMissingSkills, cleanupSession, cliSessionIds, hideRecords,
    finishHandover(session) {
      if (session.handover && session.agentSessionId) delete session.handover;
    },
  };
}
