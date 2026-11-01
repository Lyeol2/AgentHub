import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { askOnce } from "../one-shot.mjs";
import { listSkills, scanSkills, checkSkill, writeSkill, deleteSkill, moveSkill, parseSkill, formatSkill, personalSkillsDirs, scopeDirs, readsNatively, suggestName, SCOPES, SCOPE_READER, SKILL_NAME } from "../skills.mjs";
import { checkSkillText } from "../skill-check.mjs";
import { markdownAnswer } from "../guide.mjs";
import { HttpError } from "./errors.mjs";

const hash = (text) => createHash("sha1").update(String(text ?? "")).digest("hex").slice(0, 16);
const FILE_MAX = 1_000_000;
const TEXT_EXT = /\.(md|txt|json|ya?ml|toml|js|mjs|cjs|ts|py|ps1|sh|bat|cmd|cs|xml|html|css|csv)$/i;
const AI_TIMEOUT = 300_000;

export function createSkillService({ config, projects, sessions, store = null, cliPaths = null, ask = askOnce, saveConfig, notify }) {
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

  // ── 스킬 보기 ────────────────────────────────────────────────
  const otherRoots = (root) => (config.projects ?? []).map((p) => path.resolve(p.path)).filter((p) => p.toLowerCase() !== root.toLowerCase() && fs.existsSync(p));
  const projectSessions = (root) => (store?.list?.() ?? []).filter((s) => !s.chat && s.projectPath && path.resolve(s.projectPath).toLowerCase() === root.toLowerCase());

  // 다른 프로젝트의 같은 이름 스킬(프로젝트 범위 세 곳만. 공용은 어디서나 같다)
  function elsewhereOf(root, name, text) {
    const out = [];
    for (const other of otherRoots(root)) {
      for (const scope of ["project", "claude", "codex"]) {
        const file = path.join(scopeDirs(scope, other)[0], name, "SKILL.md");
        if (!fs.existsSync(file)) continue;
        const otherText = fs.readFileSync(file, "utf8");
        out.push({ project: other, projectName: (config.projects ?? []).find((p) => path.resolve(p.path) === other)?.name ?? path.basename(other), scope, file, same: norm(otherText) === norm(text), mtime: fs.statSync(file).mtime.toISOString(), text: otherText });
        break;
      }
    }
    return out;
  }
  const norm = (text) => String(text ?? "").replace(/\r\n/g, "\n").trim();

  function warningsFor(root, skill, all) {
    return checkSkillText({ ...skill, folder: skill.name }, { projectPath: root, others: all.filter((s) => s.name !== skill.name), roots: otherRoots(root) });
  }

  // 목록: 스킬·건너뛴 것·읽지 못한 위치와 문제 요약(잠김·경고 수·갈라짐)·장착 세션
  function catalog(projectPath) {
    const project = projectFor(projectPath);
    const { skills, skipped, errors, shadowed } = scanSkills(project.path);
    const used = projectSessions(project.path);
    const rows = skills.map((skill) => {
      const text = fs.readFileSync(skill.file, "utf8");
      const warnings = warningsFor(project.path, skill, skills);
      const elsewhere = ["project", "claude", "codex"].includes(skill.scope) ? elsewhereOf(project.path, skill.name, text) : [];
      return { name: skill.name, description: skill.description, scope: skill.scope, reader: SCOPE_READER[skill.scope], file: skill.file, locked: !!skill.locked,
        bytes: Buffer.byteLength(text), lines: text.split(/\r?\n/).length,
        warnings: warnings.filter((w) => w.level !== "info").length, info: warnings.filter((w) => w.level === "info").length,
        diverged: elsewhere.filter((e) => !e.same).length, elsewhere: elsewhere.length,
        equipped: used.filter((s) => s.skills?.includes(skill.name)).length,
        reading: used.filter((s) => readsNatively(s.agent, skill.scope)).length };
    });
    return { skills: rows, skipped: skipped.map(({ body: _b, ...rest }) => rest), errors, shadowed: shadowed.map(({ name, scope, file }) => ({ name, scope, file })) };
  }

  function findAny(root, name, file) {
    const scan = scanSkills(root);
    if (file) {
      const target = path.resolve(file).toLowerCase();
      const hit = [...scan.skills, ...scan.skipped].find((s) => s.file.toLowerCase() === target);
      if (hit) return hit;
    }
    const hit = scan.skills.find((s) => s.name === name);
    if (!hit) throw new HttpError(404, "스킬이 없습니다.");
    return hit;
  }

  function fileTree(dir) {
    const out = [];
    const walk = (sub, depth) => {
      if (depth > 3 || out.length > 300) return;
      let entries;
      try { entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
        const rel = path.join(sub, entry.name).replaceAll("\\", "/");
        if (rel === "SKILL.md" || entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) { out.push({ path: rel, dir: true, depth }); walk(rel, depth + 1); }
        else out.push({ path: rel, dir: false, depth, bytes: fs.statSync(path.join(dir, rel)).size, text: TEXT_EXT.test(entry.name) });
      }
    };
    walk("", 0);
    return out;
  }

  // 한 스킬: SKILL.md 전체·지문, 참고 파일, 장착·읽는 세션, 다른 프로젝트, 공용 두 위치, 검사
  function detail(projectPath, name, { file } = {}) {
    const project = projectFor(projectPath);
    const skill = findAny(project.path, name, file);
    const exists = fs.existsSync(skill.file);
    const text = exists ? fs.readFileSync(skill.file, "utf8") : "";
    const parsed = parseSkill(text);
    const all = listSkills(project.path);
    const used = projectSessions(project.path);
    const locations = skill.scope === "personal" ? personalSkillsDirs().map((dir) => {
      const f = path.join(dir, skill.name, "SKILL.md");
      return fs.existsSync(f) ? { dir, file: f, label: dir.includes(".agents") ? "~/.agents/skills (Codex가 읽음)" : "~/.claude/skills (Claude가 읽음)", text: fs.readFileSync(f, "utf8"), mtime: fs.statSync(f).mtime.toISOString() } : null;
    }).filter(Boolean) : [];
    return {
      name: skill.name, scope: skill.scope, reader: SCOPE_READER[skill.scope], file: skill.file, dir: path.dirname(skill.file), locked: !!skill.locked, skipped: !!skill.skipped, reasons: skill.reasons ?? [],
      description: parsed.description, body: parsed.body, multiline: parsed.multiline, frontmatter: parsed.frontmatter, text, hash: exists ? hash(text) : null,
      bytes: Buffer.byteLength(text), lines: text.split(/\r?\n/).length, mtime: exists ? fs.statSync(skill.file).mtime.toISOString() : null,
      files: fileTree(path.dirname(skill.file)),
      sessions: used.filter((s) => s.skills?.includes(skill.name) || readsNatively(s.agent, skill.scope)).map((s) => ({ id: s.id, title: s.title, agent: s.agent, state: s.state, equipped: !!s.skills?.includes(skill.name), native: readsNatively(s.agent, skill.scope) })),
      elsewhere: ["project", "claude", "codex"].includes(skill.scope) ? elsewhereOf(project.path, skill.name, text) : [],
      locations,
      warnings: skill.skipped ? [] : checkSkillText({ name: skill.name, folder: skill.name, description: parsed.description, body: parsed.body, multiline: parsed.multiline, file: skill.file }, { projectPath: project.path, others: all.filter((s) => s.name !== skill.name), roots: otherRoots(project.path) }),
    };
  }

  function check(projectPath, body = {}) {
    const project = projectFor(projectPath);
    const all = listSkills(project.path);
    const current = body.name ? all.find((s) => s.name === body.folder || s.name === body.name) : null;
    return { warnings: checkSkillText({ name: body.name, folder: body.folder, description: body.description, body: body.body, file: current?.file ?? body.file }, { projectPath: project.path, others: all.filter((s) => s.name !== (body.folder || body.name)), roots: otherRoots(project.path) }) };
  }

  function create(projectPath, body) {
    const project = projectFor(projectPath, true);
    const scope = SCOPES.includes(body.scope) && body.scope !== "codex-home" ? body.scope : "project";
    let skill;
    try { skill = writeSkill(project.path, checkSkill(body), { create: true, scope }); }
    catch (error) { throw new HttpError(400, error.message); }
    savePos(project.path, skill.name, body.pos);
    notify("skills", { projectPath: project.path });
    return skill;
  }

  // baseHash가 있으면 다른 곳에서 바뀐 파일을 덮어쓰지 않는다(force로 덮어쓰기).
  function update(projectPath, name, body) {
    const project = projectFor(projectPath, true);
    const skill = existing(project, name);
    if (body.description !== undefined || body.body !== undefined) {
      if (body.baseHash !== undefined && !body.force && fs.existsSync(skill.file) && hash(fs.readFileSync(skill.file, "utf8")) !== body.baseHash) throw new HttpError(409, "파일이 다른 곳에서 바뀌었습니다.", "skill-changed");
      try { writeSkill(project.path, checkSkill({ ...skill, ...body, name }), { scope: skill.scope }); }
      catch (error) { throw new HttpError(400, error.message); }
    }
    savePos(project.path, name, body.pos);
    notify("skills", { projectPath: project.path });
    return { ok: true, hash: hash(fs.readFileSync(existing(project, name).file, "utf8")) };
  }

  function move(projectPath, name, to) {
    const project = projectFor(projectPath, true);
    existing(project, name);
    if (!SCOPES.includes(to) || to === "codex-home") throw new HttpError(400, "옮길 곳은 project·claude·codex·personal 중 하나입니다.");
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

  // ── 참고 파일 ────────────────────────────────────────────────
  function fileTarget(project, name, rel) {
    const skill = existing(project, name);
    const dir = path.dirname(skill.file);
    const full = path.resolve(dir, String(rel ?? ""));
    const inside = path.relative(dir, full);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new HttpError(400, "스킬 폴더 안의 파일만 열 수 있습니다.");
    return { skill, full, rel: inside.replaceAll("\\", "/") };
  }
  function readFile(projectPath, name, rel) {
    const project = projectFor(projectPath);
    const { full, rel: r } = fileTarget(project, name, rel);
    if (!fs.existsSync(full)) throw new HttpError(404, "파일이 없습니다.");
    const stat = fs.statSync(full);
    if (stat.size > FILE_MAX) throw new HttpError(400, "1MB가 넘는 파일은 여기서 열지 않습니다.");
    if (!TEXT_EXT.test(full)) throw new HttpError(400, "글 파일만 열 수 있습니다.");
    const text = fs.readFileSync(full, "utf8");
    return { path: r, text, hash: hash(text), bytes: stat.size };
  }
  function writeFile(projectPath, name, rel, body = {}) {
    const project = projectFor(projectPath, true);
    const { skill, full, rel: r } = fileTarget(project, name, rel);
    if (skill.locked) throw new HttpError(400, "두 위치의 내용이 달라 잠긴 스킬입니다. 먼저 합치세요.");
    if (!TEXT_EXT.test(full)) throw new HttpError(400, "글 파일만 쓸 수 있습니다.");
    const text = String(body.text ?? "");
    if (text.length > FILE_MAX) throw new HttpError(400, "파일이 너무 큽니다.");
    if (fs.existsSync(full) && body.baseHash !== undefined && !body.force && hash(fs.readFileSync(full, "utf8")) !== body.baseHash) throw new HttpError(409, "파일이 다른 곳에서 바뀌었습니다.", "skill-changed");
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    // 공용 스킬은 두 위치에 같이 둔다.
    if (skill.scope === "personal") for (const dir of personalSkillsDirs().slice(1)) { const copy = path.join(dir, skill.name, r); fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.writeFileSync(copy, text); }
    notify("skills", { projectPath: project.path });
    return { path: r, hash: hash(text) };
  }

  // 공용 스킬의 두 위치를 합친다: 고른 SKILL.md 내용을 두 곳에 쓰면 잠김이 풀린다.
  function mergePersonal(projectPath, name, body = {}) {
    const project = projectFor(projectPath, true);
    const skill = existing(project, name);
    if (skill.scope !== "personal") throw new HttpError(400, "공용 스킬만 합칠 수 있습니다.");
    const parsed = parseSkill(String(body.text ?? ""));
    let checked;
    try { checked = checkSkill({ name, description: parsed.description, body: parsed.body }); } catch (error) { throw new HttpError(400, error.message); }
    for (const dir of personalSkillsDirs()) {
      const file = path.join(dir, name, "SKILL.md");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, formatSkill(checked));
    }
    notify("skills", { projectPath: project.path });
    return detail(project.path, name);
  }

  // 건너뛴 스킬 고치기: 폴더 이름을 규칙에 맞게 바꾸고 앞머리를 한 줄 description으로 다시 쓴다.
  function fixSkipped(projectPath, body = {}) {
    const project = projectFor(projectPath, true);
    const { skipped } = scanSkills(project.path);
    const target = skipped.find((s) => s.file.toLowerCase() === path.resolve(String(body.file ?? "")).toLowerCase());
    if (!target) throw new HttpError(404, "건너뛴 스킬이 없습니다.");
    const oldDir = path.dirname(target.file);
    const name = SKILL_NAME.test(target.name) ? target.name : suggestName(target.name);
    const newDir = path.join(path.dirname(oldDir), name);
    if (newDir.toLowerCase() !== oldDir.toLowerCase() && fs.existsSync(newDir)) throw new HttpError(409, `${name} 폴더가 이미 있습니다.`);
    const text = fs.existsSync(target.file) ? fs.readFileSync(target.file, "utf8") : "";
    const parsed = parseSkill(text);
    const description = String(body.description ?? parsed.description ?? "").replace(/\s+/g, " ").trim();
    if (!description) throw new HttpError(400, "언제 쓰는 스킬인지 description을 적어 주세요.");
    if (newDir !== oldDir) {
      // Windows는 대소문자만 다른 이름 바꾸기를 한 번에 못 하므로 임시 이름을 거친다.
      const temp = `${oldDir}.renaming-${Date.now()}`;
      fs.renameSync(oldDir, temp);
      fs.renameSync(temp, newDir);
    }
    fs.writeFileSync(path.join(newDir, "SKILL.md"), formatSkill({ name, description, body: parsed.body }));
    notify("skills", { projectPath: project.path });
    return { name, file: path.join(newDir, "SKILL.md") };
  }

  // ── AI ──────────────────────────────────────────────────────
  function needAi() { if (!cliPaths) throw new HttpError(400, "AI CLI 설정이 없습니다."); }
  const abortOnClose = (res) => { const controller = new AbortController(); res?.on?.("close", () => { if (!res.writableEnded) controller.abort(); }); return controller.signal; };
  function skillAnswer(answer, name) {
    let text;
    try { text = markdownAnswer(answer); } catch (error) { throw new HttpError(502, error.message, "skill-ai"); }
    const parsed = parseSkill(text);
    if (!parsed.frontmatter) return { name, description: "", body: text.trim() };
    return { name: SKILL_NAME.test(parsed.name) ? parsed.name : name, description: parsed.description.replace(/\s+/g, " ").trim(), body: parsed.body };
  }

  async function draft(projectPath, body = {}, res) {
    needAi();
    const project = projectFor(projectPath);
    const name = String(body.name ?? "").trim();
    const purpose = String(body.purpose ?? "").trim().slice(0, 2000);
    if (!purpose) throw new HttpError(400, "어떤 일을 할 때 쓰는 스킬인지 적어 주세요.");
    const others = listSkills(project.path).map((s) => `- ${s.name}: ${s.description}`).join("\n").slice(0, 6000);
    const prompt = `너는 Claude Code·Codex 공통 형식의 SKILL.md를 쓴다. 저장소를 읽어 확인한 사실만 쓰고, 파일은 고치지 않는다.
[스킬 이름] ${name || "(정해 주세요: 영문 소문자·하이픈)"}
[쓰는 때] ${purpose}
[형식]
- 앞머리: --- name: <이름> / description: "<무엇을 하는지와 언제 쓰는지, 범위 밖 일 한 문장. 한 줄>" ---
- 본문: 짧은 제목, 번호 매긴 절차, 하지 않는 것, 결과 보고 형식. 300줄을 넘기지 않는다.
- 아래 기존 스킬과 발동 조건이 겹치지 않게 description에 범위 밖 일을 적는다.
- AgentHub 연결과 부딪히지 않게: 승인·보고·커밋을 요구하면 "연결로 넘어온 작업은 승인 없이 진행하고 판정 줄을 맨 마지막에 쓴다"를 함께 쓴다.
[기존 스킬]
${others || "(없음)"}
[답] SKILL.md 전체를 \`\`\`markdown 블록 하나로만 쓴다.`;
    const answer = await ask({ cliPaths, prompt, cwd: project.path, agent: body.agent || undefined, timeoutMs: AI_TIMEOUT, label: "스킬 초안", signal: abortOnClose(res) });
    return skillAnswer(answer, name);
  }

  async function suggest(projectPath, name, body = {}, res) {
    needAi();
    const project = projectFor(projectPath);
    const skill = existing(project, name);
    const description = body.description ?? skill.description;
    const current = body.body ?? skill.body;
    const warnings = checkSkillText({ name, folder: name, description, body: current, file: skill.file }, { projectPath: project.path, others: listSkills(project.path).filter((s) => s.name !== name), roots: otherRoots(project.path) });
    const prompt = `너는 SKILL.md를 더 잘 동작하게 고친다. 파일은 고치지 않는다.
[고칠 점] description은 무엇을 하는지·언제 쓰는지·범위 밖 일을 한 줄로. 본문은 중복과 군더더기를 빼고, 자주 안 쓰는 긴 절차는 "references/<이름>.md로 옮기고 링크"로 줄인다(옮길 내용은 본문에 남기지 말고 링크만 둔다). 맞는 문장은 그대로 둔다.
${warnings.length ? `[검사에서 나온 문제]\n${warnings.map((w) => `- ${w.title}: ${w.detail}${w.quote ? ` (${w.quote})` : ""}`).join("\n")}\n` : ""}[지금 SKILL.md]
${formatSkill({ name, description, body: current })}
[답] 고친 SKILL.md 전체를 \`\`\`markdown 블록 하나로만 쓴다.`;
    const answer = await ask({ cliPaths, prompt, cwd: path.dirname(skill.file), agent: body.agent || undefined, timeoutMs: AI_TIMEOUT, label: "스킬 고칠 점", signal: abortOnClose(res) });
    return skillAnswer(answer, name);
  }

  // 발동 시험: 요청 예시에 어떤 스킬이 발동할지 description만 보고 추정한다.
  async function trigger(projectPath, body = {}, res) {
    needAi();
    const project = projectFor(projectPath);
    const request = String(body.request ?? "").trim().slice(0, 1000);
    if (!request) throw new HttpError(400, "요청 예시를 적어 주세요.");
    const agent = body.agent === "codex" ? "codex" : "claude";
    const session = body.sessionId ? store?.get?.(body.sessionId) : null;
    const candidates = listSkills(project.path).filter((s) => readsNatively(agent, s.scope) || session?.skills?.includes(s.name));
    if (!candidates.length) return { results: [], candidates: 0 };
    const prompt = `너는 AI 에이전트가 요청을 받았을 때 아래 스킬 중 무엇을 고를지 description만 보고 판정한다. 파일은 읽지 않는다.
[요청] ${request}
[스킬]
${candidates.map((s) => `- ${s.name}: ${s.description}`).join("\n")}
[답] 맞을 가능성이 있는 스킬만 높은 순으로, JSON 하나: {"results":[{"name":"<스킬>","score":0-100,"reason":"<description의 어느 말과 맞는지·안 맞는지 한 문장>"}]}`;
    const answer = await ask({ cliPaths, prompt, cwd: project.path, agent: body.engine || undefined, timeoutMs: 120_000, label: "발동 시험", signal: abortOnClose(res) });
    const textAnswer = String(answer ?? "");
    let value;
    try { value = JSON.parse(textAnswer.match(/```(?:json)?\s*\n([\s\S]*?)```/)?.[1] ?? textAnswer.slice(textAnswer.indexOf("{"), textAnswer.lastIndexOf("}") + 1)); }
    catch { throw new HttpError(502, "AI가 판정을 JSON으로 돌려주지 않았습니다. 다시 시험해 주세요.", "skill-trigger"); }
    const known = new Map(candidates.map((s) => [s.name, s]));
    const results = (Array.isArray(value?.results) ? value.results : []).filter((r) => known.has(r?.name)).slice(0, 8)
      .map((r) => ({ name: r.name, scope: known.get(r.name).scope, score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))), reason: String(r.reason ?? "").slice(0, 200) }))
      .sort((a, b) => b.score - a.score);
    return { results, candidates: candidates.length, agent };
  }

  return { list, catalog, detail, check, create, update, move, remove, readFile, writeFile, mergePersonal, fixSkipped, draft, suggest, trigger };
}
