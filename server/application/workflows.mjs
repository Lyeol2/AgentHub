import { randomBytes } from "node:crypto";
import { isGitRepo, checkWorktreeAvailable, headCommit } from "../git.mjs";
import { ROLE_MAX } from "../role.mjs";
import { CONDITIONS, lastAnswer } from "../chain.mjs";
import { extractPlan, normalizePlan } from "../orchestrator.mjs";
import { isCommandId, commandKind } from "../commands.mjs";
import { samePath } from "./projects.mjs";
import { HttpError } from "./errors.mjs";

export function createWorkflowService({ store, runner, links, commands, chain, projects, sessions, nodeGroups, graphTabs, notify: broadcast }) {
  const { ensureProject, projectSessions } = projects;
  const { getSession, createSession, checkSessionOptions } = sessions;
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
      sessions: projectSessions(session.projectPath).filter((item) => !graphTabs || graphTabs.tabFor(item) === graphTabs.tabFor(session)),
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

  function checkedLinkFields(from, to, body, current = {}) {
    const fields = linkFields(body, current);
    if (commandKind(from) === "git" && !["success", "error", "always", "manual"].includes(fields.when)) throw new HttpError(400, "Git 출력은 성공·실패·항상·수동 조건을 사용하세요.");
    if (commandKind(from) === "repeat" && !["success", "error", "always", "manual"].includes(fields.when)) throw new HttpError(400, "반복 출력은 성공·실패·항상·수동 조건을 사용하세요.");
    if (isCommandId(from.id) && commandKind(from) === "task" && !["success", "error", "always", "manual"].includes(fields.when)) throw new HttpError(400, "작업 출력은 성공·실패·항상·수동 조건을 사용하세요.");
    if (fields.when === "call" && (isCommandId(from.id) || isCommandId(to.id) || from.chat || to.chat)) throw new HttpError(400, "요청 시 부르기 연결은 프로젝트 세션끼리만 만들 수 있습니다.");
    // 아트 레퍼런스는 세션에 "참고"로만 잇는다. 참고 연결은 실행을 일으키지 않는다.
    if (isCommandId(from.id) && commandKind(from) === "artref") {
      if (isCommandId(to.id) || to.chat) throw new HttpError(400, "아트 레퍼런스는 프로젝트 세션에만 연결할 수 있습니다.");
      fields.when = "ref";
      fields.keyword = "";
      fields.approve = false;
    } else if (fields.when === "ref") throw new HttpError(400, "참고 연결은 아트 레퍼런스 노드에서 세션으로만 만들 수 있습니다.");
    // 작업 마무리는 커밋·push·PR을 만들므로 따로 정하지 않으면 넘기기 전에 승인을 받는다.
    if (body.approve === undefined && current.approve === undefined && isCommandId(to.id) && commandKind(to) === "task" && to.taskAction === "finish") fields.approve = true;
    const fromTask = isCommandId(from.id) && commandKind(from) === "task" && from.taskAction === "start";
    const canUse = (commandKind(from) === "git" || fromTask) && (!isCommandId(to.id) || commandKind(to) === "command");
    const useGitWorktree = body.useGitWorktree ?? (fields.when === "error" ? false : current.useGitWorktree) ?? (canUse && (fromTask || from.gitAction === "use") && fields.when === "success");
    if (typeof useGitWorktree !== "boolean") throw new HttpError(400, "Git 작업 폴더 사용 설정이 올바르지 않습니다.");
    if (useGitWorktree && fields.when === "error") throw new HttpError(400, "실패 출력에는 사용할 Git 작업 폴더가 없습니다.");
    if (useGitWorktree && !canUse) throw new HttpError(400, "Git 작업 폴더는 Git 노드나 새 작업 노드에서 세션이나 명령으로 넘길 때 사용할 수 있습니다.");
    return { ...fields, ...(canUse || current.useGitWorktree !== undefined ? { useGitWorktree } : {}) };
  }

  const sameOutput = (link, fields) => link.when === fields.when && (fields.when !== "keyword" || link.keyword === fields.keyword);

  function createLink(body) {
    const endpoint = (id) => isCommandId(id) ? getCommand(id) : getSession(id);
    const resolve = (id, portId, direction) => {
      if (typeof id !== "string" || !id.startsWith("grp-")) return { node: endpoint(id) };
      if (!nodeGroups) throw new HttpError(404, "노드 그룹이 없습니다.");
      const port = nodeGroups.resolvePort(id, portId, direction);
      return { node: endpoint(port.nodeId), port };
    };
    const source = resolve(body.from, body.fromPort, "output");
    const target = resolve(body.to, body.toPort, "input");
    const from = source.node;
    const to = target.node;
    if (source.port?.when) {
      if (body.when != null && body.when !== source.port.when) throw new HttpError(400, "그룹 출력 포트의 조건과 연결 조건이 다릅니다.");
      if (source.port.when === "keyword" && body.keyword != null && String(body.keyword).trim() !== source.port.keyword) throw new HttpError(400, "그룹 출력 포트의 키워드와 연결 키워드가 다릅니다.");
      body = { ...body, when: source.port.when, keyword: source.port.keyword ?? "" };
    }
    if (["button", "input", "watch", "schedule", "webhook-in"].includes(commandKind(to))) throw new HttpError(400, "버튼·입력 폼·파일 감시·시간 예약·웹훅 받기 노드는 시작점이므로 들어오는 연결을 만들 수 없습니다.");
    if (isCommandId(to.id) && commandKind(to) === "artref") throw new HttpError(400, "아트 레퍼런스 노드로 들어오는 연결은 만들 수 없습니다. 레퍼런스에서 세션으로 이으세요.");
    if (commandKind(from) === "markdown") throw new HttpError(400, "MD 출력 노드는 완료 메시지를 저장하는 마지막 노드입니다.");
    if (from.chat || to.chat) throw new HttpError(400, "일반 채팅 세션은 연결할 수 없습니다.");
    if (from.id === to.id) throw new HttpError(400, "같은 세션끼리는 연결할 수 없습니다.");
    if (!samePath(from.projectPath, to.projectPath)) throw new HttpError(400, "같은 프로젝트의 세션끼리만 연결할 수 있습니다.");
    const fields = checkedLinkFields(from, to, body);
    const multipleOutputs = (isCommandId(from.id) && ["command", "git", "task", "repeat", "group", "transform"].includes(commandKind(from))) || !!nodeGroups?.hasNode?.(from.id);
    if (links.list().some((l) => l.from === from.id && l.to === to.id && (!multipleOutputs || sameOutput(l, fields)))) throw new HttpError(409, "이미 연결되어 있습니다.");
    const link = { id: randomBytes(4).toString("hex"), from: from.id, to: to.id, ...fields };
    links.add(link);
    broadcast("links", {});
    return link;
  }

  function updateLink(id, body) {
    const link = getLink(id);
    const from = isCommandId(link.from) ? getCommand(link.from) : getSession(link.from);
    const to = isCommandId(link.to) ? getCommand(link.to) : getSession(link.to);
    const fields = checkedLinkFields(from, to, body, link);
    if (links.list().some((other) => other.id !== id && other.from === link.from && other.to === link.to && sameOutput(other, fields))) throw new HttpError(409, "이미 연결되어 있습니다.");
    links.update(link, { ...fields, ...(["git", "task"].includes(commandKind(from)) ? { pending: null } : {}) });
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
    if (getLink(id).when === "ref") throw new HttpError(400, "참고 연결은 넘길 결과가 없습니다. 세션이 요청을 받을 때 레퍼런스를 함께 읽습니다.");
    await chain.deliver(getLink(id), 0);
    return { ok: true };
  }

  return {
    applyPlan, recordPlan, listLinks: () => links.list(),
    createLink, updateLink, removeLink, decideLink, runLink,
  };
}
