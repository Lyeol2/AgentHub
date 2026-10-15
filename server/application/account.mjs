// GitHub 계정 연결. 토큰은 gh가 OS 키체인에 보관하고 AgentHub는 저장하지 않는다.
// 연결 해제는 기본으로 AgentHub에서만 숨기고, 원하면 gh 로그아웃까지 한다.
import { runGitHubCommand } from "../github.mjs";
import { locateCli } from "../cli.mjs";
import { HttpError } from "./errors.mjs";

const CACHE_MS = 60_000;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

export function createAccountService({ config, setup, saveConfig, locate = () => locateCli("gh", ""), run = runGitHubCommand }) {
  config.account ??= { hidden: false };
  let cache = null;

  async function readUser(file) {
    const user = JSON.parse(await run(file, ["api", "--hostname", "github.com", "user"], { timeout: 15_000 }));
    if (!LOGIN.test(String(user.login ?? ""))) throw new Error("GitHub 계정을 확인하지 못했습니다.");
    return {
      login: user.login, name: String(user.name ?? ""), id: Number(user.id) || null,
      avatarUrl: /^https:\/\//.test(user.avatar_url ?? "") ? user.avatar_url : "",
      url: "https://github.com/" + user.login,
    };
  }

  async function status(fresh = false) {
    const file = locate();
    if (!file) return { installed: false, connected: false, hidden: !!config.account.hidden };
    if (config.account.hidden) return { installed: true, connected: false, hidden: true };
    if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    let value;
    try {
      value = { installed: true, connected: true, hidden: false, user: await readUser(file) };
    } catch (error) {
      value = { installed: true, connected: false, hidden: false, error: error.timedOut ? "GitHub 응답 시간이 초과되었습니다." : null };
    }
    cache = { at: Date.now(), value };
    return value;
  }

  function persist(hidden) {
    config.account.hidden = hidden;
    saveConfig(config);
    cache = null;
  }

  // 이미 gh에 로그인되어 있으면 바로 연결하고, 아니면 gh 브라우저 로그인을 시작한다.
  async function connect() {
    if (!locate()) throw new HttpError(400, "GitHub CLI가 없습니다. 먼저 설치하세요.", "gh-missing");
    persist(false);
    const current = await status(true);
    if (current.connected) return { ...current, login: null };
    try {
      return { ...current, login: setup.login("gh") };
    } catch (error) {
      throw new HttpError(409, error.message);
    }
  }

  async function disconnect({ logout = false } = {}) {
    const file = locate();
    const before = cache?.value?.user?.login;
    if (logout && file) {
      const args = ["auth", "logout", "--hostname", "github.com", ...(before ? ["--user", before] : [])];
      try { await run(file, args, { timeout: 15_000 }); }
      catch (error) { throw new HttpError(409, "gh 로그아웃에 실패했습니다: " + error.message); }
    }
    persist(true);
    return status(true);
  }

  return { status, connect, disconnect, forget: () => { cache = null; } };
}
