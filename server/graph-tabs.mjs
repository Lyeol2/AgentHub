import path from "node:path";
import { randomBytes } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "./infrastructure/persistence/json-file.mjs";
import { HttpError } from "./application/errors.mjs";

const key = (value) => path.resolve(value).toLowerCase();
const sameProject = (a, b) => !!a && !!b && key(a) === key(b);
const empty = () => ({ version: 1, tabs: [], defaults: {} });
const valid = (value) => value?.version === 1 && Array.isArray(value.tabs) && value.defaults && typeof value.defaults === "object" && !Array.isArray(value.defaults)
  && new Set(value.tabs.map((tab) => tab?.id)).size === value.tabs.length
  && value.tabs.every((tab) => typeof tab?.id === "string" && tab.id && typeof tab.projectPath === "string" && tab.projectPath
    && typeof tab.title === "string" && Number.isInteger(tab.order) && tab.order >= 0);

export class GraphTabStore {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, "graph-tabs.json");
    this.data = readJsonFile(this.file, { dataDir, fallback: empty, valid });
  }
  commit(next) {
    // A failed atomic write must not change the live catalog.
    writeJsonAtomic(this.file, next);
    this.data = next;
  }
  list(projectPath) { return this.data.tabs.filter((tab) => sameProject(tab.projectPath, projectPath)).sort((a, b) => a.order - b.order); }
  get(id) { return this.data.tabs.find((tab) => tab.id === id); }
}

