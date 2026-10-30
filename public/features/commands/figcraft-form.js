import { $, el, timeAgo } from "../../shared/dom.js";
import { gen3dFileUrl } from "./gen3d-form.js";

// FigCraft 노드의 설정 칸과 결과 기록. 결과는 프레임별 PNG 미리보기로 보고, 원본은 FigCraft 앱에서 연다.
const basename = (file) => String(file ?? "").split(/[\\/]/).pop();
export const figcraftThumbnail = (run) => run?.previews?.[0] ?? null;

export function createFigcraftForm({ api, onChanged, openImage }) {
  let editing = null;
  let searchTimer = null;
  function sync() {
    const run = $("figcraft-action").value === "run";
    $("figcraft-run-fields").hidden = !run;
    $("figcraft-export-fields").hidden = run;
    $("figcraft-input").placeholder = run ? "선택 · 이어서 고칠 디자인 파일 (비우면 새 문서)" : "예: design/login.figcraft · {{input}}이면 앞 노드의 FigCraft 결과";
  }
  $("figcraft-action").addEventListener("change", () => {
    if ($("figcraft-action").value === "export" && !$("figcraft-input").value) $("figcraft-input").value = "{{input}}";
    sync();
  });
  // 명령 찾기: 고르면 스크립트에 한 단계를 덧붙인다.
  $("figcraft-command-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const filter = $("figcraft-command-search").value.trim();
      if (!filter) { $("figcraft-commands").replaceChildren(); return; }
      try {
        const list = await api("GET", `/api/figcraft/commands?filter=${encodeURIComponent(filter)}`);
        $("figcraft-commands").replaceChildren(...list.slice(0, 30).map((command) => el("li", {},
          el("button", { type: "button", class: "ghost sm mono", title: "스크립트에 넣기", onclick: () => addStep(command.id) }, command.id),
          el("span", { class: "muted" }, ` ${command.label}`), el("div", { class: "figcraft-params mono" }, command.params ?? ""))));
      } catch (error) { $("figcraft-commands").replaceChildren(el("li", { class: "error" }, error.message)); }
    }, 200);
  });
  function addStep(id) {
    let steps = [];
    try { steps = JSON.parse($("figcraft-script").value); } catch { steps = null; }
    if (!Array.isArray(steps)) steps = [];
    steps.push({ command: id, params: {} });
    $("figcraft-script").value = JSON.stringify(steps, null, 2);
  }

  async function loadCli() {
    try {
      const view = await api("GET", "/api/figcraft");
      $("figcraft-cli-state").textContent = view.found ? `figcraft-cli: ${view.cli}` : "figcraft-cli를 찾지 못했습니다. FigCraft를 설치하거나 설정 → FigCraft에서 경로를 정하세요.";
      $("figcraft-cli-state").classList.toggle("error", !view.found);
    } catch { $("figcraft-cli-state").textContent = ""; }
  }

  function fill(node, active) {
    editing = node?.id ? node : null;
    $("figcraft-action").value = node?.action ?? "run";
    $("figcraft-script").value = node?.script ?? "{{input}}";
    $("figcraft-input").value = node?.inputFile ?? (node?.action === "export" ? "{{input}}" : "");
    $("figcraft-format").value = node?.format ?? "png";
    $("figcraft-scale").value = node?.scale ?? 1;
    $("figcraft-page").value = node?.page ?? "";
    $("figcraft-target").value = node?.target ?? "";
    $("figcraft-output").value = node?.outputDir ?? "output/figcraft";
    $("figcraft-timeout").value = node?.timeoutSec ?? 300;
    $("figcraft-builtin-fonts").checked = node?.builtinFonts === true;
    $("figcraft-command-search").value = "";
    $("figcraft-commands").replaceChildren();
    sync();
    renderHistory(editing);
    if (active) void loadCli();
  }

  function body() {
    return {
      action: $("figcraft-action").value, script: $("figcraft-script").value, inputFile: $("figcraft-input").value,
      format: $("figcraft-format").value, scale: Number($("figcraft-scale").value), page: $("figcraft-page").value, target: $("figcraft-target").value,
      outputDir: $("figcraft-output").value, timeoutSec: Number($("figcraft-timeout").value), builtinFonts: $("figcraft-builtin-fonts").checked,
    };
  }

  const action = (label, run, attrs = {}) => el("button", { type: "button", class: "ghost sm", onclick: async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await run(); } catch (error) { $("command-error").textContent = error.message; } finally { button.disabled = false; }
  }, ...attrs }, label);
  async function copy(text, button) {
    try { await navigator.clipboard.writeText(text); button.textContent = "복사함"; }
    catch { button.textContent = "복사 실패"; button.title = text; }
    setTimeout(() => { button.textContent = "경로 복사"; }, 1500);
  }

  // 실행마다 프레임 미리보기를 썸네일로 보이고, 누르면 이미지 미리보기 창에서 확대·넘겨 본다.
  function renderHistory(node = editing) {
    const box = $("figcraft-history-box");
    if (!node || node.kind !== "figcraft") { box.hidden = true; return; }
    editing = node;
    box.hidden = false;
    const runs = node.history ?? [];
    $("figcraft-history").replaceChildren(...(runs.length ? runs.map((run) => {
      const previews = run.previews ?? [];
      const gallery = previews.map((file) => ({ url: gen3dFileUrl(node, file), label: basename(file), kind: "image" }));
      return el("li", { class: `gen3d-run figcraft-run${run.ok ? "" : " failed"}` },
        el("div", { class: "figcraft-previews" }, ...(previews.length ? previews.slice(0, 8).map((file, index) =>
          el("button", { type: "button", class: "figcraft-preview", title: `${basename(file)} 크게 보기`, onclick: () => openImage?.(gallery[index], gallery) },
            el("img", { src: gen3dFileUrl(node, file), alt: basename(file), loading: "lazy" }))) : [el("span", { class: "gen3d-thumb empty", "aria-hidden": "true" }, run.ok ? "FC" : "!")])),
        el("div", { class: "gen3d-run-body" },
          el("div", { class: "gen3d-run-meta" }, el("strong", {}, run.ok ? "완료" : run.stopped ? "중지" : "실패"),
            el("span", { class: "muted", title: run.at }, ` · ${timeAgo(run.at)}${run.frames?.length ? ` · 프레임 ${run.frames.length}개` : ""}${run.steps ? ` · 명령 ${run.steps}개` : ""}`)),
          run.error ? el("div", { class: "error gen3d-run-error" }, run.error) : null,
          run.missingFonts?.length ? el("div", { class: "hint" }, `빠진 글꼴: ${run.missingFonts.join(", ")} · 내장 글꼴만 쓰기를 켜면 어느 PC에서나 같게 그립니다.`) : null,
          run.file ? el("div", { class: "gen3d-run-file mono", title: run.file }, run.file) : null,
          ...(run.exports?.length ? [el("div", { class: "gen3d-run-file mono", title: run.exports.join("\n") }, `내보냄: ${run.exports.map(basename).join(", ")}`)] : []),
          el("div", { class: "gen3d-run-actions" },
            ...(run.file ? [el("button", { type: "button", class: "ghost sm", onclick: (event) => copy(run.file, event.currentTarget) }, "경로 복사")] : []),
            ...(run.file && run.ok ? [action("FigCraft에서 열기", () => api("POST", `/api/commands/${node.id}/figcraft/open`, { path: run.file }))] : []),
            ...(run.ok ? [action("다음 노드로 넘기기", async () => {
              await api("POST", `/api/commands/${node.id}/gen3d/forward`, { runId: run.runId });
              await onChanged?.();
            }, { title: "다시 실행하지 않고 이 결과를 연결된 다음 노드로 보냅니다" })] : []))));
    }) : [el("li", { class: "muted" }, "아직 실행 기록이 없습니다.")]));
  }

  return { fill, body, renderHistory };
}

