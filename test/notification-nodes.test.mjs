import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND_KINDS, checkCommand } from "../server/commands.mjs";
import { FLOW_MEMBER_KINDS } from "../server/flow-nodes.mjs";

test("notification nodes: defaults and saved fields are validated as executable flow nodes", () => {
  assert.ok(COMMAND_KINDS.includes("notify"));
  assert.ok(FLOW_MEMBER_KINDS.includes("notify"));
  assert.deepEqual(checkCommand({ kind: "notify" }), { kind: "notify", title: "알림", message: "{{input}}", notificationTitle: "AgentHub", level: "info", sound: false });
  const fields = checkCommand({ kind: "notify", title: "빌드 완료", message: "{{goal}}: {{input}}", level: "success", sound: true });
  assert.equal(fields.notificationTitle, "빌드 완료");
  assert.equal(fields.sound, true);
  assert.equal(fields.message, "{{goal}}: {{input}}");
  const updated = checkCommand({ message: "검토 필요", notificationTitle: "팀 작업", level: "error" }, { id: "cmd-notify", ...fields });
  assert.equal(updated.kind, "notify");
  assert.equal(updated.notificationTitle, "팀 작업");
  assert.equal(updated.sound, true);
});

test("notification nodes: malformed level, sound, oversized content and type changes are rejected", () => {
  for (const body of [{ level: "warning" }, { sound: "false" }, { sound: 1 }, { message: "a".repeat(20001) }, { notificationTitle: "a".repeat(101) }]) {
    assert.throws(() => checkCommand({ kind: "notify", ...body }));
  }
  assert.throws(() => checkCommand({ kind: "command", command: "echo changed" }, { id: "cmd-notify", kind: "notify" }), /종류/);
});
