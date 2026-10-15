import { createConversationView } from "./conversation-view.js";
import { $, AGENT_LABEL, STATE_LABEL, el, badge, sessionLabel, pill, renderLife, renderDiff } from "../../shared/dom.js";
import { renderSessionElapsed } from "../../shared/elapsed.js";
import { linkLabel } from "../../shared/flow.js";
import { firstLine } from "../../shared/store.js";
import { closeContextMenu } from "../../shared/context-menu.js";
import { composerAction } from "../../composer.js";
import { createAttachmentComposer, uploadAttachments, renderAttachmentLinks } from "./image-composer.js";

export function createSessionsController({ POPUP, openWindow, openSessionWindow, api, show, goDashboard, goProject, selectSession, eventsList, loadStatus, loadSessions, sessionById, loadLinks, openEquipDialog, fillModels, fillEfforts, clearSelection, data, navigation }) {
  const ui = {
    "chatDraft": null
  };
  const { renderEvents, appendEvent } = createConversationView({
    getSession: () => data.current, sessionById, selectSession,
    onPlanDecision: (id, plan, body) => api("POST", `/api/sessions/${id}/plans/${plan}`, body),
    onPlanError: (id, error) => api("POST", `/api/sessions/${id}/messages`, { prompt: `[계획 오류] ${error}\n계획 블록을 고쳐 다시 제안하라.` }),
    onQuestionAnswer: (id, question, answers) => api("POST", `/api/sessions/${id}/questions/${question}`, { answers }),
    onPermissionDecision: (id, request, body) => api("POST", `/api/sessions/${id}/permissions/${request}`, body),
  });

  // ── 세션 화면 ───────────────────────────────────────────────────
  // 세션 제목 아래에 역할과 받는·넘기는 연결을 보여 준다.
  function renderFlow() {
    const s = data.current;
    if (!s) return;
    const chip = (id, text, link) => el("button", {
      class: `flow-chip${link.enabled ? "" : " off"}`,
      type: "button",
      title: "세션 열기",
      onclick: () => selectSession(id),
    }, text);
    const incoming = data.links.filter((l) => l.to === s.id && sessionById(l.from));
    const outgoing = data.links.filter((l) => l.from === s.id && sessionById(l.to));
    $("s-flow").replaceChildren(
      ...(s.role ? [el("span", { class: "flow-role", title: s.role }, `${s.roleName || "역할"} · ${firstLine(s.role)}`)] : []),
      ...incoming.map((l) => chip(l.from, `← ${sessionById(l.from).title} · ${linkLabel(l)}`, l)),
      ...outgoing.map((l) => chip(l.to, `→ ${sessionById(l.to).title} · ${linkLabel(l)}`, l)),
    );
  }

  function renderSession() {
    const s = data.current;
    if (!s) return;
    $("s-crumb-project").textContent = s.chat ? "대시보드" : s.projectName;
    $("s-crumb").textContent = ` / ${s.chat ? "일반 채팅" : "세션"}${s.imported ? " · 가져옴" : ""}`;
    $("s-agent").className = `badge ${s.agent}${s.chat ? " chat" : ""}`;
    $("s-agent").textContent = sessionLabel(s);
    $("s-title").textContent = s.title;
    $("s-kind").hidden = s.kind !== "orchestrator";
    imageComposers.s.activate(s.id);
    renderExportResult(s);
    renderState();

    const meta = [
      s.chat ? "도구 없이 대화만" : s.worktree ? `작업 폴더 ${s.cwd} (브랜치 ${s.worktree.branch})` : `원본 폴더 ${s.cwd}`,
      s.chat ? null : `권한 ${s.permission}`,
      `모델 ${s.model || "기본값"}`,
      `추론 ${s.effort || "기본값"}`,
      s.agentSessionId ? `CLI 세션 ${s.agentSessionId.slice(0, 8)}` : null,
    ].filter(Boolean);
    $("s-meta").textContent = meta.join("  ·  ");
    $("s-meta").title = s.agentSessionId ?? "";
    $("s-diff").disabled = !s.baseCommit;
    $("s-diff").hidden = !!s.chat;
    $("s-export").hidden = !!s.chat;
    $("s-back").hidden = !!s.chat || !!POPUP;
    $("s-popout").hidden = !!POPUP;
    if (POPUP) document.title = `${s.title} · AgentHub`;
    renderFlow();

    renderEvents($("s-events"), s.events);
    scrollToBottom();
  }

  function renderState() {
    const s = data.current;
    if (navigation.view === "chat") return renderChatState();
    const label = $("s-state");
    label.textContent = STATE_LABEL[s.state] ?? s.state;
    label.className = `pill ${s.state}`;
    renderSessionElapsed("s", s);
    const running = s.state === "running";
    $("s-stop").disabled = !running && s.state !== "paused";
    // 도구 호출의 "실행 중" 표시는 턴이 도는 동안에만 보인다.
    $("s-events").classList.toggle("running", running);
    $("s-restart").disabled = running || !s.agentSessionId;
    renderLife("s-life", s);
    renderComposer("s", s);
  }

  // ── 실행 중에 보내기 ────────────────────────────────────────────
  // 실행 중에 보낸 요청은 항상 대기열에 넣고, 끝나면 차례로 보낸다.
  // Claude는 대기열 항목의 "붙이기"로 지금 작업에 끼워 넣을 수 있다(CLI가 다음 도구 실행 사이에 읽는다).
  function composerMode(s) {
    return s?.state === "running" ? "queue" : "send";
  }

  const composerBusy = new Set();
  const imageComposers = Object.fromEntries(["s", "c"].map((prefix) => [prefix, createAttachmentComposer({ prefix, onChange: () => renderComposerAction(prefix, data.current) })]));
  let newChatDraft = 0;
  const pendingChats = new Map();
  const exportResults = new Map();
  const exporting = new Set();

  function renderExportResult(s) {
    const result = exportResults.get(s.id);
    $("s-export-result").hidden = !result;
    $("s-export-result").textContent = result ?? "";
    $("s-export").disabled = exporting.has(s.id);
  }

  $("s-export").addEventListener("click", async () => {
    const s = data.current;
    if (!s || s.chat || exporting.has(s.id)) return;
    exporting.add(s.id);
    exportResults.set(s.id, "기록을 문서로 저장하고 있습니다…");
    renderExportResult(s);
    try {
      const result = await api("POST", "/api/sessions/" + s.id + "/export", {});
      exportResults.set(s.id, "저장됨 · " + result.relativePath);
    } catch (err) {
      exportResults.set(s.id, "내보내기 실패 · " + err.message);
    } finally {
      exporting.delete(s.id);
      if (data.current?.id === s.id) renderExportResult(s);
    }
  });

  function renderComposerAction(prefix, s) {
    const action = composerAction(s, $(prefix + "-prompt").value, imageComposers[prefix].count());
    imageComposers[prefix].setBusy(composerBusy.has(prefix));
    const send = $(prefix + "-send");
    send.disabled = action.disabled || composerBusy.has(prefix);
    send.value = action.action;
    send.dataset.action = action.action;
    send.replaceChildren(el("span", { class: "composer-icon", "aria-hidden": "true" }, action.icon), el("span", {}, action.label));
    send.title = action.title;
    send.setAttribute("aria-label", action.label);
    send.setAttribute("aria-busy", String(composerBusy.has(prefix)));
  }

  function renderComposer(prefix, s) {
    const running = s?.state === "running";
    renderComposerAction(prefix, s);
    $(prefix + "-prompt").placeholder = running
      ? "작업 중 · 입력 후 Enter 대기열에 추가, 입력을 비우면 ⏸ 일시중지"
      : s?.state === "paused"
        ? "일시중지됨 · ▶ 재개 또는 요청을 입력해 이어서 진행"
        : (prefix === "c" ? "메시지를 입력하세요" : "요청을 입력하세요") + " · Enter 보내기, Shift+Enter 줄바꿈";
    renderQueue(prefix, s);
  }

  // 끝나면 보낼 요청 목록. 지금 작업에 붙이거나, 실행 중이 아니면 바로 보내거나, 지울 수 있다.
  function renderQueue(prefix, s) {
    const items = s?.queue ?? [];
    const running = s?.state === "running";
    const act = async (item, action) => {
      try {
        if (action === "delete") await api("DELETE", `/api/sessions/${s.id}/queue/${item.id}`);
        else await api("POST", `/api/sessions/${s.id}/queue/${item.id}`, { action });
      } catch (err) {
        alert(err.message);
      }
      refreshQueue(s.id);
    };
    $(`${prefix}-queue`).hidden = !items.length;
    $(`${prefix}-queue`).replaceChildren(...items.map((item) => el("li", { class: "queue-item" },
      el("span", { class: "queue-tag" }, item.user ? "대기" : `↳ ${item.fromTitle ?? "넘어온 작업"}`),
      el("span", { class: "queue-text", title: item.text }, firstLine(item.text) || (item.attachments?.length ? "첨부 파일 요청" : "")),
      item.attachments?.length ? renderAttachmentLinks(item.attachments) : null,
      running && s.canInject && item.user ? el("button", { type: "button", class: "ghost sm", title: "지금 하는 작업에 이 요청을 붙입니다", onclick: () => act(item, "steer") }, "붙이기") : null,
      running ? null : el("button", { type: "button", class: "ghost sm", onclick: () => act(item, "send") }, "보내기"),
      el("button", { type: "button", class: "ghost sm danger", title: "대기열에서 지우기", onclick: () => act(item, "delete") }, "×"))));
  }

  async function refreshQueue(sessionId) {
    if (data.current?.id !== sessionId) return;
    try {
      const { queue } = await api("GET", `/api/sessions/${sessionId}`);
      if (data.current?.id !== sessionId) return;
      data.current.queue = queue;
    } catch {
      return;
    }
    renderComposer(navigation.view === "chat" ? "c" : "s", data.current);
  }

  // Enter: 보내기(실행 중이면 대기열에 추가), Shift+Enter: 줄바꿈. 한글 조합 중인 키는 무시한다.
  function composerKeys(prefix) {
    $(prefix + "-prompt").addEventListener("input", () => renderComposerAction(prefix, data.current));
    $(prefix + "-prompt").addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // 빈 Enter는 작업을 멈추거나 재개하지 않는다. 제어는 버튼·Esc로만 한다.
        if ((!$(prefix + "-prompt").value.trim() && !imageComposers[prefix].count()) || $(prefix + "-send").disabled) return;
        $(prefix + "-form").requestSubmit($(prefix + "-send"));
      }
    });
  }

  function notifyQuestion(sessionId, event) {
    const seeing = data.current?.id === sessionId && document.hasFocus();
    if (seeing || !("Notification" in window)) return;
    const s = sessionById(sessionId);
    const permission = event.kind === "permission";
    const show = () => {
      const n = new Notification(`${s?.title ?? "세션"}에서 ${permission ? "허용을 기다립니다" : "질문이 왔습니다"}`, {
        body: permission ? event.text : event.questions?.[0]?.question ?? "",
        tag: `q-${event.questionId ?? event.requestId}`,
      });
      n.onclick = () => {
        window.focus();
        selectSession(sessionId);
      };
    };
    if (Notification.permission === "granted") show();
    else if (Notification.permission !== "denied") Notification.requestPermission().then((p) => p === "granted" && show());
  }
  function scrollToBottom() {
    const list = eventsList();
    list.scrollTop = list.scrollHeight;
  }

  $("s-show-log").addEventListener("change", (e) => {
    $("s-events").classList.toggle("show-log", e.target.checked);
  });

  $("s-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("s-prompt");
    const raw = input.value;
    const prompt = raw.trim();
    const s = data.current;
    if (!s || composerBusy.has("s")) return;
    const snapshot = imageComposers.s.snapshot();
    const action = composerAction(s, raw, snapshot.items.length).action;
    if (action === "pause" || action === "resume") return togglePause();
    if (!prompt && !snapshot.items.length) return;
    composerBusy.add("s");
    renderComposerAction("s", s);
    try {
      const attachments = await uploadAttachments(api, s.id, snapshot.items);
      const result = await api("POST", "/api/sessions/" + s.id + "/messages", { prompt, attachments, mode: composerMode(s) });
      imageComposers.s.commit(snapshot);
      if (result.queued) refreshQueue(s.id);
    } catch (err) {
      alert(err.message);
    } finally {
      composerBusy.delete("s");
      if (navigation.view === "session") renderComposer("s", data.current);
    }
  });
  composerKeys("s");

  $("s-crumb-project").addEventListener("click", (e) => {
    e.preventDefault();
    if (!data.current || POPUP) return; // 별도 창에는 프로젝트·대시보드 화면이 없다.
    if (data.current.chat) goDashboard();
    else goProject(data.current.projectPath);
  });
  $("s-back").addEventListener("click", () => data.current && goProject(data.current.projectPath));
  $("s-popout").addEventListener("click", () => data.current && openSessionWindow(data.current.id));

  $("s-role").addEventListener("click", () => {
    $("role-text").value = data.current?.role ?? "";
    $("role-error").textContent = "";
    $("role-dialog").showModal();
    $("role-text").focus();
  });

  $("role-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    try {
      const updated = await api("PUT", `/api/sessions/${data.current.id}`, { role: $("role-text").value });
      data.current.role = updated.role;
      $("role-dialog").close();
      renderFlow();
    } catch (err) {
      $("role-error").textContent = err.message;
    }
  });

  $("s-stop").addEventListener("click", () => api("POST", `/api/sessions/${data.current.id}/stop`).catch((e) => alert(e.message)));

  // 일시중지·재개. 일시중지는 대화를 그대로 두고 멈추며, 재개하면 멈춘 곳부터 이어서 진행한다.
  async function togglePause() {
    const s = data.current;
    const prefix = navigation.view === "chat" ? "c" : "s";
    if (!s || composerBusy.has(prefix)) return;
    composerBusy.add(prefix);
    renderComposerAction(prefix, s);
    try {
      const before = s.state;
      const action = before === "paused" ? "resume" : "pause";
      const updated = await api("POST", "/api/sessions/" + s.id + "/" + action);
      // 실시간 이벤트가 먼저 도착했다면 오래된 응답으로 상태를 되돌리지 않는다.
      if (s.state === before) {
        delete s.paused;
        delete s.pausedMidTurn;
        Object.assign(s, updated);
      }
      if (action === "resume" && data.current?.id === s.id) {
        delete data.current.paused;
        delete data.current.pausedMidTurn;
      }
    } catch (err) {
      alert(err.message);
    } finally {
      composerBusy.delete(prefix);
      if (data.current?.id === s.id) renderState();
    }
  }

  // CLI 대화만 새로 시작한다. 화면이 새로 그려지는 것은 서버가 보내는 session 이벤트로 한다.
  // s: 다시 시작할 세션(흐름 그래프 카드에서 누르면 그 카드의 세션, 아니면 보고 있는 세션)
  async function restartSession(s = data.current) {
    if (!s) return;
    const kept = s.chat ? "화면의 기록은 남지만" : "AgentHub 기록·역할·연결은 그대로 남지만";
    if (!confirm(`"${s.title}"을(를) 다시 시작할까요?\n\nCLI 대화를 새로 시작해 컨텍스트를 비웁니다. ${kept}, AI는 이전 대화 내용을 기억하지 못합니다.`)) return;
    try {
      await api("POST", `/api/sessions/${s.id}/restart`);
    } catch (err) {
      alert(err.message);
    }
  }
  $("s-restart").addEventListener("click", () => restartSession());

  $("s-delete").addEventListener("click", async () => {
    const s = data.current;
    const options = askDeleteOptions(s);
    if (!options || !(await deleteSession(s, options))) return;
    if (POPUP) return window.close(); // 별도 창은 보여 줄 세션이 없어졌으니 닫는다.
    await loadSessions();
    if (s.projectPath) await goProject(s.projectPath);
    else goDashboard();
  });

  // ── 세션 우클릭 메뉴 ────────────────────────────────────────────
  // 흐름 그래프 카드와 사이드바 세션 목록에서 쓴다.

  function openSessionMenu(e, s) {
    e.preventDefault();
    closeContextMenu();
    const running = s.state === "running";
    const item = (label, action, { danger = false, disabled = false, title = "" } = {}) => el("button", {
      type: "button",
      class: `menu-item${danger ? " danger" : ""}`,
      title,
      ...(disabled ? { disabled: "" } : {}),
      onclick: () => {
        closeContextMenu();
        action();
      },
    }, label);
    const menu = el("div", { class: "context-menu", role: "menu" },
      el("div", { class: "menu-title" }, s.title),
      item("열기", () => selectSession(s.id)),
      item("새 창으로 열기", () => openSessionWindow(s.id)),
      item("다시 시작", () => restartSession(s), {
        disabled: running, title: "CLI 대화만 새로 시작해 컨텍스트를 비웁니다. 화면 기록·역할·연결은 그대로 둡니다.",
      }),
      item("재생성", () => recreateSession(s), {
        disabled: running, title: "같은 설정(역할·모델·권한·연결)으로 새 세션을 만들고 지금 세션은 지웁니다. 화면 기록도 비워집니다.",
      }),
      s.chat ? null : item("스킬 장착…", () => openEquipDialog(s)),
      el("hr"),
      item("삭제", () => confirmDeleteSession(s), { danger: true }));
    document.body.append(menu);
    // 화면 밖으로 나가지 않게 놓는다.
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(e.clientX, innerWidth - width - 8)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - height - 8)}px`;
  }

  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".context-menu")) closeContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const hadMenu = !!document.querySelector(".context-menu");
    closeContextMenu();
    // Claude Code·Codex처럼 Esc로 실행 중인 세션을 일시중지한다(대화상자·메뉴가 열려 있으면 그것만 닫는다).
    if (hadMenu || e.defaultPrevented || document.querySelector("dialog[open]")) return;
    if (["session", "chat"].includes(navigation.view) && data.current?.state === "running") {
      e.preventDefault();
      togglePause();
    }
    // 프로젝트 화면에서는 그래프 선택을 푼다.
    if (navigation.view === "project") clearSelection();
  });
  window.addEventListener("blur", closeContextMenu);
  window.addEventListener("resize", closeContextMenu);

  async function recreateSession(s) {
    const folder = s.worktree ? `\n작업 폴더(${s.cwd})는 그대로 이어받습니다.` : "";
    if (!confirm(`"${s.title}"을(를) 재생성할까요?\n\n같은 역할·모델·권한·연결로 새 세션을 만들고 지금 세션은 지웁니다. 화면 기록과 CLI 대화는 새로 시작합니다.${folder}`)) return;
    try {
      const created = await api("POST", `/api/sessions/${s.id}/recreate`);
      await Promise.all([loadSessions(), loadLinks()]);
      if (data.current?.id === s.id) await selectSession(created.id);
    } catch (err) {
      alert(err.message);
    }
  }

  // 확인을 받고 지운다. 보고 있던 세션이면 프로젝트(또는 채팅·대시보드) 화면으로 돌아간다.
  async function confirmDeleteSession(s) {
    const options = askDeleteOptions(s);
    if (!options || !(await deleteSession(s, options))) return;
    await loadSessions();
    if (data.current?.id !== s.id) return;
    if (s.chat) openChat();
    else if (s.projectPath) await goProject(s.projectPath);
    else goDashboard();
  }

  // 삭제 확인과 함께 작업 폴더·CLI 기록 파일을 어떻게 할지 묻는다. 취소하면 null.
  // CLI 기록은 지우지 않아도 프로젝트 화면 목록에서 숨겨지므로 "가져오기"로 다시 뜨지 않는다.
  function askDeleteOptions(s) {
    if (!confirm(`"${s.title}" ${s.chat ? "채팅" : "세션"}을 삭제할까요?`)) return null;
    let removeWorktree = false;
    if (s.worktree) {
      removeWorktree = confirm(
        `작업 폴더도 지울까요?\n${s.cwd}\n\n커밋하지 않은 변경이 있으면 지우지 않고 중단합니다. 브랜치 ${s.worktree.branch}는 남습니다.`);
    }
    let deleteRecords = false;
    if (!s.chat && (s.agentSessionId || s.cliSessionIds?.length)) {
      const origin = s.imported ? "\n이 세션은 Claude Code·Codex에서 가져온 것이라, 지우면 그쪽에서도 대화를 이어 갈 수 없습니다." : "";
      deleteRecords = confirm(
        `Claude Code·Codex에 남은 대화 기록 파일도 지울까요?${origin}\n\n확인: 기록 파일까지 지웁니다(되돌릴 수 없음).\n취소: 파일은 남기고 프로젝트 화면의 기록 목록에서만 숨깁니다.`);
    }
    return { removeWorktree, deleteRecords };
  }

  // 세션을 지운다. 실행 중으로 멈춰 있거나 작업 폴더를 못 지우면 그 자리에서 어떻게 할지 묻는다. 지웠으면 true.
  async function deleteSession(s, { removeWorktree = false, deleteRecords = false, force = false } = {}) {
    const query = new URLSearchParams();
    if (removeWorktree) query.set("removeWorktree", "1");
    if (deleteRecords) query.set("records", "delete");
    if (force) query.set("force", "1");
    try {
      const { records } = await api("DELETE", `/api/sessions/${s.id}?${query}`);
      if (records?.errors.length) alert(`세션은 지웠지만 일부 기록 파일을 지우지 못했습니다(목록에서는 숨겼습니다).\n\n${records.errors.join("\n")}`);
      return true;
    } catch (err) {
      if (err.reason === "running" && confirm("실행 중인 세션입니다. 실행을 멈추고 삭제할까요?")) {
        return deleteSession(s, { removeWorktree, deleteRecords, force: true });
      }
      if (err.reason === "worktree" && confirm(`${err.message}\n\n작업 폴더는 남겨 두고 세션만 삭제할까요?`)) {
        return deleteSession(s, { deleteRecords, force });
      }
      if (!["running", "worktree"].includes(err.reason)) alert(err.message);
      return false;
    }
  }

  // ── 변경 보기 ───────────────────────────────────────────────────

  $("s-diff").addEventListener("click", async () => {
    try {
      const s = data.current;
      const diffData = await api("GET", `/api/sessions/${s.id}/diff`);
      $("diff-base").textContent = `기준 커밋 ${s.baseCommit.slice(0, 8)}${s.worktree ? "" : " · 원본 폴더라 기존 수정도 함께 보입니다"}`;
      $("diff-status").textContent = diffData.status || "변경된 파일 없음";
      $("diff-body").replaceChildren(...renderDiff(diffData.diff || "(커밋된 파일의 변경 없음)"));
      $("diff-dialog").showModal();
    } catch (err) {
      alert(err.message);
    }
  });

  // ── 세션 설정 ───────────────────────────────────────────────────
  $("s-config").addEventListener("click", async () => {
    const s = data.current;
    if (!s) return;
    await loadStatus();
    $("config-title").value = s.title;
    $("config-agent").replaceChildren(...Object.keys(data.status.agents).map((a) => el("option", { value: a }, AGENT_LABEL[a] ?? a)));
    $("config-agent").value = s.agent;
    $("config-carry").checked = true;
    $("config-model").value = s.model ?? "";
    fillConfigAgent(s.agent, s.effort ?? "", s.permission);
    $("config-permission-row").hidden = !!s.chat;
    $("config-error").textContent = "";
    $("config-dialog").showModal();
  });

  // 고른 AI에 맞춰 모델 후보·추론 강도·권한 목록을 채운다. AI를 바꾸면 이어받기 선택을 보인다.
  // 권한은 비슷한 것으로 옮긴다(읽기만 ↔ 읽기만, 수정 허용 ↔ 수정 허용). 서버의 handover.mjs와 같다.
  const PERMISSION_MAP = {
    claude: { "read-only": "plan", "workspace-write": "acceptEdits" },
    codex: { default: "read-only", plan: "read-only", acceptEdits: "workspace-write", bypassPermissions: "workspace-write" },
  };

  function fillConfigAgent(agent, effort = $("config-effort").value, permission = $("config-permission").value) {
    const s = data.current;
    const switching = agent !== s.agent;
    $("config-switch").hidden = !switching;
    fillModels("config-models", agent);
    fillEfforts("config-effort", agent, $("config-model").value.trim(), effort);
    const modes = data.status.agents[agent].permissions;
    $("config-permission").replaceChildren(...modes.map((m) => el("option", { value: m }, m)));
    const mapped = modes.includes(permission) ? permission : PERMISSION_MAP[agent]?.[permission];
    $("config-permission").value = mapped && modes.includes(mapped) ? mapped : modes.at(-1);
  }

  $("config-agent").addEventListener("change", () => {
    const s = data.current;
    if (!s) return;
    const agent = $("config-agent").value;
    // 모델 이름은 AI마다 다르므로 바꾸면 비우고(CLI 기본값), 돌아오면 원래 값을 되살린다.
    $("config-model").value = agent === s.agent ? s.model ?? "" : "";
    fillConfigAgent(agent, agent === s.agent ? s.effort ?? "" : "", agent === s.agent ? s.permission : $("config-permission").value);
  });

  $("config-model").addEventListener("input", () => {
    if (data.current) fillEfforts("config-effort", $("config-agent").value, $("config-model").value.trim());
  });

  $("config-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const s = data.current;
    const body = { title: $("config-title").value, model: $("config-model").value.trim(), effort: $("config-effort").value };
    if (!s.chat) body.permission = $("config-permission").value;
    const agent = $("config-agent").value;
    if (agent !== s.agent) Object.assign(body, { agent, carry: $("config-carry").checked });
    try {
      const updated = await api("PUT", `/api/sessions/${s.id}`, body);
      $("config-dialog").close();
      // AI를 바꾸면 기록에 상태 줄이 붙고 CLI 대화 ID도 바뀌므로 세션을 통째로 다시 받는다.
      if (updated.agent !== s.agent) await selectSession(s.id);
      else {
        Object.assign(data.current, { title: updated.title, model: updated.model, effort: updated.effort, permission: updated.permission });
        renderSession();
      }
      loadSessions();
    } catch (err) {
      $("config-error").textContent = err.message;
    }
  });

  // ── 일반 채팅 화면 ──────────────────────────────────────────────
  // 새 채팅은 첫 메시지를 보낼 때 세션을 만든다. 그 전까지 고른 AI·모델·추론 강도는 초안에 두고, 다음 새 채팅에도 쓴다.
  const CHAT_PREFS_KEY = "agenthub.chat";

  function loadChatPrefs() {
    const prefs = { agent: "claude", model: "", effort: "" };
    try {
      Object.assign(prefs, JSON.parse(localStorage.getItem(CHAT_PREFS_KEY) ?? "{}"));
    } catch {
      // 저장소를 못 쓰면 기본값
    }
    if (!data.status.agents[prefs.agent]) prefs.agent = "claude";
    return prefs;
  }

  function saveChatPrefs({ agent, model, effort }) {
    try {
      localStorage.setItem(CHAT_PREFS_KEY, JSON.stringify({ agent, model, effort }));
    } catch {
      // 저장하지 못해도 이번 채팅에는 지장 없다.
    }
  }

  function openChat() {
    data.current = null;
    navigation.project = null;
    ui.chatDraft = loadChatPrefs();
    newChatDraft++;
    show("chat");
    renderChat();
    $("c-prompt").focus();
  }

  // 지금 채팅의 설정: 세션이 있으면 세션 값, 없으면 새 채팅 초안
  const chatConfig = () => data.current ?? ui.chatDraft;

  function renderChat() {
    const s = data.current;
    imageComposers.c.activate(s?.id ?? "new-chat-" + newChatDraft);
    $("c-title").textContent = s?.title ?? "새 채팅";
    $("c-title").disabled = !s;
    $("c-delete").hidden = !s;
    $("c-popout").hidden = !!POPUP;
    $("c-empty").hidden = !!s?.events.length;
    renderEvents($("c-events"), s?.events ?? []);
    if (POPUP) document.title = `${s?.title ?? "새 채팅"} · AgentHub`;
    renderChatPick();
    renderChatState();
    scrollToBottom();
  }

  // AI·모델·추론 강도 선택. 대화는 CLI별로 이어지므로 시작한 뒤에는 AI만 바꿀 수 없다.
  function renderChatPick() {
    const cfg = chatConfig();
    const started = !!data.current;
    $("c-agent").value = cfg.agent;
    $("c-agent").disabled = started;
    $("c-agent").title = started ? "대화를 시작한 뒤에는 AI를 바꿀 수 없습니다. 새 채팅에서 고르세요." : "AI";
    const models = data.status.agents[cfg.agent].models;
    const options = [el("option", { value: "" }, "기본 모델"), ...models.map((m) => el("option", { value: m.id }, m.label))];
    // 목록에 없는 모델(직접 넣은 ID)도 고른 값으로 보여 준다.
    if (cfg.model && !models.some((m) => m.id === cfg.model)) options.push(el("option", { value: cfg.model }, cfg.model));
    $("c-model").replaceChildren(...options);
    $("c-model").value = cfg.model ?? "";
    fillEfforts("c-effort", cfg.agent, cfg.model ?? "", cfg.effort ?? "");
  }

  function renderChatState() {
    const s = data.current;
    const running = s?.state === "running";
    $("c-state").hidden = !s || s.state === "idle";
    if (s) {
      $("c-state").textContent = STATE_LABEL[s.state] ?? s.state;
      $("c-state").className = `pill ${s.state}`;
    }
    renderSessionElapsed("c", s);
    $("c-life").hidden = !s;
    if (s) renderLife("c-life", s);
    $("c-restart").hidden = !s?.agentSessionId;
    $("c-restart").disabled = running;
    renderComposer("c", s);
    $("c-events").classList.toggle("running", running);
    if (running) $("c-empty").hidden = true;
  }

  // 새 채팅이면 초안만 바꾸고, 진행 중인 채팅이면 다음 메시지부터 적용되도록 저장한다.
  async function changeChat(patch) {
    const s = data.current;
    if (!s) {
      Object.assign(ui.chatDraft, patch);
      saveChatPrefs(ui.chatDraft);
      renderChatPick();
      return;
    }
    try {
      const updated = await api("PUT", `/api/sessions/${s.id}`, patch);
      Object.assign(s, { model: updated.model, effort: updated.effort });
      saveChatPrefs(s);
    } catch (err) {
      alert(err.message);
    }
    renderChatPick();
    loadSessions();
  }

  $("c-agent").addEventListener("change", () => changeChat({ agent: $("c-agent").value, model: "", effort: "" }));
  $("c-model").addEventListener("change", () => {
    const cfg = chatConfig();
    const model = $("c-model").value;
    // 바꾼 모델이 지금 추론 강도를 지원하지 않으면 기본값으로 돌린다.
    const known = data.status.agents[cfg.agent].models.find((m) => m.id === model);
    const effort = known?.efforts.length && !known.efforts.includes(cfg.effort) ? "" : cfg.effort;
    changeChat({ model, effort });
  });
  $("c-effort").addEventListener("change", () => changeChat({ effort: $("c-effort").value }));

  const chatTitle = (text) => {
    const line = firstLine(text).trim();
    return line.length > 40 ? `${line.slice(0, 40)}…` : line;
  };

  $("c-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (composerBusy.has("c")) return;
    const input = $("c-prompt");
    const raw = input.value;
    const prompt = raw.trim();
    const current = data.current;
    const viewRevision = navigation.viewRevision;
    const snapshot = imageComposers.c.snapshot();
    const action = composerAction(current, raw, snapshot.items.length).action;
    if (action === "pause" || action === "resume") return togglePause();
    if (!prompt && !snapshot.items.length) return;
    composerBusy.add("c");
    renderComposerAction("c", current);
    try {
      let s = current ?? pendingChats.get(snapshot.key);
      if (!s) {
        const { agent, model, effort } = ui.chatDraft;
        s = await api("POST", "/api/sessions", { chat: true, agent, model, effort, title: chatTitle(prompt || snapshot.items[0]?.file.name || "이미지 채팅") });
        pendingChats.set(snapshot.key, s);
      }
      const attachments = await uploadAttachments(api, s.id, snapshot.items);
      const result = await api("POST", "/api/sessions/" + s.id + "/messages", { prompt, attachments, mode: composerMode(current) });
      const stillCurrent = current ? data.current?.id === current.id
        : !data.current && navigation.view === "chat" && navigation.viewRevision === viewRevision;
      imageComposers.c.commit(snapshot);
      pendingChats.delete(snapshot.key);
      if (result.queued) refreshQueue(s.id);
      if (!current && stillCurrent) {
        await loadSessions();
        if (!data.current && navigation.view === "chat" && navigation.viewRevision === viewRevision) await selectSession(s.id);
      }
    } catch (err) {
      alert(err.message);
    } finally {
      composerBusy.delete("c");
      if (navigation.view === "chat") renderChatState();
    }
  });

  composerKeys("c");

  $("c-title").addEventListener("click", async () => {
    const s = data.current;
    if (!s) return;
    const title = prompt("채팅 이름", s.title);
    if (title === null || !title.trim()) return;
    try {
      s.title = (await api("PUT", `/api/sessions/${s.id}`, { title })).title;
      renderChat();
      loadSessions();
    } catch (err) {
      alert(err.message);
    }
  });

  $("c-new").addEventListener("click", () => openChat());
  $("c-restart").addEventListener("click", () => restartSession());

  $("c-delete").addEventListener("click", async () => {
    const s = data.current;
    if (!s || !confirm(`"${s.title}" 채팅을 삭제할까요?`)) return;
    if (!(await deleteSession(s))) return;
    await loadSessions();
    openChat();
  });

  $("c-popout").addEventListener("click", () => openWindow(`chat=${data.current?.id ?? "new"}`));

  return { renderFlow, renderSession, renderState, renderChat, openChat, restartSession, openSessionMenu, refreshQueue, notifyQuestion, appendEvent, scrollToBottom };
}
