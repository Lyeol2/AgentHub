---
name: frontend-api
description: "AgentHub 화면(public/app.js)과 서버(server/index.mjs)가 주고받는 부분, 즉 REST API 경로·오류 응답·SSE 실시간 이벤트를 새로 만들거나 고칠 때 쓴다. 화면만 고칠 때는 frontend 스킬을 쓴다."
---

# 화면과 서버 연결

서버는 외부 패키지 없이 `node:http`로 돈다(`server/index.mjs`). 화면은 `fetch`로 REST API를 부르고, `EventSource("/api/stream")` 하나로 서버가 보내는 변화를 받는다. 새 패키지(express, socket.io, 상태 관리 라이브러리 등)를 들이지 않는다.

## 요청 (화면 → 서버)
- 화면에서는 `api(method, url, body)`만 쓴다. JSON 본문과 `X-AgentHub: 1` 헤더를 붙인다.
- 서버의 `isTrustedRequest`가 Host(`127.0.0.1:<port>`, `localhost:<port>`)와, GET이 아닌 요청의 `X-AgentHub` 헤더를 확인한다(DNS 리바인딩·CSRF 방지). **이 검사를 빼거나 우회하는 경로를 만들지 않는다.** GET은 헤더 없이 통과하므로 상태를 바꾸는 일은 GET에 두지 않는다.
- 경로는 `handleApi`에서 `parts`(`/api` 뒤를 `/`로 나눈 배열)와 `method`로 가른다. 새 경로는 비슷한 자원 옆에 `if (parts[0] === "…" && method === "…")` 블록으로 넣고, 위에 한 줄 한국어 주석을 단다.
- 자원 모양: 목록 `GET /api/<자원>`, 만들기 `POST`, 고치기 `PUT /api/<자원>/<id>`, 지우기 `DELETE`, 동작은 `POST /api/<자원>/<id>/<동작>`(예: `/sessions/:id/restart`). 옵션은 `?force=1`처럼 쿼리로 준다.
- 본문은 `readJson(req)`로 읽는다(1MB 제한). 경로·이름 같은 입력은 서버에서 검증한다(예: `SKILL_NAME`, 프로젝트 경로 확인). 화면 검증만 믿지 않는다.

## 응답과 오류
- 성공은 `send(res, status, body)`로 JSON을 보낸다. 만들거나 고친 뒤에는 그 자원 전체를 돌려줘 화면이 다시 받지 않아도 되게 한다.
- 실패는 `throw new HttpError(status, "한국어 메시지", reason)`. 바깥 처리기가 `{ error, reason }`으로 바꾼다. 400 잘못된 입력, 404 없음, 409 충돌·실행 중, 413 너무 큼.
- `reason`은 화면이 다음 선택지를 물어야 할 때만 붙인다(예: `"running"` → "멈추고 삭제할까요?" 후 `?force=1`로 다시 요청, `"worktree"`). 화면에서는 `err.reason`으로 가르고, 나머지는 `err.message`를 그대로 보여 준다.
- 메시지는 사용자가 읽는 문장으로 쓴다. 스택이나 내부 경로를 그대로 내보내지 않는다.

## 실시간 이벤트 (서버 → 화면)
- 서버는 `broadcast(type, data)`로 모든 화면에 `event: <type>` SSE를 보낸다. 25초마다 `ping`을 보낸다.
- 기존 종류: `event`(세션 출력 한 건, `seq` 포함), `state`, `sessions`, `session`, `links`, `commands`, `skills`, `queue`, `setup`, `cli`, `limits`, `update`.
- 원칙: **이벤트는 "무엇이 바뀌었는지"만 알리고, 화면은 그 자원을 다시 받는다**(`sessions` → `loadSessions()`). 데이터를 통째로 실어 보내는 건 자주 오는 작은 변화(`event`, `state`, `setup`)뿐이다.
- 프로젝트에 딸린 변화는 `{ projectPath }`를 실어 보내고, 화면은 `samePath(…, state.project)`일 때만 다시 받는다.
- 데이터를 바꾸는 API를 추가하면, 다른 창(별도 세션·채팅 창, 다른 브라우저 탭)도 따라오도록 알맞은 `broadcast`를 함께 넣는다. 새 종류가 필요하면 `connectStream()`에 리스너를 추가한다.
- 끊겼다 다시 이어지면(`open`) 화면이 목록과 보던 세션을 다시 받는다. 세션 출력은 `seq`로 이미 받은 것을 건너뛴다. 새 이벤트도 다시 받아도 깨지지 않게(멱등하게) 만든다.

## 순서
1. 비슷한 기존 기능(스킬·명령·연결)의 서버 블록, `broadcast`, 화면의 `load…`·리스너를 함께 읽고 같은 모양으로 만든다.
2. 서버 경로 → `broadcast` → 화면 `api` 호출·`load…`·SSE 리스너 순으로 고친다. 서버 로직이 크면 `server/<기능>.mjs`로 떼어 `index.mjs`에서는 부르기만 한다.
3. `test/api.test.mjs`에 경로 테스트를 추가한다. 이 테스트는 임시 데이터 폴더·임시 git 저장소·임시 홈으로 서버를 띄우고 CLI는 실행하지 않는다. 성공 응답과 함께 400·404·409 같은 실패 응답도 확인한다.
4. `npm test`를 돌린다. 그다음 `npm start`로 띄워, 창 두 개를 열고 한쪽에서 바꾼 것이 다른 쪽에 반영되는지 확인한다. 직접 확인하지 못했으면 그렇다고 알린다.
5. 하지 않는 것: 보안 검사 완화, `127.0.0.1` 밖으로 열기, 새 패키지 추가, 릴리스.
