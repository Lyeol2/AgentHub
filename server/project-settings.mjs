// 프로젝트별 설정: 새 세션·새 작업 창의 기본값(AI·권한·워크트리)과 유니티 사용 통제.
// config.projectSettings[프로젝트 경로(소문자)] = { defaults: { agent, permission: { claude, codex }, isolate }, unity }
import path from "node:path";
import { HttpError } from "./application/errors.mjs";
import * as claude from "./agents/claude.mjs";
import * as codex from "./agents/codex.mjs";

const PERMISSIONS = { claude: claude.PERMISSION_MODES, codex: codex.PERMISSION_MODES };
// allow(기본): 세션 권한을 따른다. ask: 세션 권한과 무관하게 유니티 실행·조작을 매번 묻는다. off: 유니티 도구를 끈다.
export const UNITY_MODES = ["ask", "allow", "off"];
export const DEFAULT_UNITY = "allow";

export function projectSettingsKey(projectPath) {
  if (typeof projectPath !== "string" || !projectPath.trim()) throw new HttpError(400, "프로젝트를 선택하세요.");
  return path.resolve(projectPath).toLowerCase();
}

// 저장된 값 중 지금 쓸 수 있는 값만 남긴다. 없는 값은 null(창의 마지막 선택이나 기본값을 쓴다).
export function normalizeProjectSettings(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const d = input.defaults && typeof input.defaults === "object" ? input.defaults : {};
  const permission = {};
  for (const agent of Object.keys(PERMISSIONS)) if (PERMISSIONS[agent].includes(d.permission?.[agent])) permission[agent] = d.permission[agent];
  return {
    defaults: { agent: PERMISSIONS[d.agent] ? d.agent : null, permission, isolate: typeof d.isolate === "boolean" ? d.isolate : null },
    unity: UNITY_MODES.includes(input.unity) ? input.unity : DEFAULT_UNITY,
  };
}

export function projectSettings(config, projectPath) {
  if (!projectPath) return normalizeProjectSettings();
  return normalizeProjectSettings(config?.projectSettings?.[projectSettingsKey(projectPath)]);
}

export const projectUnityMode = (config, projectPath) => projectSettings(config, projectPath).unity;

// 화면에서 받은 값을 검사한다. 잘못된 값은 조용히 버리지 않고 알린다.
export function checkProjectSettings(body = {}) {
  const d = body.defaults ?? {};
  if (d.agent != null && d.agent !== "" && !PERMISSIONS[d.agent]) throw new HttpError(400, "기본 AI는 claude 또는 codex입니다.");
  for (const [agent, mode] of Object.entries(d.permission ?? {})) {
    if (mode == null || mode === "") continue;
    if (!PERMISSIONS[agent]?.includes(mode)) throw new HttpError(400, "기본 권한이 올바르지 않습니다.");
  }
  if (d.isolate != null && d.isolate !== "" && typeof d.isolate !== "boolean") throw new HttpError(400, "워크트리 사용 기본값은 true 또는 false입니다.");
  if (body.unity !== undefined && !UNITY_MODES.includes(body.unity)) throw new HttpError(400, "유니티 사용은 ask, allow, off 중 하나입니다.");
  return normalizeProjectSettings(body);
}
