import { el } from "../../shared/dom.js";
import { renderMarkdown } from "../../markdown.js";
import { collectReportReferences, classifyReportTarget, trimUrl } from "../../report-references.js";

const KIND = { image: "화면·이미지", video: "영상", markdown: "보고서", text: "검증 기록·텍스트", html: "화면", file: "파일", web: "실행 화면", session: "세션", task: "작업" };
const STATUS = { passed: "검증 통과", failed: "검증 실패", "not-run": "검증 미실행" };
const basename = (value) => String(value ?? "").replace(/\\/g, "/").split("/").pop();
const contentUrl = (session, path, download = false) => `/api/sessions/${encodeURIComponent(session.id)}/artifact/content?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
const absolute = (value) => /^(?:[a-z]:[\\/]|\/|file:)/i.test(value);

// Links inside a report resolve relative to that report, rather than the session root.
function relativeTo(value, documentPath) {
  if (!documentPath || absolute(value)) return value;
  return documentPath.replace(/\\/g, "/").replace(/[^/]*$/, "") + value;
}

// 마크다운이 아닌 글(보낸 요청·세션 메시지·상태 줄)의 http(s)·www. 주소를 새 창 링크로 만들어 node에 붙인다.
// 앞이 영문·숫자면 낱말 중간으로 보고 건너뛴다. 끝의 문장 부호와 짝 없는 닫는 괄호는 주소에서 뺀다.
const URL_IN_TEXT = /(?<![A-Za-z0-9@.\/])(?:https?:\/\/|www\.)[^\s<>"']+/gi;
export function appendLinkedText(node, text) {
  const value = String(text ?? "");
  let last = 0;
  for (const match of value.matchAll(URL_IN_TEXT)) {
    const url = trimUrl(match[0]);
    if (!/^(?:https?:\/\/|www\.[^.\s]+\.[^\s]+)/i.test(url)) continue;
    node.append(value.slice(last, match.index),
      el("a", { href: /^www\./i.test(url) ? `https://${url}` : url, target: "_blank", rel: "noreferrer", class: "text-link" }, url));
    last = match.index + url.length;
  }
  node.append(value.slice(last));
  return node;
}

export function isLocalPreviewUrl(value, origin = globalThis.location?.origin) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
    // Never embed the AgentHub UI (including the other spelling of its loopback host).
    const current = origin && new URL(origin);
    return !current || url.port !== current.port || url.protocol !== current.protocol;
  } catch { return false; }
}