export function createGraphTabService({ tabs, store, commands, groups, projects, notify = () => {} }) {
  const projectService = () => typeof projects === "function" ? projects() : projects;
  const node = (id) => store.get(id) ?? commands.get(id);
  const publicTab = (tab) => ({ id: tab.id, projectPath: tab.projectPath, title: tab.title, order: tab.order });
  const changed = (projectPath, affectedTabIds) => notify("graph-tabs", { projectPath, ...(affectedTabIds ? { affectedTabIds } : {}) });
  function ensure(projectPath) {
    const dir = path.resolve(projectPath);
    let found = tabs.list(dir);
    if (!found.length) {
      const tab = { id: `tab-${randomBytes(6).toString("hex")}`, projectPath: dir, title: "기본", order: 0 };
      tabs.commit({ ...tabs.data, tabs: [...tabs.data.tabs, tab], defaults: { ...tabs.data.defaults, [key(dir)]: tab.id } });
      found = [tab];
    }
    if (!found.some((tab) => tab.id === tabs.data.defaults[key(dir)])) {
      tabs.commit({ ...tabs.data, defaults: { ...tabs.data.defaults, [key(dir)]: found[0].id } });
    }
    return found;
  }
  function defaultId(projectPath) {
    const found = ensure(projectPath);
    return found.find((tab) => tab.id === tabs.data.defaults[key(projectPath)])?.id ?? found[0].id;
  }
  function tabFor(item) {
    if (!item || item.chat || !item.projectPath) return null;
    const tab = tabs.get(item.tabId);
    return tab && sameProject(tab.projectPath, item.projectPath) ? tab.id : defaultId(item.projectPath);
  }
  function resolve(projectPath, tabId, inheritedId) {
    if (tabId === undefined) {
      const source = inheritedId ? node(inheritedId) ?? groups.get(inheritedId) : null;
      return source && sameProject(source.projectPath, projectPath) ? tabFor(source) : defaultId(projectPath);
    }
    const tab = typeof tabId === "string" ? tabs.get(tabId) : null;
    if (!tab || !sameProject(tab.projectPath, projectPath)) throw new HttpError(400, "이 프로젝트의 그리드 탭을 선택하세요.");
    return tab.id;
  }
  function get(id) {
    const tab = tabs.get(id);
    if (!tab) throw new HttpError(404, "그리드 탭이 없습니다.");
    return tab;
  }
  function title(value, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !value.trim() || value.trim().length > 100) throw new HttpError(400, "탭 이름을 1~100자로 입력하세요.");
    return value.trim();
  }
  function list(projectPath) {
    if (!projectPath) return { tabs: [], defaultTabId: null };
    // Viewing an automatically discovered project must not register it in config.json.
    const dir = path.resolve(projectPath);
    return { tabs: ensure(dir).map(publicTab), defaultTabId: defaultId(dir) };
  }
  function create(body = {}) {
    const project = projectService().ensureProject(body.projectPath);
    const found = ensure(project.path);
    let number = 1;
    while (found.some((tab) => tab.title === `시트 ${number}`)) number++;
    const tab = { id: `tab-${randomBytes(6).toString("hex")}`, projectPath: project.path,
      title: title(body.title, `시트 ${number}`), order: found.length };
    tabs.commit({ ...tabs.data, tabs: [...tabs.data.tabs, tab] });
    changed(project.path);
    return publicTab(tab);
  }
  function update(id, body = {}) {
    const current = get(id);
    const next = { ...current, title: title(body.title, current.title) };
    tabs.commit({ ...tabs.data, tabs: tabs.data.tabs.map((tab) => tab.id === id ? next : tab) });
    changed(current.projectPath);
    return publicTab(next);
  }
  function reorder({ projectPath, ids } = {}) {
    const project = projectService().ensureProject(projectPath);
    const found = ensure(project.path);
    if (!Array.isArray(ids) || new Set(ids).size !== found.length || ids.length !== found.length || found.some((tab) => !ids.includes(tab.id))) {
      throw new HttpError(400, "프로젝트의 모든 탭을 중복 없이 지정하세요.");
    }
    tabs.commit({ ...tabs.data, tabs: tabs.data.tabs.map((tab) => sameProject(tab.projectPath, project.path) ? { ...tab, order: ids.indexOf(tab.id) } : tab) });
    changed(project.path);
    return { tabs: tabs.list(project.path).map(publicTab) };
  }
  function selection(ids, projectPath) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new HttpError(400, "이동할 노드를 선택하세요.");
    const selected = new Set(ids);
    for (const id of selected) {
      const found = node(id) ?? groups.get(id);
      if (!found || found.chat || !sameProject(found.projectPath, projectPath)) throw new HttpError(400, "같은 프로젝트의 노드만 옮길 수 있습니다.");
    }
    // A visual container and all its members always travel together. Links are untouched.
    for (const group of groups.list(projectPath)) {
      if (!selected.has(group.id) && !(group.members ?? []).some((id) => selected.has(id))) continue;
      selected.add(group.id);
      for (const id of group.members ?? []) if (node(id) && sameProject(node(id).projectPath, projectPath)) selected.add(id);
    }
    return [...selected].map((id) => ({ item: node(id) ?? groups.get(id), kind: store.get(id) ? "session" : commands.get(id) ? "command" : "group" }));
  }
  function persist(items) {
    for (const { item, kind } of items) if (kind === "session") store.flush(item.id);
    if (items.some(({ kind }) => kind === "command")) commands.save();
    if (items.some(({ kind }) => kind === "group")) groups.save();
  }
  function reassign(items, targetId, finish = () => {}) {
    const previous = items.map(({ item }) => ({ item, existed: Object.hasOwn(item, "tabId"), tabId: item.tabId }));
    try {
      for (const { item } of items) item.tabId = targetId;
      persist(items);
      finish();
    } catch (error) {
      for (const old of previous) if (old.existed) old.item.tabId = old.tabId; else delete old.item.tabId;
      try { persist(items); } catch { /* Keep original catalog; every node remains recoverable on restart. */ }
      throw error;
    }
  }
  function notifyContents(projectPath, affectedTabIds) {
    for (const event of ["sessions", "commands", "node-groups", "skills"]) notify(event, { projectPath });
    changed(projectPath, affectedTabIds);
  }
  function move(id, { nodeIds } = {}) {
    const target = get(id);
    const items = selection(nodeIds, target.projectPath).filter(({ item }) => tabFor(item) !== target.id);
    const affectedTabIds = items.length ? [...new Set([...items.map(({ item }) => tabFor(item)), target.id])] : [];
    reassign(items, target.id);
    notifyContents(target.projectPath, affectedTabIds);
    return { ok: true };
  }
  function remove(id, targetId) {
    const source = get(id);
    const found = tabs.list(source.projectPath);
    if (found.length < 2) throw new HttpError(409, "마지막 그리드 탭은 삭제할 수 없습니다.");
    const target = get(targetId);
    if (target.id === source.id || !sameProject(target.projectPath, source.projectPath)) throw new HttpError(400, "내용을 옮길 같은 프로젝트의 다른 탭을 선택하세요.");
    const contents = [...store.list(), ...commands.list(source.projectPath), ...groups.list(source.projectPath)]
      .filter((item) => sameProject(item.projectPath, source.projectPath) && tabFor(item) === source.id);
    const remaining = found.filter((tab) => tab.id !== id);
    const defaults = { ...tabs.data.defaults, [key(source.projectPath)]: defaultId(source.projectPath) === id ? target.id : defaultId(source.projectPath) };
    reassign(selection(contents.map((item) => item.id), source.projectPath), target.id, () => {
      tabs.commit({ ...tabs.data, defaults, tabs: tabs.data.tabs.filter((tab) => tab.id !== id)
        .map((tab) => sameProject(tab.projectPath, source.projectPath) ? { ...tab, order: remaining.findIndex((other) => other.id === tab.id) } : tab) });
    });
    notifyContents(source.projectPath, contents.length ? [source.id, target.id] : [source.id]);
    return { ok: true };
  }
  function removeProject(projectPath) {
    const defaults = { ...tabs.data.defaults };
    delete defaults[key(projectPath)];
    tabs.commit({ ...tabs.data, defaults, tabs: tabs.data.tabs.filter((tab) => !sameProject(tab.projectPath, projectPath)) });
    changed(projectPath);
  }
  return { list, create, update, reorder, move, remove, removeProject, defaultId, resolve, tabFor, ensure };
}
