import fs from "node:fs";
import path from "node:path";
import { discoverProjects, discoverSessions } from "../discover.mjs";
import { removeWorktree } from "../git.mjs";
import { HttpError } from "./errors.mjs";
export const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function createProjectService({ config, store, runner, links, commands, chain, board, saveConfig, notify: broadcast, sessions, tasks }) {
  const cleanupSession = (...args) => sessions().cleanupSession(...args);
  const cliSessionIds = (...args) => sessions().cliSessionIds(...args);
  const clearBoard = (...args) => board.clear(...args);
  function unhideProject(dir) {
    config.hiddenProjects = config.hiddenProjects.filter((p) => !samePath(p, dir));
  }

  // 등록된 프로젝트를 찾고, 없으면(자동 감지된 프로젝트) 그 자리에서 등록한다.
  function ensureProject(projectPath) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const existing = config.projects.find((p) => samePath(p.path, projectPath));
    if (existing) return existing;
    const dir = path.resolve(projectPath);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new HttpError(400, "프로젝트 폴더가 없습니다.");
    const project = { name: path.basename(dir), path: dir };
    config.projects.push(project);
    unhideProject(dir);
    // 제거했던 프로젝트에서 다시 세션을 만들면 다시 보인다.
    saveConfig(config);
    return project;
  }

  const projectSessions = (projectPath) => store.list().filter((s) => samePath(s.projectPath, projectPath));
  async function removeProject(projectPath, { force = false, removeWorktrees = false } = {}) {
    const dir = path.resolve(projectPath);
    const sessions = projectSessions(dir).filter((s) => !s.chat);
    const running = sessions.filter((s) => runner.isRunning(s.id));
    if (running.length && !force) {
      throw new HttpError(409, `실행 중인 세션이 ${running.length}개 있습니다: ${running.map((s) => s.title).join(", ")}`, "running");
    }
    const worktreeErrors = [];
    for (const s of sessions) {
      if (runner.isRunning(s.id)) runner.stop(s);
      if (removeWorktrees && s.worktree && !s.taskId) {
        try {
          await removeWorktree(s.projectPath, s.worktree.dir);
        } catch (err) {
          worktreeErrors.push(`${s.title}: ${err.message}`);
        }
      }
      store.remove(s.id);
      cleanupSession(s);
      tasks?.()?.detachSession?.(s.id);
    }
    const cmds = commands.list(dir);
    for (const c of cmds) {
      chain.stopCommand(c);
      commands.remove(c.id);
      links.removeForSession(c.id);
    }
    clearBoard(dir);
    delete config.skillLayout?.[dir.toLowerCase()];
    config.projects = config.projects.filter((p) => !samePath(p.path, dir));
    if (!config.hiddenProjects.some((p) => samePath(p, dir))) config.hiddenProjects.push(dir);
    saveConfig(config);
    return { sessions: sessions.length, commands: cmds.length, worktreeErrors };
  }

  function add(body) {
    const dir = path.resolve(String(body.path ?? "").trim());
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new HttpError(400, "폴더가 없습니다.");
    if (config.projects.some((p) => p.path === dir)) throw new HttpError(400, "이미 등록된 프로젝트입니다.");
    config.projects.push({ name: String(body.name ?? "").trim() || path.basename(dir), path: dir });
    unhideProject(dir);
    saveConfig(config);
    broadcast("projects", {});
    return config.projects;
  }

  async function remove(projectPath, options) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const result = await removeProject(projectPath, options);
    for (const event of ["projects", "sessions", "links", "commands"]) broadcast(event, {});
    return result;
  }

  function all() {
    const detected = discoverProjects();
    const merged = config.projects.map((p) => {
      const d = detected.find((x) => samePath(x.path, p.path));
      return { name: p.name, path: p.path, registered: true, claude: d?.claude ?? 0, codex: d?.codex ?? 0, lastActive: d?.lastActive ?? null };
    });
    for (const d of detected) {
      if (merged.some((p) => samePath(p.path, d.path)) || config.hiddenProjects.some((h) => samePath(h, d.path))) continue;
      merged.push({ ...d, registered: false });
    }
    return merged;
  }

  function discover(projectPath) {
    if (!projectPath || !fs.existsSync(projectPath)) throw new HttpError(400, "프로젝트 폴더가 없습니다.");
    const linked = new Map(store.list().flatMap((s) => cliSessionIds(s).map((id) => [id, s.id])));
    const hidden = new Set(config.hiddenSessions);
    return discoverSessions(path.resolve(projectPath)).map(({ file, ...found }) => {
      const linkedId = linked.get(found.agentSessionId) ?? null;
      return { ...found, linkedId, linkedTitle: linkedId ? store.get(linkedId)?.title ?? null : null, hidden: hidden.has(found.agentSessionId) };
    });
  }

  function hide(body) {
    const id = String(body.agentSessionId ?? "").trim();
    if (!id) throw new HttpError(400, "세션 ID가 없습니다.");
    config.hiddenSessions = config.hiddenSessions.filter((x) => x !== id);
    if (body.hidden !== false) config.hiddenSessions.push(id);
    saveConfig(config);
    return { ok: true };
  }

  function unregister(index) {
    config.projects.splice(Number(index), 1);
    saveConfig(config);
    return config.projects;
  }

  return { add, remove, all, discover, hide, unregister, ensureProject, projectSessions };
}
