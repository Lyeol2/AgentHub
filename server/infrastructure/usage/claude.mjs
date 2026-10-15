// OAuth HTTP 요청의 주소·인증 헤더·제한 시간은 외부 API 어댑터에 둔다.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export function createClaudeUsageReader({ fetch: fetchUsage = globalThis.fetch } = {}) {
  return async (accessToken) => {
    const response = await fetchUsage(USAGE_URL, {
      headers: { Authorization: "Bearer " + accessToken, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    return {
      ok: response.ok,
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      usage: response.ok ? await response.json() : null,
    };
  };
}
