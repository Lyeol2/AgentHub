import { $, el } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";

// 세션 흐름 아래에 고정한 AI 입력창. 요청을 보내면 AI가 만든 작업 목록을 보여 주고, 적용을 누르면 그래프에 반영한다.
// 고른 카드가 있으면 함께 보내므로 "이 세션 역할을 테스터로 바꿔 줘"처럼 쓸 수 있다.
export function createFlowAssistant({ api, navigation, getSelected, onApplied }) {
  const prompt = $("p-flow-assistant-prompt");
  let pending = null; // { projectPath, tabId, actions }
  let request = 0;
  let busy = false;
  let notice = ""; // 적용 결과. 다음 입력 전까지 선택 개수 대신 보여 준다.
  const sameGraph = (projectPath, tabId) => samePath(projectPath, navigation.project) && tabId === navigation.graphTabId;

  function status(text = "") { $("p-flow-assistant-status").textContent = text; }
  function error(text = "") {
    $("p-flow-assistant-error").textContent = text;
    $("p-flow-assistant-error").hidden = !text;
  }
  function sync() {
    prompt.disabled = busy;
    $("p-flow-assistant-send").disabled = busy || !prompt.value.trim();
    $("p-flow-assistant-apply").disabled = busy || !pending?.actions.length;
    if (!busy) {
      const count = getSelected().length;
      status(notice || (count ? `선택 ${count}개 함께 보냄` : ""));
    }
  }
  // 입력한 줄 수만큼 늘린다(최대 높이는 CSS). 비어 있으면 한 줄 높이로 돌아간다.
  function grow() {
    prompt.style.height = "";
    if (!prompt.value || !prompt.scrollHeight || prompt.scrollHeight <= prompt.clientHeight) return;
    prompt.style.height = `${prompt.scrollHeight + prompt.offsetHeight - prompt.clientHeight}px`;
  }

  function showPlan(summary, actions) {
    $("p-flow-assistant-summary").textContent = summary || (actions.length ? "다음 작업을 적용할까요?" : "할 작업이 없습니다.");
    $("p-flow-assistant-steps").replaceChildren(...actions.map((action) => el("li", {}, action.text)));
    $("p-flow-assistant-plan").hidden = false;
  }

  function reset() {
    request++;
    pending = null;
    busy = false;
    notice = "";
    error();
    $("p-flow-assistant-plan").hidden = true;
    sync();
  }

  async function ask(e) {
    e.preventDefault();
    const text = prompt.value.trim();
    const projectPath = navigation.project;
    const tabId = navigation.graphTabId;
    if (!text || busy || !projectPath) return;
    const mine = ++request;
    busy = true;
    pending = null;
    notice = "";
    error();
    $("p-flow-assistant-plan").hidden = true;
    sync();
    status("AI가 작업을 정리하는 중…");
    try {
      const result = await api("POST", "/api/flow-assistant/plan", { projectPath, ...(tabId ? { tabId } : {}), prompt: text, selected: getSelected() });
      if (mine !== request || !sameGraph(projectPath, tabId)) return;
      pending = { projectPath, tabId, actions: result.actions ?? [] };
      showPlan(result.summary, pending.actions);
    } catch (err) {
      if (mine !== request || !sameGraph(projectPath, tabId)) return;
      showPlan("", []);
      $("p-flow-assistant-summary").textContent = "작업을 만들지 못했습니다.";
      error(err.message);
    } finally {
      if (mine === request) { busy = false; sync(); }
    }
  }

  async function apply() {
    if (!pending?.actions.length || busy) return;
    const { projectPath, tabId, actions } = pending;
    if (!sameGraph(projectPath, tabId)) return reset();
    const mine = ++request;
    busy = true;
    error();
    sync();
    status("적용하는 중…");
    try {
      const result = await api("POST", "/api/flow-assistant/apply", { projectPath, ...(tabId ? { tabId } : {}), actions });
      if (mine !== request) return;
      if (!sameGraph(projectPath, tabId)) return reset();
      prompt.value = "";
      grow();
      reset();
      const appliedRequest = request;
      // 그래프를 다시 불러오고 새 노드를 고른 뒤에 끝났다고 알린다.
      await onApplied(result.created ?? [], { projectPath, tabId });
      if (appliedRequest !== request || !sameGraph(projectPath, tabId)) return;
      notice = `${result.done.length}개 작업을 적용했습니다.`;
      sync();
    } catch (err) {
      if (mine !== request || !sameGraph(projectPath, tabId)) return;
      error(err.message);
      busy = false;
      sync();
    }
  }

  $("p-flow-assistant").addEventListener("submit", ask);
  prompt.addEventListener("input", () => { notice = ""; grow(); sync(); });
  prompt.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    $("p-flow-assistant").requestSubmit();
  });
  $("p-flow-assistant-apply").addEventListener("click", apply);
  $("p-flow-assistant-cancel").addEventListener("click", () => { reset(); prompt.focus(); });
  sync();

  // 프로젝트를 옮기면 보여 주던 작업 목록은 버린다. 선택이 바뀌면 함께 보낼 개수를 고친다.
  return { reset, selectionChanged: sync };
}
