import { $, el, fmtDate } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";

const MAX_BYTES = { markdown: 5 * 1024 * 1024, agenthub: 30 * 1024 * 1024 };
const AGENT_LABEL = { claude: "Claude", codex: "Codex" };
const FORMAT_LABEL = { agenthub: "세션 파일", markdown: "문서" };
const formatOf = (fileName) => /\.agenthub$/i.test(fileName) ? "agenthub" : "markdown";

// 기록 가져오기: 기록 내보내기로 만든 .agenthub 세션 파일이나 Markdown 문서를
// 새 세션으로 되살리거나(새 세션으로 불러오기), 보고 있는 세션의 다음 요청에 붙인다(이 세션에 읽히기).
export function createRecordsController({ api, loadSessions, selectSession, data, navigation }) {
  const ui = { projectPath: null, sessionId: null, records: [], upload: null, context: null };
  const sameGraph = (context) => context.view === navigation.view &&
    (context.navigationProject === navigation.project || samePath(context.navigationProject, navigation.project)) &&
    context.navigationTabId === navigation.graphTabId && (navigation.view !== "session" || context.currentSessionId === data.current?.id);

  const option = (record, index) => el("option", { value: String(index) },
    `${record.title} · ${FORMAT_LABEL[record.format ?? "markdown"]} · ${record.exportedAt ? fmtDate(record.exportedAt) : fmtDate(record.modifiedAt)}${record.agent ? ` · ${AGENT_LABEL[record.agent]}` : ""}${record.location === "session" ? " · 이 세션 작업 폴더" : ""}`);

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

  const mode = () => ui.sessionId && document.querySelector("input[name=record-mode]:checked")?.value === "read" ? "read" : "new";

  function applyMode() {
    const reading = mode() === "read";
    $("record-new-fields").hidden = reading;
    $("record-read-hint").hidden = !reading;
    $("record-submit").textContent = reading ? "읽히기" : "가져오기";
  }

  async function openRecordImport(projectPath, sessionId = null) {
    if (!projectPath) return;
    const context = { projectPath, sessionId, tabId: samePath(projectPath, navigation.project) ? navigation.graphTabId : undefined,
      view: navigation.view, navigationProject: navigation.project, navigationTabId: navigation.graphTabId, currentSessionId: data.current?.id };
    Object.assign(ui, { projectPath, sessionId, records: [], upload: null, context });
    $("record-project").textContent = projectPath;
    $("record-title").value = "";
    $("record-carry").checked = true;
    $("record-picked").textContent = "";
    $("record-error").textContent = "";
    $("record-upload").value = "";
    $("record-mode-row").hidden = !sessionId;
    document.querySelector("input[name=record-mode][value=new]").checked = true;
    applyMode();
    $("record-file").replaceChildren(el("option", { value: "" }, "기록을 찾는 중…"));
    $("record-dialog").showModal();
    try {
      const query = new URLSearchParams({ path: projectPath, ...(sessionId ? { session: sessionId } : {}) });
      const records = await api("GET", `/api/records?${query}`);
      if (ui.context !== context) return;
      ui.records = records;
    } catch (err) {
      if (ui.context === context) $("record-error").textContent = err.message;
    }
    if (ui.context === context) renderFiles();
  }

  $("record-file").addEventListener("change", applySelection);
  for (const radio of document.querySelectorAll("input[name=record-mode]")) radio.addEventListener("change", applyMode);
  $("record-pick").addEventListener("click", () => $("record-upload").click());
  $("record-upload").addEventListener("change", async () => {
    const context = ui.context;
    const file = $("record-upload").files?.[0];
    if (!file) return;
    $("record-error").textContent = "";
    const format = formatOf(file.name);
    if (file.size > MAX_BYTES[format]) {
      $("record-error").textContent = format === "agenthub" ? "세션 파일(.agenthub)은 30MB까지 가져올 수 있습니다." : "기록 문서는 5MB까지 가져올 수 있습니다.";
      return;
    }
    const content = await file.text();
    if (ui.context !== context) return;
    ui.upload = { fileName: file.name, content };
    $("record-picked").textContent = format === "agenthub" ? "세션 파일에 담긴 첨부도 함께 가져옵니다." : "선택한 문서의 이미지는 함께 가져오지 않습니다.";
    renderFiles();
  });

  $("record-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const context = ui.context;
    if (!context) return;
    const value = $("record-file").value;
    const record = value === "upload" ? null : ui.records[Number(value)];
    if (value !== "upload" && !record) {
      $("record-error").textContent = "가져올 기록을 고르세요.";
      return;
    }
    const source = value === "upload" ? { content: ui.upload.content, fileName: ui.upload.fileName }
      : { fileName: record.fileName, location: record.location, ...(ui.sessionId ? { sessionId: ui.sessionId } : {}) };
    const reading = mode() === "read";
    const button = e.submitter;
    button.disabled = true;
    try {
      if (reading) {
        await api("POST", `/api/sessions/${context.sessionId}/read-record`, source);
        if (ui.context === context) $("record-dialog").close();
        return;
      }
      const created = await api("POST", "/api/sessions/import-record", {
        projectPath: context.projectPath, ...(context.tabId ? { tabId: context.tabId } : {}), title: $("record-title").value, agent: $("record-agent").value, carry: $("record-carry").checked, ...source,
      });
      const current = ui.context === context;
      if (current) $("record-dialog").close();
      await loadSessions();
      if (current && sameGraph(context)) await selectSession(created.id);
    } catch (err) {
      if (ui.context === context) $("record-error").textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  $("s-import").addEventListener("click", () => {
    const s = data.current;
    if (s && !s.chat) openRecordImport(s.projectPath, s.id);
  });
  $("p-import-record").addEventListener("click", () => openRecordImport(navigation.project));
  $("record-dialog").addEventListener("close", () => { ui.context = null; });

  function cancelCreation() {
    ui.context = null;
    if ($("record-dialog").open) $("record-dialog").close();
  }

  return { openRecordImport, cancelCreation };
}
