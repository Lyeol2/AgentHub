// 프로젝트 지침(AGENTS.md·CLAUDE.md) 도우미의 순수 규칙: 섹션 나누기, 저장 전 검사, CLAUDE.md 상태, 지침 지도, 순서도 검사.
// 파일 읽기는 이 모듈에서 하지만 쓰기·AI 호출은 application/guide.mjs가 한다.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// 권장 섹션(보이는 순서). aliases는 기존 문서의 비슷한 제목을 같은 섹션으로 보기 위한 말이다.
export const GUIDE_SECTIONS = [
  { key: "summary", title: "프로젝트 요약", aliases: ["프로젝트 요약", "프로젝트 개요", "개요", "요약", "프로젝트"], hint: "무엇을 만드는 프로젝트인지, 주요 기술과 버전, 주요 폴더를 짧게 쓴다." },
  { key: "process", title: "작업 절차", aliases: ["작업 절차", "작업 전 필수 절차", "절차", "작업 순서", "워크플로"], hint: "요청을 받으면 무엇부터 하는지 번호로 쓴다." },
  { key: "docs", title: "필독 문서", aliases: ["필독 문서", "작업별 필독 문서", "참고 문서", "문서"], hint: "작업 종류별로 먼저 읽을 문서를 링크로 쓴다. 예: - C# 수정 시 [코드 스타일](Docs/CodeStyle.md)" },
  { key: "principles", title: "구현 원칙", aliases: ["구현 원칙", "구현 필수 원칙", "원칙", "코딩 규칙", "코드 규칙"], hint: "코드를 쓸 때 지킬 구조·이름·패턴을 쓴다." },
  { key: "forbidden", title: "금지 사항", aliases: ["금지 사항", "금지", "하지 않는 것", "주의 사항"], hint: "절대 하지 않을 일을 쓴다." },
  { key: "verify", title: "검증", aliases: ["검증", "검증과 완료", "테스트", "확인"], hint: "작업 뒤 무엇으로 확인하는지 쓴다." },
  { key: "commit", title: "커밋 규칙", aliases: ["커밋 규칙", "커밋", "git", "git 규칙", "커밋 메시지"], hint: "커밋 메시지 형식과 push 규칙을 쓴다." },
  { key: "response", title: "응답 방식", aliases: ["응답 방식", "응답", "답변 방식", "보고 방식"], hint: "답변에 무엇을 쓰는지 쓴다." },
];
export const GUIDE_FILE_MAX = 400_000;
export const LONG_SECTION = 60;

