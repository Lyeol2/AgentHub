---
name: backend
description: "AgentHub 서버(server/의 index.mjs와 각 모듈, agents/의 Claude·Codex 연결)를 만들거나 고칠 때 쓴다. 외부 패키지 없는 Node 내장 모듈 관례, API 경로·HttpError·SSE broadcast 패턴, data/ 저장 방식, node:test 테스트를 따른다."
---

# 백엔드 작업

AgentHub 서버는 `server/`의 ES 모듈(`.mjs`)이다. `node server/index.mjs`(`npm start`)로 뜨고, Electron 앱도 같은 서버를 불러 쓴다. **Node 내장 모듈만 쓴다.** 프레임워크(Express 등)·DB·새 npm 패키지를 들이지 않는다. Node 20 이상에서 돌아야 한다.

## 파일
- `index.mjs`: HTTP 서버, 보안 검사, 모든 API 경로(`handleApi`), SSE(`broadcast`). 모듈들을 엮기만 하고, 덩어리가 큰 로직은 따로 모듈로 뺀다.
- `config.mjs`: `ROOT`, `DATA_DIR`(`AGENTHUB_DATA`로 바꿀 수 있음), `data/config.json` 읽기·쓰기. 새 설정은 `DEFAULTS`에 기본값과 주석을 함께 넣는다.
- `store.mjs`(세션), `links.mjs`(연결), `commands.mjs`(명령 노드): 메모리에 두고 바뀔 때 `data/` 아래 JSON 파일로 저장한다.
- `runner.mjs` + `agents/claude.mjs`, `agents/codex.mjs`: CLI 실행과 출력 해석. 두 에이전트는 같은 모양(`PERMISSION_MODES`, `models()`, `efforts()`, `buildArgs` …)을 내보내고 `AGENTS[agent]`로 고른다. 한쪽에 기능을 넣으면 다른 쪽도 맞춘다.
- `cli.mjs`: CLI 찾기·실행(`locateCli`, `spawnCli`), 버전·로그인 확인. `git.mjs`: worktree와 diff. `discover.mjs`: 디스크의 Claude·Codex 기록 읽기.
- `chain.mjs`, `orchestrator.mjs`, `hubfile.mjs`, `role.mjs`, `skills.mjs`, `question.mjs`, `limits.mjs`, `setup.mjs`: 기능별 모듈. 순수 함수로 둘 수 있는 것은 순수 함수로 두어 테스트하기 쉽게 한다.

## 관례
- API는 `handleApi`에서 `parts`(경로 조각)와 `method`로 가른다. 비슷한 기존 경로 옆에 같은 모양으로 넣는다. 응답은 `send(res, status, body)`, 본문은 `await readJson(req)`.
- 오류는 `throw new HttpError(status, "한국어 메시지", reason?)`. 400 입력 오류, 404 없음, 409 상태 충돌(실행 중·이미 처리됨), 500 서버 실패. 메시지는 화면에 그대로 나오므로 사용자가 이해할 수 있게 쓴다. 다른 모듈이 던진 일반 `Error`는 `try/catch`로 받아 알맞은 `HttpError`로 바꾼다.
- 입력은 경로 처리 전에 검사한다(`checkModel`, `checkEffort`, `checkSessionOptions`, `SKILL_NAME` 같은 패턴). 사용자 입력을 CLI 인자·셸 명령에 넣지 않는다. 프롬프트는 항상 stdin으로 보낸다.
- 보안을 약하게 하지 않는다: 127.0.0.1에만 열고, `isTrustedRequest`(Host 헤더, GET 아닌 요청의 `X-AgentHub: 1`)를 지킨다. 파일 경로를 받으면 정규화하고 허용된 폴더 안인지 확인한다.
- 상태가 바뀌면 `broadcast(type, data)`로 화면에 알린다. 기존 이벤트 이름(`sessions`, `session`, `links`, `commands`, `skills`, `state`, `event` …)을 재사용하고, 새 이름을 만들면 `public/app.js`의 SSE 처리도 함께 고친다.
- 저장은 기존 Store처럼 메모리 + JSON 파일. 자주 바뀌는 것은 `store.touch()`처럼 모아서 저장한다. 서버가 꺼질 때 남는 상태(실행 중 등)는 읽을 때 바로잡는다.
- 자식 프로세스는 `spawnCli`(Windows `.cmd` 처리)나 `git()`을 쓴다. 이 앱은 주로 Windows에서 돈다. 경로 구분자·대소문자(`samePath`)·`.cmd`·환경 변수(`USERPROFILE`) 차이를 생각한다.
- 주석·오류 메시지·로그는 한국어. 주석은 코드가 왜 그런지를 짧게 적는다. 파일 맨 위에 모듈이 무엇을 하는지 한두 줄 적는 관례를 따른다.

