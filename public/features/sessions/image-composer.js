import { $, el } from "../../shared/dom.js";

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", pdf: "application/pdf" };
export const attachmentType = (file) => file.type?.toLowerCase() || EXT_TYPES[file.name?.split(".").pop()?.toLowerCase()] || "application/octet-stream";
export const isPreviewImage = (type) => IMAGE_TYPES.has(type);

export function validateAttachments(files, existing = 0) {
  if (existing + files.length > MAX_ATTACHMENTS) throw Error("파일은 한 요청에 최대 4개까지 첨부할 수 있습니다.");
  for (const file of files) {
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_ATTACHMENT_BYTES || (!file.size && isPreviewImage(attachmentType(file)))) {
      throw Error("파일 하나는 10 MiB 이하여야 하며, 이미지 파일은 비어 있을 수 없습니다.");
    }
  }
}

export function readAttachmentData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(Error("파일을 읽지 못했습니다. 다시 첨부해 주세요."));
    reader.readAsDataURL(file);
  });
}

// Uploads are cached per destination, so retrying a failed message does not upload again.
export async function uploadAttachments(api, sessionId, items, read = readAttachmentData) {
  const attachments = [];
  for (const item of items) {
    if (item.uploaded?.sessionId !== sessionId) {
      const attachment = await api("POST", "/api/sessions/" + sessionId + "/attachments", {
        name: item.file.name || "attachment", mimeType: attachmentType(item.file), data: await read(item.file),
      });
      item.uploaded = { sessionId, attachment };
    }
    attachments.push(item.uploaded.attachment.id);
  }
  return attachments;
}

export function transferFiles(transfer) {
  if ([...(transfer?.items ?? [])].some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
    throw Error("폴더는 첨부할 수 없습니다. 폴더 안의 파일을 선택해 주세요.");
  }
  const files = [...(transfer?.files ?? [])];
  return files.length ? files : [...(transfer?.items ?? [])].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
}

const fileIcon = (name = "") => el("span", { class: "attachment-file-icon", "aria-hidden": "true" }, name.includes(".") ? name.split(".").pop().slice(0, 7).toUpperCase() : "FILE");
const release = (item) => { if (item.url) URL.revokeObjectURL(item.url); };

