import test from "node:test";
import assert from "node:assert/strict";
import { createHttpServer } from "../server/transport/http.mjs";
import { HttpError } from "../server/application/errors.mjs";
import { hintFor } from "../server/application/error-hints.mjs";
import { createApiClient } from "../public/shared/api.js";
import { errorDetails, errorReportText, errorRequestPrompt, showError } from "../public/shared/error-report.js";

test("error report: details keep message, hint, raw and uncertain outcome from API errors", () => {
  const error = Object.assign(new Error("커밋하지 않은 변경이 있습니다."), { hint: "커밋하세요.", raw: "error: local changes", reason: "git-dirty", outcomeUnknown: true });
  assert.deepEqual(errorDetails(error), { message: "커밋하지 않은 변경이 있습니다.", hint: "커밋하세요.", raw: "error: local changes", reason: "git-dirty", outcomeUnknown: true, recoveryId: "" });
  assert.equal(errorDetails("단순 안내").message, "단순 안내");
  assert.match(errorDetails({}).message, /처리하지 못했습니다/);
  const text = errorReportText(error, { action: "커밋" });
  for (const part of ["동작: 커밋", "오류: 커밋하지 않은", "해결 방법: 커밋하세요.", "완료 여부가 확실하지 않습니다", "사유 코드: git-dirty", "원문:\nerror: local changes"]) assert.ok(text.includes(part), part);
});

test("error report: AI request is a normal message with action, cause, hint and a clipped raw excerpt", () => {
  const prompt = errorRequestPrompt({ message: "푸시가 거절됐습니다.", hint: "Fetch 후 다시 푸시하세요.", raw: "x".repeat(4000) }, { action: "현재 브랜치 푸시" });
  assert.match(prompt, /^다음 오류가 났습니다\./);
  assert.match(prompt, /- 동작: 현재 브랜치 푸시/);
  assert.match(prompt, /- 오류: 푸시가 거절됐습니다\./);
  assert.match(prompt, /- 안내된 해결 방법: Fetch 후 다시 푸시하세요\./);
  assert.match(prompt, /이하 생략/);
  assert.ok(prompt.length < 2200);
  assert.match(prompt, /원인을 확인하고 해결해 주세요\./);
  assert.doesNotMatch(errorRequestPrompt({ message: "같은 문장", raw: "같은 문장" }), /원문 일부/);
});

test("error report: without a DOM the error still reaches the user through alert", () => {
  const saved = globalThis.alert, seen = [];
  globalThis.alert = (text) => seen.push(text);
  try { assert.equal(showError({ message: "실패", hint: "다시 시도" }, { action: "저장" }), null); }
  finally { globalThis.alert = saved; }
  assert.deepEqual(seen, ["동작: 저장\n오류: 실패\n해결 방법: 다시 시도"]);
});

test("error hints: responses without a hint get the reason's next step, explicit hints and raw output win", async () => {
  assert.match(hintFor("task-busy"), /기다린 뒤/);
  assert.equal(hintFor("no-such-reason"), "");
  assert.equal(hintFor(undefined), "");
  const server = createHttpServer({
    getPort: () => server.address().port,
    handleApi: (_request, _response, url) => {
      if (url.searchParams.has("explicit")) throw new HttpError(409, "충돌", "task-conflict", { hint: "직접 준 해결 방법", raw: "CONFLICT (content)" });
      if (url.searchParams.has("unknown")) throw new HttpError(409, "알 수 없음", "no-such-reason");
      throw new HttpError(409, "작업의 Git 처리가 진행 중입니다.", "task-busy");
    },
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const api = createApiClient();
    const address = "http://127.0.0.1:" + server.address().port + "/api/tasks/x/refresh";
    await assert.rejects(() => api("POST", address, {}), (error) => error.reason === "task-busy" && error.hint === hintFor("task-busy") && error.status === 409);
    await assert.rejects(() => api("POST", address + "?explicit=1", {}), (error) => error.hint === "직접 준 해결 방법" && error.raw === "CONFLICT (content)");
    await assert.rejects(() => api("POST", address + "?unknown=1", {}), (error) => !Object.hasOwn(error, "hint"));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
