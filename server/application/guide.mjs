// 프로젝트 지침 탭: AGENTS.md·CLAUDE.md 읽기·저장, 저장 전 검사, CLAUDE.md 연결·합치기, AI 초안·섹션 다시 쓰기, 지침 지도, 작업 순서도.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "../infrastructure/persistence/json-file.mjs";
import { SESSION_GUIDE_DIR, parseSessionGuide, sessionGuideChecks, guideFileName, GUIDE_SECTIONS_SESSION } from "../session-guide.mjs";

// 세션 지침의 권장 섹션(지침 탭 섹션 목록에 쓴다)
const SESSION_HINTS = ["이 세션이 맡는 일을 한두 줄로 쓴다.", "고쳐도 되는 폴더·파일을 쓴다.", "건드리면 안 되는 범위를 쓴다.", "끝났다고 볼 기준을 쓴다.", "연결로 넘길 때 handoff 도구로 알릴 판정어를 따옴표로 쓰고 언제 쓰는지 적는다. 예: 끝나면 \"검토 요청\""];
const SESSION_CATALOG = GUIDE_SECTIONS_SESSION.map((title, i) => ({ key: `session-${i}`, title, hint: SESSION_HINTS[i] }));
const sessionKey = (title) => SESSION_CATALOG.find((c) => c.title.replace(/\s/g, "") === String(title).replace(/\s/g, ""))?.key ?? null;
import { GUIDE_NAMES, folderSuggestions, checkFolder, defaultDocDir, docFileName, blankDoc, blankNested, insertDocLink, moveSections, dropReferences, guideSources, branchChecks } from "../guide-branches.mjs";
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
const TRASH_KEEP = 20;
const slash = (value) => value.split(path.sep).join("/");