export const hashText = (text) => createHash("sha1").update(String(text ?? "")).digest("hex").slice(0, 16);
const norm = (s) => String(s ?? "").toLowerCase().replace(/^\d+[.)]\s*/, "").replace(/[\s·`*_]/g, "");

export function sectionKey(title) {
  const t = norm(title);
  for (const section of GUIDE_SECTIONS) if (section.aliases.some((alias) => norm(alias) === t)) return section.key;
  for (const section of GUIDE_SECTIONS) if (section.aliases.some((alias) => norm(alias).length > 1 && t.includes(norm(alias)))) return section.key;
  return null;
}

// "## 제목"(또는 ###) 단위로 나눈다. 줄 번호는 1부터. 코드 블록 안의 #은 제목으로 보지 않는다.
export function parseSections(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const sections = [];
  let fence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const match = line.match(/^(#{2,3})\s+(.+?)\s*#*\s*$/);
    if (!match) return;
    if (match[1].length === 3 && sections.length) return; // ###은 위 섹션의 일부
    sections.push({ title: match[2].trim(), line: index + 1, key: sectionKey(match[2]) });
  });
  for (let i = 0; i < sections.length; i++) {
    const end = (sections[i + 1]?.line ?? lines.length + 1) - 1;
    let last = end;
    while (last > sections[i].line && !lines[last - 1].trim()) last--;
    sections[i].end = last;
    sections[i].lines = last - sections[i].line;
  }
  return sections;
}

// 빈 틀: 권장 섹션 제목과 쓰는 법 주석
export function blankGuide(name = "프로젝트") {
  return [`# ${name} 에이전트 지침`, "", ...GUIDE_SECTIONS.flatMap((s) => [`## ${s.title}`, `<!-- ${s.hint} -->`, ""])].join("\n");
}
export function sectionTemplate(key) {
  const section = GUIDE_SECTIONS.find((s) => s.key === key);
  return section ? `## ${section.title}\n<!-- ${section.hint} -->\n` : "";
}

// ── 저장 전 검사 ──────────────────────────────────────────────
// AgentHub의 연결(다음 세션으로 넘기기)과 부딪히는 문장. 연결로 넘어온 작업에도 그대로 적용되면 흐름이 멈추거나 판정 줄이 밀린다.
const CONFLICTS = [
  { kind: "approval", title: "연결 작업을 멈추게 합니다", pattern: /승인\s*(을|를)?\s*받(은|고|기)?\s*(뒤|후|다음)|승인\s*(전|없이)(에는|는)?\s*.{0,12}(진행|구현|변경|시작).{0,6}(않|말|금지)|승인한\s*(뒤|후|다음)에만|approv(al|ed)\s+before/i,
    detail: "연결로 넘어온 작업은 승인을 기다리면 다음 세션으로 넘어가지 않습니다.", note: " (사용자가 직접 요청한 작업에만 적용한다. 연결로 넘어온 작업은 승인 없이 바로 진행한다.)" },
  { kind: "report-tail", title: "마지막 줄 판정을 밀어냅니다", pattern: /(응답|답변|보고)\s*(의)?\s*(끝|마지막)(에|에는)?.{0,30}(보고|쓴다|적는다|포함|붙인다|덧붙인다|단다)|(끝에|마지막에)\s*.{0,20}(보고한다|요약한다)/,
    detail: "응답 끝에 보고를 붙이면, 연결 세션이 마지막 줄에 쓰는 판정(키워드)이 밀려 다음 세션으로 넘어가지 않습니다.", note: " 단, 연결로 넘어온 작업은 판정 줄을 맨 마지막에 쓴다." },
  { kind: "commit-every", title: "작업마다 커밋·완료보고서", pattern: /(작업|요청)(마다|이\s*끝나면|이\s*완료되면|을\s*마치면).{0,30}(커밋|완료\s*보고서)|완료\s*보고서를?\s*(작성|쓴다)/,
    detail: "역할이 좁은 연결 세션까지 매 턴 커밋·보고서를 만들려 합니다.", note: " (사용자가 직접 요청한 작업에만 적용한다.)" },
];
// 스킬과 겹칠 만한 섹션: 섹션 키 → 스킬 이름에 들어갈 말
const SKILL_TOPICS = { commit: ["commit", "커밋"], verify: ["test", "review", "검증"], docs: ["doc"] };

const LINK = /!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const isExternal = (target) => /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target);
const cleanTarget = (target) => decodeURIComponent(target.split("#")[0].split("?")[0]);

// 문서의 링크(및 CLAUDE.md의 @가져오기). { line, text, target, label, condition, import }
export function guideLinks(text) {
  const links = [];
  let fence = false;
  String(text ?? "").split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const imported = line.match(/^\s*@([^\s]+\.md)\s*$/i);
    if (imported) { links.push({ line: index + 1, text: line.trim(), target: imported[1], label: imported[1], import: true }); return; }
    for (const match of line.matchAll(LINK)) {
      const target = match[2];
      if (isExternal(target)) continue;
      // 링크 앞에 "C# 수정 시"처럼 조건이 있으면 조건부 참조로 본다.
      const before = line.slice(0, match.index).replace(/^\s*(?:[-*+]|\d+[.)]|\|)\s*/, "").replace(/\|/g, " ").trim();
      const condition = /(시|때|경우|전|후|작업)\s*[:：]?\s*$/.test(before) && before.length <= 40 ? before.replace(/[:：]\s*$/, "").trim() : "";
      links.push({ line: index + 1, text: line.trim(), target: cleanTarget(target), label: match[1] || target, condition });
    }
  });
  return links;
}

function lineAt(text, line) { return String(text ?? "").split(/\r?\n/)[line - 1] ?? ""; }

