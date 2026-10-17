import test from "node:test";
import assert from "node:assert/strict";
import { createHttpServer } from "../server/transport/http.mjs";
import { HttpError } from "../server/application/errors.mjs";
import { createApiClient } from "../public/shared/api.js";

test("Git recovery identity and uncertain outcome survive the HTTP and browser clients", async () => {
  const recoveryId = "1234567890123-11111111-2222-3333-4444-555555555555";
  const server = createHttpServer({
    getPort: () => server.address().port,
    handleApi: (_request, _response, url) => {
      throw new HttpError(409, "복구 기록을 확인하세요.", "git-recovery-required", { outcomeUnknown: true, recoveryId: url.searchParams.has("invalid") ? "../private-file" : recoveryId });
    },
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const api = createApiClient();
    const address = "http://127.0.0.1:" + server.address().port + "/api/git/execute";
    await assert.rejects(() => api("POST", address, { previewId: "fixture" }), error => {
      assert.equal(error.recoveryId, recoveryId);
      assert.equal(error.outcomeUnknown, true);
      assert.equal(error.reason, "git-recovery-required");
      return true;
    });
    await assert.rejects(() => api("POST", address + "?invalid=1", {}), error => {
      assert.equal(Object.hasOwn(error, "recoveryId"), false);
      return true;
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