// 설정 창의 "FigCraft": figcraft-cli 경로와 연결 확인
export function createFigcraftSettings({ api }) {
  const box = $("figcraft-settings-row");
  if (!box) return { load: () => {} };
  async function load() {
    let view;
    try { view = await api("GET", "/api/figcraft"); }
    catch (error) { box.replaceChildren(el("p", { class: "error" }, error.message)); return; }
    const input = el("input", { class: "mono", spellcheck: "false", value: view.cliPath, placeholder: view.cli ?? "figcraft-cli.exe 경로", "aria-label": "figcraft-cli 경로" });
    const status = el("span", { class: view.found ? "ok-text" : "error", "aria-live": "polite" }, view.found ? "CLI 찾음" : "CLI 없음");
    const button = (label, run) => el("button", { type: "button", class: "ghost sm", onclick: async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      try { await run(); } catch (error) { status.textContent = error.message; status.className = "error"; } finally { target.disabled = false; }
    } }, label);
    box.replaceChildren(el("strong", {}, "figcraft-cli"), status, el("label", {}, "CLI 경로 (비우면 자동으로 찾기)", input),
      el("div", { class: "gen3d-provider-actions" },
        button("저장", async () => { await api("PUT", "/api/figcraft", { cliPath: input.value.trim() }); await load(); }),
        button("연결 확인", async () => {
          const result = await api("POST", "/api/figcraft/check");
          status.textContent = result.message;
          status.className = result.ok ? "ok-text" : "error";
        })));
  }
  const dialog = $("settings-dialog");
  if (dialog && globalThis.MutationObserver) new MutationObserver(() => { if (dialog.open) void load(); }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
  return { load };
}
