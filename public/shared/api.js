/** Browser HTTP transport. All feature controllers use this client. */
export function createApiClient({ fetch: request = globalThis.fetch } = {}) {
  // options.signal: 오래 걸리는 요청(AI 초안 등)을 중지할 때 쓴다.
  return async function api(method, url, body, { signal } = {}) {
    const res = await request(url, {
      method, ...(signal ? { signal } : {}),
      headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `요청 실패 (${res.status})`), {
      reason: data.reason, status: res.status, outcomeUnknown: data.outcomeUnknown === true,
      ...(typeof data.hint === "string" ? { hint: data.hint } : {}),
      ...(typeof data.raw === "string" ? { raw: data.raw } : {}),
      ...(typeof data.recoveryId === "string" && /^[0-9]{13}-[0-9a-f-]{36}$/.test(data.recoveryId) ? { recoveryId: data.recoveryId } : {}),
    });
    return data;
  };
}
