import { $, el } from "../../shared/dom.js";

export const FLOW_KINDS = ["input", "repeat", "transform", "watch", "notify"];
export const KIND_LABEL = { command: "명령", button: "버튼", markdown: "MD 출력", group: "결과 모으기", git: "GIT", input: "입력 폼", repeat: "반복 제어", transform: "결과 가공", watch: "파일 감시", notify: "알림" };
export const kindOf = (node) => Object.hasOwn(KIND_LABEL, node?.kind) ? node.kind : "command";
export const hasBranchPorts = (node) => ["git", "repeat"].includes(node?.kind);
export const isSourceOnly = (node) => ["button", "input", "watch"].includes(node?.kind);
export const KIND_HINT = {
  notify: "앞 노드의 결과를 앱 알림으로 보여 주고 다음 노드로 전달합니다. 메시지에 {{input}}와 입력값 {{key}}를 사용할 수 있습니다. 데스크톱 알림과 소리는 흐름 알림 설정에서 허용하세요.",
  input: "실행할 때 입력 폼을 엽니다. 입력값은 이번 실행과 뒤따르는 노드에서만 사용합니다. 프롬프트와 연결의 전달 내용에 {{key}}를 쓰세요. 명령에서는 입력값을 AGENTHUB_KEY 환경 변수로 읽습니다(예: PowerShell $env:AGENTHUB_TASK, Bash $AGENTHUB_TASK).",
  repeat: "성공 출력을 반복할 작업에 연결하고, 작업의 실패 출력을 이 노드로 되돌리세요. 같은 실행에서 최대 횟수까지 다시 시도하며, 한도를 넘으면 실패 출력으로 넘깁니다. 성공한 작업은 다음 노드로 연결합니다.",
  transform: "앞 노드의 결과를 AI 없이 가공합니다. JSON은 점으로 구분한 필드 경로, 줄 선택은 검색할 문구, 템플릿은 {{input}}와 입력값 {{key}}를 사용합니다. 결과 보기에서 출력 내용을 확인할 수 있습니다.",
  watch: "▶를 누른 뒤 지정한 파일이나 폴더의 변경을 감시합니다. 짧은 시간 안의 변경은 모아서 연결된 작업을 시작합니다. 중지하면 감시를 해제하며, 앱을 다시 열면 직접 시작해야 합니다.",
};

