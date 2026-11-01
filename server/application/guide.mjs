// 프로젝트 지침 탭: AGENTS.md·CLAUDE.md 읽기·저장, 저장 전 검사, CLAUDE.md 연결·합치기, AI 초안·섹션 다시 쓰기, 지침 지도, 작업 순서도.
import fs from "node:fs";
import path from "node:path";
import { askOnce } from "../one-shot.mjs";
import { listSkills } from "../skills.mjs";
import { HttpError } from "./errors.mjs";
import { samePath } from "./projects.mjs";
import {
  GUIDE_SECTIONS, GUIDE_FILE_MAX, hashText, parseSections, checkGuide, claudeStatus, claudeSections, guideMap, findNestedGuides,
  flowPrompt, parseFlow, flowHighlights, draftPrompt, rewritePrompt, markdownAnswer, repoContext, blankGuide,
} from "../guide.mjs";

const REQUEST_MAX = 1000;
const DRAFT_TIMEOUT = 600_000;
const FLOW_TIMEOUT = 300_000;

export function createGuideService({ dataDir, projects, store, links, cliPaths, ask = askOnce }) {
  const flowDir = path.join(dataDir, "guide-flows");

  function project(projectPath) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 정하세요.");
    return projects.ensureProject(projectPath).path;
  }
  // 프로젝트 안의 .md만 연다. 비우면 루트 AGENTS.md
  function target(root, file = "AGENTS.md") {
    const name = String(file || "AGENTS.md").replaceAll("\\", "/");
    const full = path.resolve(root, name);
    const inside = path.relative(root, full);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || !/\.md$/i.test(full)) throw new HttpError(400, "프로젝트 안의 .md 파일만 열 수 있습니다.");
    return { full, rel: inside.replaceAll("\\", "/") };
  }
  const read = (full) => { try { return fs.readFileSync(full, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw new HttpError(500, `지침 파일을 읽지 못했습니다: ${error.code ?? error.message}`); } };
  const skillsOf = (root) => { try { return listSkills(root); } catch { return []; } };
  const projectSessions = (root) => store.list().filter((s) => !s.chat && samePath(s.projectPath, root));

  function guideFiles(root) {
    const files = ["AGENTS.md", "CLAUDE.md"].filter((name) => fs.existsSync(path.join(root, name)));
    if (!files.includes("AGENTS.md")) files.unshift("AGENTS.md");
    for (const file of findNestedGuides(root)) files.push(path.relative(root, file).replaceAll("\\", "/"));
    return files;
  }

  function view(projectPath, file) {
    const root = project(projectPath);
    const { full, rel } = target(root, file);
    const text = read(full);
    const stat = text === null ? null : fs.statSync(full);
    return {
      projectPath: root, file: rel, exists: text !== null, text: text ?? "", hash: text === null ? null : hashText(text),
      savedAt: stat?.mtime.toISOString() ?? null, lines: text === null ? 0 : text.split(/\r?\n/).length,
      sections: parseSections(text ?? ""), warnings: text === null ? [] : checkGuide(text, { file: full, projectPath: root, skills: skillsOf(root) }),
      claude: claudeStatus(root), files: guideFiles(root), catalog: GUIDE_SECTIONS.map(({ key, title, hint }) => ({ key, title, hint })),
      blank: blankGuide(path.basename(root)),
    };
  }

  function check({ projectPath, file, text } = {}) {
    const root = project(projectPath);
    const { full } = target(root, file);
    const value = String(text ?? "");
    return { sections: parseSections(value), warnings: checkGuide(value, { file: full, projectPath: root, skills: skillsOf(root) }) };
  }

  // 다른 곳(에디터·다른 세션)에서 바뀐 파일은 덮어쓰지 않는다. force면 덮어쓴다.
  function save({ projectPath, file, text, baseHash, force = false } = {}) {
    const root = project(projectPath);
    const { full, rel } = target(root, file);
    const value = String(text ?? "");
    if (value.length > GUIDE_FILE_MAX) throw new HttpError(400, "지침이 너무 깁니다. 자세한 내용은 문서로 옮기고 링크하세요.");
    const current = read(full);
    if (!force && current !== null && hashText(current) !== baseHash) throw new HttpError(409, "파일이 다른 곳에서 바뀌었습니다.", "guide-changed");
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, value);
    } catch (error) { throw new HttpError(500, `저장하지 못했습니다: ${error.code ?? error.message}`, "guide-write"); }
    return view(root, rel);
  }

  // CLAUDE.md가 없으면 @AGENTS.md 한 줄짜리를 만들고, 있는데 가져오지 않으면 맨 위에 @AGENTS.md를 넣는다.
  function linkClaude({ projectPath } = {}) {
    const root = project(projectPath);
    const claude = path.join(root, "CLAUDE.md");
    const status = claudeStatus(root);
    if (!status.agents) throw new HttpError(400, "먼저 AGENTS.md를 저장하세요.");
    if (status.imports) return view(root, "AGENTS.md");
    const text = read(claude);
    fs.writeFileSync(claude, text === null ? "@AGENTS.md\n" : `@AGENTS.md\n\n${text}`);
    return view(root, "AGENTS.md");
  }

  // CLAUDE.md의 고른 덩어리를 AGENTS.md 끝으로 옮기고, CLAUDE.md는 @AGENTS.md와 남긴 덩어리만 둔다.
  function mergeClaude({ projectPath, sections: picked = [], baseHash } = {}) {
    const root = project(projectPath);
    const agents = path.join(root, "AGENTS.md");
    const claude = path.join(root, "CLAUDE.md");
    const claudeText = read(claude);
    if (claudeText === null) throw new HttpError(400, "CLAUDE.md가 없습니다.");
    const agentsText = read(agents) ?? "";
    if (baseHash && agentsText && hashText(agentsText) !== baseHash) throw new HttpError(409, "AGENTS.md가 다른 곳에서 바뀌었습니다. 다시 불러온 뒤 합치세요.", "guide-changed");
    const chunks = claudeSections(claudeText);
    const move = new Set((Array.isArray(picked) ? picked : []).map(Number));
    const moved = chunks.filter((c) => move.has(c.index));
    const kept = chunks.filter((c) => !move.has(c.index));
    if (!moved.length) throw new HttpError(400, "옮길 내용을 고르세요.");
    const appended = moved.map((c) => `## ${c.title === "앞부분" ? "Claude에서 옮긴 내용" : c.title}\n${c.text}`).join("\n\n");
    fs.writeFileSync(agents, `${agentsText.replace(/\s+$/, "")}${agentsText.trim() ? "\n\n" : ""}${appended}\n`);
    fs.writeFileSync(claude, ["# CLAUDE.md", "", "@AGENTS.md", ...kept.flatMap((c) => ["", `## ${c.title}`, c.text])].join("\n") + "\n");
    return view(root, "AGENTS.md");
  }

  // 응답이 끊기면(사용자가 중지) AI도 멈춘다.
  function abortOnClose(res) {
    const controller = new AbortController();
    res?.on?.("close", () => { if (!res.writableEnded) controller.abort(); });
    return controller.signal;
  }

  async function draft({ projectPath, file, agent, text } = {}, res) {
    const root = project(projectPath);
    const { full } = target(root, file);
    const existing = text != null ? String(text) : read(full) ?? "";
    const answer = await ask({ cliPaths, prompt: draftPrompt({ name: path.basename(root), existing: existing.trim() ? existing : "", context: repoContext(root) }),
      cwd: root, agent: agent || undefined, timeoutMs: DRAFT_TIMEOUT, label: "지침 초안", signal: abortOnClose(res) });
    try { return { text: markdownAnswer(answer) }; } catch (error) { throw new HttpError(502, error.message, "guide-draft"); }
  }

  async function rewrite({ projectPath, file, text, line, request, agent } = {}, res) {
    const root = project(projectPath);
    target(root, file);
    const whole = String(text ?? "");
    const ask_ = String(request ?? "").trim().slice(0, REQUEST_MAX);
    const section = parseSections(whole).find((s) => s.line === Number(line));
    if (!section) throw new HttpError(400, "다시 쓸 섹션을 고르세요.");
    const lines = whole.split(/\r?\n/);
    const body = lines.slice(section.line - 1, section.end).join("\n");
    const answer = await ask({ cliPaths, prompt: rewritePrompt({ section: body, request: ask_, whole }), cwd: root, agent: agent || undefined, timeoutMs: FLOW_TIMEOUT, label: "섹션 다시 쓰기", signal: abortOnClose(res) });
    let next;
    try { next = markdownAnswer(answer).replace(/\n+$/, ""); } catch (error) { throw new HttpError(502, error.message, "guide-rewrite"); }
    // 제목 줄이 빠졌으면 붙인다.
    if (!/^#{2,3}\s/.test(next)) next = `${lines[section.line - 1]}\n${next}`;
    const result = [...lines.slice(0, section.line - 1), ...next.split("\n"), ...lines.slice(section.end)].join("\n");
    return { text: result, section: { title: section.title, line: section.line } };
  }

  function map({ projectPath } = {}) {
    const root = project(projectPath);
    return guideMap(root, { skills: skillsOf(root), sessions: projectSessions(root), links: links.list() });
  }

  // ── 순서도 ──────────────────────────────────────────────────
  const flowFile = (root, rel) => path.join(flowDir, `${hashText(`${root.toLowerCase()}|${rel.toLowerCase()}`)}.json`);
  function sessionsFor(root) {
    const all = links.list();
    return projectSessions(root).map((s) => ({ id: s.id, title: s.title, agent: s.agent,
      receives: all.some((l) => l.enabled !== false && l.to === s.id && !["call", "ref"].includes(l.when)) }));
  }
  function withHighlights(root, full, flow, sessionId) {
    const text = read(full) ?? "";
    const session = sessionId ? sessionsFor(root).find((s) => s.id === sessionId) : null;
    const highlights = session?.receives ? flowHighlights(flow, checkGuide(text, { file: full, projectPath: root })) : null;
    return { ...flow, stale: flow.hash !== hashText(text), sessions: sessionsFor(root), session: session ?? null, highlights };
  }

  function getFlow({ projectPath, file, session } = {}) {
    const root = project(projectPath);
    const { full, rel } = target(root, file);
    let flow = null;
    try { flow = JSON.parse(fs.readFileSync(flowFile(root, rel), "utf8")); } catch {}
    if (!flow) return { file: rel, empty: true, exists: fs.existsSync(full), sessions: sessionsFor(root) };
    return withHighlights(root, full, flow, session);
  }

  async function drawFlow({ projectPath, file, agent, session } = {}, res) {
    const root = project(projectPath);
    const { full, rel } = target(root, file);
    const text = read(full);
    if (!text?.trim()) throw new HttpError(400, "먼저 지침을 저장하세요.");
    const answer = await ask({ cliPaths, prompt: flowPrompt(text, rel), cwd: root, agent: agent || undefined, timeoutMs: FLOW_TIMEOUT, label: "작업 순서도", signal: abortOnClose(res) });
    let parsed;
    try { parsed = parseFlow(answer, text.split(/\r?\n/).length); } catch (error) { throw new HttpError(502, error.message, "guide-flow"); }
    const flow = { file: rel, hash: hashText(text), lines: text.split(/\r?\n/).length, drawnAt: new Date().toISOString(), ...parsed };
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(flowFile(root, rel), JSON.stringify(flow));
    return withHighlights(root, full, flow, session);
  }

  return { view, check, save, linkClaude, mergeClaude, draft, rewrite, map, getFlow, drawFlow };
}
