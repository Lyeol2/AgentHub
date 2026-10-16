import { $, el } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";

export function createSkillsController({ api, loadSessions, sessionById, renderGraph, highlightSessions, data, navigation }) {
  const ui = {
    "editingSkill": null,
    "equipping": null
  };
  let request = 0;
  // ── 스킬 ────────────────────────────────────────────────────────
  const skillByName = (name) => (data.skills ?? []).find((k) => k.name === name);

  async function loadSkills(projectPath = navigation.project) {
    if (!projectPath) return;
    try {
      const skills = await api("GET", `/api/skills?path=${encodeURIComponent(projectPath)}`);
      if (!samePath(projectPath, navigation.project)) return;
      data.skills = skills;
      data.skillsProject = projectPath;
    } catch {
      return;
    }
    $("p-skills").textContent = `스킬 ${data.skills.length}`;
    if (navigation.view === "project") renderGraph();
    if ($("skills-dialog").open) renderSkillsManager();
  }

  // 스킬 범위: project(AgentHub 전용) | claude(프로젝트의 .claude/skills, 예전 위치) | personal(~/.claude·~/.agents 두 곳)
  const SKILL_SCOPE_LABEL = { project: "스킬", claude: "Claude 스킬", personal: "개인 스킬" };
  const SKILL_SCOPE_HINT = {
    project: "이 프로젝트의 .agenthub\\skills에 저장합니다. 흐름 그래프에서 ● 손잡이를 세션 카드에 끌어 놓은 세션만 씁니다(Claude·Codex 모두).",
    claude: "프로젝트의 .claude\\skills에 있는 스킬입니다. Claude는 노드를 잇지 않아도 이 프로젝트에서 저절로 씁니다. 우클릭으로 AgentHub 전용이나 개인으로 옮길 수 있습니다.",
    personal: "~\\.claude\\skills(Claude)와 ~\\.agents\\skills(Codex) 두 곳에 같은 내용으로 저장합니다. 모든 프로젝트에서 노드를 잇지 않아도 두 CLI가 저절로 찾고, 이은 세션에는 한 번 더 알려 줍니다.",
  };

  function syncSkillScope() {
    const skill = ui.editingSkill?.skill;
    const scope = skill?.scope ?? $("skill-scope").value;
    const name = $("skill-name").value.trim() || "<이름>";
    $("skill-scope-hint").textContent = SKILL_SCOPE_HINT[scope];
    $("skill-file").textContent = skill
      ? skill.file
      : scope === "personal"
        ? `~\\.claude\\skills\\${name}\\SKILL.md, ~\\.agents\\skills\\${name}\\SKILL.md`
        : `${ui.editingSkill?.projectPath ?? navigation.project}\\.agenthub\\skills\\${name}\\SKILL.md`;
  }

  // skill이 없으면 새로 만든다. pos는 새 스킬 노드를 놓을 자리.
  function openSkillDialog(skill, pos = null) {
    ui.editingSkill = { skill, pos, projectPath: navigation.project };
    $("skill-heading").textContent = skill ? `${SKILL_SCOPE_LABEL[skill.scope] ?? "스킬"} ${skill.name}` : "새 스킬";
    $("skill-name").value = skill?.name ?? "";
    $("skill-name").disabled = !!skill;
    $("skill-scope-row").hidden = !!skill; // 범위는 만들 때 고르고, 바꿀 때는 우클릭의 옮기기를 쓴다.
    $("skill-scope").value = "project";
    $("skill-description").value = skill?.description ?? "";
    $("skill-body").value = skill?.body ?? "";
    // 두 곳의 내용이 다른 개인 스킬은 덮어쓰지 않도록 읽기만 한다.
    const locked = !!skill?.locked;
    $("skill-description").disabled = locked;
    $("skill-body").disabled = locked;
    $("skill-form").querySelector('button[value="ok"]').hidden = locked;
    $("skill-delete").hidden = !skill;
    $("skill-error").textContent = locked ? "~\\.claude와 ~\\.agents에 서로 다른 내용으로 있는 개인 스킬이라 AgentHub에서는 읽기만 합니다." : "";
    syncSkillScope();
    $("skill-dialog").showModal();
  }
  $("skill-scope").addEventListener("change", syncSkillScope);
  $("skill-name").addEventListener("input", syncSkillScope);

  $("skill-form").addEventListener("submit", async (e) => {
    const action = e.submitter?.value;
    if (action === "cancel") return;
    e.preventDefault();
    const context = ui.editingSkill;
    if (!context) return;
    const { skill, pos, projectPath } = context;
    if (action === "delete") {
      $("skill-dialog").close();
      return removeSkill(skill, projectPath);
    }
    const body = { projectPath, description: $("skill-description").value, body: $("skill-body").value };
    try {
      if (skill) await api("PUT", `/api/skills/${skill.name}`, body);
      else await api("POST", "/api/skills", { ...body, name: $("skill-name").value.trim(), scope: $("skill-scope").value, pos });
      if (ui.editingSkill === context) $("skill-dialog").close();
      await loadSkills(projectPath);
    } catch (err) {
      if (ui.editingSkill === context) $("skill-error").textContent = err.message;
    }
  });

  async function removeSkill(skill, projectPath = navigation.project) {
    const where = skill.scope === "personal"
      ? `~\\.claude\\skills와 ~\\.agents\\skills 두 곳의 "${skill.name}" 폴더를 지웁니다. 다른 프로젝트와 AgentHub 밖의 Claude·Codex에서도 사라집니다.`
      : `${skill.file} 폴더째 지웁니다.`;
    if (!confirm(`스킬 "${skill.name}"을(를) 삭제할까요?\n\n${where}\n이 스킬을 이어 둔 세션에서도 뺍니다.`)) return;
    try {
      await api("DELETE", `/api/skills/${skill.name}?path=${encodeURIComponent(projectPath)}`);
    } catch (err) {
      alert(err.message);
    }
    await Promise.all([loadSkills(), loadSessions()]);
  }

  // 다른 범위로 옮긴다. to: project | personal
  async function moveSkill(skill, to) {
    const note = to === "personal"
      ? "개인 스킬로 옮기면 ~\\.claude\\skills와 ~\\.agents\\skills에 두고, 모든 프로젝트에서 Claude·Codex가 저절로 찾습니다."
      : "이 프로젝트의 AgentHub 전용 스킬(.agenthub\\skills)로 옮기면 노드로 이은 세션만 씁니다.";
    if (!confirm(`스킬 "${skill.name}"을(를) 옮길까요?\n\n${note}`)) return;
    try {
      await api("POST", `/api/skills/${skill.name}/move`, { projectPath: navigation.project, to });
    } catch (err) {
      alert(err.message);
    }
    await Promise.all([loadSkills(), loadSessions()]);
  }

  // 세션이 쓰는 스킬 목록을 바꾼다.
  async function setSessionSkills(sessionId, change) {
    const s = sessionById(sessionId);
    if (!s) return;
    const next = change(s.skills ?? []);
    try {
      await api("PUT", `/api/sessions/${sessionId}`, { skills: next });
    } catch (err) {
      alert(err.message);
    }
    await loadSessions();
    if (navigation.view === "project") renderGraph();
  }

  const detachSkill = (sessionId, name) => setSessionSkills(sessionId, (list) => list.filter((n) => n !== name));

  // ── 스킬 장착 ───────────────────────────────────────────────────
  // 세션 카드의 스킬 칩. 누르면 장착할 스킬을 고른다. 칩은 3개까지 보이고 나머지는 +n으로 줄인다.
  function skillChips(s) {
    const names = s.skills ?? [];
    const chip = (name) => el("span", { class: `skill-chip ${skillByName(name)?.scope ?? "missing"}` }, name);
    return el("div", {
      class: "gcard-skills",
      title: names.length ? `장착한 스킬: ${names.join(", ")}\n누르면 바꿉니다` : "누르면 스킬을 장착합니다",
      onclick: () => openEquipDialog(s),
    },
    ...names.slice(0, 3).map(chip),
    names.length > 3 ? el("span", { class: "skill-chip more" }, `+${names.length - 3}`) : null,
    names.length ? null : el("span", { class: "skill-chip add" }, "+ 스킬"));
  }

  // 사이드바에서 우클릭해 열 수도 있으므로 보고 있는 프로젝트와 상관없이 그 세션의 프로젝트 스킬을 읽는다.
  async function openEquipDialog(s) {
    const mine = ++request;
    let skills;
    try {
      skills = await api("GET", `/api/skills?path=${encodeURIComponent(s.projectPath)}`);
    } catch (err) {
      if (mine === request) alert(err.message);
      return;
    }
    if (mine !== request) return;
    ui.equipping = s;
    const on = new Set(s.skills ?? []);
    $("equip-session").textContent = s.title;
    $("equip-error").textContent = "";
    const groups = ["project", "claude", "personal"]
      .map((scope) => [scope, skills.filter((k) => (k.scope ?? "project") === scope)])
      .filter(([, list]) => list.length);
    $("equip-list").replaceChildren(
      ...groups.map(([scope, list]) => el("fieldset", { class: "equip-group" },
        el("legend", {}, SKILL_GROUP_LABEL[scope]),
        ...list.map((k) => {
          const box = el("input", { type: "checkbox", value: k.name });
          box.checked = on.has(k.name);
          return el("label", { class: "check equip-item", title: k.file }, box,
            el("span", { class: "equip-name mono" }, k.name),
            el("span", { class: "muted" }, k.description));
        }))),
      skills.length ? null : el("p", { class: "hint" }, "아직 스킬이 없습니다. '스킬 관리'에서 만드세요."));
    $("equip-dialog").showModal();
  }

  const SKILL_GROUP_LABEL = { project: "이 프로젝트 (AgentHub 전용)", claude: "Claude 프로젝트 스킬 (.claude/skills)", personal: "개인 스킬 (모든 프로젝트)" };

  $("equip-form").addEventListener("submit", async (e) => {
    const action = e.submitter?.value;
    if (action === "cancel") return;
    e.preventDefault();
    if (action === "manage") {
      $("equip-dialog").close();
      return openSkillsManager();
    }
    const names = [...$("equip-list").querySelectorAll("input:checked")].map((b) => b.value);
    await setSessionSkills(ui.equipping.id, () => names);
    $("equip-dialog").close();
  });

  // ── 스킬 관리 ───────────────────────────────────────────────────
  // 만들기·편집·옮기기·삭제. 스킬에 마우스를 올리면 그 스킬을 장착한 카드를 강조한다.
  async function openSkillsManager() {
    const mine = ++request;
    await loadSkills();
    if (mine !== request) return;
    renderSkillsManager();
    if (!$("skills-dialog").open) $("skills-dialog").showModal();
  }

  function renderSkillsManager() {
    const skills = data.skills ?? [];
    const usedBy = (name) => data.sessions.filter((s) => samePath(s.projectPath, navigation.project) && s.skills?.includes(name));
    const highlight = (name) => {
      const ids = new Set(name ? usedBy(name).map((s) => s.id) : []);
      highlightSessions(ids);
    };
    $("skills-list").replaceChildren(
      ...skills.map((k) => {
        const using = usedBy(k.name);
        const scope = k.scope ?? "project";
        const button = (label, action, cls = "ghost sm") => el("button", { type: "button", class: cls, onclick: action }, label);
        return el("div", { class: "skills-row", onmouseenter: () => highlight(k.name), onmouseleave: () => highlight(null) },
          el("span", { class: `skill-chip ${scope}` }, SKILL_SCOPE_LABEL[scope]),
          el("div", { class: "skills-main" },
            el("div", {}, el("b", { class: "mono" }, k.name), k.locked ? el("span", { class: "muted" }, " · 읽기 전용") : null),
            el("div", { class: "muted", title: k.file }, k.description)),
          el("span", { class: "muted skills-used", title: using.map((s) => s.title).join("\n") }, using.length ? `세션 ${using.length}` : "장착 없음"),
          el("div", { class: "skills-actions" },
            button(k.locked ? "보기" : "편집", () => openSkillDialog(k)),
            scope !== "project" && !k.locked ? button("프로젝트로", () => moveSkill(k, "project")) : null,
            scope !== "personal" ? button("개인으로", () => moveSkill(k, "personal")) : null,
            using.length ? button("장착 해제", () => detachSkillEverywhere(k.name)) : null,
            button("삭제", () => removeSkill(k), "ghost sm danger")));
      }),
      skills.length ? null : el("p", { class: "hint" }, "스킬이 없습니다. '새 스킬'로 만드세요."));
  }

  $("skills-new").addEventListener("click", () => openSkillDialog(null));
  $("p-skills").addEventListener("click", () => openSkillsManager());

  $("skills-dialog").addEventListener("close", () => {
    highlightSessions();
  });

  async function detachSkillEverywhere(name) {
    const using = data.sessions.filter((s) => samePath(s.projectPath, navigation.project) && s.skills?.includes(name));
    for (const s of using) await detachSkill(s.id, name);
    if ($("skills-dialog").open) renderSkillsManager();
  }

  $("skill-dialog").addEventListener("close", () => { ui.editingSkill = null; });
  function cancelCreation() {
    request++;
    ui.editingSkill = null;
    ui.equipping = null;
    for (const id of ["skill-dialog", "equip-dialog", "skills-dialog"]) if ($(id).open) $(id).close();
  }

  return { loadSkills, skillChips, openSkillsManager, openEquipDialog, openSkillDialog, setSessionSkills, cancelCreation };
}
