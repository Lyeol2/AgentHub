import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.mjs";
import { readJsonFile, writeJsonAtomic } from "./infrastructure/persistence/json-file.mjs";
import { CONDITIONS } from "./policies/workflows.mjs";
import { HttpError } from "./application/errors.mjs";

export const NODE_GROUP_PREFIX = "grp-";
export const isNodeGroupId = (id) => typeof id === "string" && id.startsWith(NODE_GROUP_PREFIX);
const sameProject = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const point = (value) => value && Number.isFinite(value.x) && Number.isFinite(value.y);
const portKey = (port) => JSON.stringify([port.direction, port.nodeId, port.direction === "output" ? port.when ?? "success" : "", port.direction === "output" && port.when === "keyword" ? port.keyword ?? "" : ""]);

// Containers have their own persistence. Executable links retain the actual node IDs.
export class NodeGroupStore {
  constructor({ dataDir = DATA_DIR } = {}) {
    this.file = path.join(dataDir, "node-groups.json");
    this.groups = readJsonFile(this.file, { dataDir, fallback: () => [], valid: (value) => Array.isArray(value) && value.every((group) => group && typeof group.id === "string" && typeof group.projectPath === "string" && Array.isArray(group.members)) });
  }
  list(projectPath) { return projectPath ? this.groups.filter((group) => sameProject(group.projectPath, projectPath)) : this.groups; }
  get(id) { return this.groups.find((group) => group.id === id); }
  add(group) { this.groups.push(group); this.save(); return group; }
  update(groupOrId, changes) {
    const group = typeof groupOrId === "string" ? this.get(groupOrId) : groupOrId;
    if (!group) return null;
    Object.assign(group, changes); this.save(); return group;
  }
  remove(id) {
    const before = this.groups.length;
    this.groups = this.groups.filter((group) => group.id !== id);
    if (this.groups.length !== before) this.save();
  }
  save() { writeJsonAtomic(this.file, this.groups); }
}

