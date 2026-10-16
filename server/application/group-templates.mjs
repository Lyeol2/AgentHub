import { randomBytes } from "node:crypto";
import { GroupTemplateStore } from "../group-templates.mjs";
import { checkCommand, commandKind, newCommandId } from "../commands.mjs";
import { FLOW_MEMBER_KINDS, newHookToken } from "../flow-nodes.mjs";
import { CONDITIONS } from "../policies/workflows.mjs";
import { listWorkbranches } from "../workbranches.mjs";
import { summary } from "../store.mjs";
import { ROLE_MAX } from "../role.mjs";
import { HttpError } from "./errors.mjs";

const clone = (value) => structuredClone(value);
const point = (value) => value && Number.isFinite(value.x) && Number.isFinite(value.y);
const fail = (message) => { throw new HttpError(400, message); };
const label = (value, fallback) => String(value ?? "").trim().slice(0, 100) || fallback;
const freshId = (prefix) => prefix + randomBytes(8).toString("hex");

export function createGroupTemplateService({ dataDir, store, commands, links, nodeGroups, projects, sessions, graphTabs, notify = () => {} }) {
  const templates = new GroupTemplateStore({ dataDir });
  const node = (id) => store.get(id) ?? commands.get(id);
  function get(id) {
    const template = templates.get(id);
    if (!template) throw new HttpError(404, "그룹 템플릿이 없습니다.");
    return template;
  }
  function sessionDefinition(item) {
    const options = sessions.checkSessionOptions(item);
    return { ...options, title: label(item.title, "AI 세션"), role: String(item.role ?? "").trim().slice(0, ROLE_MAX),
      roleName: String(item.roleName ?? "").trim().slice(0, 100), orchestrator: item.kind === "orchestrator" || item.orchestrator === true,
      locked: item.locked === true,
      skills: [...new Set((Array.isArray(item.skills) ? item.skills : []).filter((skill) => typeof skill === "string" && skill.trim()).map((skill) => skill.trim()))] };
  }
  function commandDefinition(item) {
    try {
      const config = { ...checkCommand(item), kind: commandKind(item) };
      // A template stores the timing rule, never an active schedule or its next firing.
      if (config.kind === "schedule") { delete config.scheduleEnabled; delete config.nextRunAt; }
      return config;
    }
    catch (error) { throw new HttpError(400, error.message); }
  }
  function linkDefinition(item, byKey) {
    const from = byKey.get(item.from), to = byKey.get(item.to);
    if (!from || !to || item.from === item.to) fail("템플릿 연결은 서로 다른 내부 노드에 연결해야 합니다.");
    const fromKind = from.type === "session" ? "session" : commandKind(from.config);
    const toKind = to.type === "session" ? "session" : commandKind(to.config);
    if (["button", "input", "watch", "webhook-in", "schedule"].includes(toKind) || fromKind === "markdown") fail("템플릿의 연결 방향이 노드 종류와 맞지 않습니다.");
    const when = item.when ?? "success";
    if (!CONDITIONS.includes(when)) fail("템플릿 연결 조건이 올바르지 않습니다.");
    if (["git", "task", "repeat"].includes(fromKind) && !["success", "error", "always", "manual"].includes(when)) fail("Git·작업·반복 출력은 성공·실패·항상·수동 조건을 사용하세요.");
    const keyword = when === "keyword" ? String(item.keyword ?? "").trim().slice(0, 100) : "";
    if (when === "keyword" && !keyword) fail("키워드 연결에는 키워드를 입력하세요.");
    const fromTask = fromKind === "task" && from.config.taskAction === "start";
    const canUse = (fromKind === "git" || fromTask) && ["session", "command"].includes(toKind);
    const useGitWorktree = item.useGitWorktree ?? (canUse && (fromTask || from.config.gitAction === "use") && when === "success");
    if (typeof useGitWorktree !== "boolean" || (useGitWorktree && (!canUse || when === "error"))) fail("템플릿의 Git 작업 폴더 전달 설정이 올바르지 않습니다.");
    return { from: item.from, to: item.to, when, keyword,
      note: String(item.note ?? "").trim().slice(0, ROLE_MAX), enabled: item.enabled !== false, approve: item.approve === true,
      ...(canUse || item.useGitWorktree !== undefined ? { useGitWorktree } : {}) };
  }
  // Validate persisted definitions again before creating anything, including after app upgrades.
  function validate(template) {
    if (!Array.isArray(template.nodes) || !template.nodes.length || template.nodes.length > 500) fail("템플릿에는 노드를 1~500개 넣을 수 있습니다.");
    if (!Array.isArray(template.links) || !template.group || !Array.isArray(template.group.ports)) fail("그룹 템플릿 형식이 올바르지 않습니다.");
    const byKey = new Map();
    const nodes = template.nodes.map((item) => {
      if (!item || typeof item.key !== "string" || !item.key || byKey.has(item.key) || !["session", "command"].includes(item.type) || !point(item.pos)) fail("템플릿 노드 형식이 올바르지 않습니다.");
      const config = item.type === "session" ? sessionDefinition(item.config ?? {}) : commandDefinition(item.config ?? {});
      const definition = { key: item.key, type: item.type, config, pos: { x: item.pos.x, y: item.pos.y } };
      byKey.set(item.key, definition);
      return definition;
    });
    for (const item of nodes.filter((item) => item.type === "command" && item.config.kind === "group")) {
      for (const key of item.config.members) {
        const member = byKey.get(key);
        if (!member) fail("결과 모으기의 모든 구성원을 같은 그룹 박스에 넣은 뒤 템플릿을 저장하세요.");
        if (key === item.key || (member.type === "command" && !FLOW_MEMBER_KINDS.includes(member.config.kind))) fail("템플릿의 결과 모으기 구성원이 올바르지 않습니다.");
      }
    }
    const rect = template.group.rect;
    if (!rect || !Number.isFinite(rect.w) || !Number.isFinite(rect.h) || rect.w < 260 || rect.h < 160) fail("템플릿 그룹 크기가 올바르지 않습니다.");
    const portIds = new Set(), portKeys = new Set();
    const ports = template.group.ports.map((item) => {
      const target = byKey.get(item.nodeId);
      if (!target || !["input", "output"].includes(item.direction)) fail("템플릿 포트는 내부 노드에 연결해야 합니다.");
      const kind = target.type === "session" ? "session" : target.config.kind;
      if (item.direction === "input" && ["button", "input", "watch", "webhook-in", "schedule"].includes(kind) || item.direction === "output" && kind === "markdown") fail("템플릿 포트 방향이 노드 종류와 맞지 않습니다.");
      if (typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || portIds.has(item.id)) fail("템플릿 포트 ID가 올바르지 않습니다.");
      portIds.add(item.id);
      const port = { id: item.id, direction: item.direction, nodeId: item.nodeId, label: label(item.label, "포트") };
      if (item.direction === "output") {
        port.when = item.when ?? "success";
        if (!CONDITIONS.includes(port.when) || ["git", "task", "repeat"].includes(kind) && !["success", "error", "always", "manual"].includes(port.when)) fail("템플릿 포트 출력 조건이 올바르지 않습니다.");
        port.keyword = port.when === "keyword" ? String(item.keyword ?? "").trim().slice(0, 100) : "";
        if (port.when === "keyword" && !port.keyword) fail("키워드 출력 포트에는 키워드를 입력하세요.");
      }
      const key = JSON.stringify([port.direction, port.nodeId, port.when ?? "", port.keyword ?? ""]);
      if (portKeys.has(key)) fail("템플릿의 같은 입출력 포트가 중복되었습니다.");
      portKeys.add(key);
      return port;
    });
    const edgeKeys = new Set();
    const edges = template.links.map((item) => {
      const checked = linkDefinition(item, byKey);
      const key = JSON.stringify([checked.from, checked.to, checked.when, checked.keyword]);
      if (edgeKeys.has(key)) fail("템플릿의 같은 연결이 중복되었습니다.");
      edgeKeys.add(key);
      return checked;
    });
    return { nodes, links: edges, group: { title: label(template.group.title, "노드 그룹"), collapsed: template.group.collapsed === true,
      rect: { w: Math.round(rect.w), h: Math.round(rect.h) }, ports } };
  }
  function list(projectPath) {
    if (projectPath) projects.ensureProject(projectPath);
    return { templates: clone(templates.list()) };
  }
  function create(body = {}) {
    // A saved container always has an internal node that identifies its project.
    const found = [...new Set([...store.list(), ...commands.list()].map((item) => item.projectPath).filter(Boolean))]
      .flatMap((projectPath) => nodeGroups.list(projectPath).groups).find((item) => item.id === body.groupId);
    if (!found) throw new HttpError(404, "노드 그룹이 없습니다.");
    if (!found.members.length) fail("빈 그룹은 템플릿으로 저장할 수 없습니다.");
    const selected = new Set(found.members), keys = new Map(found.members.map((id, index) => [id, "n" + (index + 1)]));
    const definition = {
      nodes: found.members.map((id) => {
        const source = node(id);
        if (!source || source.chat || String(id).startsWith("grp-")) fail("템플릿에는 내부 실행 노드만 넣을 수 있습니다.");
        const pos = store.get(id) ? source.graphPos : source.pos;
        if (!point(pos)) fail("그룹 노드의 위치를 저장한 뒤 다시 시도하세요.");
        const config = store.get(id) ? sessionDefinition(source) : commandDefinition(source);
        if (config.kind === "group") {
          if (config.members.some((member) => !selected.has(member))) fail("결과 모으기의 모든 구성원을 같은 그룹 박스에 넣은 뒤 템플릿을 저장하세요.");
          config.members = config.members.map((member) => keys.get(member));
        }
        return { key: keys.get(id), type: store.get(id) ? "session" : "command", config, pos: { x: pos.x - found.rect.x, y: pos.y - found.rect.y } };
      }),
      links: links.list().filter((link) => selected.has(link.from) && selected.has(link.to)).map((link) => ({ ...link, from: keys.get(link.from), to: keys.get(link.to) })),
      group: { title: found.title, collapsed: found.collapsed, rect: { w: found.rect.w, h: found.rect.h },
        ports: (found.ports ?? []).map((port) => ({ ...port, nodeId: keys.get(port.nodeId) })) },
    };
    const checked = validate(definition);
    const now = new Date().toISOString();
    const template = { id: freshId("gtpl-"), version: 1, title: label(body.title, found.title), createdAt: now, ...checked };
    templates.add(template);
    notify("group-templates", {});
    return clone(template);
  }
  async function instantiate(id, body = {}) {
    const definition = validate(get(id));
    const project = projects.ensureProject(body.projectPath);
    const tabId = graphTabs?.resolve(project.path, body.tabId);
    if (body.pos !== undefined && (!point(body.pos) || body.pos.x < 0 || body.pos.y < 0)) fail("템플릿을 놓을 위치가 올바르지 않습니다.");
    const pos = { x: Math.max(body.pos?.x ?? 60, 0, ...definition.nodes.map((item) => -item.pos.x)),
      y: Math.max(body.pos?.y ?? 60, 0, ...definition.nodes.map((item) => -item.pos.y)) };
    const gitNodes = definition.nodes.filter((item) => item.type === "command" && item.config.kind === "git");
    if (gitNodes.length) {
      // Listing is read only; instantiation never creates or checks out a worktree.
      const branches = await listWorkbranches(project.path);
      const existing = new Set(branches.branches.map((branch) => branch.name));
      for (const item of gitNodes) for (const branch of [item.config.branch, item.config.targetBranch].filter(Boolean)) {
        if (!existing.has(branch)) fail('대상 프로젝트에 "' + branch + '" 로컬 브랜치가 없습니다. 필요한 브랜치를 만든 뒤 템플릿을 추가하세요.');
      }
    }
    const createdSessions = [], createdCommands = [], createdLinks = [], ids = new Map();
    let group = null, groupsBefore = null;
    try {
      for (const item of definition.nodes.filter((item) => item.type === "session")) {
        const session = await sessions.createSession({ project, ...item.config, tabId, chat: false, isolate: false });
        createdSessions.push(session);
        ids.set(item.key, session.id);
        session.graphPos = { x: pos.x + item.pos.x, y: pos.y + item.pos.y };
        session.locked = item.config.locked;
        sessions.setSessionSkills?.(session, item.config.skills);
        store.touch(session);
      }
      for (const item of definition.nodes.filter((item) => item.type === "command")) ids.set(item.key, newCommandId());
      for (const item of definition.nodes.filter((item) => item.type === "command")) {
        const config = clone(item.config);
        if (config.kind === "group") config.members = config.members.map((key) => ids.get(key));
        // 템플릿은 받는 주소를 담지 않는다. 추가할 때마다 새 주소를 만든다.
        if (config.kind === "webhook-in") config.hookToken = newHookToken();
        if (config.kind === "schedule") { config.scheduleEnabled = false; config.nextRunAt = null; }
        const command = { id: ids.get(item.key), projectPath: project.path, ...config,
          ...(tabId ? { tabId } : {}),
          pos: { x: pos.x + item.pos.x, y: pos.y + item.pos.y }, state: "idle", lastRun: null, createdAt: new Date().toISOString() };
        createdCommands.push(command);
        commands.add(command);
      }
      for (const item of definition.links) {
        const link = { id: freshId(""), ...item, from: ids.get(item.from), to: ids.get(item.to), pending: null };
        createdLinks.push(link);
        links.add(link);
      }
      groupsBefore = new Set(nodeGroups.list(project.path).groups.map((item) => item.id));
      group = nodeGroups.create({ projectPath: project.path, tabId, title: definition.group.title, members: definition.nodes.map((item) => ids.get(item.key)),
        rect: { x: pos.x, y: pos.y, ...definition.group.rect }, collapsed: definition.group.collapsed,
        ports: definition.group.ports.map((port) => ({ ...port, id: freshId("port-"), nodeId: ids.get(port.nodeId) })) });
      notify("sessions", {});
      notify("commands", {});
      notify("links", {});
      return { group, nodes: { sessions: createdSessions.map(summary), commands: clone(createdCommands) }, links: clone(createdLinks) };
    } catch (error) {
      const rollbackErrors = [];
      const undo = (action) => { try { action(); } catch (failure) { rollbackErrors.push(failure.message); } };
      if (group) undo(() => nodeGroups.remove(group.id));
      else if (groupsBefore) {
        // create() is synchronous; account for a persistence failure after it inserted the box.
        const owned = new Set([...createdSessions, ...createdCommands].map((item) => item.id));
        for (const candidate of nodeGroups.list(project.path).groups) {
          if (!groupsBefore.has(candidate.id) && candidate.members.length && candidate.members.every((member) => owned.has(member))) undo(() => nodeGroups.remove(candidate.id));
        }
      }
      for (const link of createdLinks.reverse()) undo(() => links.remove(link.id));
      for (const command of createdCommands.reverse()) undo(() => commands.remove(command.id));
      for (const session of createdSessions.reverse()) undo(() => store.remove(session.id));
      notify("sessions", {}); notify("commands", {}); notify("links", {}); notify("node-groups", {});
      if (rollbackErrors.length) throw new HttpError(500, error.message + " (생성 취소 중 오류: " + rollbackErrors.join("; ") + ")");
      throw error;
    }
  }
  function remove(id) { get(id); templates.remove(id); notify("group-templates", {}); return { ok: true }; }
  return { list, create, instantiate, remove };
}
