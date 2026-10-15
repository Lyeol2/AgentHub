// Claude 사용 한도 기록. 실제 사용량 API는 부르지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-limits-"));
process.env.AGENTHUB_DATA = tmp;
const { recordClaudeLimit, sameWindow } = await import("../server/limits.mjs");

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("limits: 초기화 시각이 조금 달라도 같은 기간으로 본다", () => {
  assert.equal(sameWindow("2026-10-15T11:50:00.000Z", "2026-10-15T11:50:00.316Z"), true);
  assert.equal(sameWindow("2026-10-15T11:50:00.000Z", "2026-10-15T16:50:00.000Z"), false);
  assert.equal(sameWindow(null, "2026-10-15T11:50:00.000Z"), false);
});

test("limits: 사용률 없는 실행 중 이벤트가 사용량 조회로 받은 값을 지우지 않는다", () => {
  const file = path.join(tmp, "limits.json");
  const resetsAt = "2026-10-15T11:50:00.316Z"; // 사용량 조회는 밀리초까지 준다.
  fs.writeFileSync(file, JSON.stringify({ claude: { five_hour: { status: "allowed", usedPercent: 37, resetsAt } } }));
  recordClaudeLimit({ rateLimitType: "five_hour", status: "allowed", resetsAt: Date.parse("2026-10-15T11:50:00Z") / 1000 });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claude.five_hour.usedPercent, 37);
  // 다음 기간으로 넘어가면 지난 사용률은 버린다.
  recordClaudeLimit({ rateLimitType: "five_hour", status: "allowed", resetsAt: Date.parse("2026-10-15T16:50:00Z") / 1000 });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).claude.five_hour.usedPercent, null);
});
