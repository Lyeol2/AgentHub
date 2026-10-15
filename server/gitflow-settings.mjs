import path from "node:path";
import { HttpError } from "./application/errors.mjs";

export const DEFAULT_GITFLOW_SETTINGS = Object.freeze({
  main: "main",
  develop: "develop",
  featurePrefix: "feature/",
  hotfixPrefix: "hotfix/",
  releasePrefix: "release/",
});

const LABELS = { main: "배포 브랜치", develop: "개발 브랜치", featurePrefix: "기능 개발 접두어", hotfixPrefix: "긴급 수정 접두어", releasePrefix: "배포 준비 접두어" };
const invalid = (message) => new HttpError(400, message, "gitflow-settings");

// 브랜치 이름의 대소문자를 보존한다. Git ref 문법 검사는 저장 전에 Git으로 검증한다.
export function normalizeGitflowSettings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("GitFlow 설정을 확인하세요.");
  const settings = {};
  for (const [key, fallback] of Object.entries(DEFAULT_GITFLOW_SETTINGS)) {
    const input = Object.hasOwn(value, key) ? value[key] : fallback;
    if (typeof input !== "string" || !input.trim()) throw invalid(`${LABELS[key]}를 입력하세요.`);
    const name = input.trim();
    if (name.length > 200) throw invalid(`${LABELS[key]}는 200자 이내로 입력하세요.`);
    settings[key] = key.endsWith("Prefix") && !name.endsWith("/") ? `${name}/` : name;
  }
  if (settings.main.toLowerCase() === settings.develop.toLowerCase()) throw invalid("배포 브랜치와 개발 브랜치는 서로 다른 이름으로 입력하세요.");
  return settings;
}

export function gitflowSettingsKey(projectPath) {
  if (typeof projectPath !== "string" || !projectPath.trim()) throw invalid("GitFlow 설정을 저장할 프로젝트를 선택하세요.");
  return path.resolve(projectPath).toLowerCase();
}

export function projectGitflowSettings(config, projectPath) {
  return normalizeGitflowSettings(config?.gitflow?.[gitflowSettingsKey(projectPath)] ?? {});
}