## 프론트엔드와 맞물리는 부분
화면(`public/app.js`)과 서버는 같은 저장소에서 함께 바뀐다. 한쪽만 고치면 깨지므로 아래 약속을 지키고, 약속을 바꾸면 양쪽을 한 번에 고친다.
**이 절이 화면·서버 약속의 기준이다.** `frontend-api` 스킬은 이 약속을 화면 쪽에서 처리하는 방법만 다룬다. 약속을 바꾸면 이 절을 고치고, 화면 처리 방법이 달라지면 `frontend-api`도 맞춘다.

### 요청과 응답
- 화면은 `api(method, url, body)` 하나로만 서버를 부른다. JSON 본문 + `X-AgentHub: 1` 헤더를 보낸다. 서버는 JSON만 돌려준다(`send`).
- 경로는 `/api/<자원>[/<id>[/<동작>]]`. 조회 GET, 만들기 POST, 고치기 PUT, 지우기 DELETE, 동작은 `POST /api/<자원>/<id>/<동작>`(예: `/sessions/:id/stop`). 선택 옵션은 쿼리(`?force=1`, `?fresh=1`). 새 경로는 `handleApi`에서 비슷한 자원 옆에 넣고 위에 한 줄 한국어 주석을 단다.
- `isTrustedRequest`는 GET이 아닌 요청에만 `X-AgentHub` 헤더를 확인한다. 그러니 **데이터를 바꾸는 일을 GET 경로에 두지 않는다.**
- 본문은 `readJson(req)`로 읽는다(1MB를 넘으면 413). 화면에서 검사했더라도 서버에서 다시 검사한다.
- 성공 응답은 화면이 바로 쓸 수 있는 객체를 준다. 만들기·고치기는 바뀐 객체 전체를, 값을 돌려줄 것이 없으면 `{ ok: true }`를 준다. 목록의 세션은 `summary()`(이벤트 빼고 `eventCount`만)로, 세션 하나는 이벤트까지 준다.
- 실패 응답은 `{ error, reason }`. 화면은 `error`를 그대로 사용자에게 보여 주므로(대화상자의 `…-error` 칸, `alert`) **한국어 문장**으로 쓴다. 스택이나 내부 정보를 그대로 내보내지 않는다. 화면은 상태 코드로 분기하지 않으므로, 화면이 구분해야 하는 실패는 `reason`으로 나눈다.
- 화면이 실패 종류에 따라 다음 선택지를 물어야 하면 `HttpError`의 세 번째 인자 `reason`에 짧은 영문 값을 붙인다(예: 세션 삭제의 `"running"` → 멈추고 삭제할지, `"worktree"` → 작업 폴더를 남기고 삭제할지). 새 `reason`을 만들면 `app.js`에서 그 값을 처리하는 곳도 같이 만든다.
- 필드 이름은 camelCase(`projectPath`, `sessionId`, `graphPos`). 기존 필드의 이름·의미·형식을 바꾸지 않는다. 바꿔야 하면 `app.js`에서 그 필드를 쓰는 곳을 모두 찾아 고친다. 필드를 더하는 것은 괜찮다.
- 화면에서 고를 수 있는 값(권한 모드, 모델, 추론 강도, 연결 조건 등)은 서버가 목록으로 내려 주고(`/api/status`의 `agents.<에이전트>.permissions`·`models`·`efforts`) 같은 목록으로 검사한다. 화면에 값을 따로 박아 두게 만들지 않는다.