export function createReportView({ api, getSession, sessionById = () => null, selectSession = () => {}, onTaskReference }) {
  let dialog, body, heading, location, toolbar, message, revision = 0;
  const metadata = new Map();
  const read = (session, path, summary = false) => api("GET", `/api/sessions/${encodeURIComponent(session.id)}/artifact?path=${encodeURIComponent(path)}${summary ? "&summary=1" : ""}`);

  async function copy(value, button) {
    const label = button?.textContent;
    try {
      try { await navigator.clipboard.writeText(value); }
      catch {
        const input = el("textarea", { class: "report-copy-buffer", "aria-label": "복사할 경로" }, value);
        (dialog?.open ? dialog : document.body).append(input);
        input.select();
        const copied = document.execCommand("copy");
        input.remove();
        if (!copied) throw Error("경로를 복사하지 못했습니다.");
      }
      if (button) {
        button.textContent = "복사됨";
        setTimeout(() => { button.textContent = label; }, 1500);
      }
    } catch (error) {
      if (message && dialog?.open) message.textContent = error.message;
      else if (button) { button.textContent = "복사 실패"; button.title = value; }
    }
  }

  function ensureDialog() {
    if (dialog) return;
    heading = el("h2", { id: "report-preview-title" });
    location = el("div", { class: "report-location" });
    toolbar = el("div", { class: "report-toolbar", role: "toolbar", "aria-label": "미리보기 도구" });
    message = el("div", { class: "report-message", role: "status", "aria-live": "polite" });
    body = el("div", { class: "report-body" });
    dialog = el("dialog", { class: "report-preview", "aria-labelledby": "report-preview-title" },
      el("header", { class: "report-preview-head" }, heading, el("button", { type: "button", class: "ghost", "aria-label": "미리보기 닫기", onclick: () => dialog.close() }, "닫기 ✕")),
      location, toolbar, message, body);
    dialog.addEventListener("close", () => { if (!dialog.open) { revision++; body.replaceChildren(); keys = {}; } });
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    // ←→ 이전·다음, + − 확대·축소, 0 맞춤. 입력칸이나 영상 조작 중이면 넘기지 않는다.
    dialog.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest?.("input, textarea, select, video")) return;
      const action = { ArrowLeft: keys.prev, ArrowRight: keys.next, "+": keys.zoomIn, "=": keys.zoomIn, "-": keys.zoomOut, "0": keys.fit }[event.key];
      if (!action) return;
      event.preventDefault();
      action();
    });
    document.body.append(dialog);
  }

  let keys = {}; // 지금 보이는 항목의 키보드 동작

  // 대화 안의 이미지·영상(첨부, 답변 속 참조)을 화면 순서대로 모은다. 미리보기 창에서 이전·다음으로 넘긴다.
  function mediaGallery(root) {
    const seen = new Set(), items = [];
    for (const node of root?.querySelectorAll?.(".event-attachments a[href]:not(.file), a.report-ref[data-report-image], a.report-ref[data-report-video]") ?? []) {
      const ref = node.matches(".event-attachments a")
        ? { url: node.getAttribute("href"), label: node.title || node.textContent, kind: "image" }
        : referenceFromAnchor(node);
      const key = ref.path || ref.url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(ref);
    }
    return items;
  }

  const mediaKey = (ref) => ref?.path || ref?.url;

  // 이전·다음 버튼과 썸네일 줄. 갤러리에 지금 항목이 있을 때만 보인다.
  function renderNavigation(ref, session, gallery) {
    const index = gallery.findIndex((item) => mediaKey(item) === mediaKey(ref));
    if (gallery.length < 2 || index < 0) return;
    const go = (step) => open(gallery[(index + step + gallery.length) % gallery.length], session, gallery);
    keys.prev = () => go(-1);
    keys.next = () => go(1);
    toolbar.append(button("이전", keys.prev, { title: "이전 (←)" }), el("span", { class: "muted report-position" }, `${index + 1} / ${gallery.length}`), button("다음", keys.next, { title: "다음 (→)" }));
    // 썸네일은 지금 항목 앞뒤로 30개까지 그린다.
    const from = Math.max(0, index - 30), shown = gallery.slice(from, index + 31);
    const strip = el("div", { class: "report-strip", role: "list", "aria-label": "이 대화의 이미지·영상" }, ...shown.map((item, offset) => {
      const active = from + offset === index;
      const thumb = item.kind === "video"
        ? el("span", { class: "report-strip-video", "aria-hidden": "true" }, "▶")
        : el("img", { src: item.path ? contentUrl(session, item.path) : item.url, alt: "", loading: "lazy" });
      return el("button", { type: "button", role: "listitem", class: `report-strip-item${active ? " active" : ""}`, title: item.label || basename(mediaKey(item)), "aria-current": active ? "true" : "false", onclick: () => { if (!active) void open(item, session, gallery); } }, thumb);
    }));
    body.append(strip);
    strip.querySelector(".active")?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }

  const button = (label, action, attrs = {}) => el("button", { type: "button", class: "ghost sm", onclick: action, ...attrs }, label);

  async function open(ref, session = getSession(), gallery = []) {
    if (!session) return;
    if (ref.sessionId) {
      if (!sessionById(ref.sessionId)) return showError(ref, "세션을 찾을 수 없습니다.");
      if (dialog?.open) dialog.close();
      try { await selectSession(ref.sessionId); } catch (error) { showError(ref, error.message); }
      return;
    }
    if (ref.taskId) {
      try {
        if (!onTaskReference) throw Error("작업을 찾을 수 없습니다.");
        if (dialog?.open) dialog.close();
        await onTaskReference(ref.taskId, session.projectPath);
      } catch (error) { showError(ref, error.message); }
      return;
    }
    ensureDialog();
    keys = {};
    const request = ++revision;
    heading.textContent = ref.label || basename(ref.path || ref.url);
    location.textContent = ref.path || ref.url || "";
    toolbar.replaceChildren(button("경로 복사", (event) => copy(ref.path || ref.url, event.currentTarget)));
    message.textContent = "불러오는 중…";
    body.replaceChildren();
    if (!dialog.open) dialog.showModal();
    if (ref.url) {
      if (ref.kind === "video" && /^https?:\/\//.test(ref.url)) {
        message.textContent = "";
        renderVideo(ref.url, ref.label);
        toolbar.append(el("a", { class: "ghost sm", href: ref.url, target: "_blank", rel: "noopener noreferrer" }, "원본 열기"));
        renderNavigation(ref, session, gallery);
        return;
      }
      if (ref.kind === "image" && /^(https?:\/\/|\/api\/sessions\/[^/]+\/attachments\/)/.test(ref.url)) {
        message.textContent = "";
        renderImage(ref.url, ref.label);
        toolbar.append(el("a", { class: "ghost sm", href: ref.url, target: "_blank", rel: "noopener noreferrer" }, "원본 열기"));
        renderNavigation(ref, session, gallery);
        return;
      }
      if (!isLocalPreviewUrl(ref.url)) {
        message.textContent = "실행 화면은 AgentHub와 다른 포트의 로컬 앱 주소로 열 수 있습니다.";
      } else {
        const frame = el("iframe", { class: "report-frame", title: ref.label || "실행 화면", sandbox: "allow-scripts allow-same-origin allow-forms", referrerpolicy: "no-referrer", src: ref.url });
        body.append(frame);
        message.textContent = "화면이 표시되지 않으면 새 창으로 열어 주세요.";
        toolbar.append(button("새로고침", () => { frame.src = ref.url; }));
      }
      if (/^https?:\/\//.test(ref.url)) toolbar.append(el("a", { class: "ghost sm", href: ref.url, target: "_blank", rel: "noopener noreferrer" }, "새 창으로 열기"));
      return;
    }
    try {
      const item = await read(session, ref.path);
      if (revision !== request || !dialog.open) return;
      location.textContent = item.path;
      toolbar.replaceChildren(button("경로 복사", (event) => copy(item.path, event.currentTarget)),
        el("a", { class: "ghost sm", href: contentUrl(session, item.path, true), download: item.name }, "다운로드"));
      const desktop = globalThis.agenthubDesktop;
      if (desktop?.openArtifact) {
        for (const [action, label] of [["open", "파일 열기"], ["reveal", "폴더에서 보기"]]) toolbar.append(button(label, async () => {
          try { await desktop.openArtifact({ sessionId: session.id, path: item.path, action }); }
          catch (error) { message.textContent = error.message; }
        }));
      }
      message.textContent = item.truncated ? "미리보기는 파일의 앞부분입니다. 전체 내용은 다운로드로 확인하세요." : "";
      if (item.kind === "image") renderImage(contentUrl(session, item.path), item.name);
      else if (item.kind === "video") renderVideo(contentUrl(session, item.path), item.name);
      if (["image", "video"].includes(item.kind)) renderNavigation(ref, session, gallery);
      else if (["markdown", "text", "html"].includes(item.kind)) renderDocument(item, session);
      else body.append(el("p", { class: "muted" }, "이 형식은 다운로드하거나 기본 앱으로 열어 확인할 수 있습니다."));
    } catch (error) {
      if (revision !== request || !dialog.open) return;
      message.textContent = error.status === 404 ? "파일을 찾을 수 없습니다. 이동되었거나 다른 환경에서 만든 경로일 수 있습니다." : error.message;
      body.append(el("p", { class: "muted" }, "위 경로를 복사해 파일 위치를 확인할 수 있습니다."));
    }
  }

  function renderVideo(url, name) {
    const video = el("video", { class: "report-video", controls: "", preload: "metadata", playsinline: "", src: url, "aria-label": name || "영상 미리보기" });
    video.addEventListener("error", () => { message.textContent = "영상을 재생하지 못했습니다. 파일 위치나 브라우저가 지원하는 영상 형식인지 확인하세요."; });
    body.append(video);
  }

  function showError(ref, text) {
    ensureDialog(); revision++;
    heading.textContent = ref.label || "참조";
    location.textContent = ref.sessionId || ref.taskId || "";
    toolbar.replaceChildren(); body.replaceChildren(); message.textContent = text;
    if (!dialog.open) dialog.showModal();
  }

  // 맞춤으로 시작한다. 휠로 마우스 위치를 기준으로 확대·축소하고, 끌어서 옮기고, 두 번 누르면 원본 크기와 맞춤을 오간다.
  function renderImage(url, name) {
    const image = el("img", { src: url, alt: name || "화면 미리보기", class: "report-full-image", draggable: "false" });
    const viewport = el("div", { class: "report-image-viewport", tabindex: "0" }, image);
    let zoom = null; // null: 맞춤
    const scaleLabel = el("span", { class: "muted report-scale", "aria-live": "polite" }, "맞춤");
    const fitted = () => image.getBoundingClientRect().width / (image.naturalWidth || 1);
    const setZoom = (next, at) => {
      const before = zoom ?? fitted();
      zoom = Math.max(.1, Math.min(8, next));
      // 확대 기준점(마우스 위치)이 그 자리에 머물도록 스크롤을 옮긴다.
      const box = viewport.getBoundingClientRect();
      const x = (at?.x ?? box.left + box.width / 2) - box.left, y = (at?.y ?? box.top + box.height / 2) - box.top;
      const left = (viewport.scrollLeft + x) / before, top = (viewport.scrollTop + y) / before;
      image.style.maxWidth = "none"; image.style.maxHeight = "none";
      image.style.width = `${(image.naturalWidth || 800) * zoom}px`;
      viewport.classList.add("zoomed");
      viewport.scrollLeft = left * zoom - x; viewport.scrollTop = top * zoom - y;
      scaleLabel.textContent = `${Math.round(zoom * 100)}%`;
    };
    const fit = () => { image.removeAttribute("style"); viewport.classList.remove("zoomed"); zoom = null; scaleLabel.textContent = "맞춤"; };
    keys.zoomIn = () => setZoom((zoom ?? fitted()) * 1.25);
    keys.zoomOut = () => setZoom((zoom ?? fitted()) / 1.25);
    keys.fit = fit;
    viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      setZoom((zoom ?? fitted()) * Math.exp(-event.deltaY * 0.0015), { x: event.clientX, y: event.clientY });
    }, { passive: false });
    image.addEventListener("dblclick", (event) => (zoom === null ? setZoom(1, { x: event.clientX, y: event.clientY }) : fit()));
    let drag = null;
    viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || zoom === null) return;
      drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture?.(event.pointerId);
      viewport.classList.add("dragging");
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!drag) return;
      viewport.scrollLeft = drag.left - (event.clientX - drag.x);
      viewport.scrollTop = drag.top - (event.clientY - drag.y);
    });
    const stop = () => { drag = null; viewport.classList.remove("dragging"); };
    viewport.addEventListener("pointerup", stop);
    viewport.addEventListener("pointercancel", stop);
    image.addEventListener("error", () => { message.textContent = "이미지를 불러오지 못했습니다. 경로나 원본 파일을 확인하세요."; });
    image.addEventListener("load", () => { if (image.naturalWidth) location.title = `${image.naturalWidth} × ${image.naturalHeight}px`; });
    toolbar.append(button("−", keys.zoomOut, { "aria-label": "이미지 축소", title: "축소 (−)" }), scaleLabel,
      button("+", keys.zoomIn, { "aria-label": "이미지 확대", title: "확대 (+)" }), button("맞춤", fit, { title: "맞춤 (0)" }), button("100%", () => setZoom(1), { title: "원본 크기" }));
    body.append(viewport);
  }

  function renderDocument(item, session) {
    const raw = el("pre", { class: "report-source", tabindex: "0" }, item.text ?? "");
    let target;
    if (item.line) {
      const lines = (item.text ?? "").split("\n");
      if (item.line <= lines.length) {
        target = el("span", { class: "report-target-line", tabindex: "-1", "aria-label": `${item.line}행` }, lines[item.line - 1] || " ");
        raw.replaceChildren(item.line > 1 ? lines.slice(0, item.line - 1).join("\n") + "\n" : "", target,
          item.line < lines.length ? "\n" + lines.slice(item.line).join("\n") : "");
      } else message.textContent = [message.textContent, "참조한 줄이 미리보기 범위를 벗어납니다."].filter(Boolean).join(" · ");
    }
    const rendered = el("div", { class: "report-document md" });
    if (item.kind === "markdown") {
      rendered.innerHTML = renderMarkdown(item.text, { sessionId: session.id });
      enhance(rendered, item.text, { session, basePath: item.path, showCards: false });
    } else if (item.kind === "html" && item.previewHtml) {
      rendered.append(el("iframe", { class: "report-frame", title: item.name, sandbox: "allow-scripts", referrerpolicy: "no-referrer", src: `/api/sessions/${encodeURIComponent(session.id)}/artifact/preview?path=${encodeURIComponent(item.path)}` }));
    }
    const hasPreview = item.kind === "markdown" || (item.kind === "html" && !!item.previewHtml);
    raw.hidden = hasPreview;
    rendered.hidden = !hasPreview;
    const previewButton = button("미리보기", () => setMode(false));
    const sourceButton = button("원문", () => setMode(true));
    function setMode(source) {
      raw.hidden = !source; rendered.hidden = source;
      previewButton.setAttribute("aria-pressed", String(!source));
      sourceButton.setAttribute("aria-pressed", String(source));
    }
    if (hasPreview) { toolbar.append(previewButton, sourceButton); setMode(!!item.line); }
    if (item.kind === "html") message.textContent = [message.textContent, ...(item.previewWarnings ?? [])].filter(Boolean).join(" · ");
    body.append(rendered, raw);
    if (target) requestAnimationFrame(() => { if (target.isConnected && !raw.hidden) target.scrollIntoView({ block: "center" }); });
  }

  function referenceFromAnchor(anchor, basePath) {
    return { label: anchor.textContent, path: anchor.dataset.reportPath ? relativeTo(anchor.dataset.reportPath, basePath) : undefined,
      url: anchor.dataset.reportUrl, sessionId: anchor.dataset.reportSession, taskId: anchor.dataset.reportTask,
      kind: anchor.dataset.reportImage === "true" ? "image" : anchor.dataset.reportVideo === "true" ? "video" : anchor.dataset.reportUrl ? "web" : undefined };
  }

  function enhance(node, text, { references, session = getSession(), showCards = true, basePath } = {}) {
    if (!session) return;
    const refs = collectReportReferences(text, { references }).map((ref) => ({ ...ref, ...(ref.path ? { path: relativeTo(ref.path, basePath) } : {}) }));
    const gallery = refs.filter((ref) => ref.kind === "image");
    node.addEventListener("click", (event) => {
      const anchor = event.target.closest("[data-report-path],[data-report-url],[data-report-session],[data-report-task]");
      if (!anchor || !node.contains(anchor)) return;
      event.preventDefault();
      const ref = referenceFromAnchor(anchor, basePath);
      // 대화 기록 안이면 대화 전체의 이미지·영상을 넘겨 볼 수 있게 한다.
      const list = node.closest(".events");
      void open(ref, session, list && ["image", "video"].includes(ref.kind) ? mediaGallery(list) : gallery);
    });
    if (!showCards) return;
    const artifacts = refs.filter((ref) => ref.path || ["image", "video"].includes(ref.kind) || (ref.url && isLocalPreviewUrl(ref.url))).slice(0, 24);
    if (!artifacts.length) return;
    const cards = el("div", { class: "report-cards" });
    for (const ref of artifacts) {
      const status = el("span", { class: "report-card-state" }, KIND[ref.kind] || "파일");
      const primary = button(ref.label || basename(ref.path || ref.url), () => open(ref, session, gallery), { class: "report-card-open", title: ref.path || ref.url });
      const card = el("article", { class: "report-card", "data-report-kind": ref.kind },
        el("div", { class: "report-card-info" }, status, primary,
          ref.status && STATUS[ref.status] ? el("span", { class: `report-verification ${ref.status}` }, STATUS[ref.status]) : null),
        button("경로 복사", (event) => copy(ref.path || ref.url, event.currentTarget), { class: "ghost sm report-card-copy" }));
      if (ref.kind === "image") {
        const image = el("img", { alt: ref.label || basename(ref.path || ref.url), loading: "lazy" });
        const thumbnail = button("", () => open(ref, session, gallery), { class: "report-thumbnail", "aria-label": `${ref.label || "이미지"} 확대` });
        thumbnail.append(image); card.prepend(thumbnail);
        // Local thumbnails use the same checked API as file previews. Remote images load only on click.
        if (ref.path) image.src = contentUrl(session, ref.path);
        else if (ref.url?.startsWith("/api/sessions/")) image.src = ref.url;
        else { image.hidden = true; thumbnail.append(el("span", {}, "이미지 보기")); }
        image.addEventListener("error", () => { image.hidden = true; status.textContent = "이미지를 불러오지 못했습니다"; card.classList.add("unavailable"); });
      }
      if (ref.path) {
        const key = session.id + "\0" + ref.path;
        let pending = metadata.get(key);
        if (!pending || Date.now() - pending.at > 5000) {
          pending = { at: Date.now(), promise: read(session, ref.path, true) }; metadata.set(key, pending);
          if (metadata.size > 128) metadata.delete(metadata.keys().next().value);
        }
        pending.promise.then((item) => { status.textContent = KIND[item.kind] || "파일"; }, (error) => {
          status.textContent = error.status === 404 ? "파일을 찾을 수 없음" : "미리보기 불가";
          status.title = error.message; card.classList.add("unavailable");
        });
      }
      cards.append(card);
    }
    node.append(el("section", { class: "report-results", "aria-label": "결과물" }, el("div", { class: "report-results-title" }, `결과물 · ${artifacts.length}개`), cards));
  }

  function renderUser(node, text, references = []) {
    const refs = references.filter((ref) => ref && typeof ref.path === "string" && typeof ref.label === "string");
    const matches = [];
    for (const ref of refs) {
      // 뒤에 글이 붙은 참조는 공백이 없어도 따옴표로 감싸 보낸다.
      const words = [`@"${ref.path}"`, ...(/\s/.test(ref.path) ? [] : [`@${ref.path}`]), ref.path];
      for (const word of words) {
        let start = text.indexOf(word);
        while (start !== -1) {
          const before = start ? text[start - 1] : "";
          const after = text.slice(start + word.length);
          const startsWord = !before || /[\s([<{"']/.test(before);
          // 따옴표로 감싼 참조는 뒤에 조사가 붙어도 된다("@\"경로\"에").
          const endsWord = !after || word.endsWith('"') || /^[\s)\]}>"',;!?]/.test(after) || /^\.(?:\s|$)/.test(after);
          if (startsWord && endsWord) matches.push({ start, end: start + word.length, ref });
          start = text.indexOf(word, start + word.length);
        }
      }
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    let end = 0;
    for (const match of matches) {
      if (match.start < end) continue;
      appendLinkedText(node, text.slice(end, match.start));
      const { ref } = match;
      const target = classifyReportTarget(ref.path);
      const attrs = target?.sessionId ? { "data-report-session": target.sessionId } : target?.taskId ? { "data-report-task": target.taskId } : { "data-report-path": ref.path };
      node.append(el("a", { href: "#", class: "report-ref mention-chip", title: ref.path, ...attrs }, `@${ref.label}`));
      end = match.end;
    }
    appendLinkedText(node, text.slice(end));
    enhance(node, text, { references, showCards: false });
  }

  return { enhance, renderUser, open, mediaGallery };
}
