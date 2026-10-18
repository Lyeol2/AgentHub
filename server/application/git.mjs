import { gitOverview, fileDiff, showCommit, branchDiff, stage, unstage, commit, checkout } from "../gitpanel.mjs";
import { githubPulls, GitHubError } from "../github.mjs";
import { HttpError } from "./errors.mjs";
import { gitErrorDetails } from "../git-errors.mjs";
import { createGitClient, sameGitPath } from "../git-client.mjs";
import { projectGitflowSettings } from "../gitflow-settings.mjs";

export function createGitService({ sessions, projects, runner, notify, tasks, config = {} }) {
  const allSessions = () => typeof sessions.list === "function" ? sessions.list().map(s => sessions.getSession(s.id)) : [];
  const client = createGitClient({
    getSessions: allSessions,
    getTasks: () => tasks?.()?.list?.()?.tasks ?? [],
    // 백그라운드 작업 중인 세션도 파일을 바꿀 수 있으므로 실행 중으로 본다.
    isRunning: id => runner.isBusy?.(id) ?? runner.isRunning(id),
    assertSession: session => tasks?.()?.assertSession?.(session),
    assertTaskOperation: (cwd, action) => tasks?.()?.assertGitOperation?.(cwd, action),
  });

  async function execute(action, { projectPath, sessionId, cwd, file, area, hash, branch, remote, state, number, ...body } = {}) {
    try {
      if (sessionId) {
        const session = sessions.getSession(sessionId);
        if (!sameGitPath(session.projectPath, projectPath) || !session.worktree)
          throw new HttpError(400, "이 프로젝트에 연결된 워크트리 세션이 아닙니다.", "git-context");
        if (cwd !== undefined && !sameGitPath(cwd, session.worktree.dir))
          throw new HttpError(400, "세션과 선택한 작업 폴더가 다릅니다.", "git-context");
        cwd = session.worktree.dir;
      }
      const ctx = await client.context(projectPath, cwd);
      const options = { ...body, ...(hash === undefined ? {} : { hash }), ...(branch === undefined ? {} : { branch }), ...(remote === undefined ? {} : { remote }), ...(state === undefined ? {} : { state }) };
      const changed = async (promise) => {
        const result = await promise;
        notify("git", { projectPath, cwd: ctx.cwd });
        return result;
      };
      if (action === "overview") {
        const overview = await gitOverview(ctx.cwd, projects.projectSessions(projectPath));
        return { ...overview, cwd: ctx.cwd, originalCwd: ctx.original };
      }
      if (action === "diff") return { diff: await fileDiff(ctx.cwd, file ?? "", area) };
      if (action === "show") return { diff: await showCommit(ctx.cwd, hash) };
      if (action === "branch") return { diff: await branchDiff(ctx.cwd, branch) };
      if (action === "worktrees") return await client.list(ctx);
      if (action === "createWorktree") return await changed(client.create(ctx, options));
      if (action === "removeWorktree") return await changed(client.remove(ctx, options));
      if (action === "pruneWorktrees") return await changed(client.prune(ctx));
      if (action === "remotes") return await client.remotes(ctx, remote);
      if (action === "fetch") return await changed(client.fetch(ctx, options));
      if (action === "pullState") return await client.pullState(ctx);
      if (action === "pullRemote") return await changed(client.pull(ctx, options));
      if (action === "createBranch") return await changed(client.createBranch(ctx, options));
      if (action === "preview") return await client.preview(ctx, options);
      if (action === "execute") return await changed(client.execute(ctx, options));
      if (action === "recovery") return await client.recovery(ctx);
      if (action === "restore") return await changed(client.restore(ctx, options));
      if (action === "push" && !Object.hasOwn(body, "repo")) return await changed(client.push(ctx, options));
      // PR 대상 브랜치는 원본 저장소에 저장한 GitFlow 설정을 따른다.
      const gitflow = () => projectGitflowSettings(config, ctx.original ?? projectPath);
      if (action === "pulls") return await githubPulls.list(ctx.cwd, { remote, state: state ?? "open", gitflow: gitflow() });
      if (action === "pull") return await githubPulls.detail(ctx.cwd, number, { remote });
      // 라벨은 작업 폴더를 바꾸지 않으므로 실행 중인 세션이 있어도 바꿀 수 있다.
      if (action === "pullLabels") return await changed(githubPulls.labels(ctx.cwd, number, options));
      if (["push", "createPull", "mergePull", "closePull"].includes(action)) {
        return await changed(client.write(ctx, action, async actual => {
          if (action === "push") return githubPulls.push(actual.cwd, options);
          if (action === "createPull") return githubPulls.create(actual.cwd, options, { gitflow: gitflow() });
          if (action === "mergePull") return githubPulls.merge(actual.cwd, number, options);
          return githubPulls.close(actual.cwd, number, options);
        }));
      }
      if (action === "stage" || action === "unstage") return await changed(client.write(ctx, action, async actual => ({ ok: true, count: await (action === "stage" ? stage : unstage)(actual.cwd, body.files) })));
      if (action === "commit") return await changed(client.write(ctx, action, async actual => ({ ok: true, result: await commit(actual.cwd, body.message, Array.isArray(body.files) ? body.files : null, { staged: body.staged === true }) })));
      if (action === "checkout") return await changed(client.write(ctx, action, async actual => {
        const result = await checkout(actual.cwd, String(branch ?? ""));
        return { ok: true, result };
      }));
      // Preserve the former endpoint while routing it through the same validation and rollback.
      if (action === "merge") {
        const preview = await client.preview(ctx, { action: "merge", branch });
        if (body.expectedHead && body.expectedHead !== preview.head) throw new HttpError(409, "현재 커밋이 바뀌었습니다.", "stale-head");
        if (body.expectedSourceHead && body.expectedSourceHead !== preview.sourceHead) throw new HttpError(409, "병합할 커밋이 바뀌었습니다.", "stale-head");
        return await changed(client.execute(ctx, { previewId: preview.previewId }));
      }
      throw new HttpError(404, "없는 API입니다.");
    } catch (e) {
      if (e instanceof GitHubError) throw new HttpError(e.status, e.message, e.reason, { outcomeUnknown: e.outcomeUnknown });
      if (e instanceof HttpError) throw e;
      // gitpanel의 원문 오류도 알려진 경우 한국어 설명과 해결 방법으로 바꾼다. 앞에 붙인 한국어 안내는 유지한다.
      const known = gitErrorDetails(e.message);
      if (known && !e.conflict) {
        const lead = e.message.split("\n")[0];
        throw new HttpError(known.status, /[가-힣]/.test(lead) ? lead : known.message, known.reason, { hint: known.hint, raw: known.raw });
      }
      throw new HttpError(e.conflict ? 409 : 400, e.message, e.conflict ? "conflict" : undefined);
    }
  }
  return { execute };
}
