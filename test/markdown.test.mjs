import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../public/markdown.js";

test("markdown: 제목·굵게·기울임·코드", () => {
  assert.equal(renderMarkdown("## 요약"), "<h2>요약</h2>");
  assert.equal(renderMarkdown("**굵게** *기울임* `x < y`"), "<p><strong>굵게</strong> <em>기울임</em> <code>x &lt; y</code></p>");
});

test("markdown: 표와 정렬", () => {
  const html = renderMarkdown("| 이름 | 수 |\n|---|---:|\n| a | 1 |\n| **b** | 2 |");
  assert.match(html, /<table><thead><tr><th>이름<\/th><th style="text-align:right">수<\/th><\/tr><\/thead>/);
  assert.match(html, /<td><strong>b<\/strong><\/td><td style="text-align:right">2<\/td>/);
});

test("markdown: 중첩 목록과 번호 목록", () => {
  assert.equal(renderMarkdown("- a\n  - b\n- c"), "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
  assert.equal(renderMarkdown("3. 셋\n4. 넷"), '<ol start="3"><li>셋</li><li>넷</li></ol>');
});

test("markdown: 코드 블록 안은 그대로 둔다", () => {
  assert.equal(renderMarkdown("```js\nconst a = **b**;\n```"), '<pre><code class="lang-js">const a = **b**;</code></pre>');
});

test("markdown: HTML과 위험한 링크는 글자로 남긴다", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"> [x](javascript:alert(1))');
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes('href="javascript'));
  assert.match(renderMarkdown("[문서](https://example.com/a?b=1&c=2)"), /<a href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noreferrer">문서<\/a>/);
});
