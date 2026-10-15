import test from "node:test";
import assert from "node:assert/strict";
import { parseLoginOutput, TOOLS } from "../server/setup.mjs";

test("setup: 로그인 출력에서 주소와 일회용 코드를 꺼낸다", () => {
  const gh = parseLoginOutput("! One-time code (AB12-CD34) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n");
  assert.deepEqual(gh, { url: "https://github.com/login/device", code: "AB12-CD34", waitsForCode: false });

  const codex = parseLoginOutput("Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?a=1&b=2\n");
  assert.equal(codex.url, "https://auth.openai.com/oauth/authorize?a=1&b=2"); // localhost 콜백 주소는 건너뛴다.
  assert.equal(codex.code, null);

  const device = parseLoginOutput("1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter this one-time code\n   \x1b[94mWXYZ-12345\x1b[0m\n");
  assert.equal(device.url, "https://auth.openai.com/codex/device");
  assert.equal(device.code, "WXYZ-12345");

  const claude = parseLoginOutput("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true\nPaste code here if prompted > ");
  assert.equal(claude.waitsForCode, true);
});

test("setup: winget 패키지 ID", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, t.winget])),
    { claude: "Anthropic.ClaudeCode", codex: "OpenAI.Codex", gh: "GitHub.cli" });
});