### 실시간 알림(SSE)
- 화면은 `/api/stream` 하나를 열어 두고 이벤트 이름별로 다시 불러온다(`connectStream`). 서버는 `broadcast(이름, 데이터)`로 보낸다.
- 이벤트는 "무엇이 바뀌었는지"만 알리고 화면이 API로 다시 받아 가는 방식이 기본이다. 데이터는 비우거나(`{}`) 범위를 좁힐 값만 넣는다(`{ sessionId }`, `{ projectPath }`). 큰 객체를 통째로 싣지 않는다. 예외로 `event`(세션 이벤트 하나, `seq` 포함), `state`(`{ sessionId, state }`), `setup`, `update`는 값을 직접 싣는다.
- 지금 있는 이름과 화면 반응:
  - `sessions` → 세션 목록 다시 받기, `session` `{ sessionId }` → 보고 있는 세션이면 다시 받기
  - `event` `{ sessionId, event }` → 보고 있는 세션에 덧붙이기(`event.seq`는 `session.events` 안의 위치다. 화면은 이 값으로 중복을 거르므로 이벤트는 runner를 거쳐 덧붙이고 중간에 끼우거나 지우지 않는다), `state` → 실행 상태 표시
  - `links`, `commands`, `skills` `{ projectPath }`, `queue` `{ sessionId }`, `limits`, `cli`, `setup`, `update`, `ping`(연결 유지)
- 데이터를 바꾸는 API는 그 변화를 보는 화면이 있으면 알맞은 이벤트를 보낸다. 다른 창(별도 창 `?session=`, 여러 탭)도 같은 이벤트로 갱신되기 때문이다. 요청한 창은 응답으로, 나머지 창은 이벤트로 바뀐다.
- 연결이 끊겼다 이어지면 화면이 목록과 현재 세션을 처음부터 다시 받는다. 그러니 이벤트를 놓쳐도 GET API만으로 같은 상태가 나와야 한다. 이벤트에만 있고 API로 얻을 수 없는 상태를 만들지 않는다.
- 새 이벤트 이름을 만들면 `connectStream`에 처리기를 넣는다. 처리기가 없으면 화면은 조용히 무시한다.

### 고칠 때 확인
- `grep`으로 `app.js`에서 해당 경로(`/api/...`)와 이벤트 이름을 찾아 화면이 무엇을 기대하는지 먼저 본다.
- 응답 모양을 바꿨으면 `test/api.test.mjs`에 그 모양을 확인하는 단언을 넣는다.
- 화면 쪽 수정이 필요하면 `frontend` 스킬의 관례를, 화면의 API 호출·오류 표시·SSE 처리기는 `frontend-api` 스킬을 따른다.
- 이벤트를 더하거나 바꿨으면 `npm start`로 띄워 창 두 개를 열고, 한쪽에서 바꾼 것이 다른 쪽에도 반영되는지 본다. 직접 확인하지 못했으면 그렇다고 알린다.

## 테스트
- `test/*.test.mjs`, `node:test` + `node:assert/strict`. `npm test`로 모두 돈다.
- 순수 로직은 모듈 단위 테스트(`skills.test.mjs`처럼 `fs.mkdtempSync` 임시 폴더를 쓰고 `finally`에서 지운다).
- API는 `test/api.test.mjs`에 넣는다. 임시 `AGENTHUB_DATA`, 임시 git 저장소, 임시 홈 폴더로 서버를 띄워 확인한다. **실제 CLI(claude, codex)를 실행하는 테스트를 만들지 않는다.** 실제 사용자 폴더(`~/.claude` 등)를 건드리지 않는다.
- 새 API·새 검사 규칙에는 성공 경우와 실패 상태 코드(400/404/409)를 함께 확인한다.

## 순서
1. 고칠 경로의 `handleApi` 부분과 관련 모듈, 해당 테스트를 먼저 읽는다. 비슷한 기능(예: 스킬·명령 노드 API)을 찾아 같은 모양으로 만든다.
2. 고친다. 응답 모양이 바뀌거나 새 API가 생기면 `public/app.js`의 호출부도 함께 고친다.
3. 테스트를 추가하고 `npm test`를 돌린다. 실패하면 고치고 다시 돌린다.
4. CLI 출력 해석(`agents/`)을 고쳤으면 `test/parsers.test.mjs`에 실제 출력 줄을 예로 넣는다. 실제 CLI로 확인하지 못했으면 그렇다고 알린다.
5. 하지 않는 것: npm 패키지 추가, `data/`·`dist/` 수정, 보안 검사 완화, 릴리스.
