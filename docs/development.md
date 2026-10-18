# AgentHub 개발 안내

소스에서 실행·빌드·릴리스하는 방법과 내부 동작을 적는다. 앱 사용법은 [README](../README.md)를 본다.

서버는 외부 패키지를 쓰지 않는다. Electron과 electron-builder는 앱 실행·빌드용 개발 의존성이다. 소스에서 실행하거나 빌드하려면 Node.js 20 이상이 필요하다.

## 소스에서 실행

### 데스크톱 앱

```bash
npm install
npm run app
```

`npm run app`은 소스에서 바로 앱을 띄운다. 이때는 저장소의 `data/`를 쓴다. 설치 파일은 `npm run dist`로 만든다.

### 브라우저

```bash
npm start
```

브라우저에서 <http://127.0.0.1:4517>을 연다. 포트는 `PORT` 환경 변수나 `data/config.json`의 `port`로 바꾼다. 같은 포트를 쓰므로 데스크톱 앱과 동시에 띄우지 않는다.

아이콘은 `build/make-icon.ps1`이 그린다. 고친 뒤 `powershell -ExecutionPolicy Bypass -File build/make-icon.ps1`로 `build/icon.ico`를 다시 만든다.

## 릴리스

```bash
npm run release
```

테스트, 버전 올리기, 빌드, 커밋·태그 push, GitHub Release 생성까지 한 번에 한다. 버전 단위는 릴리스 준비 초안의 값을 자동으로 쓰고, 준비한 값이 없으면 patch로 올린다. `npm run release -- minor`처럼 직접 지정하면 그 값이 우선한다. 앱의 업데이트 기능은 릴리스에 함께 올라가는 `latest.yml`을 읽는다. 마지막 커밋을 임시 작업 트리에 꺼내 빌드하므로 커밋하지 않은 변경은 릴리스에 들어가지 않고 그대로 남는다. 단, `package.json`·`package-lock.json`에 커밋하지 않은 변경이 있으면 시작하지 않는다.

- 릴리스 노트는 지난 태그 이후 커밋으로 만든다. `feat:`·`fix:`·`chore:` 같은 앞머리로 종류를 묶고, 커밋 본문의 `- ` 줄을 아래에 붙인다(릴리스 커밋은 뺀다).
- 릴리스 준비 단계(Claude Code `release` 스킬)가 점검을 통과하면 커밋 노트를 사용자 말투로 다시 쓴 초안을 `release-notes.draft.md`(git 제외)에 남기고, 첫 줄에 기준 커밋과 버전 단위(`bump=patch|minor|major`)를 기록한다. 큰 기능 추가나 주요 사용 흐름 변경은 minor로 자동 선택한다. 승인 전에 고칠 수 있고, 릴리스할 때 이 초안이 커밋 노트 대신 나간 뒤 지워진다. 초안을 쓴 뒤 커밋이 더 생겼으면 버전 단위와 노트를 모두 쓰지 않고 기본 patch·커밋 노트로 진행하므로, 다시 준비해야 한다.
- 릴리스가 끝나면 같은 노트를 **Discord 웹후크**로 보낸다. 주소는 비밀이라 저장소에 두지 않고, 환경 변수 `AGENTHUB_DISCORD_WEBHOOK`이나 저장소 루트의 `release.local.json`(git 제외)에 `{ "discordWebhook": "https://discord.com/api/webhooks/..." }`로 적는다. 없거나 보내지 못해도 릴리스는 그대로 끝난다.
- `node scripts/release-notes.mjs`는 다음 릴리스에 들어갈 노트를 미리 보여 주고, `node scripts/release-notes.mjs v0.1.15 --discord`는 그 버전의 노트를 Discord로 다시 보낸다.

## 동작 방식

| 에이전트 | 첫 턴 | 이후 턴 |
| --- | --- | --- |
| Claude | `claude -p --output-format stream-json --verbose --session-id <uuid>` | `--resume <세션 ID>` |
| Codex | `codex app-server --listen stdio://`에서 `thread/start`·`turn/start` | 저장된 스레드를 `thread/resume`한 뒤 `turn/start` |