// warnings: [{ id, kind, level, title, detail, line, quote, fix?: { line, from, to } }]
export function checkGuide(text, { file, projectPath, skills = [] } = {}) {
  const warnings = [];
  const lines = String(text ?? "").split(/\r?\n/);
  let fence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence || /^\s*#/.test(line) || /^\s*<!--/.test(line)) return;
    for (const rule of CONFLICTS) {
      if (!rule.pattern.test(line)) continue;
      // 이미 연결 작업 예외를 적어 둔 줄은 넘어간다.
      if (/연결(로|에서)?\s*(넘어온|받은)|사용자가\s*직접\s*요청한/.test(line)) continue;
      const trimmed = line.replace(/\s+$/, "");
      const to = /[.)]$/.test(trimmed) || /다$/.test(trimmed) ? `${trimmed}${rule.note}` : `${trimmed}.${rule.note}`;
      warnings.push({ id: `${rule.kind}:${index + 1}`, kind: rule.kind, level: "conflict", title: rule.title, detail: rule.detail, line: index + 1, quote: line.trim().replace(/^[-*+]\s*|^\d+[.)]\s*/, ""),
        fix: { line: index + 1, from: line, to } });
      break;
    }
  });
  const base = file ? path.dirname(file) : projectPath;
  if (base) {
    for (const link of guideLinks(text)) {
      const target = path.resolve(base, link.target);
      if (fs.existsSync(target)) continue;
      warnings.push({ id: `broken:${link.line}:${link.target}`, kind: "broken-link", level: "error", title: "없는 파일을 가리킵니다", detail: `${link.target} 파일이 없습니다.`, line: link.line, quote: link.text,
        fix: { line: link.line, from: lineAt(text, link.line), to: null } });
    }
  }
  for (const section of parseSections(text)) {
    if (section.lines > LONG_SECTION) warnings.push({ id: `long:${section.line}`, kind: "long-section", level: "info", title: `${section.title}이(가) ${section.lines}줄입니다`, detail: `${LONG_SECTION}줄 이하를 권장합니다. 자세한 내용은 문서로 옮기고 링크하세요.`, line: section.line, quote: "" });
    const topics = SKILL_TOPICS[section.key];
    if (!topics || section.lines < 4) continue;
    const skill = skills.find((s) => topics.some((topic) => s.name.includes(topic)));
    if (skill) warnings.push({ id: `skill:${section.line}:${skill.name}`, kind: "skill-dup", level: "info", title: `${skill.name} 스킬과 겹칩니다`, detail: `${section.title} ${section.lines}줄이 ${skill.name} 스킬과 같은 일을 다룹니다. 스킬을 링크하고 지침에는 요점만 남기세요.`, line: section.line, quote: "" });
  }
  return warnings;
}

// 고쳐 쓰기 제안을 적용한다. to가 null이면 링크만 걷어 내고 글은 남긴다.
export function applyFix(text, fix) {
  const lines = String(text ?? "").split(/\r?\n/);
  const index = fix.line - 1;
  if (lines[index] !== fix.from) throw new Error("그 줄이 바뀌었습니다. 다시 검사하세요.");
  lines[index] = fix.to ?? fix.from.replace(LINK, (_m, label, target) => label || target);
  return lines.join("\n");
}

// ── CLAUDE.md ─────────────────────────────────────────────────
// Claude Code는 CLAUDE.md를 읽는다. @AGENTS.md로 가져오면 같은 지침을 읽는다.
export function claudeStatus(projectPath) {
  const agents = path.join(projectPath, "AGENTS.md");
  const claude = path.join(projectPath, "CLAUDE.md");
  const hasAgents = fs.existsSync(agents);
  if (!fs.existsSync(claude)) return { agents: hasAgents, claude: false, imports: false, extraLines: 0, sections: [] };
  const text = fs.readFileSync(claude, "utf8");
  const imports = guideLinks(text).some((link) => link.import && path.resolve(projectPath, link.target).toLowerCase() === agents.toLowerCase());
  const meaningful = text.split(/\r?\n/).filter((line) => line.trim() && !/^\s*@/.test(line) && !/^#{1,6}\s/.test(line) && !/^\s*<!--/.test(line));
  return { agents: hasAgents, claude: true, imports, extraLines: meaningful.length, sections: claudeSections(text) };
}

// CLAUDE.md의 내용을 합치기 창에 보일 덩어리로 나눈다(제목 없는 앞부분은 "앞부분").
export function claudeSections(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const chunks = [];
  let current = { title: "앞부분", body: [] };
  for (const line of lines) {
    if (/^\s*@\S+\.md\s*$/i.test(line) || /^#\s/.test(line)) continue;
    const heading = line.match(/^#{2,3}\s+(.+)$/);
    if (heading) { if (current.body.some((l) => l.trim())) chunks.push(current); current = { title: heading[1].trim(), body: [] }; continue; }
    current.body.push(line);
  }
  if (current.body.some((l) => l.trim())) chunks.push(current);
  return chunks.map((chunk, index) => ({ index, title: chunk.title, lines: chunk.body.filter((l) => l.trim()).length, text: chunk.body.join("\n").trim() }));
}

// ── 지침 지도 ─────────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", ".git", "Library", "Temp", "obj", "Logs", "Build", "Builds", "dist", "out", ".agenthub", ".claude", ".idea", ".vs", "UserSettings", "Packages"]);
const DOC_DIRS = ["docs", "Docs", ".ai"];

// 하위 폴더의 AGENTS.md·CLAUDE.md(깊이·폴더 수 제한)
export function findNestedGuides(projectPath, { depth = 4, maxDirs = 3000 } = {}) {
  const found = [];
  let seen = 0;
  const walk = (dir, level) => {
    if (level > depth || seen > maxDirs) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".") && entry.name !== ".ai") continue;
      seen++;
      const sub = path.join(dir, entry.name);
      for (const name of ["AGENTS.md", "CLAUDE.md"]) if (fs.existsSync(path.join(sub, name))) found.push(path.join(sub, name));
      walk(sub, level + 1);
    }
  };
  walk(projectPath, 1);
  return found;
}

