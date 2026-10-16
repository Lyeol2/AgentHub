import { $ } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";

export function createKnowledgeController({ api, currentProject }) {
  const ui = {
    "boardProject": null,
    "boardDirty": null
  };
  // ── 공유 노트 ───────────────────────────────────────────────────
  // 세션들이 MCP 도구로 덧붙이는 프로젝트 메모. 열어 둔 동안 세션이 덧붙이면 다시 받는다(고치던 중이면 그대로 둔다).
  async function loadBoard() {
    const projectPath = ui.boardProject;
    try {
      const { text } = await api("GET", `/api/board?path=${encodeURIComponent(projectPath)}`);
      if (!samePath(projectPath, ui.boardProject) || ui.boardDirty) return;
      $("board-text").value = text;
    } catch (err) {
      $("board-error").textContent = err.message;
    }
  }

  $("p-board").addEventListener("click", async () => {
    const p = currentProject();
    if (!p) return;
    ui.boardProject = p.path;
    ui.boardDirty = false;
    $("board-project").textContent = p.name;
    $("board-text").value = "";
    $("board-error").textContent = "";
    $("board-dialog").showModal();
    await loadBoard();
  });
  $("board-text").addEventListener("input", () => { ui.boardDirty = true; });

  $("board-form").addEventListener("submit", async (e) => {
    const action = e.submitter?.value;
    if (action === "cancel") return;
    e.preventDefault();
    if (action === "clear" && !confirm("공유 노트를 모두 지울까요?")) return;
    try {
      const text = action === "clear" ? "" : $("board-text").value;
      await api("PUT", "/api/board", { path: ui.boardProject, text });
      $("board-dialog").close();
    } catch (err) {
      $("board-error").textContent = err.message;
    }
  });

  function refreshBoard(projectPath) {
    if ($("board-dialog").open && samePath(projectPath, ui.boardProject)) return loadBoard();
  }

  return { refreshBoard };
}
