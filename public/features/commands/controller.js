import { $, el, pill, timeAgo } from "../../shared/dom.js";
import { elapsedElement } from "../../shared/elapsed.js";
import { samePath, firstLine } from "../../shared/store.js";

export function createCommandsController({ api, loadLinks, renderGraph, connectCreatedGraphNode, commandById, data, navigation }) {
  const ui = {
    "editingCommand": null
  };
  // ── 명령 노드 ───────────────────────────────────────────────────
  const COMMAND_STATE = { idle: "대기", running: "실행 중", success: "성공", error: "실패" };
  const shellLabel = (id) => (data.shells ?? []).find((s) => s.id === id)?.label ?? id;
  const seconds = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}초`;

  // 세션끼리 주고받은 메시지. 그래프에 대화선으로 그린다.

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
    return running ? `실행 중 · ${firstLine(c.live?.tail?.split(/\r?\n/).at(-1) ?? "") || "출력 기다리는 중"}`
      : run ? `종료 ${run.exitCode}${run.timedOut ? " (시간 초과)" : ""} · ${seconds(run.durationMs)} · ${timeAgo(run.startedAt)}` : "아직 실행하지 않음";
  }

  function commandNode(c) {
    const running = c.state === "running";
    return el("div", { class: `gcmd ${c.state}`, "data-id": c.id, title: `${c.title}\n${c.command}\n\n누르면 편집, ● 손잡이를 끌어 다음 세션·명령에 잇습니다.` },
      el("div", { class: "gcard-top" },
        el("span", { class: "pill cmd" }, "명령"),
        el("span", { class: "gcmd-shell" }, shellLabel(c.shell)),
        el("span", { class: `pill cmd-${c.state}` }, COMMAND_STATE[c.state] ?? c.state)),
      el("div", { class: "gcard-title" }, c.title),
      el("div", { class: "gcmd-code mono" }, firstLine(c.command)),
      el("div", { class: "gcmd-foot" },
        el("span", { class: "gcmd-result" }, elapsedElement("command", c), el("span", { class: "gcmd-result-text" }, commandNodeFoot(c))),
        el("button", {
          type: "button",
          class: `gcmd-btn${running ? " stop" : ""}`,
          title: running ? "중지" : "지금 실행",
          onclick: () => (running ? stopCommand(c) : runCommand(c)),
        }, running ? "■" : "▶")),
      el("span", { class: "gcard-handle", title: "끌어서 다음 세션이나 명령에 연결" }));
  }

  async function runCommand(c) {
    try {
      await api("POST", `/api/commands/${c.id}/run`);
    } catch (err) {
      alert(err.message);
    }
    loadCommands();
  }

  async function stopCommand(c) {
    await api("POST", `/api/commands/${c.id}/stop`).catch((err) => alert(err.message));
    loadCommands();
  }

  async function removeCommand(c) {
    if (!confirm(`명령 노드 "${c.title}"을(를) 삭제할까요? 이 노드에 이어진 연결도 지웁니다.`)) return;
    try {
      await api("DELETE", `/api/commands/${c.id}`);
    } catch (err) {
      alert(err.message);
    }
    await Promise.all([loadCommands(), loadLinks()]);
  }

  // cmd가 없으면 새로 만든다. pos는 새 노드를 놓을 자리.
  function openCommandDialog(cmd, pos = null, connectFrom = null) {
    if (ui.editingCommand) ui.editingCommand.cancelled = true;
    ui.editingCommand = { id: cmd?.id ?? null, pos, projectPath: navigation.project, connectFrom };
    const shells = data.shells ?? [{ id: "powershell", label: "PowerShell" }];
    $("command-heading").textContent = cmd ? `명령 ${cmd.title}` : "새 명령";
    $("command-title").value = cmd?.title ?? "";
    $("command-shell").replaceChildren(...shells.map((s) => el("option", { value: s.id }, s.label)));
    $("command-shell").value = cmd?.shell ?? shells[0].id;
    $("command-cwd").value = cmd?.cwdMode ?? "source";
    $("command-timeout").value = cmd?.timeoutSec ?? 600;
    $("command-text").value = cmd?.command ?? "";
    $("command-prompt").value = "";
    $("command-explain").textContent = "";
    $("command-error").textContent = "";
    $("command-delete").hidden = !cmd;
    $("command-run").hidden = !cmd;
    renderCommandRun();
    $("command-dialog").showModal();
  }

  // 편집 창 아래쪽의 실행 결과(실행 중이면 지금까지의 출력)
  function renderCommandRun() {
    const cmd = commandById(ui.editingCommand?.id);
    const run = cmd?.lastRun;
    const box = $("command-last");
    if (!cmd || (!run && cmd.state !== "running")) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const running = cmd.state === "running";
    $("command-last-meta").textContent = running
      ? `실행 중 · ${cmd.live?.cwd ?? ""}`
      : `${run.ok ? "성공" : "실패"} · 종료 코드 ${run.exitCode}${run.timedOut ? " (시간 초과)" : ""}${run.stopped ? " (중지함)" : ""} · ${seconds(run.durationMs)} · ${timeAgo(run.startedAt)}${run.originTitle ? ` · ${run.originTitle}에서` : ""}\n${run.cwd}`;
    $("command-last-meta").className = `hint ${running ? "" : run.ok ? "ok-text" : "error"}`;
    $("command-output").textContent = (running ? cmd.live?.tail : run.tail) || "(출력 없음)";
    $("command-run").textContent = running ? "중지" : "지금 실행";
  }

  // 적은 설명으로 명령을 만든다. 제목이 비어 있으면 제목도 채운다.
  $("command-generate").addEventListener("click", async () => {
    const prompt = $("command-prompt").value.trim();
    if (!prompt) return $("command-prompt").focus();
    const button = $("command-generate");
    button.disabled = true;
    button.textContent = "만드는 중…";
    $("command-error").textContent = "";
    $("command-explain").textContent = "";
    try {
      const made = await api("POST", "/api/commands/generate", { projectPath: navigation.project, prompt, shell: $("command-shell").value });
      $("command-text").value = made.command;
      if (!$("command-title").value.trim()) $("command-title").value = made.title;
      $("command-explain").textContent = made.explanation ? `만든 명령: ${made.explanation} · 실행하기 전에 한번 확인하세요.` : "실행하기 전에 한번 확인하세요.";
    } catch (err) {
      $("command-error").textContent = err.message;
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
    const { id, pos, projectPath } = context;
    const cmd = commandById(id);
    if (action === "delete") {
      $("command-dialog").close();
      return removeCommand(cmd);
    }
    if (action === "run") return cmd.state === "running" ? stopCommand(cmd) : runCommand(cmd);
    const body = {
      title: $("command-title").value,
      command: $("command-text").value,
      shell: $("command-shell").value,
      cwdMode: $("command-cwd").value,
      timeoutSec: Number($("command-timeout").value),
    };
    try {
      let created = null;
      if (cmd) await api("PUT", `/api/commands/${cmd.id}`, body);
      else created = await api("POST", "/api/commands", { ...body, projectPath, pos });
      if (ui.editingCommand === context) {
        ui.editingCommand = null;
        $("command-dialog").close();
      }
      if (created) await connectCreatedGraphNode(context, created.id, projectPath);
      await loadCommands(projectPath);
    } catch (err) {
      $("command-error").textContent = err.message;
    }
  });

  function cancelCreation() {
    if (ui.editingCommand) ui.editingCommand.cancelled = true;
    ui.editingCommand = null;
    if ($("command-dialog").open) $("command-dialog").close();
  }

  return { loadCommands, commandNodeFoot, commandNode, runCommand, stopCommand, removeCommand, openCommandDialog, cancelCreation };
}