function docFiles(projectPath, max = 400) {
  const files = [];
  const walk = (dir, level) => {
    if (level > 5 || files.length >= max) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full, level + 1); }
      else if (/\.md$/i.test(entry.name)) files.push(full);
    }
  };
  const seen = new Set();
  for (const name of DOC_DIRS) {
    const dir = path.join(projectPath, name);
    let real;
    try { real = fs.realpathSync(dir); } catch { continue; }
    if (seen.has(real.toLowerCase())) continue; // Windows: docs와 Docs는 같은 폴더
    seen.add(real.toLowerCase());
    walk(dir, 1);
  }
  return files;
}

const rel = (projectPath, file) => path.relative(projectPath, file).replaceAll("\\", "/");
const lineCount = (file) => { try { return fs.readFileSync(file, "utf8").split(/\r?\n/).length; } catch { return 0; } };

// nodes: { id, kind: root|claude|nested|doc|skill|role|inject, title, sub, file?, readers, lines?, broken?, orphan?, sessionId? }
// edges: { from, to, kind: import|link|conditional|skill|inject, label?, broken? }
export function guideMap(projectPath, { skills = [], sessions = [], links = [] } = {}) {
  const nodes = new Map();
  const edges = [];
  const add = (node) => { if (!nodes.has(node.id)) nodes.set(node.id, node); return nodes.get(node.id); };
  const status = claudeStatus(projectPath);
  const fileNode = (file, kind) => {
    const id = rel(projectPath, file);
    const exists = fs.existsSync(file);
    const readers = kind === "root" ? (status.imports ? "둘 다 (Claude · Codex)" : "Codex만") : kind === "claude" ? "Claude 전용" : kind === "nested" ? (/CLAUDE\.md$/i.test(file) ? "Claude 전용" : "Codex 전용") : "링크를 따라가면";
    return add({ id, kind, title: path.basename(file), sub: kind === "doc" ? id : kind === "nested" ? `${path.dirname(id)}/ 아래에서 읽음` : kind === "root" ? `루트 · ${exists ? lineCount(file) : 0}줄` : "", file, readers, lines: exists ? lineCount(file) : 0, broken: !exists });
  };
  const sources = [];
  const agents = path.join(projectPath, "AGENTS.md");
  const claude = path.join(projectPath, "CLAUDE.md");
  if (fs.existsSync(agents)) { fileNode(agents, "root"); sources.push(agents); }
  if (fs.existsSync(claude)) {
    const node = fileNode(claude, "claude");
    node.sub = status.imports ? (status.extraLines ? `@AGENTS.md + ${status.extraLines}줄` : "@AGENTS.md만 있음") : "AGENTS.md를 가져오지 않음";
    sources.push(claude);
  }
  for (const file of findNestedGuides(projectPath)) {
    fileNode(file, "nested");
    sources.push(file);
    const parent = fs.existsSync(agents) ? rel(projectPath, agents) : null;
    if (parent && /AGENTS\.md$/i.test(file)) edges.push({ from: parent, to: rel(projectPath, file), kind: "link", label: "하위 폴더" });
  }
  const referenced = new Set();
  for (const source of sources) {
    const text = fs.readFileSync(source, "utf8");
    for (const link of guideLinks(text)) {
      const target = path.resolve(path.dirname(source), link.target);
      const id = rel(projectPath, target);
      if (id === rel(projectPath, source)) continue;
      const known = nodes.get(id);
      if (!known) {
        const node = fileNode(target, "doc");
        if (node.broken) node.sub = "파일 없음";
      }
      referenced.add(id.toLowerCase());
      edges.push({ from: rel(projectPath, source), to: id, kind: link.import ? "import" : link.condition ? "conditional" : "link", label: link.import ? "@import" : link.condition || "", line: link.line, broken: !fs.existsSync(target) });
    }
  }
  // 문서 폴더에 있는데 아무도 가리키지 않는 문서(흐리게)
  for (const file of docFiles(projectPath)) {
    const id = rel(projectPath, file);
    if (referenced.has(id.toLowerCase()) || nodes.has(id)) continue;
    add({ id, kind: "doc", title: path.basename(file), sub: "참조 없음", file, readers: "참조 없음", lines: lineCount(file), orphan: true });
  }
  const root = fs.existsSync(agents) ? rel(projectPath, agents) : fs.existsSync(claude) ? rel(projectPath, claude) : null;
  for (const skill of skills) {
    const id = `skill:${skill.name}`;
    add({ id, kind: "skill", title: skill.name, sub: rel(projectPath, path.dirname(path.dirname(skill.file))).startsWith("..") ? "개인 스킬" : rel(projectPath, path.dirname(path.dirname(skill.file))), file: skill.file, readers: skill.scope === "project" ? "AgentHub가 이은 세션" : "Claude · Codex", scope: skill.scope, description: skill.description });
    // 지침이 스킬 파일을 가리키면 이미 링크로 이어져 있다. 아니면 "스킬 목록"으로 잇는다.
    if (root && !edges.some((e) => e.to === rel(projectPath, skill.file))) edges.push({ from: root, to: id, kind: "skill", label: "" });
  }
  // 세션 역할과 AgentHub가 붙이는 안내
  const injections = [
    { id: "inject:messages", title: "세션 간 소통", sub: "AgentHub가 자동으로 붙임", applies: (s) => links.some((l) => l.enabled !== false && (l.from === s.id || l.to === s.id) && l.when !== "ref") },
    { id: "inject:handoff", title: "연결로 넘어온 작업", sub: "보낸 세션의 결과·지시", applies: (s) => links.some((l) => l.enabled !== false && l.to === s.id && !["call", "ref"].includes(l.when)) },
    { id: "inject:skills", title: "이은 스킬 안내", sub: "새 대화·요약 뒤에 붙임", applies: (s) => (s.skills ?? []).length > 0 },
    { id: "inject:artref", title: "아트 레퍼런스", sub: "요청마다 붙임", applies: (s) => links.some((l) => l.enabled !== false && l.to === s.id && l.when === "ref") },
  ];
  for (const session of sessions) {
    if (!session.role && !(session.skills ?? []).length && !links.some((l) => l.from === session.id || l.to === session.id)) continue;
    const id = `role:${session.id}`;
    add({ id, kind: "role", title: session.title, sub: `${session.roleName ? `${session.roleName} · ` : ""}${session.agent === "codex" ? "Codex" : "Claude"}`, readers: session.agent === "codex" ? "Codex" : "Claude", sessionId: session.id, role: session.role ?? "" });
    for (const injection of injections) {
      if (!injection.applies(session)) continue;
      add({ id: injection.id, kind: "inject", title: injection.title, sub: injection.sub, readers: "AgentHub" });
      edges.push({ from: injection.id, to: id, kind: "inject", label: "" });
    }
    for (const name of session.skills ?? []) if (nodes.has(`skill:${name}`)) edges.push({ from: `skill:${name}`, to: id, kind: "inject", label: "이은 스킬" });
  }
  return { nodes: [...nodes.values()], edges, claude: status };
}

