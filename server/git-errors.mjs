import { gitAuthFailure } from "./github.mjs";

// 자주 나는 git 오류 원문을 사용자가 이해할 수 있는 한국어 설명과 해결 방법으로 바꾼다.
// 위에서부터 먼저 맞는 규칙을 쓴다. 인증 실패는 푸시 거부 문구와 함께 나와도 인증을 먼저 안내한다.
const RULES = [
  { reason: "git-locked", test: /index\.lock'?: File exists|Unable to create '[^']*\.lock'|another git process seems to be running/i,
    message: "다른 Git 작업이 이 저장소를 사용하고 있습니다.",
    hint: "세션이나 다른 Git 프로그램의 작업이 끝난 뒤 다시 시도하세요. 잠금 파일은 자동으로 지우지 않습니다." },
  { reason: "git-dirty", test: /would be overwritten by (?:checkout|merge|switch)|Please commit your changes or stash them|Your local changes to the following files|untracked working tree files would be|You have unstaged changes|contains uncommitted changes/i,
    message: "커밋하지 않은 변경이 있어 진행하지 않았습니다.",
    hint: "변경 사항을 먼저 커밋하거나 정리한 뒤 다시 시도하세요." },
  { reason: "git-conflict", test: /CONFLICT \(|Automatic merge failed|Merge conflict in|fix conflicts and then commit|unmerged files|needs merge|resolve your current index first/i,
    message: "같은 부분이 양쪽에서 바뀌어 충돌이 났습니다.",
    hint: "충돌한 파일을 고친 뒤 다시 반영하세요. 세션에 충돌 해결을 요청할 수 있습니다." },
  { reason: "git-push-protected", test: /pre-receive hook declined|protected branch|GH006|GH013/i,
    message: "원격 저장소의 보호 규칙이 푸시를 거절했습니다.",
    hint: "보호된 브랜치에는 직접 푸시하지 말고 작업 브랜치에서 Pull Request로 반영하세요." },
  { reason: "git-push-rejected", test: /\[rejected\]|non-fast-forward|\(fetch first\)|Updates were rejected|failed to push some refs/i,
    message: "원격 브랜치에 아직 받지 않은 커밋이 있어 푸시가 거절됐습니다.",
    hint: "Pull로 원격 변경을 받아 합친 뒤 다시 푸시하세요. 작업 카드에서는 '원격 변경 합치기'(기준 반영)가 원격 작업 브랜치의 새 커밋을 먼저 합칩니다." },
  { reason: "git-diverged", test: /Not possible to fast-forward|Diverging branches can't be fast-forwarded|have diverged/i,
    message: "로컬과 원격이 서로 다른 커밋을 가지고 있어 앞으로 감기만으로 받을 수 없습니다.",
    hint: "병합(Merge)이나 리베이스(Rebase)로 두 기록을 합쳐야 합니다." },
  { reason: "git-no-upstream", test: /There is no tracking information|has no upstream branch|no upstream configured/i,
    message: "이 브랜치가 따라갈 원격 브랜치가 정해지지 않았습니다.",
    hint: "먼저 Push로 원격에 브랜치를 게시하면서 추적을 설정하세요." },
  { reason: "git-network", test: /Could not resolve host|Failed to connect to|Connection (?:timed out|refused)|Network is unreachable|unable to access '[^']*': (?:Could not|Failed|Recv failure|OpenSSL)/i,
    message: "원격 저장소에 연결하지 못했습니다.",
    hint: "인터넷 연결과 원격 주소를 확인한 뒤 다시 시도하세요." },
];

export function translateGitError(text) {
  const raw = String(text ?? "");
  const auth = gitAuthFailure(raw);
  if (auth) return { reason: auth.reason, message: auth.message, hint: "", status: auth.status ?? 401 };
  const rule = RULES.find((item) => item.test.test(raw));
  return rule ? { reason: rule.reason, message: rule.message, hint: rule.hint, status: 409 } : null;
}

// 사유와 해결 방법을 담은 오류 속성. 원문은 raw로 남겨 화면에서 펼쳐 볼 수 있게 한다.
export function gitErrorDetails(text, { maxRaw = 1600 } = {}) {
  const translated = translateGitError(text);
  if (!translated) return null;
  return { ...translated, raw: String(text ?? "").trim().slice(0, maxRaw) };
}