- 프롬프트는 명령줄 인자가 아니라 stdin으로 넘긴다. Codex는 JSON-RPC App Server 프로토콜로 대화·이미지·실행 중 승인 응답을 주고받으며 기존 CLI 로그인을 재사용한다. `app-server`를 지원하는 CLI가 필요하다(0.162.1에서 초기화·설정·대화 생성 확인). [OpenAI App Server 문서](https://learn.chatgpt.com/docs/app-server)를 따른다.
- Codex 대화가 다른 연결에서 열려 있어 `already has an active writer`가 나면 잠시 후 한 번 다시 연결한다. 충돌이 계속되면 저장된 대화 기록을 복사한 새 스레드로 이어가고 그 사실을 세션에 표시한다. 원래 대화는 보존하며, 복구 실패 시 빈 대화로 몰래 전환하지 않는다.
- 모델을 고르지 않은 Codex 세션은 `~/.codex/config.toml`의 기본 모델을 쓴다. 이 기본 모델이나 세션에 저장한 모델이 Codex 모델 목록(`~/.codex/models_cache.json`, 숨은 모델 포함)에 아예 없으면 지금 계정에서 쓸 수 없는 모델이다(예: "model is not supported when using Codex with a ChatGPT account"). 그때는 목록의 첫 모델로 바꿔 실행하고, 세션 기록과 모델 입력칸에 그 사실을 알린다. 추론 강도를 바꾼 모델이 지원하지 않으면 그 모델의 기본 강도를 쓴다. 이 목록은 마지막으로 받아 온 Codex 버전이 아는 모델만 담으므로, Codex 앱에는 있는 새 모델이 빠져 보이면 CLI를 업데이트한다(`npm i -g @openai/codex@latest`).
- 워크트리를 선택하면 `<저장소>.agenthub/<이름>` 폴더와 `agenthub/<이름>` 브랜치를 현재 커밋에서 만든다. 커밋하지 않은 원본 수정은 포함하지 않는다. 이름은 영문·숫자·한글로 시작하는 1~64자의 영문·숫자·한글·하이픈·밑줄이며 Windows 예약어는 쓸 수 없다.
- 워크트리를 선택한 세션은 앱을 다시 시작하거나 재생성해도 같은 작업 폴더와 브랜치를 이어 쓴다. 이전 버전에서 원본으로 전환된 세션의 작업 폴더나 브랜치를 자동 복원하거나 합치지는 않는다. 가져온 CLI 기록은 원본 폴더에서 이어 쓴다.
- 세션 기록은 데이터 폴더의 `sessions/`에, 설정은 `config.json`에 저장된다. 연결은 `links.json`, 메시지는 `messages.json`(최근 300개), 공유 노트는 `boards/`에, 팀 작업 이슈와 세션의 연결은 `issue-links.json`에 저장된다. 프로젝트별 GitFlow 설정은 `config.json`의 `gitflow`에 둔다. Claude Code·Codex 기록 검색 요약은 `discover-cache.json`에 캐시하며(파일별 크기·수정 시각·읽은 위치), 기록 파일이 자라면 늘어난 부분만 읽는다. 지워도 다음 검색 때 다시 만든다. 저장소의 `data/`는 git에 올리지 않는다.
- 데이터 파일은 임시 파일에 쓰고 fsync한 뒤 이름을 바꿔 저장하므로, 저장 중에 꺼져도 원래 파일이 남는다. 시작할 때 읽을 수 없는 세션·설정·명령·연결·메시지·작업 파일이 있으면 데이터 폴더의 `corrupted/<시각>/`으로 옮기고 나머지 데이터로 시작한다. 설정 파일이 깨졌으면 기본값으로 다시 만든다.
- 그리드 탭의 목록·이름·순서·기본 탭은 `graph-tabs.json`에 저장하고 세션·명령·시각 그룹은 `tabId`로 소속을 구분한다. 예전 데이터의 누락된 `tabId`는 프로젝트의 기본 탭으로 해석한다. 탭은 화면 분리 단위이며 노드 ID·연결·실행은 프로젝트 전체에서 유지한다. `graph-tabs` SSE의 `affectedTabIds`는 노드 이동·탭 삭제로 오래된 되돌리기 기록을 비워야 할 탭을 알린다.
- 기존 세션 가져오기는 아래 기록 파일을 읽기만 한다.
  - Claude: `~/.claude/projects/<인코딩된 경로>/*.jsonl`
  - Codex: `~/.codex/sessions/**/rollout-*.jsonl` (하위 에이전트·검토용 스레드는 제외)
- 사용 한도
  - Claude: AgentHub에서 Claude 세션을 실행할 때 `stream-json`의 `rate_limit_event`를 받아 데이터 폴더의 `limits.json`에 저장한다. 로그인한 계정의 사용량 API(Claude Code의 `/usage`와 같은 곳)에서도 1분마다 사용률을 읽고, 요청이 많아 거절(429)되면 몇 분 쉬었다가 다시 읽는다.
  - Codex: `~/.codex/sessions` 기록에 남는 `rate_limits` 중 가장 최근 값을 읽는다.

### Claude CLI 띄워 두기와 하위 작업

Claude CLI는 입력(stdin)이 닫히면 백그라운드 작업(서브에이전트·백그라운드 명령)을 강제로 끝낸다. 그래서 AgentHub는 턴이 끝나도(`result`) 입력을 닫지 않는다.

- 턴 마무리(`turnEnd`, 대기 전환, 대기열 전송, 비용·컨텍스트)는 `result`마다 한다. 프로세스가 끝나는 것은 정리만 한다.
- 다음 요청은 같은 프로세스의 열린 입력에 쓴다(쓰기 전에 그 턴의 권한 모드를 `set_permission_mode`로 맞춘다). CLI 인자에 영향을 주는 변경(모델·추론 강도·MCP 주소·작업 폴더·유니티 통제·추가 폴더, 모든 권한 허용 켜고 끄기, 지운 허용 규칙, 다시 시작으로 바뀐 대화)이 있으면 다음 요청 때 이전 프로세스를 닫고 `--resume`으로 새로 띄운다. 단, 백그라운드 작업이 도는 중이면 작업이 끊기지 않게 같은 프로세스를 계속 쓰고 그 사실을 기록에 알린다.
- 하위 작업이 없으면 `config.json`의 `cliKeepAlive.idleMinutes`(기본 15분) 동안 쉬면 입력을 닫아 끝낸다. 0이면 하위 작업이 없을 때 바로 닫는다. 동시에 띄워 두는 수는 `cliKeepAlive.maxProcesses`(기본 8)이며, 넘으면 가장 오래 쉰 프로세스부터 닫는다. 실행 중·백그라운드 작업 중인 프로세스는 닫지 않는다. 설정 화면의 "Claude CLI 띄워 두기"에서 바꾼다. CLI 업데이트 전에는 쉬는 프로세스를 닫는다.
- `initialize`에 `perTaskStopAffordance`·`agentProgressSummaries`·`forwardSubagentText`를 선언한다. 일시중지(interrupt)는 턴만 멈추고 백그라운드 작업은 살려 둔다. 세션 "중지"는 프로세스를 끝내며 남은 작업은 `stopped`가 된다. 프로세스가 비정상으로 끝나면 남은 작업은 `interrupted`로 표시하고 상태 메시지를 남긴다.
- 백그라운드 작업이 끝나면 CLI가 스스로 다음 턴을 시작한다(`system/init` → 답변 → `result`). AgentHub는 이를 실행 중으로 보이고 결과가 오면 평소 턴처럼 마친다. 일시중지 중에 시작된 턴은 바로 멈춘다.
- Codex는 턴마다 `app-server`를 띄우고 턴이 끝나면 닫는다(띄워 두기 미적용).

#### 화면용 서버 계약

- 세션 상태 `state`에 `background`가 있다: 턴은 끝났고 CLI에서 하위 작업이 도는 중. 새 요청은 바로 보낼 수 있고(대기열에 넣지 않음) 같은 프로세스에 쓴다. 중지(`POST /api/sessions/:id/stop`)는 남은 작업과 CLI를 함께 멈춘다. 라벨은 `STATE_LABEL.background`("백그라운드 작업 중").
- `GET /api/sessions/:id`(및 `?meta=1`)의 `subtasks`: 최근 30개 작업 배열(넘으면 끝난 작업부터 오래된 순으로 지움). 목록(`GET /api/sessions`)에는 배열 대신 `subtaskCount: { running, total }`만 싣는다.
  - `id`(CLI task_id), `toolUseId`(작업을 시작한 Agent 도구 호출 ID), `description`, `type`(서브에이전트 종류 또는 작업 종류), `taskType`(`local_agent`·`local_bash`·`local_workflow` 등), `status`(`running`·`completed`·`failed`·`stopped`·`interrupted`), `background`(백그라운드로 띄웠는지. 동기 Agent 도구는 `false`), `parentId`(이 작업을 띄운 상위 작업), `depth`(서브에이전트 중첩 깊이), `prompt`(최대 2000자), `startedAt`·`endedAt`·`lastProgressAt`(ISO 시각), `usage: { totalTokens, toolUses, durationMs } | null`, `lastTool`(한국어 도구 라벨, 예: "파일 읽기"), `summary`(진행 한 줄 요약 또는 끝난 뒤 결과 요약), `error`, `outputFile`, `reason`, `ambient`(CLI 정리 작업. 상태 계산에서 뺀다), `activity`(최근 30개 `{ ts, kind: "text"|"tool"|"error", label?, text }`. 하위 작업 안의 대화는 본 기록 `events`에 넣지 않고 여기에만 둔다).
- SSE `subtasks` `{ sessionId, tasks: [작업 전체 객체], removed: [작업 id] }`: 바뀐 작업만 보낸다. 화면은 `id`로 합치고 `removed`는 지운다.
- `POST /api/sessions/:id/subtasks/:taskId/stop`: 작업 하나만 멈춘다(Claude `stop_task`). CLI가 받으면 `{ ok: true, confirmed: true }`, 10초 안에 답이 없으면 `{ ok: true, confirmed: false }`. 이미 끝났거나 CLI가 없으면 409. 멈춘 결과는 SSE `subtasks`로 온다.
- 설정: `GET /api/status`의 `cliKeepAlive: { idleMinutes, maxProcesses }`, `PUT /api/settings`의 `cliKeepAlive`(0~1440분, 1~64개).

### 작성창 명령과 세션 파일

- 작성창의 `/이름`·`@경로`는 `server/prompt-refs.mjs`가 CLI에 넘길 내용으로 풀어 쓴다(화면 기록에는 입력 그대로). 사용자가 직접 보낸 요청·대기열 요청·작업 중 붙인 요청·버튼 프롬프트만 풀어 쓰고, 연결로 넘어온 글은 그대로 둔다. `/스킬`은 스킬 실행 지시로 바꾸고, 워크트리에서 일하는 Claude에는 프로젝트 스킬 폴더를 `--add-dir`로 연다. `@`는 작업 폴더 안의 실제 파일·폴더만 받으며(심볼릭 링크로 밖을 가리키면 무시), 64KiB 이하 텍스트는 내용을, 그 밖은 경로를 붙인다. 요청 하나에 10개, 붙이는 내용 합계 256KiB까지다. 자동 완성 목록은 `GET /api/sessions/:id/files?q=`가 `git ls-files --cached --others --exclude-standard`(git이 아니면 폴더 탐색) 결과를 15초 동안 캐시해 이름순 점수로 고른다.
- `.agenthub` 파일(`server/session-bundle.mjs`)은 `{ format: "agenthub-session", version: 1, exportedAt, session, events, attachments }` JSON이다. `events`는 보이는 필드만 담고 비밀값을 가리며, 기다리던 질문·계획·권한 카드는 끝난 상태로 바꾼다. 첨부는 base64로 합계 20MB까지 넣고 넘치면 이름만 남긴다(`omittedAttachments`). 더 새 `version`은 거절한다.
- `POST /api/sessions/:id/export`의 `format`은 `markdown`(기본, 예전 호출과 호환)·`agenthub`이고, 화면은 `.agenthub`를 먼저 보인다. `POST /api/sessions/import-record`와 `POST /api/sessions/:id/read-record`는 `docs/agenthub`의 `fileName`이나 업로드한 `content`(예전 `markdown`도 받음)를 받는다. 읽힌 기록은 세션의 `pendingReads`에 두었다가 다음 요청 하나에만 붙인다.

### 세션 묶음 노드

명령 노드 저장소(`commands.json`)에 `kind: "group"`, `members: [세션 ID]`로 둔다(20개까지, 같은 프로젝트의 일반 세션만). `Chain.onTurnEnd`가 연결·대기열 처리 뒤 그 세션이 든 묶음을 확인해, 묶은 세션이 모두 실행·일시중지·답 대기·대기열이 없으면 `fireGroup`으로 나가는 연결을 고른다(성공: 오류로 끝난 세션 없음, 키워드: 세션들의 판정 줄 중 하나). 넘기는 단계 수는 묶은 세션 중 가장 깊은 값을 잇는다. 묶음으로 들어오는 연결은 묶은 세션마다 같은 내용을 넣는다. 세션을 지우거나 재생성하면 `members`도 고친다.

### 세션끼리 소통하는 MCP 도구

모든 세션(일반 채팅 제외)의 CLI에 AgentHub MCP 서버가 붙고, 첫 요청에 사용법이 붙는다.

| 도구 | 하는 일 |
| --- | --- |
| `list_sessions` | 같은 프로젝트에서 활성 노드 연결로 직접 연결된 세션(이름, 역할, 상태)만 본다. |
| `send_message(to, text)` | 다른 세션에 메시지를 보낸다. 받는 쪽이 실행 중이고 요청을 붙일 수 있으면(Claude, Codex) 작업 중인 턴에 바로 들어가고, 아니면 대기열을 거쳐 다음 요청으로 받는다. |
| `ask_session(to, question)` | 묻고 답이 올 때까지 기다린다(기본 5분, 최대 10분). 상대가 `send_message`로 답하면 도구 결과로 돌아온다. |
| `check_messages` | 작업 중에 와서 대기열에 쌓인 메시지를 꺼내 읽는다(Codex가 턴을 준비하는 중이라 바로 붙이지 못한 경우처럼 실행 중 턴에 들어가지 못한 메시지용). |
| `board_read` / `board_post(text)` | 프로젝트 **공유 노트**를 읽고 덧붙인다. |

- `to`에는 세션 이름, 역할 이름, 세션 id를 쓴다. "작업 · 리뷰"처럼 흐름 이름이 붙은 제목은 "리뷰"만 써도 된다.
- MCP 도구를 쓸 수 없으면 답변 끝의 ` ```agenthub-message ` 블록(`{"to", "text", "wait"}`)으로 보낸다. `wait`이면 답이 올 때까지 그 세션의 연결로 넘기지 않고, 답을 받은 턴이 끝나면 연결로 넘긴다.
- 메시지로 새 턴을 여는 것도 자동 연결의 8단계 제한에 들어가고, 한 턴에 보낼 수 있는 메시지는 12개다. 서로의 답을 기다리는 `ask_session`은 거절한다.

### 오케스트레이터 계획 형식

오케스트레이터는 답변 끝에 ` ```agenthub-plan ` JSON 블록으로 계획(만들 세션, 연결, 보낼 요청)을 쓴다. 첫 요청에는 지휘 규칙과 이 프로젝트의 세션 목록이 붙고, 이후 요청에는 세션 상태가 붙는다. 계획에 `isolate: true`와 `worktreeName`을 명시한 경우에만 워크트리를 만든다. 계획에 워커 → `orchestrator` 연결을 넣으면 결과가 오케스트레이터로 돌아온다.

## 보안

서버는 `127.0.0.1`에만 열린다. Host 헤더와 `X-AgentHub` 헤더를 확인해 다른 웹사이트가 브라우저를 통해 명령을 실행하지 못하게 한다. 에이전트 CLI가 부르는 MCP 주소(`/mcp/<토큰>`)는 세션마다 서버가 켜질 때 새로 만드는 비밀 토큰으로 확인하고, 브라우저에서 온 요청(Origin 헤더)은 받지 않는다. 이 앱은 에이전트에게 파일 수정과 명령 실행을 맡기므로 외부에 노출하지 않는다.

## 코드 구조

- `public/app.js`는 화면 기능들을 조립한다. `public/features/`의 Controller가 API 요청과 화면 상태를 관리하고 View는 DOM을 그린다. 공통 HTTP·SSE·서버 상태 처리는 `public/shared/`와 `public/application/`에 둔다.
- `server/bootstrap.mjs`의 `createHub()`가 저장소·실행기·서비스를 조립한다. 생성 후 `start()`로 서버를 열고 `shutdown()`으로 닫는다. 모듈을 import하는 것만으로 서버를 시작하지 않는다.
- `server/transport/`는 HTTP·MCP·SSE 입출력, `server/application/`은 세션·프로젝트·메시지·워크플로의 업무 처리, `server/policies/`는 연락 권한과 연결 조건 같은 순수 판단을 맡는다.
- `server/infrastructure/persistence/`는 파일 저장을 담당한다. 서버와 저장소의 `dataDir`을 주입해 테스트용 데이터와 실제 기록을 분리한다. 기존 저장소 import 경로는 호환용 진입점으로 유지한다.
- `server/index.mjs`는 명령줄 실행 진입점이며, `electron/main.mjs`는 창과 앱 수명을 관리한다. 두 진입점이 같은 서버 조립 코드를 사용한다.

## 테스트

작은 변경은 해당 테스트 파일이나 영역부터 실행한다. 아래 명령은 저장소 루트에서 실행한다.

| 명령 | 검사 범위와 사용 시점 |
| --- | --- |
| `npm run test:fast` | 작성창·시간 표시·프런트 공통 로직·Git 그래프 배치·마크다운의 순수 로직 5개 파일. 해당 로직을 수정하는 동안 빠르게 확인한다. |
| `npm run test:git` | Git 패널·그래프·스테이징·워크트리·읽기 전용 조회·GitHub 및 관련 API 통합 검사. |
| `npm run test:ui` | 화면 로직과 브라우저 통합 검사. |
| `node --test test/parsers.test.mjs` | 파일을 직접 지정하는 예시. 서버 등 특정 기능 수정 시 관련 테스트 파일을 지정한다. 여러 파일도 지정할 수 있다. |
| `npm test` | 모든 테스트. 공통 기반이나 여러 영역을 수정했을 때, 최종 회귀 검증이 필요할 때 실행한다. Git·브라우저 테스트가 한꺼번에 몰려 시간 초과되지 않도록 테스트 파일은 4개씩만 동시에 실행한다. |

빠른 검사와 영역별 검사는 전체 검증을 대신하지 않는다. 영역 간에는 공통 테스트가 겹치므로 전체 검증이 필요하면 `npm test`를 한 번 실행한다. 영역별 명령의 파일 목록은 `package.json`에 있으며, 해당 영역의 테스트 파일을 추가하거나 나누면 목록도 갱신한다.

Git 패널의 그래프·스테이징 검사는 별도 파일과 임시 저장소에서 실행한다. 같은 저장소 상태를 이어 사용하는 `gitpanel.test.mjs` 안의 검사는 순서를 유지한다.

서버 통합 테스트는 임시 데이터 폴더를 사용한다. 화면 통합 테스트는 Windows에 Chrome이 설치되어 있으면 임시 프로필과 가짜 API로 실행하며, 실제 에이전트 작업을 시작하지 않는다. Chrome이 없는 환경에서는 브라우저 테스트만 건너뛴다.

## README 스크린샷

`docs/images/`의 화면은 예시 프로젝트(`web-shop`)와 예시 대화를 넣은 별도 데이터 폴더(`AGENTHUB_DATA`)로 띄운 서버를 헤드리스 Chrome으로 찍은 것이다. 실제 사용자 데이터와 사용량은 들어 있지 않다.
