import { $, el } from "../../shared/dom.js";

// GitHub 계정 연결. 로그인은 gh CLI의 브라우저 로그인을 그대로 쓰고, 진행은 CLI 설치·로그인 창에서 보여 준다.
export function createAccountController({ api, openSetup, onChange = () => {} }) {
  let account = null;

  const avatar = (user, size) => user.avatarUrl
    ? el("img", { class: "account-avatar", src: user.avatarUrl + (user.avatarUrl.includes("?") ? "&" : "?") + "s=" + size * 2, alt: "", width: String(size), height: String(size) })
    : el("span", { class: "account-avatar placeholder", "aria-hidden": "true" }, user.login.slice(0, 1).toUpperCase());

  async function loadAccount(fresh = false) {
    try {
      account = await api("GET", "/api/account" + (fresh ? "?fresh=1" : ""));
    } catch {
      account = { installed: false, connected: false };
    }
    render();
    onChange(account);
    return account;
  }

  async function connect() {
    try {
      const result = await api("POST", "/api/account/connect");
      if (result.login) openSetup("gh");
      account = result;
      render();
      onChange(account);
    } catch (err) {
      if (err.reason === "gh-missing") openSetup("gh", "install");
      else alert(err.message);
    }
  }

  async function disconnect() {
    const logout = confirm("GitHub CLI에서도 로그아웃할까요?\n\n확인: gh 로그아웃까지 합니다(Pull Request 기능도 다시 로그인해야 합니다).\n취소: AgentHub에서만 연결을 해제합니다.");
    try {
      account = await api("POST", "/api/account/disconnect", { logout });
    } catch (err) {
      alert(err.message);
    }
    render();
    onChange(account);
  }

  function render() {
    const box = $("account-box");
    const settings = $("account-settings");
    const a = account;
    if (a?.connected) {
      const name = a.user.name ? `${a.user.name} (@${a.user.login})` : `@${a.user.login}`;
      box.replaceChildren(el("div", { class: "account-line", title: `GitHub ${name}로 연결됨` }, avatar(a.user, 20), el("span", { class: "account-name" }, a.user.login)));
      settings.replaceChildren(el("div", { class: "account-row" }, avatar(a.user, 32),
        el("div", { class: "account-who" }, el("b", {}, a.user.name || a.user.login), el("a", { href: a.user.url, target: "_blank", rel: "noopener noreferrer", class: "muted" }, `github.com/${a.user.login}`)),
        el("span", { class: "spacer" }),
        el("button", { type: "button", class: "ghost sm", onclick: disconnect }, "연결 해제")));
      return;
    }
    const label = a && !a.installed ? "GitHub CLI 설치" : "GitHub 계정 연결";
    const action = () => (a && !a.installed ? openSetup("gh", "install") : connect());
    box.replaceChildren(el("button", { type: "button", class: "account-connect", onclick: action, title: "팀원에게 작업을 보내고 받으려면 GitHub 계정을 연결하세요" }, label));
    settings.replaceChildren(el("div", { class: "account-row" },
      el("span", { class: "muted" }, a?.error ?? (a && !a.installed ? "GitHub CLI가 없습니다." : "연결된 계정이 없습니다. 팀 작업(받은 작업·작업 보내기)에 GitHub 계정이 필요합니다.")),
      el("span", { class: "spacer" }),
      el("button", { type: "button", class: "sm", onclick: action }, label)));
  }

  return { loadAccount, connect, account: () => account };
}
