---
name: frontend
description: "AgentHub 화면(public/의 index.html·app.js·style.css·markdown.js·theme.js)을 만들거나 고칠 때 쓴다. 빌드 도구 없는 순수 HTML·CSS·JS 관례, 다크·라이트 테마 토큰, 대화상자·DOM 패턴을 따른다."
---

# 프론트엔드 작업

AgentHub 화면은 `public/`의 정적 파일이다. 서버(`server/index.mjs`)가 그대로 내보내고, Electron 앱도 같은 화면을 띄운다. **빌드 단계·프레임워크·외부 패키지가 없다.** 새 의존성(React, 번들러, CDN 스크립트 등)을 들이지 않는다.

## 파일
- `index.html`: 화면 뼈대와 모든 `<dialog>`. 대화상자는 미리 HTML에 두고 JS에서 값만 채운다.
- `app.js`: 모듈 하나(`type="module"`). 상태는 맨 위 `state` 객체 하나에 모은다.
- `style.css`: 한 파일. `/* ── 구역 이름 ─── */` 머리말로 구역을 나눈다. 새 기능은 새 구역을 맨 아래에 붙인다.
- `markdown.js`: 답변 마크다운 렌더러. 브라우저와 Node 양쪽에서 돌아야 한다(DOM API 금지). `test/markdown.test.mjs`로 시험한다.
- `theme.js`: CSS보다 먼저 테마를 적용한다. 테마가 바뀌면 `agenthub-theme` 이벤트가 난다.

## 관례
- DOM은 `el(tag, attrs, ...children)`과 `$(id)`로 만든다. `on…` 속성은 이벤트로 붙는다. 사용자·에이전트가 쓴 글을 `innerHTML`에 넣지 않는다(마크다운은 `renderMarkdown`이 이스케이프한 결과만).
- 서버 호출은 `api(method, url, body)`만 쓴다. `X-AgentHub` 헤더를 붙이고 실패하면 서버의 한국어 `error`를 던진다. 대화상자에서는 그 메시지를 `…-error` 칸에 보여 준다.
- 대화상자: `open…Dialog()`에서 값을 채우고 `showModal()`. `<form method="dialog">`의 `submit`에서 `e.submitter?.value`로 ok·cancel·delete를 가른다. 서버 요청이 성공한 뒤에만 `close()`한다.
- 색은 `style.css` `:root`의 토큰(`--bg`, `--panel`, `--text`, `--muted`, `--accent`, `--ok`, `--warn`, `--danger`, `--claude`, `--codex` …)만 쓴다. 색 값을 직접 쓰지 않는다. 새 토큰이 필요하면 `:root`와 `:root[data-theme="light"]` **둘 다**에 넣는다.
- 아이콘은 `viewBox="0 0 24 24"`인 인라인 SVG 경로. 아이콘 폰트·이미지 파일을 늘리지 않는다.
- 화면 글자, `title`, `aria-label`, 주석은 한국어로 쓴다. 주석은 코드가 왜 그런지를 짧게 적는다.
- 별도 창(`?session=` / `?chat=`, `POPUP`)에서도 기능이 깨지지 않는지 생각한다. 이 창에는 사이드바가 없다.
- 좁은 화면은 기존 `@media (max-width: 900px)`, `(max-width: 640px)` 구간에 맞춘다.

## 순서
1. 고칠 화면의 `render…`/`load…` 함수와 해당 CSS 구역, `index.html`의 대화상자를 먼저 읽는다. 비슷한 기능(예: 스킬·명령 대화상자)을 찾아 같은 모양으로 만든다.
2. 고친다. 서버 API가 새로 필요하면 `server/`와 `test/api.test.mjs`도 함께 고친다.
3. `npm test`로 테스트를 돌린다. `markdown.js`를 고쳤으면 테스트를 추가한다.
4. `npm start`로 띄워 <http://127.0.0.1:4517>에서 다크·라이트 테마 둘 다 확인한다. 직접 확인하지 못했으면 그렇다고 알린다.
5. 하지 않는 것: 빌드 도구·패키지 추가, `dist/` 수정, 릴리스.