export function createNodeGroupService({ groups, store, commands, links, projects, notify = () => {} }) {
  const node = (id) => store.get(id) ?? commands.get(id);
  const isSession = (id) => !!store.get(id);
  const validNode = (id, projectPath) => {
    const found = node(id);
    return found && !found.chat && sameProject(found.projectPath, projectPath) ? found : null;
  };
  const groupById = (id) => {
    const group = groups.get(id);
    if (!group) throw new HttpError(404, "노드 그룹이 없습니다.");
    return group;
  };
  function checkMembers(value, projectPath, currentId, { allowEmpty = true } = {}) {
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id)) throw new HttpError(400, "그룹에 넣을 노드를 선택하세요.");
    const members = [...new Set(value)];
    if (!allowEmpty && !members.length) throw new HttpError(400, "그룹에 넣을 노드를 하나 이상 선택하세요.");
    for (const id of members) {
      if (isNodeGroupId(id)) throw new HttpError(400, "그룹 안에 다른 그룹을 넣을 수 없습니다.");
      if (!validNode(id, projectPath)) throw new HttpError(400, "같은 프로젝트의 노드만 그룹에 넣을 수 있습니다. 일반 채팅은 제외됩니다.");
      if (groups.list().some((other) => other.id !== currentId && (other.members ?? []).includes(id))) throw new HttpError(409, "이미 다른 그룹에 들어 있는 노드입니다.");
    }
    return members;
  }
  function checkRect(value) {
    if (!value || !["x", "y", "w", "h"].every((key) => Number.isFinite(value[key])) || value.x < 0 || value.y < 0 || value.w < 260 || value.h < 160) {
      throw new HttpError(400, "그룹 위치와 크기가 올바르지 않습니다. 최소 크기는 260×160입니다.");
    }
    return Object.fromEntries(["x", "y", "w", "h"].map((key) => [key, Math.round(value[key])]));
  }
  function checkPorts(value, members, projectPath) {
    if (!Array.isArray(value)) throw new HttpError(400, "그룹 포트 목록이 올바르지 않습니다.");
    const ids = new Set();
    const keys = new Set();
    return value.map((item) => {
      if (!item || !["input", "output"].includes(item.direction) || !members.includes(item.nodeId)) throw new HttpError(400, "포트는 그룹 안의 노드 입력이나 출력에 연결해야 합니다.");
      const target = validNode(item.nodeId, projectPath);
      if (!target) throw new HttpError(400, "포트에 연결한 노드가 없습니다.");
      if (item.direction === "input" && ["button", "input", "watch", "webhook-in", "schedule"].includes(target.kind)) throw new HttpError(400, "버튼·입력 폼·파일 감시·웹훅 받기·시간 예약에는 입력 포트를 만들 수 없습니다.");
      if (item.direction === "output" && target.kind === "markdown") throw new HttpError(400, "Markdown 출력에는 출력 포트를 만들 수 없습니다.");
      const id = item.id ?? `port-${randomBytes(6).toString("hex")}`;
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ids.has(id)) throw new HttpError(400, "포트 ID가 올바르지 않거나 중복되었습니다.");
      ids.add(id);
      const port = { id, direction: item.direction, nodeId: item.nodeId, label: String(item.label ?? "").trim().slice(0, 100) || target.title || "포트" };
      if (item.direction === "output") {
        port.when = item.when ?? "success";
        if (!CONDITIONS.includes(port.when)) throw new HttpError(400, "포트 출력 조건이 올바르지 않습니다.");
        if (["git", "task", "repeat"].includes(target.kind) && !["success", "error", "always", "manual"].includes(port.when)) throw new HttpError(400, "Git·작업·반복 출력은 성공·실패·항상·수동 조건을 사용하세요.");
        port.keyword = port.when === "keyword" ? String(item.keyword ?? "").trim().slice(0, 100) : "";
        if (port.when === "keyword" && !port.keyword) throw new HttpError(400, "키워드 출력 포트에는 키워드를 입력하세요.");
      }
      const key = portKey(port);
      if (keys.has(key)) throw new HttpError(400, "같은 노드의 같은 입출력 포트가 중복되었습니다.");
      keys.add(key);
      return port;
    });
  }

  // Mirror the graph's automatic layout for nodes that have not been dragged yet.
  function positions(projectPath) {
    const sessions = store.list().filter((item) => !item.chat && sameProject(item.projectPath, projectPath)).sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
    const cmds = commands.list(projectPath).filter((item) => sameProject(item.projectPath, projectPath));
    const nodes = [...sessions, ...cmds];
    const ids = new Set(nodes.map((item) => item.id));
    const edges = [
      ...sessions.filter((item) => ids.has(item.createdBy)).map((item) => ({ from: item.createdBy, to: item.id })),
      ...cmds.filter((item) => item.kind === "group").flatMap((item) => (item.members ?? []).filter((id) => ids.has(id)).map((id) => ({ from: id, to: item.id }))),
      ...links.list().filter((link) => ids.has(link.from) && ids.has(link.to)),
    ];
    const forward = [], done = new Set(), onPath = new Set();
    function walk(id) {
      onPath.add(id);
      for (const edge of edges.filter((item) => item.from === id)) {
        if (onPath.has(edge.to)) continue;
        forward.push(edge);
        if (!done.has(edge.to)) walk(edge.to);
      }
      onPath.delete(id); done.add(id);
    }
    for (const item of nodes) if (!done.has(item.id)) walk(item.id);
    const levels = new Map(), rows = new Map(), result = new Map();
    function depth(id) {
      if (levels.has(id)) return levels.get(id);
      const parents = forward.filter((item) => item.to === id).map((item) => item.from);
      const value = parents.length ? Math.max(...parents.map(depth)) + 1 : 0;
      levels.set(id, value); return value;
    }
    for (const item of nodes) {
      const level = depth(item.id), row = rows.get(level) ?? 0;
      rows.set(level, row + 1);
      result.set(item.id, point(item.graphPos) ? item.graphPos : point(item.pos) ? item.pos : { x: 20 + level * 326, y: 20 + row * 152 });
    }
    return result;
  }
  function bounds(members, allPositions) {
    const placed = members.map((id) => ({ id, ...allPositions.get(id) }));
    const x = Math.max(0, Math.min(...placed.map((item) => item.x)) - 24);
    const y = Math.max(0, Math.min(...placed.map((item) => item.y)) - 76);
    return { x, y, w: Math.max(260, Math.max(...placed.map((item) => item.x + 230)) + 24 - x), h: Math.max(160, Math.max(...placed.map((item) => item.y + (isSession(item.id) ? 128 : 108))) + 24 - y) };
  }
  function savePositions(members, allPositions, dx = 0, dy = 0, onlyMissing = false) {
    let sessionsChanged = false, commandsChanged = false;
    for (const id of members) {
      const target = node(id);
      if (!target) continue;
      const field = isSession(id) ? "graphPos" : "pos";
      if (onlyMissing && point(target[field])) continue;
      const previous = allPositions.get(id);
      if (!previous) continue;
      const next = { x: Math.max(0, previous.x + dx), y: Math.max(0, previous.y + dy) };
      if (point(target[field]) && target[field].x === next.x && target[field].y === next.y) continue;
      if (field === "graphPos") { target.graphPos = next; store.touch(target); sessionsChanged = true; }
      else { commands.update(target, { pos: next }); commandsChanged = true; }
    }
    if (sessionsChanged) notify("sessions", {});
    if (commandsChanged) notify("commands", {});
  }
  function boundaryPorts(group, members, initial) {
    const ports = [...initial];
    const keys = new Set(ports.map(portKey));
    const inside = new Set(members);
    const suffix = { success: "성공", error: "실패", always: "항상", keyword: "키워드", otherwise: "그 외", manual: "수동" };
    for (const link of links.list()) {
      const fromInside = inside.has(link.from), toInside = inside.has(link.to);
      if (fromInside === toInside || !validNode(link.from, group.projectPath) || !validNode(link.to, group.projectPath)) continue;
      const nodeId = fromInside ? link.from : link.to;
      const direction = fromInside ? "output" : "input";
      const target = node(nodeId);
      if (direction === "input" && ["button", "input", "watch", "webhook-in", "schedule"].includes(target.kind) || direction === "output" && target.kind === "markdown") continue;
      const port = { direction, nodeId, label: `${target.title || "노드"} · ${direction === "input" ? "입력" : suffix[link.when] ?? "출력"}` };
      if (direction === "output") { port.when = link.when ?? "success"; port.keyword = port.when === "keyword" ? link.keyword ?? "" : ""; }
      const key = portKey(port);
      if (keys.has(key)) continue;
      const id = `port-${createHash("sha256").update(group.id + key).digest("hex").slice(0, 16)}`;
      ports.push({ id, ...port }); keys.add(key);
    }
    return ports;
  }
  function cleaned(group) {
    const members = [...new Set((group.members ?? []).filter((id) => validNode(id, group.projectPath)))];
    const ports = [];
    // A deleted/moved member must never leave a dangling alias.
    for (const port of group.ports ?? []) {
      try { const checked = checkPorts([port], members, group.projectPath)[0]; if (!ports.some((item) => item.id === checked.id || portKey(item) === portKey(checked))) ports.push(checked); } catch {}
    }
    return { members, ports: boundaryPorts(group, members, ports) };
  }
  function sync(group) {
    const next = cleaned(group);
    if (JSON.stringify(group.members) !== JSON.stringify(next.members) || JSON.stringify(group.ports ?? []) !== JSON.stringify(next.ports)) groups.update(group, next);
    return group;
  }
  function list(projectPath) { return { groups: projectPath ? groups.list(projectPath).map(sync) : [] }; }
  function create(body) {
    const project = projects.ensureProject(body.projectPath);
    const members = checkMembers(body.members, project.path, null, { allowEmpty: false });
    const allPositions = positions(project.path);
    const rect = body.rect === undefined ? bounds(members, allPositions) : checkRect(body.rect);
    if (body.collapsed !== undefined && typeof body.collapsed !== "boolean") throw new HttpError(400, "그룹 접힘 설정이 올바르지 않습니다.");
    const ports = checkPorts(body.ports ?? [], members, project.path);
    const group = { id: `${NODE_GROUP_PREFIX}${randomBytes(6).toString("hex")}`, projectPath: project.path, title: String(body.title ?? "").trim().slice(0, 100) || "노드 그룹", members, rect, collapsed: body.collapsed ?? false, ports };
    group.ports = boundaryPorts(group, members, ports);
    savePositions(members, allPositions, 0, 0, true);
    groups.add(group);
    notify("node-groups", {});
    return group;
  }
  function update(id, body) {
    const group = groupById(id);
    if (own(body, "projectPath") && !sameProject(body.projectPath, group.projectPath)) throw new HttpError(400, "그룹의 프로젝트는 바꿀 수 없습니다.");
    const members = checkMembers(body.members === undefined ? group.members : body.members, group.projectPath, id);
    const allPositions = positions(group.projectPath);
    let rect = body.rect === undefined ? { ...group.rect } : checkRect(body.rect);
    if (body.rect === undefined && members.some((member) => !group.members.includes(member))) {
      const memberBounds = bounds(members, allPositions);
      const x = Math.min(rect.x, memberBounds.x), y = Math.min(rect.y, memberBounds.y);
      rect = { x, y, w: Math.max(rect.x + rect.w, memberBounds.x + memberBounds.w) - x, h: Math.max(rect.y + rect.h, memberBounds.y + memberBounds.h) - y };
    }
    if (body.collapsed !== undefined && typeof body.collapsed !== "boolean") throw new HttpError(400, "그룹 접힘 설정이 올바르지 않습니다.");
    const existingPorts = (group.ports ?? []).filter((port) => members.includes(port.nodeId));
    const ports = checkPorts(body.ports === undefined ? existingPorts : body.ports, members, group.projectPath);
    const next = { title: body.title === undefined ? group.title : String(body.title).trim().slice(0, 100) || "노드 그룹", members, rect, collapsed: body.collapsed ?? group.collapsed, ports: boundaryPorts(group, members, ports) };
    const dx = body.rect === undefined ? 0 : rect.x - group.rect.x;
    const dy = body.rect === undefined ? 0 : rect.y - group.rect.y;
    // Validate every field before moving any member or mutating persistence.
    if (dx || dy) savePositions(members, allPositions, dx, dy);
    else savePositions(members, allPositions, 0, 0, true);
    groups.update(group, next);
    notify("node-groups", {});
    return group;
  }
  function remove(id) { groupById(id); groups.remove(id); notify("node-groups", {}); return { ok: true }; }
  function pruneNode(id) {
    let changed = false;
    for (const group of groups.list()) {
      if (!(group.members ?? []).includes(id) && !(group.ports ?? []).some((port) => port.nodeId === id)) continue;
      groups.update(group, { members: group.members.filter((member) => member !== id), ports: (group.ports ?? []).filter((port) => port.nodeId !== id) });
      changed = true;
    }
    if (changed) notify("node-groups", {});
  }
  function replaceNode(oldId, newId) {
    const affected = groups.list().filter((group) => (group.members ?? []).includes(oldId));
    // Recreated sessions may be replaced only inside their original project.
    for (const group of affected) checkMembers(group.members.map((member) => member === oldId ? newId : member), group.projectPath, group.id);
    for (const group of affected) {
      const members = [...new Set(group.members.map((member) => member === oldId ? newId : member))];
      const ports = (group.ports ?? []).map((port) => port.nodeId === oldId ? { ...port, nodeId: newId } : port);
      groups.update(group, { members, ports: checkPorts(ports, members, group.projectPath) });
    }
    if (affected.length) notify("node-groups", {});
  }
  function removeProject(projectPath) {
    const found = groups.list(projectPath);
    for (const group of found) groups.remove(group.id);
    if (found.length) notify("node-groups", {});
  }
  function resolvePort(groupId, portId, direction) {
    const group = sync(groupById(groupId));
    const port = (group.ports ?? []).find((item) => item.id === portId && item.direction === direction);
    if (!port) throw new HttpError(400, "그룹의 입출력 포트를 선택하세요.");
    return { ...port };
  }
  const hasNode = (id) => groups.list().some((group) => (group.members ?? []).includes(id));
  return { list, create, update, remove, pruneNode, replaceNode, removeProject, resolvePort, hasNode };
}
