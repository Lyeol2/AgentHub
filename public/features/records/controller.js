import { $, el, fmtDate } from "../../shared/dom.js";

const MAX_BYTES = 5 * 1024 * 1024;
const AGENT_LABEL = { claude: "Claude", codex: "Codex" };

// 기록 가져오기: 기록 내보내기로 만든 Markdown 문서를 새 세션으로 되살린다.
export function createRecordsController({ api, loadSessions, selectSession, data, navigation }) {
  const ui = { projectPath: null, sessionId: null, records: [], upload: null };

  const option = (record, index) => el("option", { value: String(index) },
    `${record.title} · ${record.exportedAt ? fmtDate(record.exportedAt) : fmtDate(record.modifiedAt)}${record.agent ? ` · ${AGENT_LABEL[record.agent]}` : ""}${record.location === "session" ? " · 이 세션 작업 폴더" : ""}`);

  function renderFiles() {
    const select = $("record-file");
    const items = ui.records.map(option);
    if (ui.upload) items.unshift(el("option", { value: "upload" }, `${ui.upload.fileName} (선택한 파일)`));
    if (!items.length) items.push(el("option", { value: "" }, "docs/agenthub에 내보낸 기록이 없습니다. 다른 파일을 선택하세요."));
    select.replaceChildren(...items);
    select.value = ui.upload ? "upload" : items[0].value;
    applySelection();
  }

  // 고른 문서의 AI를 기본값으로 쓴다.
  function applySelection() {
    const value = $("record-file").value;
    const record = value === "upload" ? null : ui.records[Number(value)];
    if (record?.agent) $("record-agent").value = record.agent;
    $("record-title").placeholder = record?.title ?? (value === "upload" ? "비워 두면 문서 제목을 씁니다" : "");
  }

  async function openRecordImport(projectPath, sessionId = null) {
    if (!projectPath) return;
    Object.assign(ui, { projectPath, sessionId, records: [], upload: null });
    $("record-project").textContent = projectPath;
    $("record-title").value = "";
    $("record-carry").checked = true;
    $("record-picked").textContent = "";
    $("record-error").textContent = "";
    $("record-upload").value = "";
    $("record-file").replaceChildren(el("option", { value: "" }, "기록을 찾는 중…"));
    $("record-dialog").showModal();
    try {
      const query = new URLSearchParams({ path: projectPath, ...(sessionId ? { session: sessionId } : {}) });
      ui.records = await api("GET", `/api/records?${query}`);
    } catch (err) {
      $("record-error").textContent = err.message;
    }
    if (ui.projectPath === projectPath) renderFiles();
  }

  $("record-file").addEventListener("change", applySelection);
  $("record-pick").addEventListener("click", () => $("record-upload").click());
  $("record-upload").addEventListener("change", async () => {
    const file = $("record-upload").files?.[0];
    if (!file) return;
    $("record-error").textContent = "";
    if (file.size > MAX_BYTES) {
      $("record-error").textContent = "기록 문서는 5MB까지 가져올 수 있습니다.";
      return;
    }
    ui.upload = { fileName: file.name, markdown: await file.text() };
    $("record-picked").textContent = "선택한 파일의 이미지는 함께 가져오지 않습니다.";
    renderFiles();
  });

  $("record-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const value = $("record-file").value;
    const record = value === "upload" ? null : ui.records[Number(value)];
    if (value !== "upload" && !record) {
      $("record-error").textContent = "가져올 기록 문서를 고르세요.";
      return;
    }
    const body = {
      projectPath: ui.projectPath, title: $("record-title").value, agent: $("record-agent").value, carry: $("record-carry").checked,
      ...(value === "upload" ? { markdown: ui.upload.markdown, fileName: ui.upload.fileName }
        : { fileName: record.fileName, location: record.location, ...(ui.sessionId ? { sessionId: ui.sessionId } : {}) }),
    };
    const button = e.submitter;
    button.disabled = true;
    try {
      const created = await api("POST", "/api/sessions/import-record", body);
      $("record-dialog").close();
      await loadSessions();
      await selectSession(created.id);
    } catch (err) {
      $("record-error").textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  $("s-import").addEventListener("click", () => {
    const s = data.current;
    if (s && !s.chat) openRecordImport(s.projectPath, s.id);
  });
  $("p-import-record").addEventListener("click", () => openRecordImport(navigation.project));

  return { openRecordImport };
}
