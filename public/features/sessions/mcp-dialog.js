import { $, AGENT_LABEL, el } from "../../shared/dom.js";

const STATUS_LABEL = {
  connected: "연결됨", failed: "연결 실패", "needs-auth": "인증 필요", pending: "연결 중",
  disabled: "사용 안 함", disconnected: "연결 끊김", unknown: "확인되지 않음",
};
const AUTH_LABEL = {
  authenticated: "인증됨", unauthenticated: "인증 필요", "not-authenticated": "인증 필요",
  "not-required": "인증 불필요", unsupported: "인증 상태 확인 미지원", unknown: "인증 상태 미확인",
  bearerToken: "토큰 인증", oAuth: "OAuth 인증", notLoggedIn: "로그인 필요",
};

// 세션의 MCP 상태를 조회한다. 창을 닫거나 세션을 바꾸면 이전 조회·작업 결과는 버린다.
export function createMcpDialog({ api, getSession }) {
  const dialog = $("mcp-dialog");
  let target = null;
  let revision = 0;
  let busy = false;
  let snapshot = null;

  function reset() {
    revision++;
    target = null;
    snapshot = null;
    busy = false;
  }

  function close() {
    reset();
    if (dialog.open) dialog.close();
  }

  function syncSession() {
    if (!target) return;
    const session = getSession();
    if (!session || session.chat || session.id !== target.id || session.agent !== target.agent) close();
  }

  function isCurrent(ticket) {
    syncSession();
    return dialog.open && target !== null && ticket === revision;
  }

  function setText(id, text) {
    const node = $(id);
    node.textContent = text || "";
    node.hidden = !text;
  }

  function controls() {
    $("mcp-refresh").disabled = busy;
    $("mcp-reload").hidden = !(snapshot?.live && snapshot.actions?.reload);
    $("mcp-reload").disabled = busy;
    $("mcp-servers").setAttribute("aria-busy", String(busy));
    for (const button of dialog.querySelectorAll(".mcp-reconnect")) button.disabled = busy;
  }

  function render(result) {
    snapshot = result;
    const checked = new Date(result.checkedAt);
    const when = Number.isFinite(checked.getTime()) ? ` · ${checked.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 확인` : "";
    $("mcp-context").textContent = `${result.live ? "현재 세션의 연결 상태" : "조회용 연결 결과"}${when}`;
    setText("mcp-message", result.message);
    const expanded = new Set([...$("mcp-servers").querySelectorAll(".mcp-server")]
      .filter((node) => node.querySelector(".mcp-tools")?.open).map((node) => node.dataset.serverName));
    $("mcp-servers").replaceChildren(...result.servers.map((server) => {
      const status = Object.hasOwn(STATUS_LABEL, server.status) ? server.status : "unknown";
      const tools = Array.isArray(server.tools) ? server.tools : [];
      const name = String(server.name ?? "이름 없는 서버");
      const toolsView = el("details", { class: "mcp-tools" },
        el("summary", {}, `도구 ${tools.length}개`),
        tools.length ? el("ul", { class: "mcp-tool-list" }, ...tools.map((tool) => el("li", {},
          el("code", {}, tool.name), tool.description ? el("p", {}, tool.description) : null)))
          : el("p", { class: "mcp-empty-tools" }, "표시할 도구가 없습니다."));
      toolsView.open = expanded.has(name);
      return el("article", { class: "mcp-server", "data-server-name": name },
        el("div", { class: "mcp-server-head" },
          el("h4", {}, name),
          el("span", { class: "pill mcp-status", "data-status": status }, STATUS_LABEL[status]),
          result.live && result.actions?.reconnect ? el("button", {
            type: "button", class: "sm mcp-reconnect", "aria-label": `${name} 다시 연결`,
            onclick: () => perform("reconnect", name),
          }, "다시 연결") : null),
        typeof server.authStatus === "string" && server.authStatus
          ? el("p", { class: "mcp-auth" }, AUTH_LABEL[server.authStatus] ?? `인증 · ${server.authStatus}`) : null,
        server.error ? el("p", { class: "mcp-server-error" }, server.error) : null,
        toolsView);
    }));
    if (!result.servers.length) $("mcp-servers").append(el("p", { class: "mcp-empty" }, "표시할 MCP 서버가 없습니다."));
  }

  async function load(ticket, path, message = "") {
    const result = await api("GET", path);
    if (!isCurrent(ticket)) return;
    if (!Array.isArray(result?.servers)) throw Error("MCP 서버 목록을 읽지 못했습니다. 새로고침해 다시 확인하세요.");
    render(result);
    setText("mcp-feedback", message);
  }

  async function refresh() {
    syncSession();
    if (!target || !dialog.open || busy) return;
    const ticket = ++revision;
    const path = `/api/sessions/${encodeURIComponent(target.id)}/mcp`;
    busy = true;
    setText("mcp-error", "");
    setText("mcp-feedback", "MCP 서버를 확인하고 있습니다…");
    controls();
    try {
      await load(ticket, path);
    } catch (error) {
      if (!isCurrent(ticket)) return;
      setText("mcp-feedback", "");
      setText("mcp-error", error.message || "MCP 서버를 확인하지 못했습니다.");
    } finally {
      if (isCurrent(ticket)) { busy = false; controls(); }
    }
  }

  async function perform(action, serverName) {
    syncSession();
    if (!target || !dialog.open || busy || !snapshot?.live || !snapshot.actions?.[action]) return;
    const ticket = ++revision;
    const path = `/api/sessions/${encodeURIComponent(target.id)}/mcp`;
    busy = true;
    setText("mcp-error", "");
    setText("mcp-feedback", action === "reconnect" ? `${serverName}에 다시 연결하고 있습니다…` : "MCP 설정을 다시 읽고 있습니다…");
    controls();
    let message = "";
    try {
      const result = await api("POST", `${path}/${action}`, action === "reconnect" ? { serverName } : undefined);
      if (!isCurrent(ticket)) return;
      message = typeof result?.message === "string" ? result.message : "";
      setText("mcp-feedback", message);
      await load(ticket, path, message);
    } catch (error) {
      if (!isCurrent(ticket)) return;
      setText("mcp-feedback", message);
      setText("mcp-error", error.message || "MCP 작업을 완료하지 못했습니다.");
    } finally {
      if (isCurrent(ticket)) {
        busy = false;
        controls();
      }
    }
  }

  function open() {
    const session = getSession();
    if (!session || session.chat) return;
    reset();
    target = { id: session.id, agent: session.agent };
    $("mcp-session").textContent = `${session.title || "세션"} · ${AGENT_LABEL[session.agent] ?? session.agent}`;
    $("mcp-context").textContent = "";
    $("mcp-servers").replaceChildren();
    setText("mcp-message", "");
    setText("mcp-error", "");
    setText("mcp-feedback", "");
    controls();
    if (!dialog.open) dialog.showModal();
    return refresh();
  }

  $("mcp-refresh").addEventListener("click", refresh);
  $("mcp-reload").addEventListener("click", () => perform("reload"));
  $("mcp-close").addEventListener("click", close);
  dialog.addEventListener("close", () => { if (!dialog.open) reset(); });
  return { open, close, syncSession };
}
