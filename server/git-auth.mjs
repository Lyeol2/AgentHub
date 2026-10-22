import { locateCli } from "./cli.mjs";

export class GitHubError extends Error {
  constructor(message, reason = "github-error", status = 400, outcomeUnknown = false) {
    super(message);
    Object.assign(this, { reason, status, outcomeUnknown });
  }
}

export const cleanError = (text) => String(text ?? "")
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
  .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[token]")
  .replace(/https?:\/\/[^/\s@]+@/g, "https://[credentials]@")
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim().slice(0, 1600);

// 백그라운드 Git 명령은 로그인 창을 띄울 수 없다. 인증 실패를 사용자가 해결할 수 있는 안내로 바꾼다.
const SSH_AUTH = /Permission denied \(publickey\)|Host key verification failed/i;
const HTTPS_AUTH = /could not read (?:Username|Password) for|Authentication failed for|Invalid username or (?:password|token)|user interactivity has been disabled|terminal prompts disabled|Repository not found|requested URL returned error: 40[13]/i;
export function gitAuthFailure(text) {
  const value = String(text ?? "");
  if (SSH_AUTH.test(value)) return new GitHubError("SSH 키로 GitHub에 접속하지 못했습니다. 이 PC의 SSH 키를 GitHub 계정에 등록하거나, 원격 주소를 https://github.com/<소유자>/<저장소>.git 형식으로 바꾼 뒤 GitHub에 로그인하세요.", "git-auth-ssh", 401);
  if (HTTPS_AUTH.test(value)) return new GitHubError("GitHub 로그인이 필요합니다. GitHub CLI로 로그인하면 AgentHub의 최신 확인·푸시도 그 계정을 씁니다. 이미 로그인했다면 그 계정에 이 저장소 접근 권한이 있는지 확인하세요.", "git-auth", 401);
  return null;
}

// 저장된 자격 증명이 없거나 만료됐을 때 GitHub CLI 로그인으로 이어 받는다.
// 기존 자격 증명 도우미가 먼저 시도되고, 사용자의 전역 Git 설정은 바꾸지 않는다.
export function githubCredentialArgs(gh = locateCli("gh", "")) {
  const file = String(gh ?? "").replace(/\\/g, "/");
  if (!file || /["$`\r\n]/.test(file)) return [];
  return ["-c", `credential.https://github.com.helper=!"${file}" auth git-credential`];
}