export function createGuideService({ dataDir, projects, store, links, cliPaths, ask = askOnce, sessions = null }) {
  const flowDir = path.join(dataDir, "guide-flows");
  const trashDir = path.join(dataDir, "guide-trash");
  // git 읽기(추적 여부·바뀐 지침). git 저장소가 아니거나 git이 없으면 null
  const git = (root, args) => { try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true }); } catch { return null; } };
  const tracked = (root, relPath) => { try { execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], { cwd: root, stdio: "ignore", timeout: 5000, windowsHide: true }); return true; } catch (error) { return error.status === 1 ? false : null; } };
  function uncommitted(root) {
    const files = guideSources(root).map((f) => slash(path.relative(root, f)));
    if (!files.length) return [];
    const out = git(root, ["status", "--porcelain", "--untracked-files=all", "--", ...files]);
    return out == null ? null : out.split("\n").map((line) => line.trimEnd()).filter(Boolean).map((line) => line.slice(3).trim());
  }

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
  // 세션 지침 파일(.agenthub/sessions/*.md)
  const isSessionGuide = (rel) => rel.toLowerCase().startsWith(SESSION_GUIDE_DIR.toLowerCase() + "/");
  function sessionGuideFiles(root) {
    try { return fs.readdirSync(path.join(root, SESSION_GUIDE_DIR)).filter((n) => /\.md$/i.test(n)).sort().map((n) => `${SESSION_GUIDE_DIR}/${n}`); } catch { return []; }
  }
  const guideUsers = (root, rel) => projectSessions(root).filter((s) => s.guideFile?.toLowerCase() === rel.toLowerCase());
  function sessionGuideInfo(root, rel, text) {
    const parsed = parseSessionGuide(text ?? "");
    return { name: parsed.name, summary: parsed.summary, verdicts: parsed.verdicts,
      users: guideUsers(root, rel).map((s) => ({ id: s.id, title: s.title, agent: s.agent, state: s.state, guideState: s.guideState ?? null, guideSentAt: s.guideSentAt ?? null, worktree: !!s.worktree })) };
  }
  const sessionChecks = (root, rel, text) => sessionGuideChecks(text, { users: guideUsers(root, rel), links: links.list() });
  // 세션 지침이면 섹션 키를 세션 지침 권장 섹션에 맞춘다.
  const sectionsFor = (rel, text) => isSessionGuide(rel) ? parseSections(text).map((s) => ({ ...s, key: sessionKey(s.title) })) : parseSections(text);

  function view(projectPath, file) {
    const root = project(projectPath);
    const { full, rel } = target(root, file);
    const text = read(full);
    const stat = text === null ? null : fs.statSync(full);
    return {
      projectPath: root, file: rel, exists: text !== null, text: text ?? "", hash: text === null ? null : hashText(text),
      savedAt: stat?.mtime.toISOString() ?? null, lines: text === null ? 0 : text.split(/\r?\n/).length,
      sections: sectionsFor(rel, text ?? ""), warnings: text === null ? [] : [...checkGuide(text, { file: full, projectPath: root, skills: skillsOf(root) }), ...(isSessionGuide(rel) ? sessionChecks(root, rel, text) : [])],
      ...(isSessionGuide(rel) ? { catalogKind: "session" } : {}),
      claude: claudeStatus(root), files: guideFiles(root), sessionGuides: sessionGuideFiles(root).map((file) => ({ file, users: guideUsers(root, file).length })),
      ...(isSessionGuide(rel) ? { sessionGuide: sessionGuideInfo(root, rel, text) } : {}),
      // 세션 지침으로 옮기지 않은 예전 역할
      pendingRoles: projectSessions(root).filter((s) => s.role && !s.guideFile && s.kind !== "orchestrator").length, catalog: isSessionGuide(rel) ? SESSION_CATALOG : GUIDE_SECTIONS.map(({ key, title, hint }) => ({ key, title, hint })),
      blank: blankGuide(path.basename(root)),
      // 반영 시점 안내: 실행 중인 세션은 다음 새 대화부터, 워크트리 세션은 커밋·병합 뒤 읽는다.
      running: projectSessions(root).filter((s) => s.state === "running").length,
      worktrees: projectSessions(root).filter((s) => s.worktree).length,
      uncommitted: uncommitted(root), docDir: defaultDocDir(root),
      branches: branchChecks(root).reduce((n, f) => n + f.warnings.filter((w) => w.level !== "info").length, 0),
    };
  }

  function check({ projectPath, file, text } = {}) {
    const root = project(projectPath);
    const { full, rel } = target(root, file);
    const value = String(text ?? "");
    return { sections: sectionsFor(rel, value), warnings: [...checkGuide(value, { file: full, projectPath: root, skills: skillsOf(root) }), ...(isSessionGuide(rel) ? sessionChecks(root, rel, value) : [])] };
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
      writeFileAtomic(full, value);
    } catch (error) { throw new HttpError(500, `저장하지 못했습니다: ${error.code ?? error.message}`, "guide-write"); }
    // 세션 지침을 고치면 그 지침을 쓰는 세션의 이름·요약을 맞추고, 다음 요청에 다시 붙는다(파일 지문이 바뀜).
    if (isSessionGuide(rel)) sessions?.refreshGuides?.(root);
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
    writeFileAtomic(claude, text === null ? "@AGENTS.md\n" : `@AGENTS.md\n\n${text}`);
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
    writeFileAtomic(agents, `${agentsText.replace(/\s+$/, "")}${agentsText.trim() ? "\n\n" : ""}${appended}\n`);
    writeFileAtomic(claude, ["# CLAUDE.md", "", "@AGENTS.md", ...kept.flatMap((c) => ["", `## ${c.title}`, c.text])].join("\n") + "\n");
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

  // ── 갈래 만들기·삭제 ─────────────────────────────────────────
  function folders({ projectPath, q } = {}) {
    const root = project(projectPath);
    return { folders: folderSuggestions(root, q), docDir: defaultDocDir(root) };
  }

  // 새 지침: dir 폴더에 AGENTS.md / CLAUDE.md / 둘 다(CLAUDE.md는 @AGENTS.md). start=move면 상위 지침에서 고른 섹션을 옮긴다.
  // 옮긴 뒤 상위 지침의 남은 글은 저장하지 않고 돌려준다(편집기에서 확인하고 저장).
  function createGuide({ projectPath, dir, kind = "both", start = "blank", sections = [], parentText } = {}) {
    const root = project(projectPath);
    let folder;
    try { folder = checkFolder(root, dir); } catch (error) { throw new HttpError(400, error.message, "guide-path"); }
    const names = kind === "agents" ? ["AGENTS.md"] : kind === "claude" ? ["CLAUDE.md"] : ["AGENTS.md", "CLAUDE.md"];
    const relOf = (name) => (folder.rel ? folder.rel + "/" + name : name);
    const existing = names.filter((n) => fs.existsSync(path.join(folder.full, n)));
    if (existing.length === names.length) throw new HttpError(409, "이미 있습니다: " + existing.map(relOf).join(", "), "guide-exists", { file: relOf(existing[0]) });
    let body = blankNested(folder.rel), remaining = null;
    if (start === "move" && Array.isArray(sections) && sections.length && parentText != null) {
      const moved = moveSections(String(parentText), sections, relOf(names.includes("AGENTS.md") ? "AGENTS.md" : "CLAUDE.md"));
      body = "# " + (folder.rel || "루트") + " 폴더 지침\n\n" + moved.moved + "\n";
      remaining = moved.remaining;
    }
    const created = [];
    for (const name of names) {
      const full = path.join(folder.full, name);
      if (fs.existsSync(full)) continue;
      writeFileAtomic(full, name === "CLAUDE.md" && names.includes("AGENTS.md") ? "@AGENTS.md\n" : body);
      created.push(relOf(name));
    }
    const open = created.find((f) => f.endsWith("AGENTS.md")) ?? created[0];
    return { created, open, remaining, ...view(root, open) };
  }

  // 연결 문서: 문서를 만들고 지침에 "- <조건> [제목](경로)" 줄을 넣은 글을 돌려준다(지침은 사용자가 저장).
  // mode=import면 같은 폴더의 CLAUDE.md에 @경로 줄을 넣어 바로 저장한다(Claude가 항상 읽음).
  // docPath를 주면(깨진 링크의 "이 파일 만들기") 그 경로에 빈 문서만 만든다.
  function createDoc({ projectPath, file = "AGENTS.md", text, title, dir, condition, mode = "link", docPath: exact } = {}) {
    const root = project(projectPath);
    const guide = target(root, file);
    const cond = String(condition ?? "").trim().replace(/[:：]\s*$/, "");
    if (!exact && !cond) throw new HttpError(400, "언제 읽을지 적어 주세요. 예: .cs 파일을 고치기 전에", "guide-condition");
    let docFull;
    if (exact) docFull = target(root, exact).full;
    else {
      const name = String(title ?? "").trim();
      if (!name) throw new HttpError(400, "문서 제목을 적어 주세요.", "guide-title");
      let folder;
      try { folder = checkFolder(root, dir ?? defaultDocDir(root)); } catch (error) { throw new HttpError(400, error.message, "guide-path"); }
      docFull = path.join(folder.full, docFileName(name));
    }
    const docRel = slash(path.relative(root, docFull));
    if (GUIDE_NAMES.includes(path.basename(docFull))) throw new HttpError(400, "지침 파일은 + 새 지침으로 만드세요.", "guide-path");
    const createdDoc = !fs.existsSync(docFull);
    if (createdDoc) writeFileAtomic(docFull, blankDoc(String(title || path.basename(docFull, ".md")), cond || "필요할 때"));
    const current = text != null ? String(text) : read(guide.full) ?? "";
    if (exact) return { doc: docRel, created: createdDoc, text: current };
    const linkTarget = slash(path.relative(path.dirname(guide.full), docFull));
    if (mode === "import") {
      const claudeFull = path.join(path.dirname(guide.full), "CLAUDE.md");
      const claudeText = read(claudeFull) ?? "";
      const importRel = slash(path.relative(path.dirname(claudeFull), docFull));
      if (!claudeText.split(/\r?\n/).some((l) => l.trim() === "@" + importRel)) writeFileAtomic(claudeFull, claudeText.replace(/\s+$/, "") + (claudeText.trim() ? "\n" : "") + "@" + importRel + "\n");
      return { doc: docRel, created: createdDoc, imported: slash(path.relative(root, claudeFull)), text: current };
    }
    return { doc: docRel, created: createdDoc, text: insertDocLink(current, "- " + cond + " [" + String(title).trim() + "](" + linkTarget + ")", linkTarget) };
  }

  // 삭제: 데이터 폴더에 백업한 뒤 지운다. dropRefs면 이 파일을 가리키는 링크·@ 줄도 다른 지침에서 지운다.
  function removeFile({ projectPath, file, baseHash, dropRefs = false } = {}) {
    const root = project(projectPath);
    const { full, rel } = target(root, file);
    const text = read(full);
    if (text === null) throw new HttpError(404, "파일이 없습니다.", "guide-missing");
    if (baseHash !== undefined && baseHash !== null && hashText(text) !== baseHash) throw new HttpError(409, "파일이 다른 곳에서 바뀌었습니다. 다시 불러온 뒤 지우세요.", "guide-changed");
    const id = Date.now() + "-" + randomBytes(3).toString("hex");
    const wasTracked = tracked(root, rel);
    writeFileAtomic(path.join(trashDir, id, "content.md"), text);
    writeFileAtomic(path.join(trashDir, id, "meta.json"), JSON.stringify({ id, projectPath: root, file: rel, deletedAt: new Date().toISOString(), tracked: wasTracked }, null, 2));
    fs.rmSync(full);
    const cleaned = [];
    if (dropRefs) {
      for (const source of guideSources(root)) {
        const result = dropReferences(fs.readFileSync(source, "utf8"), path.dirname(source), full);
        if (result.removed) { writeFileAtomic(source, result.text); cleaned.push({ file: slash(path.relative(root, source)), removed: result.removed }); }
      }
    }
    fs.rmSync(flowFile(root, rel), { force: true });
    pruneTrash(root);
    return { removed: rel, backup: id, tracked: wasTracked, cleaned, ...view(root, "AGENTS.md") };
  }

  function trashEntries(root) {
    let ids = [];
    try { ids = fs.readdirSync(trashDir); } catch { return []; }
    return ids.map((id) => { try { return JSON.parse(fs.readFileSync(path.join(trashDir, id, "meta.json"), "utf8")); } catch { return null; } })
      .filter((m) => m && samePath(m.projectPath, root)).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }
  function pruneTrash(root) { for (const old of trashEntries(root).slice(TRASH_KEEP)) fs.rmSync(path.join(trashDir, old.id), { recursive: true, force: true }); }
  function trash({ projectPath } = {}) { return { items: trashEntries(project(projectPath)) }; }

  // 되살리기: 같은 경로에 새 파일이 생겼으면 덮어쓰지 않는다.
  function restore({ projectPath, id } = {}) {
    const root = project(projectPath);
    const entry = trashEntries(root).find((m) => m.id === String(id));
    if (!entry) throw new HttpError(404, "되살릴 백업이 없습니다.", "guide-trash-missing");
    const { full, rel } = target(root, entry.file);
    if (fs.existsSync(full)) throw new HttpError(409, rel + "이(가) 이미 있어 되살리지 않았습니다.", "guide-exists");
    writeFileAtomic(full, fs.readFileSync(path.join(trashDir, entry.id, "content.md"), "utf8"));
    fs.rmSync(path.join(trashDir, entry.id), { recursive: true, force: true });
    return { restored: rel, ...view(root, rel) };
  }

  // 지울 때 확인 창에 보일 영향: 가리키는 곳·읽는 도구·읽힘 보장·git 추적 여부·실행 중인 세션
  function impact({ projectPath, file } = {}) {
    const root = project(projectPath);
    const { full, rel } = target(root, file);
    const data = guideMap(root, { skills: skillsOf(root), sessions: projectSessions(root), links: links.list() });
    const node = data.nodes.find((n) => n.id === rel);
    const refs = data.edges.filter((e) => e.to === rel).map((e) => ({ from: e.from, kind: e.kind, label: e.label ?? "" }));
    const text = read(full);
    return { file: rel, exists: text !== null, lines: text === null ? 0 : text.split(/\r?\n/).length, savedAt: text === null ? null : fs.statSync(full).mtime.toISOString(),
      hash: text === null ? null : hashText(text), readers: node?.readers ?? "", assurance: node?.assurance ?? "", refs, tracked: tracked(root, rel),
      running: projectSessions(root).filter((s) => s.state === "running").length };
  }

  function checkAll({ projectPath } = {}) { return { files: branchChecks(project(projectPath)) }; }

  // ── 세션 지침 ────────────────────────────────────────────────
  // 새 세션 지침: sessionId를 주면 그 세션에 잇는다(역할이 있으면 from=role로 옮긴다).
  function createSessionGuide({ projectPath, name, sessionId, from = "blank" } = {}) {
    const root = project(projectPath);
    if (sessionId) {
      const result = sessions.createGuide(sessionId, { from, name });
      return { created: result.file, ...view(root, result.file) };
    }
    const title = String(name ?? "").trim();
    if (!title) throw new HttpError(400, "세션 지침 이름을 적어 주세요.", "session-guide-name");
    let rel = `${SESSION_GUIDE_DIR}/${guideFileName(title)}`;
    if (fs.existsSync(path.join(root, rel))) throw new HttpError(409, `${rel}이(가) 이미 있습니다.`, "guide-exists");
    writeFileAtomic(path.join(root, rel), `---\nname: ${title}\nsummary: ""\n---\n\n## 맡는 일\n\n## 고쳐도 되는 범위\n\n## 하지 않는 것\n\n## 완료 기준\n\n## 판정\n`);
    return { created: rel, ...view(root, rel) };
  }
  // 예전 역할을 모두 세션 지침으로 옮긴다.
  function migrateRoles({ projectPath } = {}) {
    const root = project(projectPath);
    const moved = [];
    for (const s of projectSessions(root).filter((x) => x.role && !x.guideFile && x.kind !== "orchestrator")) {
      try { moved.push({ id: s.id, title: s.title, file: sessions.createGuide(s.id, { from: "role" }).file }); }
      catch (error) { moved.push({ id: s.id, title: s.title, error: error.message }); }
    }
    return { moved, ...view(root, moved.find((m) => m.file)?.file ?? "AGENTS.md") };
  }
  // 같이 쓰던 세션 지침을 복제해 이 세션만 따로 쓴다.
  function duplicateSessionGuide({ projectPath, file, sessionId } = {}) {
    const root = project(projectPath);
    const { full, rel } = target(root, file);
    if (!isSessionGuide(rel)) throw new HttpError(400, "세션 지침만 복제할 수 있습니다.");
    const text = read(full);
    if (text === null) throw new HttpError(404, "파일이 없습니다.");
    const session = store.get(sessionId);
    if (!session) throw new HttpError(404, "세션이 없습니다.");
    const parsed = parseSessionGuide(text);
    const title = `${parsed.name || path.basename(rel, ".md")} (${session.title})`;
    let next = `${SESSION_GUIDE_DIR}/${guideFileName(title)}`;
    for (let i = 2; fs.existsSync(path.join(root, next)); i++) next = `${SESSION_GUIDE_DIR}/${guideFileName(`${title}-${i}`)}`;
    writeFileAtomic(path.join(root, next), text.replace(/^(---\r?\n[\s\S]*?^name:\s*).*$/m, `$1${title}`));
    sessions.update(sessionId, { guideFile: next });
    return { created: next, ...view(root, next) };
  }

  return { view, check, save, linkClaude, mergeClaude, draft, rewrite, map, getFlow, drawFlow, folders, createGuide, createDoc, removeFile, trash, restore, impact, checkAll, createSessionGuide, migrateRoles, duplicateSessionGuide };
}