export function createFlowNodeForms() {
  let resolveRun = null;
  function addField(field = {}) {
    const row = el("div", { class: "flow-input-field" });
    const key = el("input", { class: "flow-field-key mono", placeholder: "task", "aria-label": "변수 이름", pattern: "[A-Za-z_][A-Za-z0-9_]*", maxlength: "64", required: "" });
    key.value = field.key ?? "";
    const label = el("input", { class: "flow-field-label", placeholder: "작업 내용", "aria-label": "입력 항목 이름", maxlength: "100", required: "" });
    label.value = field.label ?? "";
    const type = el("select", { class: "flow-field-type", "aria-label": "입력 종류" }, el("option", { value: "text" }, "한 줄"), el("option", { value: "textarea" }, "여러 줄"), el("option", { value: "number" }, "숫자"));
    type.value = field.type ?? "text";
    const initial = el("input", { class: "flow-field-default", placeholder: "기본값 (선택)", "aria-label": "기본값" });
    initial.value = field.defaultValue ?? "";
    const required = el("input", { type: "checkbox", class: "flow-field-required" }); required.checked = !!field.required;
    row.append(el("label", {}, "변수 이름", key), el("label", {}, "표시 이름", label), el("label", {}, "종류", type), el("label", {}, "기본값", initial), el("label", { class: "check" }, required, " 필수"), el("button", { type: "button", class: "ghost sm", "aria-label": "입력 항목 제거", onclick: () => row.remove() }, "제거"));
    $("input-fields").append(row);
  }
  $("input-field-add").addEventListener("click", () => addField());
  $("transform-mode").addEventListener("change", syncTransform);
  function syncTransform() {
    const mode = $("transform-mode").value;
    $("transform-expression-row").hidden = mode === "template";
    $("transform-template-row").hidden = mode !== "template";
    $("transform-expression-label").textContent = mode === "json" ? "JSON 필드 경로" : "포함할 문구";
    $("transform-expression").placeholder = mode === "json" ? "예: result.failures (비우면 JSON 전체)" : "예: FAIL (비우면 빈 줄 제외)";
  }
  function fill(kind, cmd) {
    for (const name of FLOW_KINDS) $(name + "-settings").hidden = kind !== name;
    // Hidden required controls must not block a different kind of node.
    $("input-fields").replaceChildren();
    if (kind === "input") for (const field of cmd?.fields ?? [{ key: "task", label: "작업 내용", type: "textarea", required: true }]) addField(field);
    $("input-prompt").value = cmd?.prompt ?? "{{task}}";
    $("repeat-max").value = cmd?.maxIterations ?? 3;
    $("repeat-delay").value = cmd?.delayMs ?? 0;
    $("transform-mode").value = cmd?.transformMode ?? "json";
    $("transform-expression").value = cmd?.expression ?? "";
    $("transform-template").value = cmd?.template ?? "{{input}}";
    $("watch-paths").value = (cmd?.watchPaths ?? ["src"]).join("\n");
    $("watch-debounce").value = cmd?.debounceMs ?? 500;
    $("watch-prompt").value = cmd?.prompt ?? "변경된 파일을 확인하고 필요한 작업을 진행해 주세요.\n{{paths}}";
    $("notify-message").value = cmd?.message ?? "{{input}}";
    $("notify-title").value = cmd?.notificationTitle ?? "AgentHub";
    $("notify-level").value = cmd?.level ?? "info";
    $("notify-sound").checked = cmd?.sound === true;
    syncTransform();
  }
  function body(kind) {
    if (kind === "input") return { fields: [...$("input-fields").children].map((row) => ({ key: row.querySelector(".flow-field-key").value.trim(), label: row.querySelector(".flow-field-label").value.trim(), type: row.querySelector(".flow-field-type").value, required: row.querySelector(".flow-field-required").checked, defaultValue: row.querySelector(".flow-field-default").value })), prompt: $("input-prompt").value };
    if (kind === "repeat") return { maxIterations: Number($("repeat-max").value), delayMs: Number($("repeat-delay").value) };
    if (kind === "transform") return { transformMode: $("transform-mode").value, expression: $("transform-expression").value, template: $("transform-template").value };
    if (kind === "notify") return { message: $("notify-message").value, notificationTitle: $("notify-title").value, level: $("notify-level").value, sound: $("notify-sound").checked };
    if (kind === "watch") return { watchPaths: $("watch-paths").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), debounceMs: Number($("watch-debounce").value), prompt: $("watch-prompt").value };
    return {};
  }
  function collect(cmd) {
    if (resolveRun) return Promise.resolve(null);
    $("input-run-heading").textContent = cmd.title + " · 실행 입력";
    $("input-run-fields").replaceChildren(...(cmd.fields ?? []).map((field) => {
      const input = el(field.type === "textarea" ? "textarea" : "input", { name: field.key, ...(field.type === "textarea" ? { rows: "4" } : { type: field.type === "number" ? "number" : "text", ...(field.type === "number" ? { step: "any" } : {}) }), ...(field.required ? { required: "" } : {}), "data-value-type": field.type });
      input.value = field.defaultValue ?? "";
      return el("label", {}, field.label + (field.required ? " *" : ""), input);
    }));
    $("input-run-dialog").showModal();
    return new Promise((resolve) => { resolveRun = resolve; });
  }
  $("input-run-form").addEventListener("submit", (event) => {
    if (event.submitter?.value !== "run") return;
    event.preventDefault();
    const values = {};
    for (const input of $("input-run-fields").querySelectorAll("input, textarea")) values[input.name] = input.dataset.valueType === "number" && input.value !== "" ? Number(input.value) : input.value;
    const resolve = resolveRun; resolveRun = null;
    $("input-run-dialog").close(); resolve?.(values);
  });
  $("input-run-dialog").addEventListener("close", () => { const resolve = resolveRun; resolveRun = null; resolve?.(null); });
  function cancel() { if ($("input-run-dialog").open) $("input-run-dialog").close(); }
  return { fill, body, collect, cancel };
}
