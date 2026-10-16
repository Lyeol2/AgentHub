import { createSettingsView } from "./view.js";
import { $ } from "../../shared/dom.js";

export function createSettingsController({ api, goDashboard, loadProjects, renderProjectNav, currentProject, renderLinkConditions, data, navigation }) {
  // Setup, usage and updater snapshots are owned by this feature.
  const cache = {
    "auth": null,
    "setup": null,
    "limits": null,
    "update": null
  };
  const setupUi = { loading: false, refreshing: false, loadError: "", refreshError: "", actionErrors: {}, pending: new Set() };
  let setupRequest = 0;
  const view = createSettingsView({ openSetup, setupAction, refreshSetup, updateAction, onRemoveProject: async (index) => {
    data.status.projects = await api("DELETE", `/api/projects/${index}`);
    renderProjects();
    refreshProjects();
  } });
  const renderCliStatus = () => view.renderCliStatus(data.status, cache.auth, cache.setup);
  const renderSetup = () => {
    $("setup-refresh").disabled = setupUi.refreshing;
    $("setup-refresh").textContent = setupUi.refreshing ? "확인 중…" : "새로고침";
    view.renderSetup(cache.setup, { ...setupUi, error: [setupUi.loadError, setupUi.refreshError].filter(Boolean).join("\n") });
  };
  const renderLimits = () => view.renderLimits(cache.limits);
  const renderUpdate = () => view.renderUpdate(cache.update);
  const renderProjects = () => view.renderProjects(data.status.projects);
  const renderCliField = (agent) => view.renderCliField(agent, data.status, cliManual[agent]);
  const renderThemeSwitch = () => view.renderThemeSwitch();

  // ── CLI 상태 ────────────────────────────────────────────────────
  async function loadStatus(fresh = false) {
    data.status = await api("GET", `/api/status${fresh === true ? "?fresh=1" : ""}`);
    renderLinkConditions();
    renderCliStatus();
    renderProjectNav();
  }

  // 로그인 여부는 CLI를 실행해 확인하므로 따로, 느리게 불러온다. true | false | null(확인 실패)
  async function loadAuth(fresh = false) {
    try {
      cache.auth = await api("GET", `/api/auth${fresh ? "?fresh=1" : ""}`);
    } catch (err) {
      if (fresh === true) throw err;
      return;
    }
    renderCliStatus();
  }

  // 설정 창의 CLI 상태. 없으면 "설치", 로그인이 안 됐으면 "로그인" 버튼을 보이고, 누르면 설치·로그인 창에서 진행한다.

  // ── CLI 설치·로그인 ─────────────────────────────────────────────

  async function loadSetup(fresh = false) {
    const request = ++setupRequest;
    setupUi.loading = true;
    if ($("setup-dialog").open) renderSetup();
    try {
      const next = await api("GET", `/api/setup${fresh === true ? "?fresh=1" : ""}`);
      if (request !== setupRequest) return;
      cache.setup = next;
      setupUi.loadError = "";
    } catch (err) {
      if (request === setupRequest) setupUi.loadError = err.message;
      if (fresh === true) throw err;
    } finally {
      if (request === setupRequest) {
        setupUi.loading = false;
        renderCliStatus();
        if ($("setup-dialog").open) renderSetup();
      }
    }
  }

  // 창을 열고, action이 있으면 바로 시작한다.
  async function openSetup(tool = null, action = null) {
    renderSetup();
    if (!$("setup-dialog").open) $("setup-dialog").showModal();
    await loadSetup();
    if (tool && action) await setupAction(tool, action);
  }

  async function setupAction(tool, action, body) {
    if (setupUi.pending.has(tool)) return;
    const previousJob = cache.setup?.jobs?.[tool];
    setupUi.pending.add(tool);
    delete setupUi.actionErrors[tool];
    renderSetup();
    try {
      const result = await api("POST", `/api/setup/${tool}/${action}`, body);
      if (result?.kind && result?.state && cache.setup && cache.setup.jobs?.[tool] === previousJob) {
        cache.setup.jobs ??= {};
        // Keep a newer streamed job if it arrived before the POST response.
        cache.setup.jobs[tool] = result;
      }
      await loadSetup();
    } catch (err) {
      setupUi.actionErrors[tool] = err.outcomeUnknown
        ? `${err.message} 작업 상태를 새로고침한 뒤 다시 시도하세요.` : err.message;
    } finally {
      setupUi.pending.delete(tool);
      renderCliStatus();
      renderSetup();
    }
  }

  // 진행 중이거나 끝난 작업. 로그인이면 브라우저 주소·일회용 코드·코드 붙여넣기 칸을 보인다.

  async function refreshSetup() {
    if (setupUi.refreshing) return;
    setupUi.refreshing = true;
    setupUi.refreshError = "";
    renderSetup();
    try {
      const results = await Promise.allSettled([loadStatus(true), loadAuth(true), loadSetup(true)]);
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason.message);
      setupUi.refreshError = [...new Set(errors)].filter(message => message !== setupUi.loadError).join("\n");
      if (!errors.length) setupUi.actionErrors = {};
    } finally {
      setupUi.refreshing = false;
      renderSetup();
    }
  }
  $("setup-refresh").addEventListener("click", refreshSetup);
  $("cli-status").addEventListener("click", (e) => {
    if (!e.target.closest("button")) openSetup();
  });

  // ── 사용 한도 ───────────────────────────────────────────────────

  // 초기화 시각이 지난 기간은 사용률을 알 수 없으므로 0%로 보지 않고 따로 표시한다.

  // fresh: 새로고침 버튼처럼 서버의 캐시를 쓰지 않고 다시 묻는다.
  async function loadLimits(fresh = false) {
    try {
      cache.limits = await api("GET", `/api/limits${fresh === true ? "?fresh=1" : ""}`);
    } catch {
      return;
    }
    renderLimits();
  }

  // 사이드바의 한도 한 줄. 초기화 시각이 지났으면 다 남은 것으로 본다.

  // 지금부터 그 시각까지 남은 시간("2시간 13분", "40분", "3일 4시간")

  $("refresh-limits").addEventListener("click", () => loadLimits(true));
  setInterval(loadLimits, 60_000);

  // ── 업데이트 ────────────────────────────────────────────────────
  async function loadUpdate() {
    try {
      cache.update = await api("GET", "/api/update");
    } catch {
      return;
    }
    renderUpdate();
  }

  async function updateAction(action) {
    try {
      cache.update = await api("POST", `/api/update/${action}`);
    } catch (err) {
      cache.update = { ...cache.update, status: "error", error: err.message };
    }
    renderUpdate();
  }

  // ── 설정 ────────────────────────────────────────────────────────

  async function refreshProjects() {
    await loadProjects();
    if (navigation.view === "project" && !currentProject()) goDashboard();
  }

  async function openSettings() {
    await loadStatus();
    renderProjects();
    for (const agent of ["claude", "codex"]) {
      cliManual[agent] = !!data.status.cliOverrides[agent];
      $(`cli-${agent}`).value = data.status.cliOverrides[agent];
      renderCliField(agent);
    }
    $("cli-auto-update").checked = data.status.cliAutoUpdate !== false;
    $("settings-error").textContent = "";
    $("settings-dialog").showModal();
    $("project-path").focus();
  }

  // CLI 경로: 자동으로 찾은 경로는 읽기 전용으로 보여 주고, 직접 지정할 때만 고칠 수 있다.
  const cliManual = { claude: false, codex: false };

  for (const agent of ["claude", "codex"]) {
    $(`cli-${agent}-mode`).addEventListener("click", () => {
      cliManual[agent] = !cliManual[agent];
      $(`cli-${agent}`).value = cliManual[agent] ? data.status.cliOverrides[agent] || data.status.agents[agent].autoPath || "" : "";
      renderCliField(agent);
      if (cliManual[agent]) $(`cli-${agent}`).focus();
    });
  }

  $("open-settings").addEventListener("click", openSettings);
  $("open-setup").addEventListener("click", () => openSetup());
  $("add-project-nav").addEventListener("click", openSettings);
  $("add-project-dash").addEventListener("click", openSettings);

  $("add-project").addEventListener("click", async () => {
    try {
      data.status.projects = await api("POST", "/api/projects", { path: $("project-path").value });
      $("project-path").value = "";
      $("settings-error").textContent = "";
      renderProjects();
      refreshProjects();
    } catch (err) {
      $("settings-error").textContent = err.message;
    }
  });

  $("project-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("add-project").click();
    }
  });

  $("settings-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    try {
      const cli = {};
      for (const agent of ["claude", "codex"]) cli[agent] = cliManual[agent] ? $(`cli-${agent}`).value : "";
      await api("PUT", "/api/settings", { cli, cliAutoUpdate: $("cli-auto-update").checked });
      $("settings-dialog").close();
      await loadStatus(true);
      await Promise.all([loadAuth(true), loadSetup(true)]);
    } catch (err) {
      $("settings-error").textContent = err.message;
    }
  });

  // ── 화면 테마 ───────────────────────────────────────────────────
  // 테마 적용은 CSS보다 먼저 읽는 theme.js가 맡고, 여기서는 고르는 버튼만 다룬다.

  $("theme-switch").addEventListener("click", (e) => {
    const pref = e.target.closest("button")?.dataset.themePref;
    if (pref) window.agenthubTheme.set(pref);
  });
  window.addEventListener("agenthub-theme", renderThemeSwitch);
  renderThemeSwitch();

  function applySetupJobs(jobs) {
    if (!cache.setup) return loadSetup();
    cache.setup.jobs = jobs;
    renderCliStatus();
    if ($("setup-dialog").open) renderSetup();
  }
  function applyUpdate(update) { cache.update = update; renderUpdate(); }

  return { loadStatus, loadAuth, loadSetup, loadLimits, loadUpdate, openSettings, openSetup, applySetupJobs, applyUpdate };
}
