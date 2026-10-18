import fs from "node:fs";
import path from "node:path";
import { discoverProjects, discoverSessions } from "../discover.mjs";
import { removeWorktree } from "../git.mjs";
import { HttpError } from "./errors.mjs";
import { projectSettings, projectSettingsKey, checkProjectSettings } from "../project-settings.mjs";
export const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function createProjectService({ config, store, runner, links, commands, chain, board, saveConfig, notify: broadcast, sessions, tasks, nodeGroups, graphTabs }) {
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
    if (existing) { graphTabs?.ensure(existing.path); return existing; }
    const dir = path.resolve(projectPath);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new HttpError(400, "프로젝트 폴더가 없습니다.");
    const project = { name: path.basename(dir), path: dir };
    config.projects.push(project);
    unhideProject(dir);
    // 제거했던 프로젝트에서 다시 세션을 만들면 다시 보인다.
    saveConfig(config);
    graphTabs?.ensure(dir);
    return project;
  }

  // 일반 채팅 세션은 프로젝트 경로가 없어 어느 프로젝트에도 속하지 않는다.
  const projectSessions = (projectPath) => store.list().filter((s) => s.projectPath && samePath(s.projectPath, projectPath));
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
      if (removeWorktrees && s.worktree && !s.taskId && !s.worktree.shared) {
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
    nodeGroups?.()?.removeProject(dir);
    graphTabs?.removeProject(dir);
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
    if (config.projects.some((p) => samePath(p.path, dir))) throw new HttpError(400, "이미 등록된 프로젝트입니다.");
    config.projects.push({ name: String(body.name ?? "").trim() || path.basename(dir), path: dir });
    unhideProject(dir);
    saveConfig(config);
    graphTabs?.ensure(dir);
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
      return { name: p.name, path: p.path, registered: true, claude: d?.claude ?? 0, codex: d?.codex ?? 0, lastActive: d?.lastActive ?? null, settings: projectSettings(config, p.path) };
    });
    for (const d of detected) {
      if (merged.some((p) => samePath(p.path, d.path)) || config.hiddenProjects.some((h) => samePath(h, d.path))) continue;
      merged.push({ ...d, registered: false, settings: projectSettings(config, d.path) });
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

  // 프로젝트별 기본값(AI·권한·워크트리)과 유니티 사용. 보내지 않은 부분은 그대로 둔다.
  function settings(projectPath) {
    return projectSettings(config, projectPath);
  }

  function updateSettings(projectPath, body = {}) {
    const key = projectSettingsKey(projectPath);
    const current = projectSettings(config, projectPath);
    const next = checkProjectSettings({ defaults: body.defaults === undefined ? current.defaults : body.defaults, unity: body.unity ?? current.unity });
    config.projectSettings = { ...config.projectSettings, [key]: next };
    saveConfig(config);
    broadcast("projects", {});
    return next;
  }

  return { add, remove, all, discover, hide, unregister, ensureProject, projectSessions, settings, updateSettings };
}
