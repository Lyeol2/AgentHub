// 세션 역할 지침.
export const ROLE_MAX = 4000;
const RULE = "이 역할을 대화 내내 지킨다. 범위 밖 수정이 필요하면 직접 고치지 말고 알린다.";

// CLI 세션은 대화를 이어 가므로 새 대화의 첫 요청에만 역할을 붙인다.
// 대화 중에 역할을 바꾸면 다음 요청에 바뀐 역할만 붙인다.
export function withRole(session, prompt) {
  const changed = session.roleChanged;
  delete session.roleChanged;
  if (session.agentSessionId) {
    if (!changed) return prompt;
    if (!session.role) return `[이 세션의 역할 지정이 해제되었다]\n\n[요청]\n${prompt}`;
    return `[이 세션의 역할이 바뀌었다. 지금부터 아래 역할을 따른다]\n${session.role}\n\n${RULE}\n\n[요청]\n${prompt}`;
  }
  if (!session.role) return prompt;
  return `[이 세션의 역할]\n${session.role}\n\n${RULE}\n\n[요청]\n${prompt}`;
}
