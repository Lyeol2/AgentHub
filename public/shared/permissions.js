const PERMISSION_LABEL = {
  "auto-review": "자동 검토 · 승인 요청을 AI가 판단",
  "danger-full-access": "전체 접근 · 승인 없이 실행, 샌드박스 해제",
};

export const permissionLabel = (permission) => PERMISSION_LABEL[permission] ?? permission;

export function defaultPermission(agent, modes) {
  const preferred = agent === "claude" ? "acceptEdits" : "workspace-write";
  return modes.includes(preferred) ? preferred : modes[0] ?? "";
}
