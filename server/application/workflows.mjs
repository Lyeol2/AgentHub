import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { summary } from "../store.mjs";
import { isGitRepo, checkWorktreeAvailable, headCommit } from "../git.mjs";
import { ROLE_MAX } from "../role.mjs";
import { CONDITIONS, lastAnswer } from "../chain.mjs";
import { extractPlan, normalizePlan } from "../orchestrator.mjs";
import { HUB_FILE, HUB_TEMPLATE, hubFilePath, readHubFile } from "../hubfile.mjs";
import { isCommandId } from "../commands.mjs";
import { samePath } from "./projects.mjs";
import { HttpError } from "./errors.mjs";

export function createWorkflowService({ store, runner, links, commands, chain, projects, sessions, notify: broadcast }) {
  const { ensureProject, projectSessions } = projects;
  const { getSession, createSession, checkSessionOptions, startTurn } = sessions;
  function getCommand(id) {
    const command = commands.get(id);
    if (!command) throw new HttpError(404, "명령 노드가 없습니다.");
    return command;
  }
  function getLink(id) {
    const link = links.get(id);
    if (!link) throw new HttpError(404, "연결이 없습니다.");
    return link;
  }

  // 연결 조건 입력을 검사해 저장할 값만 돌려준다.
  function linkFields(body, current = {}) {
    const when = body.when ?? current.when ?? "success";
    if (!CONDITIONS.includes(when)) throw new HttpError(400, "연결 조건이 올바르지 않습니다.");
    // 키워드 조건이 아니면 키워드를 남겨 두지 않는다.
    const keyword = when === "keyword" ? String(body.keyword ?? current.keyword ?? "").trim().slice(0, 100) : "";
    if (when === "keyword" && !keyword) throw new HttpError(400, "키워드를 입력하세요. 여러 개는 쉼표로 나눕니다.");
    return {
      when,
      keyword,
      note: String(body.note ?? current.note ?? "").trim().slice(0, ROLE_MAX),
      enabled: !!(body.enabled ?? current.enabled ?? true),
      approve: !!(body.approve ?? current.approve ?? false), // 넘기기 전에 연결선 위에서 승인을 받는다
      ...(body.approve === false ? { pending: null } : {}), // 승인을 끄면 기다리던 것도 거둔다
    };
  }

  function planContext(session) {
    return {
      hub: readHubFile(session.projectPath),
      sessions: projectSessions(session.projectPath),
      orchestratorId: session.id,
    };
  }

  // 승인한 계획을 실행한다. 사용자가 승인한 것이므로 요청은 새 흐름(0단계)으로 보낸다.
  async function applyPlan(orchestrator, raw) {
    // 승인을 기다리는 사이 세션이 지워졌을 수 있으므로 다시 검사한다.
    const plan = normalizePlan(raw, planContext(orchestrator));
    const project = ensureProject(orchestrator.projectPath);
    // 이름 충돌이나 잘못된 옵션 때문에 앞의 세션만 생성되는 일을 막도록 먼저 모두 검사한다.
    if (plan.sessions.some((item) => !item.id && item.isolate)) {
      if (!await isGitRepo(project.path)) throw new Error("워크트리는 Git 저장소에서만 사용할 수 있습니다.");
      await headCommit(project.path);
    }
    for (const item of plan.sessions.filter((item) => !item.id)) {
      checkSessionOptions(item);
      if (item.isolate) await checkWorktreeAvailable(project.path, item.worktreeName);
    }
    const ids = new Map();
    let created = 0;
    for (const item of plan.sessions) {
      if (item.id) {
        ids.set(item.key, item.id);
        continue;
      }
      const session = await createSession({
        project,
        agent: item.agent,
        model: item.model,
        permission: item.permission,
        title: item.title,
        role: item.roleText,
        roleName: item.roleName,
        isolate: item.isolate,
        worktreeName: item.worktreeName,
        createdBy: orchestrator.id,
      });
      ids.set(item.key, session.id);
      created++;
    }
    const id = (name) => ids.get(name) ?? name;
    let linked = 0;
    let changed = 0;
    for (const item of plan.links) {
      const from = id(item.from);
      const to = id(item.to);
      const fields = { when: item.when, keyword: item.when === "keyword" ? item.keyword : "", note: item.note, enabled: true };
      // 이미 이어진 두 세션이면 계획의 조건으로 고친다(새 계획이 조건을 바꾸려는 것이다).
      const existing = links.list().find((l) => l.from === from && l.to === to);
      if (existing) {
        links.update(existing, { ...fields, pending: null });
        changed++;
        continue;
      }
      links.add({ id: randomBytes(4).toString("hex"), from, to, ...fields });
      linked++;
    }
    broadcast("sessions", {});
    broadcast("links", {});
    for (const item of plan.send) {
      const target = store.get(id(item.to));
      if (target) chain.enqueue(target, item.prompt, { from: orchestrator.id, fromTitle: orchestrator.title }, 0);
    }
    return `세션 ${created}개 만듦 · 연결 ${linked}개${changed ? ` · 연결 ${changed}개 고침` : ""} · 요청 ${plan.send.length}건`;
  }

  // AGENTHUB.md의 흐름 템플릿으로 역할마다 세션을 만들고 연결한다. prompt가 있으면 받는 연결이 없는 역할에 보낸다.
  async function startFlow({ project, flowName, name, prompt }) {
    const hub = readHubFile(project.path);
    if (!hub) throw new HttpError(404, `${HUB_FILE}이 없습니다.`);
    const flow = hub.flows.find((f) => f.name === flowName);
    if (!flow) throw new HttpError(404, `흐름 "${flowName}"이 없습니다.`);
    const roleNames = [...new Set(flow.steps.flatMap((s) => [s.from, s.to]))];
    const roles = new Map(roleNames.map((n) => [n, hub.roles.find((r) => r.name === n)]));
    const missing = roleNames.filter((n) => !roles.get(n));
    if (missing.length) throw new HttpError(400, `${HUB_FILE}에 없는 역할입니다: ${missing.join(", ")}`);
    for (const role of roles.values()) checkSessionOptions(role);

    const label = String(name ?? "").trim().slice(0, 100);
    const sessions = new Map();
    for (const [roleName, role] of roles) {
      sessions.set(roleName, await createSession({
        project,
        agent: role.agent,
        model: role.model,
        permission: role.permission,
        title: label ? `${label} · ${roleName}` : roleName,
        role: role.body,
        roleName,
      }));
    }
    for (const step of flow.steps) {
      links.add({
        id: randomBytes(4).toString("hex"),
        from: sessions.get(step.from).id,
        to: sessions.get(step.to).id,
        when: step.when,
        keyword: step.keyword,
        note: step.note,
        enabled: true,
      });
    }

    const text = String(prompt ?? "").trim();
    if (text) {
      const targets = new Set(flow.steps.map((s) => s.to));
      const roots = roleNames.filter((n) => !targets.has(n));
      for (const n of roots.length ? roots : roleNames.slice(0, 1)) startTurn(sessions.get(n), text);
    }
    return [...sessions.values()];
  }
  function recordPlan(session, ok) {
    if (session.kind !== "orchestrator" || !ok) return;
    const found = extractPlan(lastAnswer(session));
    if (!found) return;
    const event = { kind: "plan", planId: randomBytes(4).toString("hex"), status: "pending", text: "계획" };
    try {
      if (found.error) throw new Error(found.error);
      event.raw = found.plan;
      event.plan = normalizePlan(found.plan, planContext(session));
    } catch (err) {
      event.status = "invalid";
      event.error = err.message;
    }
    runner.append(session, event);
  }

  function createLink(body) {
    const endpoint = (id) => isCommandId(id) ? getCommand(id) : getSession(id);
    const from = endpoint(body.from);
    const to = endpoint(body.to);
    if (from.chat || to.chat) throw new HttpError(400, "일반 채팅 세션은 연결할 수 없습니다.");
    if (from.id === to.id) throw new HttpError(400, "같은 세션끼리는 연결할 수 없습니다.");
    if (!samePath(from.projectPath, to.projectPath)) throw new HttpError(400, "같은 프로젝트의 세션끼리만 연결할 수 있습니다.");
    if (links.list().some((l) => l.from === from.id && l.to === to.id)) throw new HttpError(409, "이미 연결되어 있습니다.");
    const link = { id: randomBytes(4).toString("hex"), from: from.id, to: to.id, ...linkFields(body) };
    links.add(link);
    broadcast("links", {});
    return link;
  }

  function updateLink(id, body) {
    const link = getLink(id);
    links.update(link, linkFields(body, link));
    broadcast("links", {});
    return link;
  }

  function removeLink(id) {
    getLink(id);
    links.remove(id);
    broadcast("links", {});
    return { ok: true };
  }

  async function decideLink(id, action) {
    const link = getLink(id);
    if (!["approve", "reject"].includes(action)) throw new HttpError(400, "action은 approve 또는 reject입니다.");
    try {
      await chain.decide(link, action === "approve");
    } catch (err) {
      throw new HttpError(409, err.message);
    }
    return link;
  }

  async function runLink(id) {
    await chain.deliver(getLink(id), 0);
    return { ok: true };
  }

  function hub(projectPath) {
    if (!projectPath) throw new HttpError(400, "프로젝트를 선택하세요.");
    const hub = readHubFile(projectPath);
    return { file: hubFilePath(path.resolve(projectPath)), exists: !!hub, ...hub };
  }

  function initHub(projectPath) {
    const file = hubFilePath(ensureProject(projectPath).path);
    if (fs.existsSync(file)) throw new HttpError(409, `${HUB_FILE}이 이미 있습니다.`);
    fs.writeFileSync(file, HUB_TEMPLATE);
    return hub(projectPath);
  }

  function openHub(projectPath) {
    const file = hubFilePath(ensureProject(projectPath).path);
    if (!fs.existsSync(file)) throw new HttpError(404, `${HUB_FILE}이 없습니다.`);
    const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [file], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
    return { ok: true };
  }

  async function createFlow(body) {
    const created = await startFlow({ ...body, project: ensureProject(body.projectPath) });
    broadcast("sessions", {});
    broadcast("links", {});
    return created.map(summary);
  }

  return {
    applyPlan, recordPlan, listLinks: () => links.list(),
    createLink, updateLink, removeLink, decideLink, runLink,
    hub, initHub, openHub, createFlow,
  };
}
