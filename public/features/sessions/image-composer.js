import { $, el } from "../../shared/dom.js";

export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 100 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", pdf: "application/pdf" };
export const attachmentType = (file) => file.type?.toLowerCase() || EXT_TYPES[file.name?.split(".").pop()?.toLowerCase()] || "application/octet-stream";
export const isPreviewImage = (type) => IMAGE_TYPES.has(type);

// existingBytes: 이미 붙인 파일의 크기 합계
export function validateAttachments(files, existing = 0, existingBytes = 0) {
  if (existing + files.length > MAX_ATTACHMENTS) throw Error(`파일은 한 요청에 최대 ${MAX_ATTACHMENTS}개까지 첨부할 수 있습니다.`);
  for (const file of files) {
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_ATTACHMENT_BYTES || (!file.size && isPreviewImage(attachmentType(file)))) {
      throw Error("파일 하나는 20 MiB 이하여야 하며, 이미지 파일은 비어 있을 수 없습니다.");
    }
  }
  if (existingBytes + files.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENTS_TOTAL_BYTES) throw Error("한 요청에 붙인 파일은 합계 100 MiB까지 보낼 수 있습니다.");
}

export function readAttachmentData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(Error("파일을 읽지 못했습니다. 다시 첨부해 주세요."));
    reader.readAsDataURL(file);
  });
}

// AI가 한 장에 받을 수 있는 이미지 크기(Claude: 5 MB, 긴 변 8000px). 넘으면 보낼 때 줄인다.
export const AGENT_IMAGE_BYTES = 5 * 1024 * 1024;
export const AGENT_IMAGE_EDGE = 8000;

// 큰 PNG·JPEG·WebP를 긴 변 8000px 안에서 5 MB 아래가 될 때까지 줄여 JPEG로 바꾼다. 줄일 수 없으면 원본을 돌려준다.
export async function shrinkForAgent(file, { decode = globalThis.createImageBitmap, canvas = (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h }) } = {}) {
  const type = attachmentType(file);
  if (!["image/png", "image/jpeg", "image/webp"].includes(type) || !decode) return file;
  let bitmap;
  try { bitmap = await decode(file); } catch { return file; }
  if (file.size <= AGENT_IMAGE_BYTES && Math.max(bitmap.width, bitmap.height) <= AGENT_IMAGE_EDGE) return file;
  let scale = Math.min(1, AGENT_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 6; attempt++, scale *= 0.8) {
    const board = canvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const context = board.getContext("2d");
    context.fillStyle = "#fff"; // 투명 배경은 JPEG에서 검게 되지 않게 흰색으로 채운다.
    context.fillRect(0, 0, board.width, board.height);
    context.drawImage(bitmap, 0, 0, board.width, board.height);
    const blob = await new Promise((resolve) => board.toBlob(resolve, "image/jpeg", 0.9));
    if (blob && blob.size <= AGENT_IMAGE_BYTES) return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg", lastModified: file.lastModified });
  }
  return file;
}

// Uploads are cached per destination, so retrying a failed message does not upload again.
export async function uploadAttachments(api, sessionId, items, read = readAttachmentData, shrink = shrinkForAgent) {
  const attachments = [];
  for (const item of items) {
    if (item.uploaded?.sessionId !== sessionId) {
      const file = await shrink(item.file);
      const attachment = await api("POST", "/api/sessions/" + sessionId + "/attachments", {
        name: file.name || "attachment", mimeType: attachmentType(file), data: await read(file),
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
      // 같은 파일(이름·크기·수정 시각이 같음)을 다시 넣으면 한 번만 붙인다.
      const same = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
      files = files.filter((file, i) => !saved.items.some((item) => same(item.file, file)) && files.findIndex((other) => same(other, file)) === i);
      if (!files.length) return;
      validateAttachments(files, saved.items.length, saved.items.reduce((sum, item) => sum + (item.file?.size ?? 0), 0));
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
