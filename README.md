# AgentHub

Claude Code와 Codex 세션을 한 화면에서 만들고 이어 가는 로컬 웹앱이다. 각 에이전트의 CLI를 대신 실행하므로, 이미 로그인한 구독 계정의 사용량 안에서 동작한다. API 키를 쓰지 않는다.

## 요구 사항

- Node.js 20 이상, git
- Claude Code CLI: `claude auth login`으로 로그인되어 있어야 한다. PATH에 없으면 Claude 데스크톱 앱이 내려받은 `claude.exe`를 자동으로 찾는다.
- Codex CLI: `codex login`으로 로그인되어 있어야 한다. `npm i -g @openai/codex`로 설치한 경우 `%APPDATA%\npm`에서 자동으로 찾는다.

외부 패키지는 쓰지 않는다.

## 실행

```bash
npm start
```

브라우저에서 <http://127.0.0.1:4517>을 연다. 포트는 `PORT` 환경 변수나 `data/config.json`의 `port`로 바꾼다.

1. **설정**에서 프로젝트 폴더를 추가한다.
2. **새 세션**에서 에이전트, 프로젝트, 권한을 고른다.
3. 요청을 보내면 CLI 출력이 실시간으로 표시된다. 다음 요청은 같은 CLI 세션을 이어서 실행한다.

## 동작 방식

| 에이전트 | 첫 턴 | 이후 턴 |
| --- | --- | --- |
| Claude | `claude -p --output-format stream-json --verbose --session-id <uuid>` | `--resume <세션 ID>` |
| Codex | `codex exec --json --sandbox <모드> --cd <폴더> -` | `codex exec resume <스레드 ID> --json -` |

- 프롬프트는 명령줄 인자가 아니라 stdin으로 넘긴다.
- **별도 작업 폴더**를 켜면 저장소 옆 `<저장소>.agenthub/<세션 ID>`에 현재 커밋(HEAD) 기준 git worktree와 `agenthub/<세션 ID>` 브랜치를 만든다. 커밋하지 않은 수정은 포함되지 않는다.
- **변경 보기**는 세션을 만들 때의 커밋과 현재 작업 폴더의 차이를 보여 준다.
- 세션 기록은 `data/sessions/`에, 설정은 `data/config.json`에 저장된다. `data/`는 git에 올리지 않는다.

## 권한 모드

| 에이전트 | 모드 | 의미 |
| --- | --- | --- |
| Claude | `plan` | 읽기와 계획만 한다. |
| Claude | `acceptEdits` (기본) | 파일 수정은 허용하고, 허용되지 않은 명령은 거부된다. |
| Claude | `bypassPermissions` | 모든 도구를 확인 없이 실행한다. 분리된 작업 폴더에서만 쓰는 것을 권한다. |
| Codex | `read-only` | 읽기만 한다. |
| Codex | `workspace-write` (기본) | 작업 폴더 안의 쓰기를 허용한다. |

비대화형 실행이므로 실행 도중의 승인 요청은 화면에 뜨지 않고 거부된다.

## 보안

서버는 `127.0.0.1`에만 열린다. Host 헤더와 `X-AgentHub` 헤더를 확인해 다른 웹사이트가 브라우저를 통해 명령을 실행하지 못하게 한다. 이 앱은 에이전트에게 파일 수정과 명령 실행을 맡기므로 외부에 노출하지 않는다.

## 테스트

```bash
npm test
```

## 알려진 한계

- Unity 프로젝트를 별도 작업 폴더에서 열면 `Library/`를 새로 만든다. 여러 세션이 같은 Unity Editor를 동시에 쓰지 않도록 하는 잠금은 아직 없다.
- 실행 중 승인 요청, 이미지 첨부, 작업 기록을 프로젝트 문서로 내보내는 기능은 없다.
