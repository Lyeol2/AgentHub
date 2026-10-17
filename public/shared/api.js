/** Browser HTTP transport. All feature controllers use this client. */
export function createApiClient({ fetch: request = globalThis.fetch } = {}) {
  return async function api(method, url, body) {
    const res = await request(url, {
      method,
      headers: { "Content-Type": "application/json", "X-AgentHub": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `요청 실패 (${res.status})`), {
      reason: data.reason, status: res.status, outcomeUnknown: data.outcomeUnknown === true,
      ...(typeof data.recoveryId === "string" && /^[0-9]{13}-[0-9a-f-]{36}$/.test(data.recoveryId) ? { recoveryId: data.recoveryId } : {}),
    });
    return data;
  };
}