// ── 작업 순서도 ───────────────────────────────────────────────
const FLOW_TYPES = new Set(["start", "step", "decision", "end"]);
export function flowPrompt(text, name) {
  const numbered = String(text ?? "").split(/\r?\n/).map((line, index) => `${String(index + 1).padStart(4)}| ${line}`).join("\n");
  return `너는 프로젝트 지침 문서를 읽고 AI 에이전트가 요청을 받았을 때 따르는 작업 순서도를 만든다. 파일은 읽지 말고 아래 글만 근거로 쓴다.

[규칙]
- 노드 type: start(요청, 하나) · step(할 일) · decision(분기, 예: 작업 종류?) · end(끝, 하나).
- 각 노드에 title(10자 안), detail(20자 안), lines(근거 줄 번호 [시작, 끝]), guess(근거 줄이 없으면 true)를 쓴다. 근거가 있으면 반드시 줄 번호를 쓴다.
- 문서에 작업 종류별 분기(예: 기능 추가 / 버그 수정 / 문서만)가 있으면 decision으로 나누고, 없으면 한 줄로 이어 쓴다.
- edges의 label은 분기 이름만 쓴다(없으면 빈 문자열).
- 노드는 30개를 넘기지 않는다. 문서에 없는 단계는 만들지 않는다. 꼭 필요한 연결 단계만 guess: true로 넣는다.
- 답은 JSON 하나만 쓴다: {"nodes":[{"id":"n1","type":"start","title":"요청","detail":"","lines":[],"guess":false}],"edges":[{"from":"n1","to":"n2","label":""}]}

[문서: ${name}]
${numbered}`;
}

