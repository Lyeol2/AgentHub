const seqValue = (value) => Number.isSafeInteger(value) && value >= -1 ? value : -1;

export function mergeSessionRead(session, incoming = {}) {
  session.lastResultSeq = Math.max(seqValue(session.lastResultSeq), seqValue(incoming.lastResultSeq));
  session.readResultSeq = Math.max(seqValue(session.readResultSeq), seqValue(incoming.readResultSeq));
  session.unread = session.lastResultSeq > session.readResultSeq;
  return session;
}

export function applySessionRead(data, sessionId, incoming) {
  const targets = new Set([data.sessions.find((session) => session.id === sessionId), data.current?.id === sessionId ? data.current : null]);
  for (const session of targets) if (session) mergeSessionRead(session, incoming);
}

// 세션을 선택했어도 숨겨진 창이나 예전 대화를 보는 중이면 최신 결과를 읽은 것이 아니다.
export function createSessionReadTracker({ api, data, navigation, eventsList, onChange, doc = document, win = window }) {
  const pending = new Map();
  let disposed = false;

  function visibleResult() {
    const session = data.current;
    if (disposed || !session || session.locked || !["session", "chat"].includes(navigation.view) || doc.hidden || !doc.hasFocus() || doc.querySelector("dialog[open]")) return null;
    const list = eventsList();
    if (!list || list.scrollHeight - list.scrollTop - list.clientHeight >= 80) return null;
    const result = session.events?.findLast((event) => event.kind === "result");
    if (!result || seqValue(result.seq) <= seqValue(session.readResultSeq)) return null;
    return { id: session.id, seq: result.seq };
  }

  async function readCurrent() {
    const viewed = visibleResult();
    if (!viewed || pending.has(viewed.id)) return;
    const { id, seq } = viewed;
    pending.set(id, seq);
    try {
      const state = await api("POST", `/api/sessions/${id}/read`, { seq });
      if (disposed) return;
      applySessionRead(data, id, state);
      onChange?.();
    } catch {
      // 일시적인 통신 오류에는 배지를 남긴다. 다음 열기·포커스·스크롤에서 다시 시도한다.
    } finally {
      pending.delete(id);
      const next = visibleResult();
      if (next?.id === id && next.seq > seq) void readCurrent();
    }
  }

  const check = () => { void readCurrent(); };
  win.addEventListener("focus", check);
  doc.addEventListener("visibilitychange", check);
  doc.addEventListener("scroll", check, true);
  doc.addEventListener("close", check, true);
  return {
    readCurrent,
    dispose() {
      disposed = true;
      win.removeEventListener("focus", check);
      doc.removeEventListener("visibilitychange", check);
      doc.removeEventListener("scroll", check, true);
      doc.removeEventListener("close", check, true);
    },
  };
}