// Drafts belong to a conversation. Late clipboard and upload results retain that destination.
export function createAttachmentComposer({ prefix, onChange }) {
  const form = $(prefix + "-form"), input = $(prefix + "-prompt");
  const picker = $(prefix + "-files"), tray = $(prefix + "-attachments"), error = $(prefix + "-attachment-error");
  const drafts = new Map();
  let key = null, busy = false, nextId = 0, dragDepth = 0, keyboardPaste = null;
  const draft = () => drafts.get(key);
  const render = () => {
    const items = draft()?.items ?? [];
    tray.hidden = !items.length;
    tray.replaceChildren(...items.map((item) => {
      const remove = el("button", { type: "button", class: "attachment-remove", title: "첨부 제거", "aria-label": item.file.name + " 첨부 제거", onclick: () => {
        if (busy) return;
        draft().items = draft().items.filter((entry) => entry !== item);
        release(item);
        error.textContent = "";
        render(); onChange();
      } }, "×");
      remove.disabled = busy;
      return el("li", { class: "attachment-preview" + (item.url ? "" : " file") }, item.url ? el("img", { src: item.url, alt: item.file.name }) : fileIcon(item.file.name),
        el("span", { class: "attachment-name", title: item.file.name }, item.file.name), remove);
    }));
    $(prefix + "-attach").disabled = busy;
    picker.disabled = busy;
  };
  const add = (files, destination = key, revision = drafts.get(destination)?.revision) => {
    const saved = drafts.get(destination);
    if (busy || !saved || saved.revision !== revision || !files.length) return;
    try {
      validateAttachments(files, saved.items.length);
      saved.items.push(...files.map((file) => ({ id: ++nextId, file, url: isPreviewImage(attachmentType(file)) ? URL.createObjectURL(file) : null })));
      if (key === destination) { error.textContent = ""; render(); onChange(); }
    } catch (err) { if (key === destination) error.textContent = err.message; }
  };
  const readNativeClipboard = (operation) => {
    const read = window.agenthubDesktop?.readClipboardFiles;
    if (!read || busy || !draft()) return;
    Promise.resolve().then(() => read()).then((items) => {
      if (operation.browserHandled || !items?.length) return;
      const files = items.map((item) => new File([Uint8Array.from(atob(item.data), (char) => char.charCodeAt(0))], item.name || "attachment", { type: item.mimeType || "application/octet-stream" }));
      operation.nativeHandled = true;
      add(files, operation.key, operation.revision);
    }).catch((err) => {
      if (!operation.browserHandled && key === operation.key) error.textContent = err.message || "클립보드 파일을 읽지 못했습니다.";
    });
  };
  const pasteOperation = () => ({ key, revision: draft()?.revision, browserHandled: false, nativeHandled: false });
  $(prefix + "-attach").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => { add([...picker.files]); picker.value = ""; });
  form.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.repeat && !event.isComposing && event.key.toLowerCase() === "v") {
      keyboardPaste = pasteOperation();
      readNativeClipboard(keyboardPaste);
    }
  });
  form.addEventListener("keyup", (event) => { if (event.key.toLowerCase() === "v") keyboardPaste = null; });
  input.addEventListener("blur", () => { keyboardPaste = null; });
  form.addEventListener("paste", (event) => {
    try {
      const files = transferFiles(event.clipboardData), operation = keyboardPaste ?? pasteOperation();
      if (files.length) {
        event.preventDefault();
        operation.browserHandled = true;
        if (!operation.nativeHandled) add(files, operation.key, operation.revision);
      } else if (!keyboardPaste && !event.clipboardData?.getData("text/plain") && !event.clipboardData?.getData("text/html")) {
        readNativeClipboard(operation);
      }
    } catch (err) { event.preventDefault(); error.textContent = err.message; }
  });
  const fileDrag = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files") || event.dataTransfer?.files?.length || [...(event.dataTransfer?.items ?? [])].some((item) => item.kind === "file");
  const resetDrag = () => { dragDepth = 0; form.classList.remove("file-drag"); };
  form.addEventListener("dragenter", (event) => { if (fileDrag(event)) { event.preventDefault(); dragDepth++; form.classList.add("file-drag"); } });
  form.addEventListener("dragover", (event) => { if (fileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } });
  form.addEventListener("dragleave", () => { if (--dragDepth <= 0) resetDrag(); });
  form.addEventListener("dragend", resetDrag);
  window.addEventListener("blur", resetDrag);
  form.addEventListener("drop", (event) => {
    if (!fileDrag(event)) return;
    event.preventDefault(); resetDrag();
    try { add(transferFiles(event.dataTransfer)); } catch (err) { error.textContent = err.message; }
  });
  window.addEventListener("pagehide", (event) => { if (!event.persisted) for (const value of drafts.values()) for (const item of value.items) release(item); });
  return {
    activate(nextKey) {
      if (key === nextKey) return;
      if (draft()) draft().text = input.value;
      key = nextKey; keyboardPaste = null; dragDepth = 0; form.classList.remove("file-drag");
      if (!drafts.has(key)) drafts.set(key, { text: "", items: [], revision: 0 });
      input.value = draft().text;
      error.textContent = ""; render();
    },
    count: () => draft()?.items.length ?? 0,
    snapshot: () => ({ key, items: [...(draft()?.items ?? [])], text: input.value }),
    setBusy(value) { if (busy === value) return; busy = value; render(); },
    commit(snapshot) {
      const saved = drafts.get(snapshot.key);
      if (!saved) return;
      saved.revision++;
      const sent = new Set(snapshot.items);
      saved.items = saved.items.filter((item) => !sent.has(item));
      for (const item of snapshot.items) release(item);
      if (key === snapshot.key) {
        if (input.value === snapshot.text) input.value = "";
        saved.text = input.value;
        render(); onChange();
      } else if (saved.text === snapshot.text) saved.text = "";
    },
  };
}

export function renderAttachmentLinks(attachments = []) {
  return el("div", { class: "event-attachments" }, ...attachments.filter((item) => /^\/api\/sessions\/[^/]+\/attachments\/[^/]+$/.test(item.url ?? "")).map((item) => {
    const image = isPreviewImage(item.mimeType);
    return el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer", title: item.name, ...(image ? {} : { class: "file", download: item.name || "attachment" }) },
      image ? el("img", { src: item.url, alt: item.name, loading: "lazy" }) : fileIcon(item.name), el("span", {}, item.name));
  }));
}
