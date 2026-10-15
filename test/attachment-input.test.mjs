import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachmentPreview, MAX_TEXT_PREVIEW_BYTES, unsupportedChatAttachment } from "../server/attachment-input.mjs";
import { codexInput } from "../server/codex-app-server.mjs";
import { userLine } from "../server/agents/claude.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-file-input-"));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
  return (name, mimeType, contents) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents);
    return { name, mimeType, path: file, size: fs.statSync(file).size };
  };
}

test("file delivery: both adapters include actual text content and server-owned paths", (t) => {
  const create = fixture(t);
  const file = create("notes.md", "text/markdown", "첨부한 문서의 내용");
  const codex = codexInput("요약", [file]);
  const claude = JSON.parse(userLine("요약", [file])).message.content;
  assert.deepEqual(codex, claude);
  assert.equal(codex[1].type, "text");
  assert.ok(codex[1].text.includes("첨부한 문서의 내용"));
  assert.ok(codex[1].text.includes(JSON.stringify(file.path)));
});

test("file delivery: previews are byte bounded and binary files are never treated as images or text contents", (t) => {
  const create = fixture(t);
  const large = create("large.txt", "text/plain", "가".repeat(MAX_TEXT_PREVIEW_BYTES));
  const preview = attachmentPreview(large);
  assert.equal(preview.truncated, true);
  assert.equal(unsupportedChatAttachment(large), true);
  assert.ok(Buffer.byteLength(preview.text) <= MAX_TEXT_PREVIEW_BYTES);
  assert.equal(preview.text.includes("\ufffd"), false);
  assert.match(codexInput("", [large])[1].text, /64 KiB/);
  for (const file of [create("data.zip", "application/zip", Buffer.from([0, 1, 2, 3])), create("fake.txt", "text/plain", Buffer.from([0, 255, 3]))]) {
    assert.equal(attachmentPreview(file), null);
    assert.equal(codexInput("", [file])[1].type, "text");
    assert.match(JSON.parse(userLine("", [file])).message.content[1].text, /바이너리 파일/);
  }
});

test("file delivery: source extensions and dotfiles work without browser MIME metadata", (t) => {
  const create = fixture(t);
  for (const name of [".env", ".gitignore", "Dockerfile", "main.ts"]) {
    const file = create(name, "application/octet-stream", "example=value");
    assert.deepEqual(attachmentPreview(file), { text: "example=value", truncated: false });
    assert.equal(unsupportedChatAttachment(file), false);
  }
});
