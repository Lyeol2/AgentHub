import { $, el, timeAgo } from "../../shared/dom.js";
import { elapsedElement } from "../../shared/elapsed.js";
import { samePath, firstLine } from "../../shared/store.js";
import { renderMarkdown } from "../../markdown.js";

export function createCommandsController({ api, loadLinks, renderGraph, connectCreatedGraphNode, commandById, data, navigation }) {
  const ui = {
    "editingCommand": null,
    "viewingOutput": null
  };
  const pendingRuns = new Set();
  // ── 명령 노드 ───────────────────────────────────────────────────
  const COMMAND_STATE = { idle: "대기", running: "실행 중", success: "성공", error: "실패" };
  const kindOf = (node) => node?.kind === "button" || node?.kind === "markdown" ? node.kind : "command";
  const KIND_LABEL = { command: "명령", button: "버튼", markdown: "MD 출력" };
  const KIND_HINT = {
    command: "연결로 넘어오면 실행합니다. 종료 코드 0이면 '성공 시', 아니면 '실패 시' 연결로 넘어가고, 받는 세션에는 출력 마지막 부분이 함께 갑니다. 실행 전에 확인하려면 들어오는 연결에 '넘기기 전에 승인 받기'를 켜세요.",
    button: "실행 버튼을 누르면 연결된 세션에 아래 프롬프트를 보내 실행합니다. 오른쪽 손잡이를 세션에 연결하세요. 연결에 승인을 설정했다면 승인 후 실행합니다.",
    markdown: "연결된 세션이 완료되면 마지막 답변 원문을 AI 처리 없이 .md 파일로 저장합니다. 선택한 폴더의 docs/agenthub/outputs에 완료할 때마다 새 파일을 만들며, 결과 보기에서 최근 파일을 확인할 수 있습니다.",
  };
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
    const running = c.state === "running";
    const run = c.lastRun;
    if (kindOf(c) === "markdown") return running ? "메시지 저장 중" : run?.output ? `저장됨 · ${timeAgo(run.startedAt)}` : run?.error || "세션 완료 기다리는 중";
    if (kindOf(c) === "button") return running ? "연결된 세션에 보내는 중" : run ? `${run.ok ? "전달 완료" : "전달 실패"} · ${timeAgo(run.startedAt)}` : "눌러서 연결된 세션 실행";
    return running ? `실행 중 · ${firstLine(c.live?.tail?.split(/\r?\n/).at(-1) ?? "") || "출력 기다리는 중"}`
      : run ? `종료 ${run.exitCode}${run.timedOut ? " (시간 초과)" : ""} · ${seconds(run.durationMs)} · ${timeAgo(run.startedAt)}` : "아직 실행하지 않음";
  }

  function commandNode(c) {
    const running = c.state === "running";
    const kind = kindOf(c);
    const output = c.lastRun?.output;
    const detail = kind === "button" ? c.prompt : kind === "markdown" ? output?.relativePath ?? "완료 메시지 → .md 파일" : c.command;
    const actionLabel = kind === "markdown" ? "결과 보기" : kind === "button" ? running ? "전달 중" : "실행" : running ? "중지" : "지금 실행";
    const action = el("button", {
      type: "button",
      class: `gcmd-btn${running && kind === "command" ? " stop" : ""}`,
      title: kind === "markdown" && !output ? "연결된 세션이 완료되면 결과를 볼 수 있습니다" : actionLabel,
      "aria-label": `${c.title} ${actionLabel}`,
      onclick: () => kind === "markdown" ? openCommandOutput(c) : running && kind === "command" ? stopCommand(c) : runCommand(c),
    }, kind === "command" ? running ? "■" : "▶" : actionLabel);
    action.disabled = kind === "markdown" ? !output : pendingRuns.has(c.id) || (kind === "button" && running);
    return el("div", { class: `gcmd gcmd-${kind} ${c.state}`, "data-id": c.id, "data-kind": kind, title: `${c.title}\n${detail ?? ""}\n\n두 번 누르면 편집합니다.${kind === "markdown" ? " 세션의 손잡이를 이 노드에 연결하세요." : " ● 손잡이를 끌어 다음 세션에 잇습니다."}` },
      el("div", { class: "gcard-top" },
        el("span", { class: `pill cmd ${kind}` }, KIND_LABEL[kind]),
        el("span", { class: "gcmd-shell" }, kind === "command" ? shellLabel(c.shell) : kind === "button" ? "수동 실행" : "원문 저장"),
        el("span", { class: `pill cmd-${c.state}` }, COMMAND_STATE[c.state] ?? c.state)),
      el("div", { class: "gcard-title" }, c.title),
      el("div", { class: `gcmd-code${kind === "button" ? "" : " mono"}`, title: detail ?? "" }, firstLine(detail ?? "")),
      el("div", { class: "gcmd-foot" },
        el("span", { class: "gcmd-result" }, elapsedElement("command", c), el("span", { class: "gcmd-result-text" }, commandNodeFoot(c))),
        action),
      kind === "markdown" ? null : el("span", { class: "gcard-handle", title: kind === "button" ? "끌어서 실행할 세션에 연결" : "끌어서 다음 세션이나 명령에 연결" }));
  }

  async function runCommand(c) {
    if (kindOf(c) === "markdown") return openCommandOutput(c);
    if (pendingRuns.has(c.id) || (kindOf(c) === "button" && c.state === "running")) return;
    pendingRuns.add(c.id);
    if (navigation.view === "project") renderGraph();
    renderCommandRun();
    try {
      await api("POST", `/api/commands/${c.id}/run`);
    } catch (err) {
      alert(err.message);
    } finally {
      pendingRuns.delete(c.id);
      await Promise.all([loadCommands(), ...(kindOf(c) === "button" ? [loadLinks()] : [])]);
      renderCommandRun();
    }
  }

  async function stopCommand(c) {
    await api("POST", `/api/commands/${c.id}/stop`).catch((err) => alert(err.message));
    loadCommands();
  }

  async function removeCommand(c) {
    if (!c || !confirm(`${KIND_LABEL[kindOf(c)]} 노드 "${c.title}"을(를) 삭제할까요? 이 노드에 이어진 연결도 지웁니다.`)) return;
    try {
      await api("DELETE", `/api/commands/${c.id}`);
    } catch (err) {
      alert(err.message);
    }
    await Promise.all([loadCommands(), loadLinks()]);
  }

  // cmd가 없으면 새로 만든다. pos는 새 노드를 놓을 자리.
  function openCommandDialog(cmd, pos = null, connectFrom = null, kind = "command") {
    if (ui.editingCommand) ui.editingCommand.cancelled = true;
    kind = kindOf(cmd ?? { kind });
    ui.editingCommand = { id: cmd?.id ?? null, kind, pos, projectPath: navigation.project, connectFrom };
    const shells = data.shells?.length ? data.shells : [{ id: "powershell", label: "PowerShell" }];
    $("command-heading").textContent = cmd ? `${KIND_LABEL[kind]} ${cmd.title}` : `새 ${KIND_LABEL[kind]}`;
    $("command-title").value = cmd?.title ?? "";
    $("command-title").placeholder = kind === "command" ? "비워 두면 명령 첫 줄로 정합니다" : kind === "button" ? "예: 작업 시작" : "예: 완료 보고서";
    $("command-generator").hidden = kind !== "command";
    $("command-explain").hidden = kind !== "command";
    $("command-settings").hidden = kind === "button";
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

  // 편집 창 아래쪽의 실행 결과(실행 중이면 지금까지의 출력)
  function renderCommandRun() {
    const cmd = commandById(ui.editingCommand?.id);
    const run = cmd?.lastRun;
    const kind = ui.editingCommand?.kind ?? kindOf(cmd);
    const box = $("command-last");
    const running = cmd?.state === "running";
    $("command-run").hidden = !cmd || (kind === "markdown" && !run?.output);
    $("command-run").textContent = kind === "markdown" ? "결과 보기" : kind === "button" ? running ? "전달 중" : "지금 실행" : running ? "중지" : "지금 실행";
    $("command-run").disabled = pendingRuns.has(cmd?.id) || (kind === "button" && running);
    if (!cmd || (!run && cmd.state !== "running")) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (kind !== "command") {
      $("command-last-meta").textContent = commandNodeFoot(cmd) + (run?.originTitle ? ` · ${run.originTitle}에서` : "");
      $("command-last-meta").className = `hint ${run?.ok ? "ok-text" : run?.error ? "error" : ""}`;
      $("command-output").textContent = run?.output?.path ?? run?.error ?? run?.tail ?? "";
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
    if (!cmd || kindOf(cmd) !== "markdown" || !cmd.lastRun?.output) return;
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
    if (action === "run") return cmd?.state === "running" && kind === "command" ? stopCommand(cmd) : cmd && runCommand(cmd);
    const body = {
      title: $("command-title").value,
      ...(kind === "command" ? {
        command: $("command-text").value,
        shell: $("command-shell").value,
        cwdMode: $("command-cwd").value,
        timeoutSec: Number($("command-timeout").value),
      } : kind === "button" ? { prompt: $("button-prompt").value } : { cwdMode: $("command-cwd").value }),
    };
    try {
      let created = null;
      if (cmd) await api("PUT", `/api/commands/${cmd.id}`, body);
      else created = await api("POST", "/api/commands", { ...body, ...(kind === "command" ? {} : { kind }), projectPath, pos });
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
    if (ui.editingCommand) ui.editingCommand.cancelled = true;
    ui.editingCommand = null;
    if ($("command-dialog").open) $("command-dialog").close();
    releaseOutputDownload();
    ui.viewingOutput = null;
    if ($("command-result-dialog").open) $("command-result-dialog").close();
  }

  return { loadCommands, commandNodeFoot, commandNode, runCommand, stopCommand, removeCommand, openCommandDialog, openCommandOutput, cancelCreation };
}
