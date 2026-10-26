import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../public/markdown.js";
import { collectReportReferences } from "../public/report-references.js";

test("markdown: only closed Mermaid fences become diagrams and their source stays escaped", () => {
  assert.match(renderMarkdown('```mermaid\ngraph TD\nA-->B\n```'), /<mermaid-diagram>/);
  assert.doesNotMatch(renderMarkdown('```mermaid\ngraph TD\nA-->'), /<mermaid-diagram>/);
  const html = renderMarkdown('```mermaid\n</code><script>alert(1)</script>\n```');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

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

test("markdown reports: local links and images opt into safe reference actions", () => {
  const source = String.raw`[최종 보고서](C:/My Reports/결과 (최종).md:12) ![화면](<C:\My Screens\화면.png>)`;
  const html = renderMarkdown(source, { sessionId: "session-a" });
  assert.match(html, /<a href="#" class="report-ref" data-report-path="C:\/My Reports\/결과 \(최종\)\.md:12">최종 보고서<\/a>/);
  assert.match(html, /data-report-path="C:\\My Screens\\화면\.png" data-report-image="true">화면<\/a>/);
  assert.ok(!renderMarkdown(source).includes("report-ref"));
  assert.ok(!html.includes("<img"));
});

test("markdown reports: bare files and @ mentions survive nested blocks and preserve code", () => {
  const html = renderMarkdown("- @src/main.ts\n  - [세션](agenthub://session/abc)\n\n> [작업](agenthub://task/task-1)\n\n| 결과 |\n|---|\n| /tmp/screen.png |\n\n`@src/secret.ts`\n\n```md\n[secret](C:/secret.md)\n```", { sessionId: "a" });
  assert.match(html, /data-report-path="src\/main.ts">@main.ts<\/a>/);
  assert.match(html, /data-report-session="abc">세션<\/a>/);
  assert.match(html, /data-report-task="task-1">작업<\/a>/);
  assert.match(html, /data-report-path="\/tmp\/screen.png" data-report-image="true"/);
  assert.match(html, /<code>@src\/secret.ts<\/code>/);
  assert.match(html, /<pre><code class="lang-md">\[secret\]\(C:\/secret.md\)<\/code><\/pre>/);
  assert.ok(!html.includes('data-report-path="C:/secret.md"'));
});

test("markdown reports: local web previews and external links retain separate actions", () => {
  const html = renderMarkdown("[앱](http://localhost:3000/a?q=1&b=2) http://[::1]:5555/ https://example.com ![외부 화면](https://example.com/screen.png) ![첨부](/api/sessions/s/attachments/a)", { sessionId: "s" });
  assert.match(html, /data-report-url="http:\/\/localhost:3000\/a\?q=1&amp;b=2"/);
  assert.match(html, /data-report-url="http:\/\/\[::1\]:5555\/"/);
  assert.match(html, /href="https:\/\/example.com" target="_blank" rel="noreferrer"/);
  assert.match(html, /data-report-url="https:\/\/example.com\/screen.png" data-report-image="true"/);
  assert.match(html, /data-report-url="\/api\/sessions\/s\/attachments\/a" data-report-image="true"/);
});

test("markdown reports: attribute injection, placeholders and raw HTML remain harmless", () => {
  const html = renderMarkdown('[<img src=x onerror=evil>](C:/report.md) [bad](javascript:alert(1)) [x](https://example.com/\"onmouseover=\"evil)\u00000\u0000', { sessionId: "s" });
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes(' onmouseover="'));
  assert.match(html, /&lt;img src=x onerror=evil&gt;/);
  assert.ok(!html.includes("undefined"));
  assert.ok(!renderMarkdown("[x](data:text/html,<script>alert(1)</script>)", { sessionId: "s" }).includes("data-report-"));
});

test("markdown reports: saved composer aliases render as their original mention labels", () => {
  const html = renderMarkdown('@"명세 초안" @디자인 `@디자인`', { sessionId: "current", references: [{ label: "명세 초안", path: "docs/spec.md" }, { label: "디자인", path: "agenthub://session/design-1" }] });
  assert.match(html, /data-report-path="docs\/spec.md">@명세 초안<\/a>/);
  assert.match(html, /data-report-session="design-1">@디자인<\/a>/);
  assert.match(html, /<code>@디자인<\/code>/);
});

test("markdown reports: inline code spanning paragraph lines stays literal", () => {
  const html = renderMarkdown("`example\nC:/hidden.md\n` [visible](out/report.md)", { sessionId: "s" });
  assert.match(html, /<code>example\nC:\/hidden.md\n<\/code>/);
  assert.ok(!html.includes('data-report-path="C:/hidden.md"'));
  assert.match(html, /data-report-path="out\/report.md"/);
  assert.equal(renderMarkdown("one\ntwo"), "<p>one<br>two</p>");
});

test("markdown math: inline, display, TeX delimiters and math fences render accessible formulas", () => {
  const source = [String.raw`에너지 $E=mc^2$와 \(x_i^2\).`, String.raw`$$
\frac{1}{2} + \sqrt{x}
$$`, String.raw`\[
\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}
\]`, "```math\nx^2 + y^2 = z^2\n```"].join("\n\n");
  const html = renderMarkdown(source);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 5);
  assert.equal((html.match(/class="md-math md-math-display"/g) ?? []).length, 3);
  assert.equal((html.match(/<math /g) ?? []).length, 5);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<msqrt>/);
  assert.match(html, /<mtable/);
  assert.doesNotMatch(html, /md-math-error|<em>/);
});

