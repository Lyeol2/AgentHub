import { $, el } from "../../shared/dom.js";

// 아트 레퍼런스 노드의 설정 칸. 폴더의 이미지를 썸네일로 보이고, 이미지마다 메모·태그를 적는다.
export const artrefImageUrl = (node, name) => `/api/commands/${encodeURIComponent(node.id)}/artref/image?name=${encodeURIComponent(name)}`;

const readData = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
  reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
  reader.readAsDataURL(file);
});

export function createArtrefForm({ api, onChanged }) {
  let editing = null;

  function renderImages(node) {
    const images = node?.images ?? [];
    $("artref-files").disabled = !node?.id;
    $("artref-images-hint").textContent = node?.id ? "폴더에 직접 넣은 이미지도 여기에 나타납니다. 메모·태그는 AI가 먼저 읽는 INDEX.md에 적힙니다." : "저장하면 폴더를 만들고 이미지를 넣을 수 있습니다.";
    $("artref-images").replaceChildren(...(images.length ? images.map((name) => {
      const item = node.items?.[name] ?? {};
      return el("li", { class: "artref-image", "data-name": name },
        el("img", { src: artrefImageUrl(node, name), alt: name, loading: "lazy" }),
        el("div", { class: "artref-image-fields" },
          el("span", { class: "artref-image-name mono", title: name }, name),
          el("input", { class: "artref-note", value: item.note ?? "", placeholder: "메모 (예: 버튼 모양 참고)", "aria-label": `${name} 메모` }),
          el("input", { class: "artref-tags", value: (item.tags ?? []).join(", "), placeholder: "태그 (예: 색, UI)", "aria-label": `${name} 태그` })));
    }) : [el("li", { class: "muted" }, node?.id ? "아직 이미지가 없습니다." : "")]));
  }

  // 이미지를 넣으면 바로 폴더에 저장한다(노드 저장과 별개). 적어 둔 메모는 그대로 둔다.
  $("artref-files").addEventListener("change", async () => {
    const files = [...$("artref-files").files];
    $("artref-files").value = "";
    if (!editing || !files.length) return;
    try {
      let images = editing.images ?? [];
      for (const file of files) images = (await api("POST", `/api/commands/${editing.id}/artref/images`, { name: file.name, data: await readData(file) })).images;
      const notes = items();
      editing = { ...editing, images, items: { ...(editing.items ?? {}), ...notes } };
      renderImages(editing);
      await onChanged?.();
    } catch (error) { $("command-error").textContent = error.message; }
  });

  function items() {
    const result = {};
    for (const row of $("artref-images").querySelectorAll(".artref-image")) {
      const note = row.querySelector(".artref-note").value.trim();
      const tags = row.querySelector(".artref-tags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
      if (note || tags.length) result[row.dataset.name] = { note, tags };
    }
    return result;
  }

  function fill(node) {
    editing = node?.id ? node : null;
    $("artref-folder").value = node?.folder ?? "";
    $("artref-folder-state").textContent = node?.folderPath ? `폴더: ${node.folderPath} · 이 노드를 세션에 이으면 세션이 요청을 받을 때마다 이 폴더를 알려 주고, 대화가 요약되면 다시 열어 보게 합니다.` : "비우면 프로젝트의 references/<이름> 폴더를 만듭니다.";
    $("artref-style").value = node?.style ?? "";
    $("artref-palette").value = (node?.palette ?? []).join(" ");
    renderImages(node);
  }

  function body() {
    return { folder: $("artref-folder").value.trim() || undefined, style: $("artref-style").value, palette: $("artref-palette").value, items: items() };
  }

  return { fill, body };
}
