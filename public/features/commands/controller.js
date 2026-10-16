import { $, el, timeAgo } from "../../shared/dom.js";
import { elapsedElement } from "../../shared/elapsed.js";
import { samePath, firstLine } from "../../shared/store.js";
import { renderMarkdown } from "../../markdown.js";
import { createFlowNodeForms, FLOW_KINDS, KIND_LABEL, kindOf, hasBranchPorts, KIND_HINT as FLOW_HINT } from "./flow-nodes.js";
import { commandBody } from "../graph/history.js";

export function createCommandsController({ api, loadLinks, renderGraph, connectCreatedGraphNode, commandById, data, navigation, history, nodeSnapshot, recordNodesRemoved }) {
  const ui = {
    "editingCommand": null,
    "viewingOutput": null
  };
  const pendingRuns = new Set();
  const flowForms = createFlowNodeForms();
  // ── 명령 노드 ───────────────────────────────────────────────────
  const COMMAND_STATE = { idle: "대기", running: "실행 중", watching: "감시 중", success: "성공", error: "실패" };
  const KIND_HINT = {
    ...FLOW_HINT,
    git: "기존 로컬 브랜치의 작업 폴더를 준비하거나, 소스 브랜치의 커밋을 대상 브랜치에 병합합니다. 실제 Git 상태에 따라 성공·실패 연결로 넘깁니다. 병합 충돌은 취소 후 실패로 넘깁니다.",
    command: "연결로 넘어오면 실행합니다. 종료 코드 0이면 '성공 시', 아니면 '실패 시' 연결로 넘어가고, 받는 세션에는 출력 마지막 부분이 함께 갑니다. 실행 전에 확인하려면 들어오는 연결에 '넘기기 전에 승인 받기'를 켜세요.",
    button: "실행 버튼을 누르면 연결된 세션에 아래 프롬프트를 보내 실행합니다. 오른쪽 손잡이를 세션에 연결하세요. 연결에 승인을 설정했다면 승인 후 실행합니다.",
    markdown: "연결된 세션이 완료되면 마지막 답변 원문을 AI 처리 없이 .md 파일로 저장합니다. 선택한 폴더의 docs/agenthub/outputs에 완료할 때마다 새 파일을 만들며, 결과 보기에서 최근 파일을 확인할 수 있습니다.",
    group: "AI 세션·명령·GIT·입력 폼·반복 제어·결과 가공의 결과를 함께 모읍니다. 묶음으로 들어온 요청을 모든 멤버에 보내고, 이번 실행의 멤버 결과가 모두 끝나면 다음 노드로 넘깁니다. 하나라도 실패하면 실패 출력으로 넘깁니다. 이전 실행의 결과는 섞지 않습니다.",
  };
  // 결과 모으기의 진행 상황은 묶은 세션의 지금 상태로 정한다(서버도 같은 기준으로 넘긴다).
  const groupMembers = (c) => (c.members ?? []).map((id) => [...data.sessions, ...(data.commands ?? [])].find((s) => s.id === id)).filter(Boolean);
  const memberBusy = (s) => s.state === "running" || s.state === "paused" || !!s.waiting || !!s.queued || (s.queue?.length ?? 0) > 0;
  function groupProgress(c) {
    const members = groupMembers(c);
    const busy = members.filter(memberBusy);
    return { members, busy, ready: members.length > 0 && !busy.length };
  }
  const shellLabel = (id) => (data.shells ?? []).find((s) => s.id === id)?.label ?? id;
  const seconds = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}초`;

  async function loadCommands(projectPath = navigation.project) {
    if (!projectPath) return;
    try {
      const { shells, commands } = await api("GET", `/api/commands?path=${encodeURIComponent(projectPath)}`);
      if (!samePath(projectPath, navigation.project)) return;
      data.shells = shells;
      data.commands = commands;
      data.commandsProject = projectPath;
    } catch {
      return;
    }
    if (navigation.view === "project") renderGraph();
    if ($("command-dialog").open) renderCommandRun();
  }

  function commandNodeFoot(c) {
    const running = c.state === "running" || c.state === "watching";
    const run = c.lastRun;
    if (kindOf(c) === "watch") return running ? `감시 중 · ${(c.watchPaths ?? []).length}개 경로${c.live?.tail ? ` · ${firstLine(c.live.tail)}` : ""}` : run ? `${run.ok ? "변경 전달 완료" : "감시 중지 또는 오류"} · ${timeAgo(run.startedAt)}` : "▶를 눌러 감시 시작";
    if (kindOf(c) === "webhook-in") return c.enabled === false ? "꺼짐 · 요청을 받지 않습니다" : run ? `${run.ok ? run.method === "TEST" ? "시험 실행함" : "요청 받음" : "요청 처리 실패"} · ${timeAgo(run.startedAt)}` : "POST 요청을 기다립니다";
    if (kindOf(c) === "webhook") return running ? "보내는 중" : run ? `${run.ok ? "보냄" : "보내기 실패"}${run.httpStatus ? ` · HTTP ${run.httpStatus}` : ""} · ${timeAgo(run.startedAt)}` : "앞 노드의 결과를 보냅니다";
    if (kindOf(c) === "notify") return running ? "알림 보내는 중" : run ? `${run.ok ? "알림 보냄" : "알림 실패"} · ${timeAgo(run.startedAt)}` : "앞 노드의 결과를 알립니다";
    if (FLOW_KINDS.includes(kindOf(c))) return running ? "실행 중" : run ? `${run.ok ? "성공" : "실패"}${kindOf(c) === "repeat" && run.iteration ? ` · ${run.iteration}/${c.maxIterations}회` : ""} · ${timeAgo(run.startedAt)}` : kindOf(c) === "input" ? `입력 항목 ${(c.fields ?? []).length}개 · 입력하고 실행` : kindOf(c) === "repeat" ? `최대 ${c.maxIterations}회 실행` : "연결된 결과를 가공합니다";
    if (kindOf(c) === "git") return running ? "Git 작업 실행 중" : run ? `${run.ok ? "성공" : "실패"}${run.gitResult?.recoveryRequired ? " · 복구 필요" : ""}${run.deliveryErrors?.length ? ` · 후속 실행 실패 ${run.deliveryErrors.length}개` : ""} · ${timeAgo(run.startedAt)}` : "아직 실행하지 않음";
    if (kindOf(c) === "group") {
      const { members, busy } = groupProgress(c);
      if (!members.length) return "모을 노드 없음";
      if (busy.length) return `진행 중 ${busy.length}/${members.length} · 모두 끝나면 넘김`;
      return run ? `모두 끝남 · ${run.ok ? "넘김" : "실패로 넘김"} · ${timeAgo(run.startedAt)}` : "모두 끝남 · 넘길 수 있음";
    }
    if (kindOf(c) === "markdown") return running ? "메시지 저장 중" : run?.output ? `저장됨 · ${timeAgo(run.startedAt)}` : run?.error || "세션 완료 기다리는 중";
    if (kindOf(c) === "button") return running ? "연결된 세션에 보내는 중" : run ? `${run.ok ? "전달 완료" : "전달 실패"} · ${timeAgo(run.startedAt)}` : "눌러서 연결된 세션 실행";
    return running ? `실행 중 · ${firstLine(c.live?.tail?.split(/\r?\n/).at(-1) ?? "") || "출력 기다리는 중"}`
      : run ? `종료 ${run.exitCode}${run.timedOut ? " (시간 초과)" : ""} · ${seconds(run.durationMs)} · ${timeAgo(run.startedAt)}` : "아직 실행하지 않음";
  }

  // 결과 모으기 카드: 묶은 세션과 그 상태를 보여 주고, 모두 끝났을 때만 직접 넘길 수 있다.
  function groupNode(c) {
    const { members, busy, ready } = groupProgress(c);
    const state = busy.length ? "running" : c.state === "running" ? "idle" : c.state;
    const action = el("button", {
      type: "button", class: "gcmd-btn",
      title: ready ? "모은 노드의 결과를 지금 다음 노드로 넘깁니다" : "진행 중인 노드가 있어 아직 넘길 수 없습니다",
      "aria-label": `${c.title} 지금 넘기기`,
      onclick: () => runCommand(c),
    }, "넘기기");
    action.disabled = !ready || pendingRuns.has(c.id);
    return el("div", { class: `gcmd gcmd-group ${state}`, "data-id": c.id, "data-kind": "group", title: `${c.title}\n${members.map((s) => s.title).join(", ")}\n\n두 번 누르면 편집합니다. ● 손잡이를 끌어 다음 노드에 잇습니다.` },
      el("div", { class: "gcard-top" },
        el("span", { class: "pill cmd group" }, "결과 모으기"),
        el("span", { class: "gcmd-shell" }, `노드 ${members.length}개`),
        el("span", { class: `pill cmd-${state}` }, busy.length ? "진행 중" : COMMAND_STATE[state] ?? state)),
      el("div", { class: "gcard-title" }, c.title),
      el("div", { class: "group-chips" }, ...members.map((s) => el("span", { class: `group-chip ${s.state}${memberBusy(s) ? " busy" : ""}`, title: `${s.title} · ${s.state}` }, s.title))),
      el("div", { class: "gcmd-foot" },
        el("span", { class: "gcmd-result" }, el("span", { class: "gcmd-result-text" }, commandNodeFoot(c))),
        action),
      el("span", { class: "gcard-handle", title: "끌어서 다음 세션이나 노드에 연결" }));
  }

  function commandNode(c) {
    if (kindOf(c) === "group") return groupNode(c);
    const running = ["running", "watching"].includes(c.state);
    const kind = kindOf(c);
    const output = c.lastRun?.output;
    const detail = kind === "git" ? c.gitAction === "merge" ? c.branch + " → " + c.targetBranch : c.branch + " · 작업 폴더 사용" : kind === "button" ? c.prompt : kind === "markdown" ? output?.relativePath ?? "완료 메시지 → .md 파일" : kind === "input" ? (c.fields ?? []).map((field) => field.label).join(" · ") : kind === "repeat" ? "최대 " + c.maxIterations + "회 · 실패하면 다시 실행" : kind === "transform" ? ({ json: "JSON", lines: "줄 선택", template: "템플릿" }[c.transformMode] ?? "JSON") + " · " + (c.expression || c.template || "전체 결과") : kind === "watch" ? (c.watchPaths ?? []).join(" · ") : kind === "notify" ? c.message : kind === "webhook" ? `${c.method} ${c.url}` : kind === "webhook-in" ? "POST /hooks/…" : c.command;
    const stoppable = ["command", "git", "watch", "repeat", "webhook"].includes(kind);
    const actionLabel = kind === "markdown" ? "결과 보기" : running && stoppable ? kind === "watch" ? "감시 중지" : "중지" : kind === "input" ? "입력하고 실행" : kind === "watch" ? "감시 시작" : kind === "webhook-in" ? "시험 실행" : kind === "button" ? running ? "전달 중" : "실행" : "지금 실행";
    const action = el("button", { type: "button", class: "gcmd-btn" + (running && stoppable ? " stop" : ""), title: kind === "markdown" && !output ? "결과를 받으면 볼 수 있습니다" : actionLabel, "aria-label": c.title + " " + actionLabel, onclick: () => kind === "markdown" ? openCommandOutput(c) : running && stoppable ? stopCommand(c) : runCommand(c) }, ["command", "watch"].includes(kind) ? running ? "■" : "▶" : actionLabel);
    action.disabled = kind === "markdown" ? !output : pendingRuns.has(c.id) || (running && !stoppable);
    const branchPorts = hasBranchPorts(c);
    return el("div", { class: "gcmd gcmd-" + kind + " " + c.state, "data-id": c.id, "data-kind": kind, title: c.title + "\n" + (detail ?? "") + "\n\n두 번 누르면 편집합니다. 손잡이를 끌어 다음 노드에 연결합니다." },
      el("div", { class: "gcard-top" }, el("span", { class: "pill cmd " + kind }, KIND_LABEL[kind]), el("span", { class: "gcmd-shell" }, kind === "command" ? shellLabel(c.shell) : kind === "git" ? c.gitAction === "merge" ? "브랜치 병합" : "브랜치 사용" : kind === "button" ? "수동 실행" : kind === "markdown" ? "원문 저장" : kind === "watch" ? "변경 감지" : kind === "input" ? "실행 시작" : kind === "webhook" ? c.method : kind === "webhook-in" ? "외부 요청" : ""), el("span", { class: "pill cmd-" + c.state }, COMMAND_STATE[c.state] ?? c.state)),
      el("div", { class: "gcard-title" }, c.title),
      el("div", { class: "gcmd-code" + (["command", "git", "transform", "watch", "webhook", "webhook-in"].includes(kind) ? " mono" : ""), title: detail ?? "" }, firstLine(detail ?? "")),
      el("div", { class: "gcmd-foot" }, el("span", { class: "gcmd-result" }, elapsedElement("command", c), el("span", { class: "gcmd-result-text" }, commandNodeFoot(c))), action),
      ...(branchPorts ? ["success", "error"].map((when) => el("span", { class: "gcard-handle git-port " + when, "data-when": when, title: (kind === "repeat" ? when === "success" ? "반복할 작업" : "횟수 초과" : when === "success" ? "성공" : "실패") + " · 끌어서 다음 노드에 연결", "aria-label": (when === "success" ? "성공" : "실패") + " 출력" }, el("span", { class: "git-port-label" }, kind === "repeat" ? when === "success" ? "반복" : "초과" : when === "success" ? "성공" : "실패"))) : [kind === "markdown" ? null : el("span", { class: "gcard-handle", title: "끌어서 다음 노드에 연결" })]));
  }

  async function runCommand(c) {
    if (kindOf(c) === "watch" && c.state === "watching") return stopCommand(c);
    if (kindOf(c) === "markdown") return openCommandOutput(c);
    if (pendingRuns.has(c.id) || (["button", "git"].includes(kindOf(c)) && c.state === "running")) return;
    if (kindOf(c) === "group" && !groupProgress(c).ready) return alert("묶은 세션 중 진행 중인 노드가 있어 아직 넘길 수 없습니다.");
    const values = kindOf(c) === "input" ? await flowForms.collect(c) : undefined;
    if (kindOf(c) === "input" && values === null) return;
    pendingRuns.add(c.id);
    if (navigation.view === "project") renderGraph();
    renderCommandRun();
    try {
      await api("POST", `/api/commands/${c.id}/run`, values === undefined ? undefined : { values });
    } catch (err) {
      alert(err.message);
    } finally {
      pendingRuns.delete(c.id);
      await Promise.all([loadCommands(), ...(["button", "group"].includes(kindOf(c)) ? [loadLinks()] : [])]);
      renderCommandRun();
    }
  }

  async function stopCommand(c) {
    await api("POST", `/api/commands/${c.id}/stop`).catch((err) => alert(err.message));
    loadCommands();
  }

  async function removeCommand(c) {
    if (!c || !confirm(`${KIND_LABEL[kindOf(c)]} 노드 "${c.title}"을(를) 삭제할까요? 이 노드에 이어진 연결도 지웁니다.`)) return;
    const snapshot = nodeSnapshot?.(c);
    try {
      await api("DELETE", `/api/commands/${c.id}`);
      if (snapshot) recordNodesRemoved(c.projectPath, [snapshot]);
    } catch (err) {
      alert(err.message);
    }
    await Promise.all([loadCommands(), loadLinks()]);
  }

  // 같은 프로젝트의 실행 가능한 노드를 모은다.
  function renderGroupMembers(selected) {
    const nodes = [...data.sessions.filter((s) => !s.chat && samePath(s.projectPath, navigation.project)), ...(data.commands ?? []).filter((c) => !["button", "markdown", "watch", "webhook-in", "group"].includes(kindOf(c)) && samePath(c.projectPath, navigation.project))];
    $("group-members").replaceChildren(...(nodes.length ? nodes.map((node) => el("li", {}, el("label", { class: "check" }, el("input", { type: "checkbox", value: node.id, ...(selected.has(node.id) ? { checked: "" } : {}) }), " " + node.title, el("span", { class: "muted" }, " · " + (node.agent ?? KIND_LABEL[kindOf(node)]))))) : [el("li", { class: "muted" }, "이 프로젝트에 모을 수 있는 노드가 없습니다.")]));
  }

  // cmd가 없으면 새로 만든다. pos는 새 노드를 놓을 자리. members: 새 결과 모으기에 미리 고를 세션
  function openCommandDialog(cmd, pos = null, connectFrom = null, kind = "command", { members = [], connectWhen = null, connectKeyword = "" } = {}) {
    if (ui.editingCommand) ui.editingCommand.cancelled = true;
    kind = kindOf(cmd ?? { kind });
    ui.editingCommand = { id: cmd?.id ?? null, kind, pos, projectPath: navigation.project, connectFrom, connectWhen, connectKeyword };
    const shells = data.shells?.length ? data.shells : [{ id: "powershell", label: "PowerShell" }];
    $("command-heading").textContent = cmd ? `${KIND_LABEL[kind]} ${cmd.title}` : `새 ${KIND_LABEL[kind]}`;
    $("command-title").value = cmd?.title ?? "";
    $("command-title").placeholder = kind === "command" ? "비워 두면 명령 첫 줄로 정합니다" : kind === "button" ? "예: 작업 시작" : kind === "group" ? "예: 병렬 구현" : kind === "git" ? "예: develop에 통합" : "예: 완료 보고서";
    $("command-save").disabled = false;
    $("command-generator").hidden = kind !== "command";
    $("command-explain").hidden = kind !== "command";
    $("command-settings").hidden = !["command", "markdown"].includes(kind);
    flowForms.fill(kind, cmd);
    $("git-settings").hidden = kind !== "git";
    $("git-action").value = cmd?.gitAction ?? "use";
    $("git-timeout").value = cmd?.timeoutSec ?? 600;
    $("git-timeout").disabled = kind !== "git";
    $("git-branches-status").textContent = "";
    if (kind === "git") { contextGitBranches(cmd?.branch ?? "", cmd?.targetBranch ?? ""); }
    $("group-members-row").hidden = kind !== "group";
    if (kind === "group") renderGroupMembers(new Set(cmd?.members ?? members));
    $("command-settings").classList.toggle("three", kind === "command");
    $("command-shell-row").hidden = kind !== "command";
    $("command-timeout-row").hidden = kind !== "command";
    $("command-timeout").disabled = kind !== "command";
    $("command-cwd-label").textContent = kind === "markdown" ? "저장 기준 폴더" : "실행 폴더";
    $("command-text-row").hidden = kind !== "command";
    $("button-prompt-row").hidden = kind !== "button";
    $("button-prompt").required = kind === "button";
    $("button-prompt").value = cmd?.prompt ?? "";
    $("command-kind-hint").textContent = KIND_HINT[kind];
    $("command-shell").replaceChildren(...shells.map((s) => el("option", { value: s.id }, s.label)));
    $("command-shell").value = cmd?.shell ?? shells[0].id;
    $("command-cwd").value = cmd?.cwdMode ?? "source";
    $("command-timeout").value = cmd?.timeoutSec ?? 600;
    $("command-text").value = cmd?.command ?? "";
    $("command-prompt").value = "";
    $("command-explain").textContent = "";
    $("command-error").textContent = "";
    $("command-delete").hidden = !cmd;
    renderCommandRun();
    $("command-dialog").showModal();
  }

  function gitRunDetails(cmd) {
    const run = cmd?.lastRun, result = run?.gitResult;
    if (!result) return cmd?.live?.tail ?? run?.tail ?? run?.error ?? "";
    const conflicts = result.conflicts ?? result.conflictFiles ?? [];
    return [run.tail ?? result.message, result.branch ? `브랜치: ${result.branch}${result.targetBranch ? ` → ${result.targetBranch}` : ""}` : null, result.beforeHead ? `변경 전: ${result.beforeHead}` : null, result.afterHead ? `변경 후: ${result.afterHead}` : null, result.reason || result.code ? `결과 코드: ${result.reason ?? result.code}` : null, conflicts.length ? `충돌 파일:\n${conflicts.join("\n")}` : null, run.deliveryErrors?.length ? `후속 실행 실패:\n${run.deliveryErrors.map((error) => typeof error === "string" ? error : error.message ?? JSON.stringify(error)).join("\n")}` : null, result.recoveryRequired ? "복구 필요: 작업 폴더의 Git 상태를 확인해 주세요." : result.aborted ? "충돌 병합을 취소하고 이전 상태로 복구했습니다." : null].filter(Boolean).join("\n");
  }

  function gitSelectionError() {
    const context = ui.editingCommand;
    if (context?.gitLoading) return "브랜치를 불러오는 중입니다.";
    if (context?.gitLoadError) return context.gitLoadError;
    const source = context?.gitBranches?.find((b) => b.name === $("git-branch").value);
    if (!source) return "사용할 브랜치를 선택하세요.";
    if ($("git-action").value === "use") return source.useSelectable === false ? source.useReason ?? source.reason ?? "사용할 수 없는 브랜치입니다." : "";
    const target = context.gitBranches.find((b) => b.name === $("git-target").value);
    if (!target) return "병합할 대상 브랜치를 선택하세요.";
    if (source.name === target.name) return "소스와 대상 브랜치를 다르게 선택하세요.";
    return target.targetSelectable === false ? target.targetReason ?? target.reason ?? "병합 대상으로 사용할 수 없는 브랜치입니다." : "";
  }

  function syncGitSettings(branch = $("git-branch").value, targetBranch = $("git-target").value) {
    const context = ui.editingCommand;
    if (context?.kind !== "git") return;
    const merge = $("git-action").value === "merge";
    $("git-target-row").hidden = !merge;
    $("git-branch-label").textContent = merge ? "가져올 브랜치" : "사용할 브랜치";
    for (const [id, selected, target] of [["git-branch", branch, false], ["git-target", targetBranch, true]]) {
      const select = $(id);
      select.replaceChildren(el("option", { value: "" }, context.gitLoading ? "브랜치를 불러오는 중…" : "브랜치 선택"), ...(context.gitBranches ?? []).map((b) => {
        const disabled = target ? b.targetSelectable === false : !merge && b.useSelectable === false;
        const reason = target ? b.targetReason ?? b.reason : b.useReason ?? b.reason;
        const label = `${b.name}${b.checkedOut ? " · 작업 폴더 있음" : ""}${b.busy ? " · 실행 중" : ""}${b.dirty ? " · 변경 있음" : ""}${disabled && reason ? ` · ${reason}` : ""}`;
        return el("option", { value: b.name, ...(disabled ? { disabled: "" } : {}), title: [b.cwd, reason].filter(Boolean).join(" · ") }, label);
      }));
      if (selected && !context.gitBranches?.some((b) => b.name === selected)) select.append(el("option", { value: selected, disabled: "" }, `${selected} · 목록에 없음`));
      select.value = selected;
      select.disabled = Boolean(context.gitLoading);
    }
    const selected = context.gitBranches?.find((b) => b.name === (merge ? $("git-target").value : $("git-branch").value));
    $("git-branch-details").textContent = selected ? [selected.cwd ? `작업 폴더: ${selected.cwd}` : "실행할 때 작업 폴더를 준비합니다.", selected.head ? `커밋: ${selected.head}` : null, merge ? selected.targetReason ?? selected.reason : selected.useReason ?? selected.reason].filter(Boolean).join("\n") : "";
    $("git-merge-hint").hidden = !merge;
    $("git-branches-refresh").disabled = Boolean(context.gitLoading);
    $("command-save").disabled = Boolean(context.gitLoading || context.gitLoadError);
  }

  async function contextGitBranches(branch = $("git-branch").value, targetBranch = $("git-target").value) {
    const context = ui.editingCommand;
    if (context?.kind !== "git") return;
    const request = {}; context.gitRequest = request; context.gitLoading = true; context.gitLoadError = "";
    $("git-branches-status").textContent = "브랜치를 불러오는 중…";
    syncGitSettings(branch, targetBranch);
    try {
      const result = await api("GET", `/api/commands/git-branches?path=${encodeURIComponent(context.projectPath)}`);
      if (ui.editingCommand !== context || context.cancelled || context.gitRequest !== request) return;
      context.gitBranches = result.branches ?? [];
      $("git-branches-status").textContent = context.gitBranches.length ? `로컬 브랜치 ${context.gitBranches.length}개 · 현재 ${result.currentBranch || "브랜치 없음"}` : "기존 로컬 브랜치가 없습니다.";
    } catch (err) {
      if (ui.editingCommand !== context || context.cancelled || context.gitRequest !== request) return;
      context.gitBranches = []; context.gitLoadError = err.message;
      $("git-branches-status").textContent = err.message;
    } finally {
      if (ui.editingCommand === context && !context.cancelled && context.gitRequest === request) { context.gitLoading = false; syncGitSettings(branch, targetBranch); }
    }
  }
  $("git-action").addEventListener("change", () => syncGitSettings());
  $("git-branch").addEventListener("change", () => syncGitSettings());
  $("git-target").addEventListener("change", () => syncGitSettings());
  $("git-branches-refresh").addEventListener("click", () => contextGitBranches());

  // 편집 창 아래쪽의 실행 결과(실행 중이면 지금까지의 출력)
  function renderCommandRun() {
    const cmd = commandById(ui.editingCommand?.id);
    const run = cmd?.lastRun;
    const kind = ui.editingCommand?.kind ?? kindOf(cmd);
    const box = $("command-last");
    const running = ["running", "watching"].includes(cmd?.state);
    $("command-run").hidden = !cmd || (kind === "markdown" && !run?.output);
    $("command-run").textContent = kind === "markdown" ? "결과 보기" : kind === "watch" ? running ? "감시 중지" : "감시 시작" : kind === "input" ? "입력하고 실행" : kind === "webhook-in" ? "시험 실행" : kind === "group" ? "지금 넘기기" : kind === "button" ? running ? "전달 중" : "지금 실행" : running ? "중지" : "지금 실행";
    $("command-run").disabled = pendingRuns.has(cmd?.id) || (kind === "button" && running) || (kind === "group" && !!cmd && !groupProgress(cmd).ready);
    if (!cmd || (!run && !running)) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (kind === "git") {
      $("command-last-meta").textContent = `${running ? "Git 작업 실행 중" : run?.ok ? "성공" : "실패"}${run?.gitResult?.recoveryRequired ? " · 복구 필요" : ""}${run?.cwd ? ` · ${run.cwd}` : ""}`;
      $("command-last-meta").className = `hint ${running ? "" : run?.ok ? "ok-text" : "error"}`;
      $("command-output").textContent = running ? cmd.live?.tail ?? "Git 작업 실행 중…" : gitRunDetails(cmd);
      return;
    }
    if (kind !== "command") {
      $("command-last-meta").textContent = commandNodeFoot(cmd) + (run?.originTitle ? ` · ${run.originTitle}에서` : "");
      $("command-last-meta").className = `hint ${run?.ok ? "ok-text" : run?.error ? "error" : ""}`;
      $("command-output").textContent = running ? cmd.live?.tail ?? run?.tail ?? "" : run?.output?.path ?? run?.error ?? run?.tail ?? "";
      return;
    }
    $("command-last-meta").textContent = running
      ? `실행 중 · ${cmd.live?.cwd ?? ""}`
      : `${run.ok ? "성공" : "실패"} · 종료 코드 ${run.exitCode}${run.timedOut ? " (시간 초과)" : ""}${run.stopped ? " (중지함)" : ""} · ${seconds(run.durationMs)} · ${timeAgo(run.startedAt)}${run.originTitle ? ` · ${run.originTitle}에서` : ""}\n${run.cwd}`;
    $("command-last-meta").className = `hint ${running ? "" : run.ok ? "ok-text" : "error"}`;
    $("command-output").textContent = (running ? cmd.live?.tail : run.tail) || "(출력 없음)";
  }

  function setOutputMode(source) {
    $("command-result-preview").hidden = source;
    $("command-result-raw").hidden = !source;
    $("command-result-rendered").setAttribute("aria-pressed", String(!source));
    $("command-result-source").setAttribute("aria-pressed", String(source));
  }

  function releaseOutputDownload() {
    if (ui.viewingOutput?.downloadUrl) {
      URL.revokeObjectURL(ui.viewingOutput.downloadUrl);
      ui.viewingOutput.downloadUrl = null;
    }
    $("command-result-download").hidden = true;
    $("command-result-download").removeAttribute("href");
  }

  async function openCommandOutput(cmd) {
    if (!cmd || (!cmd.lastRun && !cmd.live)) return;
    if (kindOf(cmd) !== "markdown") {
      releaseOutputDownload();
      ui.viewingOutput = { id: cmd.id, projectPath: navigation.project };
      $("command-result-heading").textContent = cmd.title + " · 실행 결과";
      $("command-result-path").textContent = cmd.lastRun?.cwd ?? "";
      $("command-result-preview").replaceChildren();
      $("command-result-raw").textContent = kindOf(cmd) === "git" ? gitRunDetails(cmd) : cmd.live?.tail ?? cmd.lastRun?.tail ?? cmd.lastRun?.error ?? "(출력 없음)";
      $("command-result-status").textContent = commandNodeFoot(cmd);
      $("command-result-status").className = "hint";
      $("command-result-rendered").hidden = true;
      $("command-result-source").hidden = true;
      setOutputMode(true);
      if (!$("command-result-dialog").open) $("command-result-dialog").showModal();
      return;
    }
    if (!cmd.lastRun?.output) return;
    $("command-result-rendered").hidden = false;
    $("command-result-source").hidden = false;
    releaseOutputDownload();
    const context = { id: cmd.id, projectPath: navigation.project };
    ui.viewingOutput = context;
    $("command-result-heading").textContent = `${cmd.title} · MD 출력 결과`;
    $("command-result-path").textContent = cmd.lastRun.output.path;
    $("command-result-preview").replaceChildren();
    $("command-result-raw").textContent = "";
    $("command-result-status").textContent = "저장한 파일을 불러오는 중…";
    $("command-result-status").className = "hint";
    setOutputMode(false);
    if (!$("command-result-dialog").open) $("command-result-dialog").showModal();
    try {
      const output = await api("GET", `/api/commands/${cmd.id}/output`);
      if (ui.viewingOutput !== context || !samePath(context.projectPath, navigation.project)) return;
      $("command-result-path").textContent = output.path;
      $("command-result-preview").innerHTML = renderMarkdown(output.text);
      $("command-result-raw").textContent = output.text;
      $("command-result-status").textContent = output.text ? "" : "저장된 메시지가 비어 있습니다.";
      // Keep the download identical to this preview even when a later completion saves a new file.
      context.downloadUrl = URL.createObjectURL(new Blob([output.text], { type: "text/markdown;charset=utf-8" }));
      $("command-result-download").href = context.downloadUrl;
      $("command-result-download").download = output.fileName;
      $("command-result-download").hidden = false;
    } catch (err) {
      if (ui.viewingOutput !== context) return;
      $("command-result-status").textContent = err.message;
      $("command-result-status").className = "error";
    }
  }

  $("command-result-rendered").addEventListener("click", () => setOutputMode(false));
  $("command-result-source").addEventListener("click", () => setOutputMode(true));
  $("command-result-dialog").addEventListener("close", () => {
    if ($("command-result-dialog").open) return;
    releaseOutputDownload();
    ui.viewingOutput = null;
  });

  // 적은 설명으로 명령을 만든다. 제목이 비어 있으면 제목도 채운다.
  $("command-generate").addEventListener("click", async () => {
    const context = ui.editingCommand;
    if (!context || context.kind !== "command" || context.cancelled) return;
    const prompt = $("command-prompt").value.trim();
    if (!prompt) return $("command-prompt").focus();
    const button = $("command-generate");
    button.disabled = true;
    button.textContent = "만드는 중…";
    $("command-error").textContent = "";
    $("command-explain").textContent = "";
    try {
      const made = await api("POST", "/api/commands/generate", { projectPath: navigation.project, prompt, shell: $("command-shell").value });
      if (ui.editingCommand !== context || context.cancelled) return;
      $("command-text").value = made.command;
      if (!$("command-title").value.trim()) $("command-title").value = made.title;
      $("command-explain").textContent = made.explanation ? `만든 명령: ${made.explanation} · 실행하기 전에 한번 확인하세요.` : "실행하기 전에 한번 확인하세요.";
    } catch (err) {
      if (ui.editingCommand === context && !context.cancelled) $("command-error").textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = "명령 만들기";
    }
  });
  $("command-prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      $("command-generate").click();
    }
  });

  $("command-dialog").addEventListener("close", () => {
    if ($("command-dialog").open) return;
    if (ui.editingCommand) ui.editingCommand.cancelled = true;
    ui.editingCommand = null;
  });

  $("command-form").addEventListener("submit", async (e) => {
    const action = e.submitter?.value;
    if (action === "cancel") return;
    e.preventDefault();
    const context = ui.editingCommand;
    if (!context || context.cancelled) return;
    const { id, pos, projectPath, kind } = context;
    const cmd = commandById(id);
    if (action === "delete") {
      $("command-dialog").close();
      return removeCommand(cmd);
    }
    if (action === "run") return ["running", "watching"].includes(cmd?.state) && ["command", "git", "repeat", "watch", "webhook"].includes(kind) ? stopCommand(cmd) : cmd && runCommand(cmd);
    const body = {
      title: $("command-title").value,
      ...(kind === "command" ? {
        command: $("command-text").value,
        shell: $("command-shell").value,
        cwdMode: $("command-cwd").value,
        timeoutSec: Number($("command-timeout").value),
      } : kind === "git" ? { gitAction: $("git-action").value, branch: $("git-branch").value, targetBranch: $("git-action").value === "merge" ? $("git-target").value : "", timeoutSec: Number($("git-timeout").value) } : kind === "button" ? { prompt: $("button-prompt").value }
        : FLOW_KINDS.includes(kind) ? flowForms.body(kind) : kind === "group" ? { members: [...$("group-members").querySelectorAll("input:checked")].map((input) => input.value) }
          : { cwdMode: $("command-cwd").value }),
    };
    if (kind === "git") {
      const error = gitSelectionError();
      if (error) { $("command-error").textContent = error; return; }
    }
    try {
      let created = null;
      if (cmd) {
        // 받는 주소 새로 만들기는 되돌릴 수 없으므로 되돌리기에서 다시 보내지 않는다.
        const { regenerateToken: _regenerate, ...next } = body;
        const previous = Object.fromEntries(Object.keys(next).filter((key) => cmd[key] !== undefined).map((key) => [key, structuredClone(cmd[key])]));
        await api("PUT", `/api/commands/${cmd.id}`, body);
        history?.record(projectPath, { label: `${KIND_LABEL[kind]} 편집`,
          undo: ({ resolve }) => api("PUT", `/api/commands/${resolve(cmd.id)}`, previous),
          redo: ({ resolve }) => api("PUT", `/api/commands/${resolve(cmd.id)}`, next) });
      } else {
        created = await api("POST", "/api/commands", { ...body, ...(kind === "command" ? {} : { kind }), projectPath, pos });
        const made = structuredClone(created);
        history?.record(projectPath, { label: `${KIND_LABEL[kind]} 만들기`,
          undo: ({ resolve }) => api("DELETE", `/api/commands/${resolve(made.id)}`),
          redo: async ({ resolve, remap }) => {
            const body = commandBody(made);
            remap(made.id, (await api("POST", "/api/commands", body.members ? { ...body, members: body.members.map(resolve) } : body)).id);
          } });
      }
      if (ui.editingCommand === context) {
        ui.editingCommand = null;
        $("command-dialog").close();
      }
      if (created) await connectCreatedGraphNode(context, created.id, projectPath);
      await loadCommands(projectPath);
    } catch (err) {
      if (ui.editingCommand === context && !context.cancelled) $("command-error").textContent = err.message;
    }
  });

  function cancelCreation() {
    flowForms.cancel();
    if (ui.editingCommand) ui.editingCommand.cancelled = true;
    ui.editingCommand = null;
    if ($("command-dialog").open) $("command-dialog").close();
    releaseOutputDownload();
    ui.viewingOutput = null;
    if ($("command-result-dialog").open) $("command-result-dialog").close();
  }

  return { loadCommands, commandNodeFoot, commandNode, runCommand, stopCommand, removeCommand, openCommandDialog, openCommandOutput, cancelCreation };
}