export function parseFlow(answer, lineTotal) {
  const text = String(answer ?? "");
  const block = text.match(/```(?:json)?\s*\n([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let value;
  try { value = JSON.parse(block); } catch { throw new Error("AI가 순서도를 JSON으로 돌려주지 않았습니다. 다시 그리기를 눌러 주세요."); }
  const nodes = (Array.isArray(value?.nodes) ? value.nodes : []).slice(0, 40).map((node, index) => {
    const lines = Array.isArray(node.lines) ? node.lines.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= lineTotal).slice(0, 2) : [];
    return { id: String(node.id ?? `n${index + 1}`).slice(0, 40), type: FLOW_TYPES.has(node.type) ? node.type : "step", title: String(node.title ?? "").trim().slice(0, 30) || "단계",
      detail: String(node.detail ?? "").trim().slice(0, 60), lines: lines.length === 1 ? [lines[0], lines[0]] : lines, guess: node.guess === true || (!lines.length && (FLOW_TYPES.has(node.type) ? node.type : "step") === "step") };
  });
  const ids = new Set(nodes.map((n) => n.id));
  if (nodes.length < 2) throw new Error("순서도로 그릴 단계를 찾지 못했습니다. 지침에 작업 절차를 번호로 적어 주세요.");
  const edges = (Array.isArray(value?.edges) ? value.edges : []).filter((e) => ids.has(String(e.from)) && ids.has(String(e.to)) && e.from !== e.to)
    .slice(0, 80).map((e) => ({ from: String(e.from), to: String(e.to), label: String(e.label ?? "").trim().slice(0, 20) }));
  return { nodes, edges };
}

// 세션이 연결로 받은 작업을 이 순서도대로 할 때 멈추는 칸과 판정 줄과 부딪히는 칸.
// stop: 승인 대기 문장을 근거로 한 첫 칸 / after: 그 칸 뒤로 이어지는 칸 / conflicts: 응답 끝 보고·작업마다 커밋 칸
export function flowHighlights(flow, warnings) {
  const hit = (node, kinds) => warnings.find((w) => kinds.includes(w.kind) && node.lines.length && w.line >= node.lines[0] && w.line <= node.lines[1]);
  const stopNode = flow.nodes.find((node) => hit(node, ["approval"]));
  const after = new Set();
  if (stopNode) {
    const queue = [stopNode.id];
    while (queue.length) {
      const id = queue.shift();
      for (const edge of flow.edges) if (edge.from === id && !after.has(edge.to) && edge.to !== stopNode.id) { after.add(edge.to); queue.push(edge.to); }
    }
    // 끝 칸과, 다른 갈래에서도 이어지는 칸은 흐리게 하지 않는다.
    for (const node of flow.nodes) if (node.type === "end") after.delete(node.id);
    for (const id of [...after]) if (flow.edges.some((e) => e.to === id && !after.has(e.from) && e.from !== stopNode.id)) after.delete(id);
  }
  const conflicts = flow.nodes.flatMap((node) => {
    const warning = hit(node, ["report-tail", "commit-every"]);
    return warning ? [{ id: node.id, warning }] : [];
  });
  return { stop: stopNode ? { id: stopNode.id, warning: hit(stopNode, ["approval"]) } : null, after: [...after], conflicts };
}

// ── AI 초안 ───────────────────────────────────────────────────
export function draftPrompt({ name, existing, context }) {
  return `너는 이 저장소에서 일할 AI 에이전트(Claude Code·Codex)를 위한 AGENTS.md를 쓴다. 저장소 파일을 직접 읽어 확인한 사실만 쓴다. 파일은 고치지 않는다.

[형식]
- 맨 위 제목: "# ${name} 에이전트 지침"
- 아래 섹션을 이 순서로 "## 제목"으로 쓴다(해당 내용이 전혀 없으면 섹션을 빼도 된다): ${GUIDE_SECTIONS.map((s) => s.title).join(", ")}
- 각 섹션은 짧은 목록으로 쓴다. 한 섹션은 30줄을 넘기지 않는다. 자세한 내용은 저장소의 문서를 링크한다(존재하는 파일만).
- 필독 문서는 "- <작업> 시 [문서 이름](상대 경로)" 형식으로 쓴다.
- 한국어로 쓴다. 코드 식별자·경로는 원문 그대로 쓴다.
- AgentHub 연결과 부딪히지 않게 쓴다: 승인·완료보고서·커밋을 요구하면 "사용자가 직접 요청한 작업에만 적용한다. 연결로 넘어온 작업은 승인 없이 진행하고 판정 줄을 맨 마지막에 쓴다"를 함께 쓴다.
${existing ? "- 아래 [지금 지침]이 있다. 맞는 내용은 문장을 그대로 두고, 틀리거나 빠진 것만 고친다." : ""}

[저장소에서 먼저 찾은 것]
${context}
${existing ? `\n[지금 지침]\n${existing}\n` : ""}
[답] 완성한 AGENTS.md 전체를 \`\`\`markdown 블록 하나로만 쓴다.`;
}

export function rewritePrompt({ section, request, whole }) {
  return `너는 AGENTS.md의 한 섹션만 다시 쓴다. 파일은 고치지 않는다.
[요청] ${request || "더 짧고 분명하게"}
[규칙] "## 제목" 줄을 그대로 두고 그 섹션 내용만 쓴다. 다른 섹션은 쓰지 않는다. 한국어로 쓴다. 승인·보고·커밋 규칙을 쓰면 "연결로 넘어온 작업은 승인 없이 진행하고 판정 줄을 맨 마지막에 쓴다"를 함께 쓴다.
[다시 쓸 섹션]
${section}

[참고: 문서 전체]
${whole}

[답] 다시 쓴 섹션을 \`\`\`markdown 블록 하나로만 쓴다.`;
}

export function markdownAnswer(answer) {
  const text = String(answer ?? "");
  const fenced = text.match(/```(?:markdown|md)?\s*\n([\s\S]*)```/);
  const value = (fenced ? fenced[1] : text).trim();
  if (!value) throw new Error("AI가 내용을 돌려주지 않았습니다.");
  return value + "\n";
}

// 초안을 쓸 때 AI에 알려 줄 저장소 정보(짧게)
export function repoContext(projectPath) {
  const out = [];
  const exists = (name) => fs.existsSync(path.join(projectPath, name));
  try {
    const top = fs.readdirSync(projectPath, { withFileTypes: true }).filter((e) => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)).slice(0, 40)
      .map((e) => e.isDirectory() ? `${e.name}/` : e.name);
    out.push(`- 최상위: ${top.join(", ")}`);
  } catch {}
  if (exists("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf8"));
      out.push(`- package.json: ${pkg.name ?? ""} · scripts: ${Object.keys(pkg.scripts ?? {}).slice(0, 12).join(", ")} · 의존성: ${Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 20).join(", ")}`);
    } catch {}
  }
  const unity = path.join(projectPath, "ProjectSettings", "ProjectVersion.txt");
  if (fs.existsSync(unity)) out.push(`- Unity: ${fs.readFileSync(unity, "utf8").match(/m_EditorVersion:\s*(\S+)/)?.[1] ?? "?"}`);
  const docs = docFiles(projectPath, 60).map((file) => rel(projectPath, file));
  if (docs.length) out.push(`- 문서: ${docs.join(", ")}`);
  for (const name of ["README.md", "CONTRIBUTING.md"]) if (exists(name)) out.push(`- ${name} 있음`);
  return out.join("\n") || "- (찾은 것 없음)";
}
