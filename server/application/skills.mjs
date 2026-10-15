import path from "node:path";
import { listSkills, checkSkill, writeSkill, deleteSkill, moveSkill, SCOPES } from "../skills.mjs";
import { HttpError } from "./errors.mjs";

export function createSkillService({ config, projects, sessions, saveConfig, notify }) {
  function projectFor(projectPath, write = false) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    return write ? projects.ensureProject(projectPath) : { path: path.resolve(projectPath) };
  }

  function savePos(projectPath, name, pos) {
    if (pos === undefined) return;
    const key = projectPath.toLowerCase();
    const layout = config.skillLayout ??= {};
    layout[key] ??= {};
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      layout[key][name] = { x: Math.max(0, Math.round(pos.x)), y: Math.max(0, Math.round(pos.y)) };
    } else {
      delete layout[key][name];
    }
    saveConfig(config);
  }

  function existing(project, name) {
    const skill = listSkills(project.path).find((item) => item.name === name);
    if (!skill) throw new HttpError(404, "스킬이 없습니다.");
    return skill;
  }

  function list(projectPath) {
    const project = projectFor(projectPath);
    const layout = config.skillLayout ??= {};
    return listSkills(project.path).map((skill) => ({ ...skill, pos: layout[project.path.toLowerCase()]?.[skill.name] ?? null }));
  }

  function create(projectPath, body) {
    const project = projectFor(projectPath, true);
    const scope = body.scope === "personal" ? "personal" : "project";
    let skill;
    try { skill = writeSkill(project.path, checkSkill(body), { create: true, scope }); }
    catch (error) { throw new HttpError(400, error.message); }
    savePos(project.path, skill.name, body.pos);
    notify("skills", { projectPath: project.path });
    return skill;
  }

  function update(projectPath, name, body) {
    const project = projectFor(projectPath, true);
    const skill = existing(project, name);
    if (body.description !== undefined || body.body !== undefined) {
      try { writeSkill(project.path, checkSkill({ ...skill, ...body, name }), { scope: skill.scope }); }
      catch (error) { throw new HttpError(400, error.message); }
    }
    savePos(project.path, name, body.pos);
    notify("skills", { projectPath: project.path });
    return { ok: true };
  }

  function move(projectPath, name, to) {
    const project = projectFor(projectPath, true);
    existing(project, name);
    if (!SCOPES.includes(to) || to === "claude") throw new HttpError(400, "옮길 곳은 project 또는 personal입니다.");
    let moved;
    try { moved = moveSkill(project.path, name, to); }
    catch (error) { throw new HttpError(400, error.message); }
    sessions.dropMissingSkills(name);
    notify("skills", { projectPath: project.path });
    notify("sessions", {});
    return moved;
  }

  function remove(projectPath, name) {
    const project = projectFor(projectPath, true);
    const skill = existing(project, name);
    deleteSkill(project.path, name, { scope: skill.scope });
    savePos(project.path, name, null);
    sessions.dropMissingSkills(name);
    notify("skills", { projectPath: project.path });
    notify("sessions", {});
    return { ok: true };
  }

  return { list, create, update, move, remove };
}
