import { $, el, timeAgo } from "../../shared/dom.js";

// 3D 생성 노드(Meshy·Tripo)의 설정 칸과 결과 기록. 단계·묶음·도구 목록은 서버(/api/gen3d)가 내려 준다.
export const GEN3D_STEP_LABEL = { generate: "모양 만들기", refine: "다듬기", texture: "질감", remesh: "형태 정리", rig: "뼈대", animate: "움직임", convert: "형식 변환" };
const PROVIDER_STEPS = { meshy: ["generate", "refine", "texture", "remesh", "rig", "animate"], tripo: Object.keys(GEN3D_STEP_LABEL) };
const PRESETS = {
  draft: { label: "빠른 시안", steps: ["generate"] },
  prop: { label: "게임 소품", steps: ["generate", "refine", "remesh"], format: "glb" },
  character: { label: "캐릭터", steps: ["generate", "refine", "rig", "animate"], format: "fbx" },
  unity: { label: "Unity용", steps: ["generate", "refine", "remesh", "convert"], format: "fbx" },
};
const STATUS_LABEL = { success: "완료", failed: "실패", skipped: "건너뜀" };

export const gen3dFileUrl = (node, file) => `/api/commands/${encodeURIComponent(node.id)}/gen3d/file?path=${encodeURIComponent(file)}`;
// 카드·기록에 보일 썸네일: 마지막으로 성공한 단계의 썸네일
export const gen3dThumbnail = (run) => [...(run?.steps ?? [])].reverse().find((step) => step.thumbnail)?.thumbnail ?? null;
export const gen3dSummary = (node) => (node.steps ?? []).map((step) => GEN3D_STEP_LABEL[step] ?? step).join(" → ");

