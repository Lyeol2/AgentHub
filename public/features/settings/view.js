import { $, el, badge, AGENT_LABEL, timeAgo, fmtDate } from "../../shared/dom.js";

const SETUP_STATE = { running: "진행 중", done: "완료", error: "실패", canceled: "취소함" };

const LIMIT_EMPTY = {
  claude: "Claude CLI에 로그인하면 사용률이 표시됩니다.",
  codex: "Codex 세션 기록에서 한도 정보를 찾지 못했습니다. Codex를 한 번 실행하면 표시됩니다.",
};

const LIMIT_STATUS = { allowed: "사용 가능", allowed_warning: "한도 임박", rejected: "한도 도달" };
const isExpired = (w) => w.resetsAt && new Date(w.resetsAt).getTime() <= Date.now();

export function createSettingsView({ openSetup, setupAction, updateAction, onRemoveProject }) {
  function renderCliStatus(status, auth, setup) {
    if (!status) return;
    const rows = Object.entries(status.agents).map(([name, info]) => ({
      id: name, label: AGENT_LABEL[name], path: info.path, version: info.version, loggedIn: auth?.[name],
    }));
    const gh = setup?.tools.find((t) => t.id === "gh");
    if (gh) rows.push({ id: "gh", label: "GitHub", path: gh.path, version: gh.version?.replace(/^gh version\s*/, "").split(" ")[0], loggedIn: gh.loggedIn });
    $("cli-status").replaceChildren(...rows.map((r) => {
      const job = setup?.jobs?.[r.id];
      const busy = job?.state === "running";
      const action = busy ? null : !r.path ? "install" : r.version && r.loggedIn === false ? "login" : null;
      const health = !r.path || !r.version || r.loggedIn === false ? "error" : r.loggedIn === true ? "ok" : "";
      const note = !r.path ? "CLI를 찾지 못했습니다. 설치했으면 설정에서 실행 파일 경로를 직접 지정하세요."
        : !r.version ? "실행 파일은 찾았지만 버전을 확인하지 못했습니다. 설정에서 경로를 확인한 뒤 다시 확인하세요."
        : r.loggedIn === null ? "로그인 상태를 확인하지 못했습니다. 설치·로그인 창에서 다시 확인하세요."
        : r.loggedIn === false ? "로그인이 필요합니다." : r.loggedIn === true ? "로그인됨" : "로그인 확인 중…";
      return el("div", { title: [r.path, note].filter(Boolean).join("\n") },
        el("span", { class: `dot ${busy ? "running" : health}` }),
        el("span", { class: "cli-text" }, `${r.label} ${busy ? (job.kind === "install" ? "설치 중…" : "로그인 중…") : r.path ? r.version ?? "버전 확인 실패" : "없음"}`),
        action ? el("button", { type: "button", class: "login-btn", onclick: () => openSetup(r.id, action), title: "앱 안에서 설치·로그인을 진행합니다" },
          action === "install" ? "설치" : "로그인 필요") : null);
    }));
  }

  function renderSetup(setup) {
    const tools = [...(setup?.winget ? [setup.winget] : []), ...(setup?.tools ?? [])];
    $("setup-list").replaceChildren(...tools.map((t) => {
      const job = setup.jobs?.[t.id];
      const running = job?.state === "running";
      const packageManager = t.id === "winget";
      const status = !t.path ? "실행 파일을 찾지 못함" : !t.version ? "실행 확인 실패"
        : packageManager ? t.version : `${t.version} · ${t.loggedIn === true ? "로그인됨" : t.loggedIn === false ? "로그인 필요" : "로그인 확인 실패"}`;
      const ok = t.path && t.version && (packageManager || t.loggedIn === true);
      const item = el("div", { class: `setup-item${ok ? " ok" : ""}` },
        el("div", { class: "setup-head" },
          el("b", {}, t.label),
          el("span", { class: `pill ${ok ? "setup-ok" : "setup-need"}` }, status),
          el("span", { class: "spacer" }),
          t.installable && (packageManager || !t.path || !t.version) ? el("button", { type: "button", class: `${ok ? "ghost" : "primary"} sm`, onclick: () => setupAction(t.id, "install"), ...(running ? { disabled: "" } : {}) }, packageManager ? "설치·복구" : t.path ? "다시 설치" : "설치") : null,
          !packageManager && t.path && t.version ? el("button", { type: "button", class: `${t.loggedIn ? "ghost" : "primary"} sm`, onclick: () => setupAction(t.id, "login"), ...(running ? { disabled: "" } : {}) }, t.loggedIn ? "다시 로그인" : "로그인") : null),
        t.path ? el("p", { class: "hint mono" }, t.path) : null,
        packageManager ? el("p", { class: "hint" }, "Windows에서 winget이 없으면 CLI 설치 전에 자동으로 준비합니다. 자동 설치·복구에 실패하면 아래 수동 설치 안내를 따라 설치한 뒤 상단의 ‘다시 확인’을 누르세요.") : null,
        !packageManager && !t.path ? el("p", { class: "hint" }, `${!t.installable ? "자동으로 설치할 방법이 없습니다. 아래 수동 설치 안내를 확인하세요. " : ""}이미 설치했다면 설정에서 CLI 실행 파일 경로를 직접 지정한 뒤 다시 확인하세요.`) : null,
        !packageManager && t.path && !t.version ? el("p", { class: "hint" }, "이 경로의 CLI를 실행하지 못했습니다. 다시 설치하거나 아래 수동 설치 안내를 확인하세요. 설정에서 실행 파일 경로를 확인하고 터미널에서 해당 CLI의 --version을 실행할 수도 있습니다.") : null,
        !packageManager && t.path && t.version && t.loggedIn === null ? el("p", { class: "hint" }, "CLI는 실행되지만 로그인 상태를 확인하지 못했습니다. 다시 확인하거나 로그인 출력을 확인하세요.") : null);
      if (job) item.append(setupJob(t, job, running));
      if (t.manual) item.append(manualInstall(t.manual, job?.kind === "install" && job.state === "error"));
      return item;
    }));
  }

  function manualInstall(manual, failed) {
    const details = el("details", { ...(failed ? { open: "" } : {}) },
      el("summary", {}, "수동 설치"),
      failed ? el("p", { class: "hint" }, "자동 설치에 실패했습니다. 공식 설치 페이지나 아래 명령으로 직접 설치할 수 있습니다.") : null,
      manual.note ? el("p", { class: "hint" }, manual.note) : null,
      ...(manual.links ?? []).map((link) => el("p", { class: "hint" },
        el("a", { href: link.url, target: "_blank", rel: "noopener noreferrer" }, link.label))));
    if (manual.command) {
      const copy = el("button", { type: "button", class: "ghost sm", onclick: async () => {
        try {
          await navigator.clipboard.writeText(manual.command);
          copy.textContent = "복사됨";
        } catch {
          copy.textContent = "아래 명령을 직접 복사하세요";
        }
      } }, "명령 복사");
      details.append(copy, el("pre", { class: "setup-log" }, manual.command));
    }
    details.append(el("p", { class: "hint" }, "설치가 끝나면 상단의 ‘다시 확인’을 누르세요."));
    return details;
  }

  function setupJob(t, job, running) {
    const box = el("div", { class: `setup-job ${job.state}` },
      el("div", { class: "setup-job-head" },
        el("span", {}, `${job.kind === "install" ? "설치" : "로그인"} ${SETUP_STATE[job.state] ?? job.state}`),
        running ? el("button", { type: "button", class: "ghost sm danger", onclick: () => setupAction(t.id, "cancel") }, "취소") : null));
    if (job.kind === "login" && running) {
      if (job.url) {
        box.append(el("p", { class: "hint" }, "브라우저에서 로그인 페이지를 열었습니다. 열리지 않았으면 아래 버튼을 누르세요."),
          el("button", { type: "button", class: "ghost sm", onclick: () => window.open(job.url, "_blank") }, "브라우저에서 열기"));
      }
      if (job.code) {
        box.append(el("div", { class: "setup-code" },
          el("span", { class: "mono" }, job.code),
          el("button", { type: "button", class: "ghost sm", onclick: () => navigator.clipboard?.writeText(job.code) }, "복사"),
          el("span", { class: "hint" }, "로그인 페이지에 이 코드를 입력하세요.")));
      }
      // Claude는 브라우저에 표시된 코드를 다시 붙여 넣으라고 한다.
      if (t.id === "claude" || job.waitsForCode) {
        const input = el("input", { class: "mono", placeholder: "브라우저에 표시된 코드를 붙여 넣으세요" });
        const send = () => input.value.trim() && setupAction(t.id, "input", { text: input.value });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault();
            send();
          }
        });
        box.append(el("div", { class: "setup-paste" }, input, el("button", { type: "button", class: "primary sm", onclick: send }, "보내기")));
      }
    }
    if (job.state === "done") box.append(el("p", { class: "ok-text" }, job.kind === "install" ? "설치했습니다." : "로그인했습니다."));
    if (job.log.trim()) box.append(el("details", { ...(job.state === "error" ? { open: "" } : {}) }, el("summary", {}, "출력"), el("pre", { class: "setup-log" }, job.log.trim().split("\n").slice(-40).join("\n"))));
    return box;
  }

  function timeUntil(iso) {
    const sec = (new Date(iso).getTime() - Date.now()) / 1000;
    if (sec <= 0) return "초기화됨";
    if (sec < 3600) return `${Math.ceil(sec / 60)}분 후`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}시간 ${Math.floor((sec % 3600) / 60)}분 후`;
    return `${Math.floor(sec / 86400)}일 ${Math.floor((sec % 86400) / 3600)}시간 후`;
  }

  function barLevel(used) {
    if (used >= 90) return "danger";
    if (used >= 70) return "warn";
    return "";
  }

  function limitRow(w) {
    const expired = isExpired(w);
    const used = expired ? null : w.usedPercent;
    const statusText = w.status === "rejected" ? "한도 도달" : w.status === "allowed_warning" ? "한도 임박" : null;
    const value = used !== null && used !== undefined
      ? `${Math.max(0, 100 - used).toFixed(0)}% 남음`
      : expired ? "초기화됨" : statusText ?? "사용률 정보 없음";
    const level = used !== null && used !== undefined ? barLevel(used)
      : w.status === "rejected" ? "danger" : w.status === "allowed_warning" ? "warn" : "";
    const width = used !== null && used !== undefined ? used : w.status === "rejected" ? 100 : 0;
    return el("div", { class: "limit-row" },
      el("div", { class: "line" }, el("span", {}, w.label), el("b", {}, value)),
      el("div", { class: "bar" }, el("span", { class: level, style: `width:${Math.min(100, width)}%` })),
      w.resetsAt && !expired
        ? el("div", { class: "reset" }, `${used !== null && used !== undefined ? `${used}% 사용 · ` : ""}초기화 ${fmtDate(w.resetsAt)} (${timeUntil(w.resetsAt)})`)
        : null);
  }

  function renderLimits(limits) {
    if (!limits) return;
    $("limits").replaceChildren(...["claude", "codex"].map((agent) => {
      const info = limits[agent] ?? { windows: [] };
      return el("div", { class: "limit-agent" },
        el("header", {}, badge(agent),
          info.plan ? el("span", { class: "pill" }, info.plan) : null,
          info.observedAt ? el("span", { class: "muted", title: fmtDate(info.observedAt) }, `${timeAgo(info.observedAt)} 기준`) : null),
        ...(info.windows.length ? info.windows.map(limitRow) : [el("div", { class: "limit-empty" }, info.error ?? LIMIT_EMPTY[agent])]));
    }));

    // 사이드바에는 에이전트마다 가장 많이 쓴 기간 하나를 보여 준다.
    // Claude는 시간제(5시간) 한도를 늘 함께 보여 주고, 초기화까지 남은 시간도 붙인다.
    $("limit-mini").replaceChildren(...["claude", "codex"].flatMap((agent) => {
      const all = limits[agent]?.windows ?? [];
      const live = all.filter((w) => !isExpired(w) && typeof w.usedPercent === "number");
      const shown = [];
      const hourly = agent === "claude" ? all.find((w) => w.id === "five_hour") : null;
      if (hourly) shown.push(hourly);
      const rest = live.filter((w) => w !== hourly);
      if (rest.length) shown.push(rest.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)));
      return shown.map((w) => limitMini(agent, w));
    }));
  }

  function limitMini(agent, w) {
    const expired = isExpired(w);
    const used = expired ? 0 : w.usedPercent;
    const known = typeof used === "number";
    const reset = !expired && w.resetsAt ? untilText(w.resetsAt) : null;
    return el("div", { class: "item", title: w.resetsAt ? `초기화 ${fmtDate(w.resetsAt)}` : "" },
      // 초기화까지 남은 시간은 이름 옆에 작게 붙여 사이드바 높이를 늘리지 않는다.
      el("div", { class: "line" },
        el("span", {}, `${AGENT_LABEL[agent]} ${w.label}`,
          reset || expired ? el("span", { class: "reset" }, expired ? " · 초기화됨" : ` · ${reset} 뒤`) : null),
        // 사용률을 모르면(실행 중 이벤트만 받은 경우) 상태만 보인다.
        el("span", {}, known ? `${Math.max(0, 100 - used).toFixed(0)}% 남음` : LIMIT_STATUS[w.status] ?? "사용률 모름")),
      el("div", { class: "bar" }, el("span", {
        class: known ? barLevel(used) : w.status === "rejected" ? "danger" : w.status === "allowed_warning" ? "warn" : "",
        style: `width:${known ? Math.min(100, used) : w.status === "rejected" ? 100 : 0}%`,
      })));
  }

  function untilText(iso) {
    const minutes = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
    if (minutes < 60) return `${minutes}분`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간${minutes % 60 ? ` ${minutes % 60}분` : ""}`;
    return `${Math.floor(hours / 24)}일${hours % 24 ? ` ${hours % 24}시간` : ""}`;
  }

  function renderUpdate(u) {
    if (!u) return;
    const version = el("span", { class: "version" }, `AgentHub v${u.current}`);
    const button = (label, action, cls = "ghost") => el("button", { class: cls, onclick: () => updateAction(action) }, label);
    let action = null;
    let note = null;

    if (!u.desktop) {
      note = el("span", { class: "note" }, "업데이트는 데스크톱 앱에서 할 수 있습니다.");
    } else if (u.portable) {
      action = button("새 버전 받기", "check");
      note = el("span", { class: "note" }, "포터블 버전은 릴리스 페이지에서 직접 받습니다.");
    } else if (!u.supported) {
      note = el("span", { class: "note" }, "개발 모드에서는 업데이트하지 않습니다.");
    } else {
      switch (u.status) {
        case "checking":
          action = el("button", { class: "ghost", disabled: "" }, "확인 중…");
          break;
        case "available":
          action = button(`v${u.latest} 받기`, "download", "primary");
          note = el("span", { class: "new" }, "새 버전이 있습니다.");
          break;
        case "downloading":
          action = el("button", { class: "ghost", disabled: "" }, `받는 중 ${u.progress}%`);
          note = el("span", { class: "note" }, `v${u.latest ?? ""} 업데이트를 받고 있습니다.`);
          break;
        case "ready":
          action = button("재시작해서 업데이트", "install", "primary");
          note = el("span", { class: "new" }, `v${u.latest} 준비됨 · 앱을 닫아도 다음 실행 때 적용됩니다.`);
          break;
        case "none":
          action = button("업데이트 확인", "check");
          note = el("span", { class: "note" }, "최신 버전입니다.");
          break;
        case "error":
          action = button("다시 확인", "check");
          note = el("span", { class: "note error", title: u.error ?? "" }, u.error ?? "업데이트 확인 실패");
          break;
        default:
          action = button("업데이트 확인", "check");
      }
    }
    $("update-box").replaceChildren(el("div", { class: "line" }, version, action), note);
  }

  function renderProjects(projects) {
    $("project-list").replaceChildren(
      ...projects.map((p, i) =>
        el("li", {}, el("span", {}, `${p.name} — ${p.path}`),
          el("button", {
            type: "button",
            class: "ghost danger sm",
            onclick: () => onRemoveProject(i),
          }, "제거"))),
    );
  }

  function renderCliField(agent, status, manual) {
    const info = status.agents[agent];
    const input = $(`cli-${agent}`);
    const note = $(`cli-${agent}-note`);
    input.readOnly = !manual;
    input.classList.toggle("auto", !manual);
    $(`cli-${agent}-mode`).textContent = manual ? "자동으로" : "직접 지정";
    if (manual) {
      input.placeholder = "실행 파일 경로";
      note.textContent = info.autoPath ? `자동으로 찾은 경로: ${info.autoPath}` : "자동으로 찾지 못했습니다.";
      note.className = "cli-note";
    } else {
      input.value = info.autoPath ?? "";
      input.placeholder = "찾지 못했습니다 · 직접 지정하세요";
      note.textContent = info.autoPath ? info.version ? `자동으로 찾음 · ${info.version}` : "실행 파일은 찾았지만 실행을 확인하지 못했습니다. 경로를 확인한 뒤 다시 확인하세요." : "CLI를 찾지 못했습니다. 설치했다면 실행 파일 경로를 직접 지정한 뒤 다시 확인하세요.";
      note.className = `cli-note ${info.autoPath && info.version ? "ok" : "missing"}`;
    }
  }

  function renderThemeSwitch() {
    const pref = window.agenthubTheme.get();
    for (const button of $("theme-switch").querySelectorAll("button")) {
      const on = button.dataset.themePref === pref;
      button.classList.toggle("active", on);
      button.setAttribute("aria-checked", String(on));
    }
  }

  return { renderCliStatus, renderSetup, renderLimits, renderUpdate, renderProjects, renderCliField, renderThemeSwitch };
}
