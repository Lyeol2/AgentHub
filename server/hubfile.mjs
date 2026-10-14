// 프로젝트 루트의 AGENTHUB.md: 세션끼리 협업하는 방식(공통 지침, 역할 템플릿, 흐름 템플릿).
// 프로젝트 규칙은 CLAUDE.md·AGENTS.md에 두고 여기에는 넣지 않는다.
import fs from "node:fs";
import path from "node:path";
import { AGENTS } from "./runner.mjs";

export const HUB_FILE = "AGENTHUB.md";

const SETTING_KEYS = {
  에이전트: "agent", agent: "agent",
  권한: "permission", permission: "permission",
  모델: "model", model: "model",
  "작업 폴더": "folder", folder: "folder",
};
const FOLDERS = { 분리: true, worktree: true, 원본: false, original: false };
const CONDITIONS = {
  성공: "success", "성공 시": "success", success: "success",
  실패: "error", "실패 시": "error", error: "error",
  항상: "always", always: "always",
  수동: "manual", manual: "manual",
};

function parseRole(name, lines, warnings) {
  const role = { name, agent: "claude", permission: null, model: "", isolate: true, body: "" };
  let i = 0;
  // 머리의 "- 키: 값" 줄은 설정이고, 처음 나오는 다른 줄부터 역할 본문이다.
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = line.match(/^[-*]\s*([^:：]+?)\s*[:：]\s*(.+)$/);
    const key = m && SETTING_KEYS[m[1].toLowerCase()];
    if (!key) break;
    const value = m[2].trim();
    if (key === "folder") {
      if (value in FOLDERS) role.isolate = FOLDERS[value];
      else warnings.push(`역할 "${name}": 작업 폴더는 분리 또는 원본입니다 (${value}).`);
    } else {
      role[key] = key === "agent" ? value.toLowerCase() : value;
    }
  }
  role.body = lines.slice(i).join("\n").trim();
  if (!AGENTS[role.agent]) {
    warnings.push(`역할 "${name}": 에이전트는 claude 또는 codex입니다 (${role.agent}).`);
    role.agent = "claude";
  }
  const modes = AGENTS[role.agent].PERMISSION_MODES;
  if (role.permission && !modes.includes(role.permission)) {
    warnings.push(`역할 "${name}": ${role.agent} 권한은 ${modes.join(", ")} 중 하나입니다 (${role.permission}).`);
    role.permission = null;
  }
  // Claude의 bypassPermissions는 기본값으로 두지 않는다.
  role.permission ??= role.agent === "claude" ? "acceptEdits" : modes.at(-1);
  return role;
}

// "- 보내는 역할 -> 받는 역할: 조건 | 지시" 줄만 연결로 읽고 나머지 줄은 설명으로 둔다.
function parseFlow(name, lines, warnings) {
  const steps = [];
  for (const raw of lines) {
    const m = raw.trim().match(/^[-*]\s*(.+?)\s*(?:->|→)\s*([^:：]+?)\s*(?:[:：]\s*(.*))?$/);
    if (!m) continue;
    const [, from, to, rest = ""] = m;
    const bar = rest.indexOf("|");
    const cond = (bar >= 0 ? rest.slice(0, bar) : rest).trim();
    const note = bar >= 0 ? rest.slice(bar + 1).trim() : "";
    const quoted = cond.match(/^["'“‘](.+)["'”’]$/);
    if (quoted) {
      steps.push({ from, to, when: "keyword", keyword: quoted[1], note });
    } else if (!cond || CONDITIONS[cond.toLowerCase()]) {
      steps.push({ from, to, when: cond ? CONDITIONS[cond.toLowerCase()] : "success", keyword: "", note });
    } else {
      warnings.push(`흐름 "${name}": 조건을 알 수 없습니다 (${cond}). 성공/실패/항상/수동 또는 "키워드"로 적습니다.`);
    }
  }
  return { name, steps };
}

export function parseHubFile(text) {
  const result = { common: "", roles: [], flows: [], warnings: [] };
  const sections = [];
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^##\s+(.+?)\s*$/);
    if (head) sections.push({ head: head[1], lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  for (const { head, lines } of sections) {
    let m;
    if (/^공통\s*지침$/.test(head)) result.common = lines.join("\n").trim();
    else if ((m = head.match(/^역할\s*[:：]\s*(.+)$/))) result.roles.push(parseRole(m[1].trim(), lines, result.warnings));
    else if ((m = head.match(/^흐름\s*[:：]\s*(.+)$/))) result.flows.push(parseFlow(m[1].trim(), lines, result.warnings));
  }

  const names = new Set();
  for (const role of result.roles) {
    if (names.has(role.name)) result.warnings.push(`역할 "${role.name}"이 두 번 있습니다. 앞의 것을 씁니다.`);
    names.add(role.name);
  }
  for (const flow of result.flows) {
    for (const step of flow.steps) {
      for (const role of [step.from, step.to]) {
        if (!names.has(role)) result.warnings.push(`흐름 "${flow.name}": 역할 "${role}"이 없습니다.`);
      }
    }
    if (!flow.steps.length) result.warnings.push(`흐름 "${flow.name}"에 연결이 없습니다.`);
  }
  return result;
}

export function hubFilePath(projectPath) {
  return path.join(projectPath, HUB_FILE);
}

// 파일이 없으면 null
export function readHubFile(projectPath) {
  if (!projectPath) return null;
  try {
    return parseHubFile(fs.readFileSync(hubFilePath(projectPath), "utf8"));
  } catch {
    return null;
  }
}

export const HUB_TEMPLATE = `# AgentHub

AgentHub에서 세션끼리 협업하는 방식이다. 코드 규칙·빌드 명령 같은 프로젝트 지식은 CLAUDE.md·AGENTS.md에 둔다.

## 공통 지침

모든 세션의 첫 요청에 붙는다.

- 커밋하지 않는다. 끝나면 바뀐 파일과 이유를 짧게 정리한다.
- 맡은 범위 밖을 고쳐야 하면 직접 고치지 말고 알린다.

## 역할: 구현

- 에이전트: claude
- 권한: acceptEdits
- 작업 폴더: 분리

요청받은 기능을 구현한다. 끝나면 마지막 줄에 "검토 요청"이라고 쓴다.

## 역할: 리뷰

- 에이전트: codex
- 권한: read-only
- 작업 폴더: 원본

코드를 고치지 않는다. 넘어온 작업 폴더의 변경을 읽고 버그와 빠진 처리를 찾는다.
고칠 것이 있으면 마지막 줄에 "수정 필요", 없으면 "통과"라고 쓴다.

## 흐름: 구현과 리뷰

- 구현 -> 리뷰: "검토 요청"
- 리뷰 -> 구현: "수정 필요" | 리뷰에서 지적한 것만 고친다.
`;