test("markdown math: code, links, currency, escapes and unfinished streaming input stay literal", () => {
  for (const source of ["$5 and $10", "unfinished $x", "unfinished $$x", String.raw`\$5 and \$10`]) {
    assert.doesNotMatch(renderMarkdown(source), /class="(?:katex|md-math)/);
  }
  assert.equal(renderMarkdown(String.raw`가격은 \$5입니다.`), "<p>가격은 $5입니다.</p>");
  const mixed = renderMarkdown("Cost $5 and $10. Formula $x$.");
  assert.match(mixed, /Cost \$5 and \$10\. Formula <span class="md-math">/);
  assert.equal((mixed.match(/class="katex"/g) ?? []).length, 1);
  const html = renderMarkdown('`$x_i$`\n\n```latex\n$$x^2$$\n```\n\n[가격 $5](https://example.com/$x$)');
  assert.match(html, /<code>\$x_i\$<\/code>/);
  assert.match(html, /<code class="lang-latex">\$\$x\^2\$\$<\/code>/);
  assert.match(html, /href="https:\/\/example.com\/\$x\$"/);
  assert.doesNotMatch(html, /class="katex"/);
});

test("markdown math: table pipes, quoted displays and indented list displays keep their structure", () => {
  const html = renderMarkdown(String.raw`| 이름 | 수식 |
|---|---|
| 절댓값 | $|x|$ |
| 조건 | $P(A\mid B)$ |

> $$
> \sum_{i=1}^{n} i
> $$

- 계산
  $$
  \frac{1}{2}
  $$
- 다음`);
  assert.equal((html.match(/<td>/g) ?? []).length, 4);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 4);
  assert.match(html, /<blockquote><span class="md-math md-math-display">/);
  assert.match(html, /<li>계산<span class="md-math md-math-display">/);
  assert.match(html, /<li>다음<\/li>/);
});

test("markdown math: formula contents are never parsed as file references or Markdown", () => {
  const source = String.raw`$\text{docs/hidden.md *literal*}$

$$
\text{docs/other.md}
$$

[문서](docs/visible.md)`;
  assert.deepEqual(collectReportReferences(source).map((ref) => ref.path), ["docs/visible.md"]);
  const html = renderMarkdown(source, { sessionId: "s" });
  assert.doesNotMatch(html, /data-report-path="docs\/(?:hidden|other)\.md"|<em>/);
  assert.match(html, /data-report-path="docs\/visible.md"/);
});

test("markdown math: unsafe commands, invalid syntax and recursive macros cannot inject HTML or break later formulas", () => {
  for (const source of [
    String.raw`$\href{javascript:alert(1)}{x}$`,
    String.raw`$\includegraphics{https://example.com/tracker.png}$`,
    String.raw`$\htmlStyle{position:fixed}{x}$`,
    String.raw`$\badcommand{<img src=x onerror=alert(1)>}$`,
    String.raw`$\def\loop{\loop}\loop$`,
  ]) {
    const html = renderMarkdown(source + "\n\n$x^2$");
    assert.doesNotMatch(html, /<img|<script|href="javascript:|src="https:|style="position:fixed/);
    assert.match(html, /class="katex"/);
  }
  const failed = renderMarkdown(String.raw`$\badcommand{<img>}$`);
  assert.match(failed, /md-math-error/);
  assert.match(failed, /<code>\$\\badcommand\{&lt;img&gt;\}\$<\/code>/);
  const isolated = renderMarkdown(String.raw`$\gdef\custom{123}\custom$ $\custom$`);
  assert.equal((isolated.match(/md-math-error/g) ?? []).length, 1, "Macros do not leak between formulas");
});

test("markdown math: escaped braces, comments and long backslash runs preserve delimiter boundaries", { timeout: 2000 }, () => {
  const html = renderMarkdown(String.raw`$\{x\}$

$$
x % $$ is a comment, not the end
+ y
$$`);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /md-math-error/);
  const slashes = "\\".repeat(100000);
  assert.equal(renderMarkdown(slashes), "<p>" + slashes + "</p>");
});
