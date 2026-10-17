import { createGitView } from "./view.js";
import { initGitResizer, initGitStageResizer } from "./resizer.js";
import { createGitOperations } from "./operations.js";
import { $, renderDiff } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";
import { renderMarkdown } from "../../markdown.js";
import { createPullRequests } from "../../gitpulls.js";
import { icon } from "../../shared/icons.js";
import { confirmAction } from "../../shared/confirm-dialog.js";

export function createGitController({ api, selectSession, openSetup, currentProject, projectTab, pullIssues = () => [], navigation }) {
  initGitResizer();
  initGitStageResizer();
  for (const slot of $("g-tabs").querySelectorAll("[data-icon]")) slot.replaceWith(icon(slot.dataset.icon, { size: 16 }));
  const ui = {
    "git": null
  };
  const { renderGit, renderGitFiles, renderGitControls, setGitActive, showGitView } = createGitView({
    getModel: () => ui.git, selectSession, showSessionChanges, selectWorkspace: async (cwd) => { await setWorkspace(cwd); showGitTab("changes"); }, showGitBranch: (branch) => showGitBranch(branch),
    mergeGitBranch, checkoutGitBranch, showGitFile, changeGitIndex, showGitTab, showGitCommit: (commit) => showGitCommit(commit),
    onToggleFile: (area, file, selected) => {
      if (selected) ui.git.selected[area].add(file);
      else ui.git.selected[area].delete(file);
      renderGitControls();
    },
  });
  // ── Git 탭 ──────────────────────────────────────────────────────
  const GIT_TAB_KEY = "agenthub-git-tab";
  const GIT_TABS = ["changes", "history", "pulls"];
  const pullRequests = createPullRequests({ api, renderMarkdown, renderDiff, onSetup: () => openSetup("gh"), isProjectCurrent: (project, cwd) => samePath(project, navigation.project) && samePath(cwd || project, ui.git?.cwd || project), pullIssues });
  const gitTab = () => GIT_TABS.includes(localStorage.getItem(GIT_TAB_KEY)) ? localStorage.getItem(GIT_TAB_KEY) : "changes";
  const gitBusy = () => !!(ui.git?.indexBusy || ui.git?.committing || ui.git?.merging || ui.git?.checkingOut || ui.git?.operationBusy);
  const gitFiles = (area) => (ui.git?.data?.files ?? []).filter((f) => f[area]);
  const operations = createGitOperations({ api, getModel: () => ui.git, isCurrent: (m) => samePath(m.project, navigation.project), isBusy: gitBusy,
    setWorkspace, reload: loadGit, controls: renderGitControls });

  async function setWorkspace(cwd) {
    if (!ui.git || gitBusy() || samePath(ui.git.cwd, cwd)) return;
    const project = ui.git.project;
    ui.git = { project, cwd, tab: ui.git.tab, selected: { staged: new Set(), unstaged: new Set() }, data: null, loadVersion: 0, viewVersion: 0 };
    closeGitDetail();
    $("g-message").value = "";
    $("g-error").textContent = "";
    $("g-body").hidden = true;
    pullRequests.setProject(project, cwd);
    operations.update();
    await loadGit();
  }

  function closeGitDetail() {
    operations.clearCommit();
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
    if (tab === "pulls" && ui.git) pullRequests.activate(ui.git.project, ui.git.cwd);
  }

  async function loadGit() {
    const p = currentProject();
    if (!p) return;
    const projectPath = p.path;
    if (!ui.git || !samePath(ui.git.project, projectPath)) {
      ui.git = { project: projectPath, cwd: projectPath, selected: { staged: new Set(), unstaged: new Set() }, tab: gitTab(), data: null, loadVersion: 0, viewVersion: 0 };
      closeGitDetail();
      pullRequests.setProject(projectPath, projectPath);
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
      const data = await api("GET", "/api/git?" + new URLSearchParams({ path: projectPath, cwd: current.cwd }));
      if (ui.git !== current || version !== current.loadVersion || !samePath(projectPath, navigation.project)) return;
      $("g-note").hidden = true;
      $("g-body").hidden = false;
      for (const area of ["staged", "unstaged"]) {
        const paths = new Set(data.files.filter((f) => f[area]).map((f) => f.path));
        for (const file of current.selected[area]) if (!paths.has(file)) current.selected[area].delete(file);
      }
      current.data = data;
      renderGit();
      operations.update();
      if (current.tab === "pulls") pullRequests.activate(current.project, current.cwd);
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
      if (ui.git === current && version === current.loadVersion) { $("g-refresh").disabled = gitBusy(); operations.update(); }
    }
  }

  const gitBranchName = (b) => b.sessionTitle || b.name;

  async function gitGet(url, title) {
    const current = ui.git;
    const version = ++current.viewVersion;
    showGitView(title, "불러오는 중…");
    try {
      const data = await api("GET", url);
      if (ui.git === current && current.viewVersion === version && samePath(current.project, navigation.project)) { showGitView(title, data.diff || "변경 없음"); return true; }
    } catch (err) {
      if (ui.git === current && current.viewVersion === version && samePath(current.project, navigation.project)) showGitView(title, err.message);
    }
  }

  const gitQuery = (extra) => new URLSearchParams({ path: ui.git.project, cwd: ui.git.cwd, ...extra });
  function showGitFile(file, area = "unstaged") {
    showGitTab("changes");
    ui.git.activeFile = { file, area };
    for (const row of $("g-changes").querySelectorAll(".git-file")) row.classList.toggle("active", row.dataset.file === file && row.dataset.area === area);
    return gitGet("/api/git/diff?" + gitQuery({ file, area }), file + (area === "staged" ? " · 스테이징됨" : " · 스테이징 전"));
  }
  const showGitCommit = async (c) => { if (await gitGet("/api/git/show?" + gitQuery({ hash: c.hash }), c.short + " · " + c.subject)) operations.commit(c); };
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

  function mergeGitBranch(b) { return operations.merge(b.name); }

  // 선택한 폴더의 브랜치를 바꾼다. 변경이 겹치면 Git이 거절한다.
  async function checkoutGitBranch(b) {
    const current = ui.git;
    if (gitBusy() || b.current || b.checkedOutAt) return;
    const dirty = current.data.files.length + current.data.moreFiles;
    const answer = await confirmAction({ title: "브랜치 전환 (Checkout)", subject: current.cwd,
      changes: [current.data.branch + " → " + b.name + " 브랜치로 작업 폴더를 바꿉니다."],
      keeps: [dirty ? "커밋하지 않은 변경 " + dirty + "개는 그대로 가져갑니다. 겹치는 파일이 있으면 전환하지 않습니다." : "커밋한 기록은 그대로 남습니다."],
      confirmLabel: "전환" });
    if (!answer.ok || ui.git !== current || gitBusy()) return;
    current.checkingOut = true;
    renderGitControls();
    try {
      await api("POST", "/api/git/checkout", { path: current.project, cwd: current.cwd, branch: b.name });
      if (ui.git === current && samePath(current.project, navigation.project)) closeGitDetail();
    } catch (err) {
      alert(err.message);
    } finally {
      current.checkingOut = false;
      if (ui.git === current) renderGitControls();
    }
    if (ui.git === current && samePath(current.project, navigation.project)) await loadGit();
  }

  $("g-tabs").addEventListener("click", (e) => {
    const button = e.target.closest("[data-git-tab]");
    if (button) showGitTab(button.dataset.gitTab);
  });
  $("g-tabs").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const active = GIT_TABS.indexOf(ui.git?.tab ?? gitTab());
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    const index = e.key === "Home" ? 0 : e.key === "End" ? GIT_TABS.length - 1 : (active + (forward ? 1 : -1) + GIT_TABS.length) % GIT_TABS.length;
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
      await api("POST", "/api/git/" + action, { path: current.project, cwd: current.cwd, files });
      if (ui.git === current && samePath(current.project, navigation.project)) closeGitDetail();
    } catch (err) {
      if (ui.git === current && samePath(current.project, navigation.project)) $("g-error").textContent = err.message;
    } finally {
      if (ui.git === current && samePath(current.project, navigation.project)) await loadGit();
      current.indexBusy = false;
      if (ui.git === current) renderGitControls();
    }
  }

  $("g-commit-push").addEventListener("click", () => commitStaged({ push: true }));
  $("g-commit").addEventListener("click", () => commitStaged());
  async function commitStaged({ push = false } = {}) {
    const current = ui.git;
    const staged = current?.data?.stagedCount ?? gitFiles("staged").length;
    if (!staged || !$("g-message").value.trim() || gitBusy()) return;
    $("g-error").textContent = "";
    current.committing = true;
    renderGitControls();
    let result;
    try {
      ({ result } = await api("POST", "/api/git/commit", { path: current.project, cwd: current.cwd, message: $("g-message").value, staged: true }));
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
    // 커밋 후 Push: 커밋에 성공했을 때만 푸시 미리보기를 연다. 실제 푸시는 미리보기에서 확인한 뒤 실행한다.
    if (push && result && ui.git === current && samePath(current.project, navigation.project)) operations.push();
  }

  // 창을 다시 열어 보면 외부 Git 작업도 반영한다.
  window.addEventListener("focus", () => {
    if (navigation.view === "project" && projectTab() === "git") loadGit();
  });

  return { loadGit };
}
