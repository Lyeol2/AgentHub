import { $, el } from "../../shared/dom.js";

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export const imageType = (file) => file.type || EXT_TYPES[file.name?.split(".").pop()?.toLowerCase()] || "";

export function validateImages(files, existing = 0) {
  if (existing + files.length > MAX_IMAGES) throw Error("이미지는 한 요청에 최대 4장까지 첨부할 수 있습니다.");
  for (const file of files) {
    if (!IMAGE_TYPES.has(imageType(file))) throw Error("PNG·JPEG·GIF·WebP 이미지만 첨부할 수 있습니다.");
    if (!file.size || file.size > MAX_IMAGE_BYTES) throw Error("이미지 한 장은 0바이트보다 크고 10 MiB 이하여야 합니다.");
  }
}

export function readImageData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(Error("이미지를 읽지 못했습니다. 다시 첨부해 주세요."));
    reader.readAsDataURL(file);
  });
}

// Uploads are cached per destination, so retrying a failed message does not upload again.
export async function uploadImages(api, sessionId, items, read = readImageData) {
  const attachments = [];
  for (const item of items) {
    if (item.uploaded?.sessionId !== sessionId) {
      const attachment = await api("POST", "/api/sessions/" + sessionId + "/attachments", {
        name: item.file.name || "image.png", mimeType: imageType(item.file), data: await read(item.file),
      });
      item.uploaded = { sessionId, attachment };
    }
    attachments.push(item.uploaded.attachment.id);
  }
  return attachments;
}

// Drafts belong to a conversation. Late upload results must never clear another draft.
export function createImageComposer({ prefix, onChange }) {
  const form = $(prefix + "-form"), input = $(prefix + "-prompt");
  const picker = $(prefix + "-files"), tray = $(prefix + "-attachments"), error = $(prefix + "-attachment-error");
  const drafts = new Map();
  let key = null, busy = false, nextId = 0, dragDepth = 0;
  const draft = () => drafts.get(key);
  const render = () => {
    const items = draft()?.items ?? [];
    tray.hidden = !items.length;
    tray.replaceChildren(...items.map((item) => {
      const remove = el("button", { type: "button", class: "attachment-remove", title: "첨부 제거", "aria-label": item.file.name + " 첨부 제거", onclick: () => {
        if (busy) return;
        draft().items = draft().items.filter((entry) => entry !== item);
        URL.revokeObjectURL(item.url);
        error.textContent = "";
        render(); onChange();
      } }, "×");
      remove.disabled = busy;
      return el("li", { class: "attachment-preview" }, el("img", { src: item.url, alt: item.file.name }),
        el("span", { class: "attachment-name", title: item.file.name }, item.file.name), remove);
    }));
    $(prefix + "-attach").disabled = busy;
    picker.disabled = busy;
  };
  const add = (files) => {
    if (busy || !draft() || !files.length) return;
    try {
      validateImages(files, draft().items.length);
      draft().items.push(...files.map((file) => ({ id: ++nextId, file, url: URL.createObjectURL(file) })));
      error.textContent = "";
      render(); onChange();
    } catch (err) { error.textContent = err.message; }
  };
  $(prefix + "-attach").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => { add([...picker.files]); picker.value = ""; });
  form.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault(); add(files);
  });
  const fileDrag = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
  form.addEventListener("dragenter", (event) => { if (fileDrag(event)) { event.preventDefault(); dragDepth++; form.classList.add("file-drag"); } });
  form.addEventListener("dragover", (event) => { if (fileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } });
  form.addEventListener("dragleave", (event) => { if (fileDrag(event) && --dragDepth <= 0) { dragDepth = 0; form.classList.remove("file-drag"); } });
  form.addEventListener("drop", (event) => {
    if (!fileDrag(event)) return;
    event.preventDefault(); dragDepth = 0; form.classList.remove("file-drag"); add([...event.dataTransfer.files]);
  });
  window.addEventListener("pagehide", () => { for (const value of drafts.values()) for (const item of value.items) URL.revokeObjectURL(item.url); });
  return {
    activate(nextKey) {
      if (key === nextKey) return;
      if (draft()) draft().text = input.value;
      key = nextKey;
      if (!drafts.has(key)) drafts.set(key, { text: "", items: [] });
      input.value = draft().text;
      error.textContent = ""; render();
    },
    count: () => draft()?.items.length ?? 0,
    snapshot: () => ({ key, items: [...(draft()?.items ?? [])], text: input.value }),
    setBusy(value) { if (busy === value) return; busy = value; render(); },
    commit(snapshot) {
      const saved = drafts.get(snapshot.key);
      if (!saved) return;
      const sent = new Set(snapshot.items);
      saved.items = saved.items.filter((item) => !sent.has(item));
      for (const item of snapshot.items) URL.revokeObjectURL(item.url);
      if (key === snapshot.key) {
        if (input.value === snapshot.text) input.value = "";
        saved.text = input.value;
        render(); onChange();
      } else if (saved.text === snapshot.text) saved.text = "";
    },
  };
}

export function renderAttachmentLinks(attachments = []) {
  return el("div", { class: "event-attachments" }, ...attachments.filter((item) => /^\/api\/sessions\/[^/]+\/attachments\/[^/]+$/.test(item.url ?? "")).map((item) =>
    el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer", title: item.name },
      el("img", { src: item.url, alt: item.name, loading: "lazy" }), el("span", {}, item.name))));
}
