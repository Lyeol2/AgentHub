import { createGitView } from "./view.js";
import { $, el, renderDiff } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";
import { renderMarkdown } from "../../markdown.js";
import { createPullRequests } from "../../gitpulls.js";

export function createGitController({ api, selectSession, openSetup, currentProject, projectTab, navigation }) {
  const ui = {
    "git": null
  };
  const { renderGit, renderGitFiles, renderGitControls, setGitActive, showGitView } = createGitView({
    getModel: () => ui.git, selectSession, showSessionChanges, openBranchCommit, showGitBranch: (branch) => showGitBranch(branch),
    mergeGitBranch, showGitFile, changeGitIndex, showGitTab, showGitCommit: (commit) => showGitCommit(commit),
    onToggleFile: (area, file, selected) => {
      if (selected) ui.git.selected[area].add(file);
      else ui.git.selected[area].delete(file);
      renderGitControls();
    },
  });
  // ── Git 탭 ──────────────────────────────────────────────────────
  const GIT_TAB_KEY = "agenthub-git-tab";
  const GIT_TABS = ["changes", "history", "pulls"];
  const pullRequests = createPullRequests({ api, renderMarkdown, renderDiff, onSetup: () => openSetup("gh"), isProjectCurrent: (project) => samePath(project, navigation.project) });
  const gitTab = () => GIT_TABS.includes(localStorage.getItem(GIT_TAB_KEY)) ? localStorage.getItem(GIT_TAB_KEY) : "changes";
  const gitBusy = () => !!(ui.git?.indexBusy || ui.git?.committing || ui.git?.merging);
  const gitFiles = (area) => (ui.git?.data?.files ?? []).filter((f) => f[area]);

  function closeGitDetail() {
    if (ui.git) {
      ++ui.git.viewVersion;
      ui.git.activeFile = null;
      setGitActive(null);
    }
    $("g-detail").hidden = true;
    $("g-diff-empty").hidden = false;
    for (const row of $("g-changes").querySelectorAll(".git-file.active")) row.classList.remove("active");
  }

  function showGitTab(tab) {
    if (!GIT_TABS.includes(tab)) return;
    if (ui.git?.tab !== tab) closeGitDetail();
    if (ui.git) ui.git.tab = tab;
    localStorage.setItem(GIT_TAB_KEY, tab);
    for (const button of $("g-tabs").querySelectorAll("[data-git-tab]")) {
      const active = button.dataset.gitTab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const panel of $("g-body").querySelectorAll("[data-git-panel]")) panel.hidden = panel.dataset.gitPanel !== tab;
    $(tab === "changes" ? "g-change-preview" : "g-history-detail").append($("g-detail"));
    if (tab === "pulls" && ui.git) pullRequests.activate(ui.git.project);
  }

  async function loadGit() {
    const p = currentProject();
    if (!p) return;
    const projectPath = p.path;
    if (!ui.git || !samePath(ui.git.project, projectPath)) {
      ui.git = { project: projectPath, selected: { staged: new Set(), unstaged: new Set() }, tab: gitTab(), data: null, loadVersion: 0, viewVersion: 0 };
      closeGitDetail();
      pullRequests.setProject(projectPath);
      showGitTab(ui.git.tab);
      $("g-body").hidden = true;
      $("g-message").value = "";
      $("g-error").textContent = "";
      $("g-branch").textContent = "";
      $("g-sync").textContent = "";
      $("p-tab-git").textContent = "";
    }
    const current = ui.git;
    const version = ++current.loadVersion;
    $("g-refresh").disabled = true;
    try {
      const data = await api("GET", "/api/git?path=" + encodeURIComponent(projectPath));
      if (ui.git !== current || version !== current.loadVersion || !samePath(projectPath, navigation.project)) return;
      $("g-note").hidden = true;
      $("g-body").hidden = false;
      for (const area of ["staged", "unstaged"]) {
        const paths = new Set(data.files.filter((f) => f[area]).map((f) => f.path));
        for (const file of current.selected[area]) if (!paths.has(file)) current.selected[area].delete(file);
      }
      current.data = data;
      renderGit();
      if (current.tab === "pulls") pullRequests.activate(current.project);
      if (current.activeFile) {
        const { file, area } = current.activeFile;
        if (gitFiles(area).some((f) => f.path === file)) showGitFile(file, area);
        else closeGitDetail();
      }
    } catch (err) {
      if (ui.git !== current || version !== current.loadVersion || !samePath(projectPath, navigation.project)) return;
      $("g-note").hidden = false;
      $("g-note").textContent = err.reason === "not-git" ? "Git 저장소가 아닙니다." : err.message;
      $("g-body").hidden = true;
    } finally {
      if (ui.git === current && version === current.loadVersion) $("g-refresh").disabled = gitBusy();
    }
  }

  const gitBranchName = (b) => b.sessionTitle || b.name;

  async function gitGet(url, title) {
    const current = ui.git;
    const version = ++current.viewVersion;
    showGitView(title, "불러오는 중…");
    try {
      const data = await api("GET", url);
      if (ui.git === current && current.viewVersion === version && samePath(current.project, navigation.project)) showGitView(title, data.diff || "변경 없음");
    } catch (err) {
      if (ui.git === current && current.viewVersion === version && samePath(current.project, navigation.project)) showGitView(title, err.message);
    }
  }

  const gitQuery = (extra) => new URLSearchParams({ path: ui.git.project, ...extra });
  function showGitFile(file, area = "unstaged") {
    showGitTab("changes");
    ui.git.activeFile = { file, area };
    for (const row of $("g-changes").querySelectorAll(".git-file")) row.classList.toggle("active", row.dataset.file === file && row.dataset.area === area);
    return gitGet("/api/git/diff?" + gitQuery({ file, area }), file + (area === "staged" ? " · 스테이징됨" : " · 스테이징 전"));
  }
  const showGitCommit = (c) => gitGet("/api/git/show?" + gitQuery({ hash: c.hash }), c.short + " · " + c.subject);
  const showGitBranch = (b) => gitGet("/api/git/branch?" + gitQuery({ branch: b.name }), gitBranchName(b) + " · 병합할 변경");

  async function showSessionChanges(b) {
    const current = ui.git;
    const version = ++current.viewVersion;
    const title = gitBranchName(b) + " · 작업 변경";
    showGitView(title, "불러오는 중…");
    try {
      const data = await api("GET", "/api/sessions/" + b.sessionId + "/diff");
      if (ui.git === current && current.viewVersion === version && samePath(current.project, navigation.project)) showGitView(title, data.diff || data.status || "변경 없음");
    } catch (err) {
      if (ui.git === current && current.viewVersion === version && samePath(current.project, navigation.project)) showGitView(title, err.message);
    }
  }

  function openBranchCommit(li, b) {
    if (gitBusy()) return;
    li.querySelector(".git-inline")?.remove();
    const current = ui.git;
    const input = el("input", { placeholder: "커밋 메시지", "aria-label": gitBranchName(b) + " 커밋 메시지", value: gitBranchName(b) + " 작업" });
    const error = el("span", { class: "error", role: "alert" });
    let busy = false;
    const submit = async () => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      try {
        await api("POST", "/api/git/commit", { path: current.project, session: b.sessionId, message: input.value });
        if (ui.git === current && samePath(current.project, navigation.project)) await loadGit();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        busy = false;
        button.disabled = false;
      }
    };
    const button = el("button", { type: "button", class: "primary sm", onclick: submit }, "커밋");
    const form = el("div", { class: "git-inline" }, input, button,
      el("button", { type: "button", class: "ghost sm", onclick: () => form.remove() }, "취소"), error);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) submit();
      if (e.key === "Escape" && !busy) form.remove();
    });
    li.querySelector("details").append(form);
    input.focus();
    input.select();
  }

  async function mergeGitBranch(b) {
    const current = ui.git;
    if (gitBusy()) return;
    const into = current.data.branch;
    if (!confirm(gitBranchName(b) + " → " + into + " 병합할까요?\n충돌하면 자동 취소됩니다.")) return;
    current.merging = true;
    renderGitControls();
    try {
      const { result } = await api("POST", "/api/git/merge", { path: current.project, branch: b.name });
      if (ui.git === current && samePath(current.project, navigation.project)) { ++current.viewVersion; showGitView("병합 완료", result); }
    } catch (err) {
      alert(err.message);
    } finally {
      current.merging = false;
      if (ui.git === current) renderGitControls();
    }
    if (ui.git === current && samePath(current.project, navigation.project)) await loadGit();
  }

  $("g-tabs").addEventListener("click", (e) => {
    const button = e.target.closest("[data-git-tab]");
    if (button) showGitTab(button.dataset.gitTab);
  });
  $("g-tabs").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const active = GIT_TABS.indexOf(ui.git?.tab ?? gitTab());
    const index = e.key === "Home" ? 0 : e.key === "End" ? GIT_TABS.length - 1 : (active + (e.key === "ArrowRight" ? 1 : -1) + GIT_TABS.length) % GIT_TABS.length;
    e.preventDefault();
    showGitTab(GIT_TABS[index]);
    $("g-tab-" + GIT_TABS[index]).focus();
  });
  $("g-detail-close").addEventListener("click", closeGitDetail);
  $("g-refresh").addEventListener("click", () => { loadGit(); if (ui.git?.tab === "pulls") pullRequests.refresh(); });
  $("g-message").addEventListener("input", renderGitControls);
  for (const area of ["unstaged", "staged"]) {
    const action = area === "staged" ? "unstage" : "stage";
    $("g-" + area + "-all").addEventListener("change", (e) => {
      for (const f of gitFiles(area)) {
        if (e.target.checked) ui.git.selected[area].add(f.path);
        else ui.git.selected[area].delete(f.path);
      }
      renderGitFiles(area);
      renderGitControls();
    });
    $("g-" + action + "-selected").addEventListener("click", () => changeGitIndex(action, [...ui.git.selected[area]]));
    $("g-" + action + "-all").addEventListener("click", () => changeGitIndex(action, gitFiles(area).map((f) => f.path)));
  }

  async function changeGitIndex(action, files) {
    const current = ui.git;
    if (!files.length || gitBusy()) return;
    $("g-error").textContent = "";
    current.indexBusy = true;
    renderGitControls();
    try {
      await api("POST", "/api/git/" + action, { path: current.project, files });
      if (ui.git === current && samePath(current.project, navigation.project)) closeGitDetail();
    } catch (err) {
      if (ui.git === current && samePath(current.project, navigation.project)) $("g-error").textContent = err.message;
    } finally {
      if (ui.git === current && samePath(current.project, navigation.project)) await loadGit();
      current.indexBusy = false;
      if (ui.git === current) renderGitControls();
    }
  }

  $("g-commit").addEventListener("click", async () => {
    const current = ui.git;
    const staged = current?.data?.stagedCount ?? gitFiles("staged").length;
    if (!staged || !$("g-message").value.trim() || gitBusy()) return;
    $("g-error").textContent = "";
    current.committing = true;
    renderGitControls();
    let result;
    try {
      ({ result } = await api("POST", "/api/git/commit", { path: current.project, message: $("g-message").value, staged: true }));
      if (ui.git === current && samePath(current.project, navigation.project)) {
        $("g-message").value = "";
        current.selected.staged.clear();
        closeGitDetail();
      }
    } catch (err) {
      if (ui.git === current && samePath(current.project, navigation.project)) $("g-error").textContent = err.message;
    } finally {
      if (ui.git === current && samePath(current.project, navigation.project)) await loadGit();
      current.committing = false;
      if (ui.git === current) renderGitControls();
    }
    if (result && ui.git === current && samePath(current.project, navigation.project) && current.tab === "changes") showGitView("커밋 완료", result);
  });

  // 창을 다시 열어 보면 외부 Git 작업도 반영한다.
  window.addEventListener("focus", () => {
    if (navigation.view === "project" && projectTab() === "git") loadGit();
  });

  return { loadGit };
}