export function createGen3dForm({ api, onRun, onChanged }) {
  let providers = null; // /api/gen3d 결과(키 설정 여부)
  let editing = null;
  $("gen3d-preset").append(...Object.entries(PRESETS).map(([id, preset]) => el("option", { value: id }, preset.label)));
  $("gen3d-steps").append(...Object.entries(GEN3D_STEP_LABEL).map(([id, label]) =>
    el("label", { class: "check gen3d-step", "data-step": id }, el("input", { type: "checkbox", value: id }), ` ${label}`)));

  const checked = () => [...$("gen3d-steps").querySelectorAll("input:checked")].map((input) => input.value);
  function sync() {
    const provider = $("gen3d-provider").value;
    const supported = PROVIDER_STEPS[provider];
    for (const row of $("gen3d-steps").children) {
      const ok = supported.includes(row.dataset.step);
      row.hidden = !ok;
      if (!ok) row.querySelector("input").checked = false;
    }
    const steps = checked();
    const first = steps[0];
    const image = $("gen3d-input-mode").value === "image";
    $("gen3d-input-mode").closest("label").hidden = first !== "generate";
    $("gen3d-prompt-row").hidden = first !== "generate" || image;
    $("gen3d-image-row").hidden = first !== "generate" || !image;
    $("gen3d-chain-hint").hidden = !first || first === "generate";
    $("gen3d-polycount-row").hidden = !steps.includes("remesh");
    $("gen3d-animation-row").hidden = !steps.includes("animate");
    $("gen3d-height-row").hidden = !(steps.includes("rig") && provider === "meshy");
    $("gen3d-texture-row").hidden = !steps.some((step) => ["texture", "refine"].includes(step));
    const info = providers?.find((item) => item.id === provider);
    $("gen3d-key-state").textContent = !providers ? "" : info?.configured
      ? `${info.label} API 키가 설정되어 있습니다.`
      : `${info?.label ?? provider} API 키가 없습니다. 설정 → 3D 생성 도구에서 키를 넣어야 실행할 수 있습니다.`;
    $("gen3d-key-state").classList.toggle("error", !!providers && !info?.configured);
  }
  for (const id of ["gen3d-provider", "gen3d-input-mode"]) $(id).addEventListener("change", sync);
  $("gen3d-steps").addEventListener("change", () => { $("gen3d-preset").value = ""; sync(); });
  $("gen3d-preset").addEventListener("change", () => {
    const preset = PRESETS[$("gen3d-preset").value];
    if (!preset) return;
    const supported = PROVIDER_STEPS[$("gen3d-provider").value];
    for (const input of $("gen3d-steps").querySelectorAll("input")) input.checked = preset.steps.includes(input.value) && supported.includes(input.value);
    if (preset.format) $("gen3d-format").value = preset.format;
    sync();
  });

  async function loadProviders() {
    try { providers = (await api("GET", "/api/gen3d")).providers; }
    catch { providers = null; }
    sync();
  }

  // node: 편집할 노드, 또는 새 노드의 처음 값({ provider, steps })
  function fill(node, active) {
    editing = node?.id ? node : null;
    const options = node?.options ?? {};
    $("gen3d-provider").value = node?.provider ?? "meshy";
    $("gen3d-preset").value = "";
    const steps = node?.steps ?? ["generate"];
    for (const input of $("gen3d-steps").querySelectorAll("input")) input.checked = steps.includes(input.value);
    $("gen3d-input-mode").value = node?.inputMode ?? "text";
    $("gen3d-prompt").value = node?.prompt ?? "{{input}}";
    $("gen3d-image").value = node?.imagePath ?? "";
    $("gen3d-format").value = options.format ?? "glb";
    $("gen3d-polycount").value = options.polycount ?? 30000;
    $("gen3d-animation").value = options.animation ?? "walk";
    $("gen3d-height").value = options.heightMeters ?? 1.7;
    $("gen3d-texture").value = options.texturePrompt ?? "";
    $("gen3d-model").value = options.aiModel ?? "";
    $("gen3d-output").value = node?.outputDir ?? "output/3d";
    $("gen3d-poll").value = node?.pollSec ?? 5;
    $("gen3d-timeout").value = node?.timeoutMin ?? 30;
    sync();
    renderHistory(editing);
    if (active) void loadProviders();
  }

  function body() {
    return {
      provider: $("gen3d-provider").value, steps: checked(), inputMode: $("gen3d-input-mode").value,
      prompt: $("gen3d-prompt").value, imagePath: $("gen3d-image").value,
      options: { format: $("gen3d-format").value, polycount: Number($("gen3d-polycount").value), animation: $("gen3d-animation").value,
        heightMeters: Number($("gen3d-height").value), texturePrompt: $("gen3d-texture").value, aiModel: $("gen3d-model").value },
      outputDir: $("gen3d-output").value, pollSec: Number($("gen3d-poll").value), timeoutMin: Number($("gen3d-timeout").value),
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

  // 실행마다 단계별 결과(썸네일·파일)를 보이고, 다시 만들기·이어 하기·다음 노드로 넘기기를 제공한다.
  function renderHistory(node = editing) {
    const box = $("gen3d-history-box");
    if (!node || node.kind !== "gen3d") { box.hidden = true; return; }
    editing = node;
    box.hidden = false;
    const runs = node.history ?? [];
    const failed = node.lastRun && !node.lastRun.ok && node.lastRun.gen3d?.steps?.some((step) => step.status === "success");
    $("gen3d-actions").replaceChildren(
      ...(failed ? [action("실패한 단계부터 이어 하기", () => onRun(node, { resume: true }), { title: "성공한 단계는 다시 만들지 않습니다" })] : []),
      ...((node.steps ?? []).length > 1 ? [action("단계 노드로 펼치기", async () => {
        if (!confirm("이 노드를 단계마다 하나씩 나눈 노드로 바꿉니다. 연결은 첫·마지막 단계로 옮겨지고, 이 노드의 결과 기록은 지워집니다. 계속할까요?")) return;
        await api("POST", `/api/commands/${node.id}/gen3d/expand`);
        $("command-dialog").close();
        await onChanged?.();
      })] : []));
    $("gen3d-history").replaceChildren(...(runs.length ? runs.map((run) => {
      const thumb = gen3dThumbnail(run);
      const model = run.model;
      const main = model ? model.files?.[model.format] ?? Object.values(model.files ?? {})[0] : null;
      return el("li", { class: `gen3d-run${run.ok ? "" : " failed"}` },
        thumb ? el("img", { class: "gen3d-thumb", src: gen3dFileUrl(node, thumb), alt: "결과 썸네일", loading: "lazy" }) : el("span", { class: "gen3d-thumb empty", "aria-hidden": "true" }, run.ok ? "3D" : "!"),
        el("div", { class: "gen3d-run-body" },
          el("div", { class: "gen3d-run-meta" }, el("strong", {}, run.ok ? "완료" : run.stopped ? "중지" : "실패"), el("span", { class: "muted", title: run.at }, ` · ${timeAgo(run.at)}`)),
          el("div", { class: "gen3d-run-steps" }, ...(run.steps ?? []).map((step) => el("span", { class: `pill gen3d-step-pill ${step.status}`, title: step.error ?? step.note ?? step.taskId ?? "" }, `${GEN3D_STEP_LABEL[step.step] ?? step.step} ${step.reused ? "· 이전 결과" : STATUS_LABEL[step.status] ?? ""}`))),
          run.error ? el("div", { class: "error gen3d-run-error" }, run.error) : null,
          main ? el("div", { class: "gen3d-run-file mono", title: main }, main) : null,
          el("div", { class: "gen3d-run-actions" },
            ...(main ? [el("button", { type: "button", class: "ghost sm", onclick: (event) => copy(main, event.currentTarget) }, "경로 복사")] : []),
            ...(run.ok && model ? [action("다음 노드로 넘기기", async () => {
              await api("POST", `/api/commands/${node.id}/gen3d/forward`, { runId: run.runId });
              await onChanged?.();
            }, { title: "다시 만들지 않고 이 결과를 연결된 다음 노드로 보냅니다" })] : []))));
    }) : [el("li", { class: "muted" }, "아직 실행 기록이 없습니다.")]));
  }

  return { fill, body, renderHistory, reload: loadProviders };
}

// 설정 창의 "3D 생성 도구": 서비스마다 API 키·주소를 저장하고 연결을 확인한다. 저장한 키는 다시 보이지 않는다.
export function createGen3dSettings({ api }) {
  const box = $("gen3d-providers");
  if (!box) return { load: () => {} };
  async function load() {
    let providers;
    try { providers = (await api("GET", "/api/gen3d")).providers; }
    catch (error) { box.replaceChildren(el("p", { class: "error" }, error.message)); return; }
    box.replaceChildren(...providers.map((provider) => {
      const key = el("input", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: provider.configured ? "저장됨 · 바꾸려면 새 키 입력" : "API 키", "aria-label": `${provider.label} API 키` });
      const url = el("input", { class: "mono", spellcheck: "false", value: provider.baseUrl === provider.defaultBaseUrl ? "" : provider.baseUrl, placeholder: provider.defaultBaseUrl, "aria-label": `${provider.label} 서비스 주소` });
      const status = el("span", { class: provider.configured ? "ok-text" : "muted", "aria-live": "polite" }, provider.configured ? "키 있음" : "키 없음");
      const button = (label, run) => el("button", { type: "button", class: "ghost sm", onclick: async (event) => {
        const target = event.currentTarget;
        target.disabled = true;
        try { await run(); } catch (error) { status.textContent = error.message; status.className = "error"; } finally { target.disabled = false; }
      } }, label);
      return el("div", { class: "gen3d-provider", "data-provider": provider.id },
        el("strong", {}, provider.label), status,
        el("label", {}, "API 키", key), el("label", {}, "서비스 주소 (비우면 기본)", url),
        el("div", { class: "gen3d-provider-actions" },
          button("저장", async () => {
            await api("PUT", `/api/gen3d/${provider.id}`, { ...(key.value.trim() ? { apiKey: key.value.trim() } : {}), baseUrl: url.value.trim() });
            await load();
          }),
          button("연결 확인", async () => {
            const result = await api("POST", `/api/gen3d/${provider.id}/check`);
            status.textContent = result.message;
            status.className = result.ok ? "ok-text" : "error";
          }),
          ...(provider.configured ? [button("키 지우기", async () => {
            if (!confirm(`${provider.label} API 키를 지울까요?`)) return;
            await api("PUT", `/api/gen3d/${provider.id}`, { apiKey: "" });
            await load();
          })] : [])));
    }));
  }
  // 설정 창을 열 때마다 새로 불러온다.
  const dialog = $("settings-dialog");
  if (dialog && globalThis.MutationObserver) new MutationObserver(() => { if (dialog.open) void load(); }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
  return { load };
}
