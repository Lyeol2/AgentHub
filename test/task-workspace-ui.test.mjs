import test from "node:test";
import assert from "node:assert/strict";
import { describePreview, formatBytes } from "../public/features/tasks/workspace.js";

test("task workspace ui: Library sizes read as short units", () => {
  assert.equal(formatBytes(512), "512B");
  assert.equal(formatBytes(1536), "1.5KB");
  assert.equal(formatBytes(3.2 * 1024 ** 3), "3.2GB");
  assert.equal(formatBytes(null), "");
});

test("task workspace ui: the preview banner says which task is shown and what blocks going back", () => {
  assert.equal(describePreview(null), null);
  const base = { title: "로그인", branch: "feature/login", head: "a".repeat(40), originalBranch: "develop", originalHead: "b".repeat(40) };
  const plain = describePreview(base);
  assert.match(plain.title, /"로그인" 작업 결과.*feature\/login @ aaaaaaa/);
  assert.match(plain.back, /develop 브랜치로 돌아갑니다/);
  assert.deepEqual(plain.notes, []);
  const view = describePreview({ ...base, originalBranch: null, dirty: true, outdated: true, taskHead: "c".repeat(40), taskUncommitted: true });
  assert.match(view.back, /bbbbbbb/);
  assert.deepEqual(view.notes.map(note => !!note.warn), [true, true, false]);
  assert.match(view.notes[0].text, /원본 폴더에 변경/);
  assert.match(view.notes[1].text, /ccccccc/);
  assert.match(view.notes[2].text, /커밋하지 않은 변경/);
  assert.match(describePreview({ ...base, moved: true, dirty: true, current: { branch: "main" } }).notes[0].text, /main 브랜치/);
});
