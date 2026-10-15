import { claudeEvent, claudeSnapshot, mergeClaudeUsage, parseCodexLimits } from "../policies/limits.mjs";

const USAGE_TTL = 60_000;
const USAGE_BACKOFF = 5 * 60_000;

// 한 Hub가 자기 기록·조회 캐시·요청 제한 상태를 소유한다. 파일과 OAuth API는 포트로 주입한다.
export function createLimitsService({ repository, credentials, rollouts, fetchUsage, now = Date.now }) {
  let usageCheckedAt = 0;
  let usageBlockedUntil = 0;
  let usageError = null;

  function recordClaudeLimit(info) {
    const saved = repository.load();
    const type = info.rateLimitType ?? "unknown";
    saved.claude ??= {};
    saved.claude[type] = claudeEvent(info, saved.claude[type], new Date(now()).toISOString());
    repository.save(saved);
  }

  async function refreshClaudeUsage({ fresh = false } = {}) {
    if (now() < usageBlockedUntil) return;
    if (!fresh && now() - usageCheckedAt < USAGE_TTL) return;
    usageCheckedAt = now();
    let oauth;
    try { oauth = credentials.read(); }
    catch {
      usageError = null; // OAuth 로그인이 없거나 API 키를 쓰는 경우
      return;
    }
    if (!oauth?.accessToken) return;
    if (oauth.expiresAt && oauth.expiresAt < now()) {
      usageError = "로그인 토큰이 만료되어 사용률을 읽지 못했습니다. Claude 세션을 한 번 실행하면 갱신됩니다.";
      return;
    }
    try {
      const response = await fetchUsage(oauth.accessToken);
      if (response.status === 429) {
        const retry = Number(response.retryAfter);
        const wait = Number.isFinite(retry) && retry > 0 ? Math.max(retry * 1000, USAGE_TTL) : USAGE_BACKOFF;
        usageBlockedUntil = now() + wait;
        throw new Error("사용률 조회가 잠시 막혔습니다(요청이 많음). " + Math.ceil(wait / 60_000) + "분 뒤에 다시 읽습니다.");
      }
      if (!response.ok) throw new Error("사용률 조회 실패 (HTTP " + response.status + ")");
      repository.save(mergeClaudeUsage(repository.load(), response.usage, oauth, new Date(now()).toISOString()));
      usageError = null;
    } catch (error) {
      usageError = error.message;
    }
  }

  function codexLimits() {
    for (const text of rollouts.recentTails()) {
      const limits = parseCodexLimits(text);
      if (limits) return limits;
    }
    return { windows: [], observedAt: null };
  }

  function readLimits() {
    const result = {};
    const readers = { claude: () => claudeSnapshot(repository.load(), usageError), codex: codexLimits };
    for (const [agent, read] of Object.entries(readers)) {
      try { result[agent] = read(); }
      catch (error) { result[agent] = { windows: [], observedAt: null, error: error.message }; }
    }
    return result;
  }

  return { recordClaudeLimit, refreshClaudeUsage, readLimits };
}
