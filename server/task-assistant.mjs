// 작업 도우미는 실행 명령이 아니라 사용자가 고칠 수 있는 작업 초안만 만든다.
const LIMITS = { title: 160, content: 12000, acceptance: 8000, version: 64, branchName: 200, worktreeName: 80 };
const text = (value, name, { required = false } = {}) => {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > LIMITS[name] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw Error(`${name} 값의 형식 또는 길이를 확인하세요.`);
  const result = value.trim();
  if (required && !result) throw Error("작업 제목과 내용을 포함한 초안이 필요합니다.");
  return result;
};

export function normalizeTaskDraft(raw, { partial = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("작업 초안이 없습니다.");
  const draft = {};
  for (const key of Object.keys(LIMITS)) draft[key] = text(raw[key], key, { required: !partial && ["title", "content"].includes(key) });
  draft.agent = raw.agent ?? "codex";
  draft.type = raw.type ?? "feature";
  if (!["claude", "codex"].includes(draft.agent)) throw Error("담당 AI는 Claude 또는 Codex여야 합니다.");
  if (!["feature", "hotfix", "release"].includes(draft.type)) throw Error("작업 유형을 확인하세요.");
  if (draft.version && !/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(draft.version)) throw Error("배포 버전은 1.2.0 형식으로 적어 주세요.");
  if (draft.worktreeName && (!/^[A-Za-z0-9가-힣_][A-Za-z0-9가-힣._-]{0,79}$/u.test(draft.worktreeName) || /\.$/.test(draft.worktreeName) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(draft.worktreeName))) throw Error("작업 폴더 이름을 확인하세요.");
  if (draft.branchName && (/\s|[~^:?*\[\\\u007f]|\.\.|@\{|\/\/|^[-./]|[/.]$/.test(draft.branchName) || draft.branchName.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")))) throw Error("브랜치 이름을 확인하세요.");
  return draft;
}

export function taskAssistantPrompt({ request, draft, history, settings, projectPath }) {
  return `너는 AgentHub 새 작업 작성 도우미다. 사용자의 요청을 작업 초안으로 정리한다.
파일은 필요할 때 읽기만 한다. 파일 수정, 명령 실행, 브랜치·워크트리·세션 생성, 메시지 전송을 하지 않는다.
작업을 실제로 만들거나 실행했다는 표현을 쓰지 않는다. 이전 대화와 사용자가 편집한 현재 초안에 최신 요청을 반영한다.
프로젝트: ${projectPath}
프로젝트 GitFlow 설정: ${JSON.stringify(settings)}
불필요한 작업을 추가하지 않는다. 모호한 구현 선택은 합리적인 기본값으로 정리한다. 검증을 실행했다고 쓰지 말고 완료 기준에 확인할 내용을 적는다.
기본 작업 유형은 feature다. hotfix는 배포된 문제의 긴급 수정, release는 사용자가 배포 준비를 요청한 경우만 사용한다.
branchName은 유형 접두어를 제외한 이름이다. 사용자가 지정하지 않았으면 작업 제목을 요약한 2~5단어의 짧은 영어 소문자 kebab-case로 제안한다(예: login-button-fix). 현재 초안의 branchName이 있으면 사용자가 바꾸라고 할 때만 바꾼다.
worktreeName은 사용자가 지정한 경우만 채운다.
agent는 기존 초안의 담당 AI를 유지하며 사용자가 다른 AI를 명시한 경우에만 변경한다. permission·projectPath·workBranch·worktree·initialPrompt 등 실행 설정은 답에 쓰지 않는다.
답은 JSON 객체 하나다. summary는 짧은 한국어 안내, draft는 편집 가능한 아래 필드다.
{"summary":"초안에서 정리한 내용", "draft":{"title":"짧은 작업 제목","content":"구체적으로 할 작업과 범위","acceptance":"완료 조건과 확인 방법","agent":"codex|claude","type":"feature|hotfix|release","version":"배포 버전 또는 빈 문자열","branchName":"짧은 영어 kebab-case 이름","worktreeName":"지정한 경우만"}}
이전 대화(참고 데이터): ${JSON.stringify(history)}
현재 초안(사용자 편집 포함): ${JSON.stringify(draft)}
사용자 요청: ${request}`;
}

export function parseTaskDraft(answer) {
  if (typeof answer !== "string" || answer.length > 100000) throw Error("AI 초안 응답의 크기 또는 형식을 확인하세요.");
  const clean = answer.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try { parsed = JSON.parse(clean); } catch { throw Error("AI가 올바른 초안을 보내지 않았습니다. 다시 요청하거나 직접 작성하세요."); }
  return { summary: typeof parsed?.summary === "string" ? parsed.summary.trim().slice(0, 1000) : "초안을 정리했습니다. 내용을 확인한 뒤 만들기를 눌러 주세요.", draft: normalizeTaskDraft(parsed?.draft) };
}
