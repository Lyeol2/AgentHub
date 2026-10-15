// GitHub PR 화면. 원격 변경은 사용자가 누른 작업만 보내고, 조회 응답은 프로젝트/요청 순서를 확인한다.
export function createPullRequests({ api, renderMarkdown, renderDiff, onSetup, isProjectCurrent, pullIssues = () => [] }) {
  const $ = (id) => document.getElementById(id);
  const node = (tag, attrs = {}, ...children) => {
    const result = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (key.startsWith("on")) result.addEventListener(key.slice(2), value);
      else if (key === "class") result.className = value;
      else result.setAttribute(key, value === true ? "" : value);
    }
    result.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return result;
  };
  let state = null;
  const current = (s) => state === s && isProjectCurrent(s.project);
  const query = (s, extra = {}) => new URLSearchParams({ path: s.project, ...(s.remote ? { remote: s.remote } : {}), ...extra });
  const prUrl = (repo, number) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo ?? "") && Number.isSafeInteger(number) && number > 0 ? "https://github.com/" + repo + "/pull/" + number : null;
  const link = (text, url) => url ? node("a", { class: "ghost sm pr-link", href: url, target: "_blank", rel: "noopener noreferrer" }, text) : null;
  const stateText = (p) => p.state === "MERGED" ? "병합됨" : p.state === "CLOSED" ? "닫힘" : p.isDraft ? "초안" : "열림";
  const badge = (p) => node("span", { class: "pr-status pr-" + (p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : p.isDraft ? "draft" : "open") }, stateText(p));
  const time = (value) => value ? new Date(value).toLocaleString() : "";
  const placeholder = () => $("pr-detail").replaceChildren(node("p", { class: "pr-empty muted" }, "Pull Request를 선택하면 상세와 변경 내용을 볼 수 있습니다."));

  function notice(text = "", setup = false) {
    $("pr-notice").hidden = !text;
    $("pr-note").textContent = text;
    $("pr-setup").hidden = !setup;
  }

  function controls() {
    const s = state;
    const c = s?.context;
    const busy = !!s?.busy;
    $("pr-refresh").disabled = busy || !!s?.loading;
    $("pr-filter").disabled = busy;
    $("pr-remote").disabled = busy || !!s?.loading;
    $("pr-new").disabled = busy || !c || !!s?.unavailable;
    $("pr-cancel").disabled = busy;
    for (const id of ["pr-base", "pr-title", "pr-description", "pr-draft"]) $(id).disabled = busy;
    $("pr-push").disabled = busy || !c?.canPush || !!s?.unavailable;
    $("pr-push").textContent = s?.busy === "push" ? "게시 중…" : "현재 브랜치 게시";
    const base = $("pr-base").value;
    const head = $("pr-head").value;
    $("pr-submit").disabled = busy || !!s?.unavailable || !c?.canCreate || !$("pr-title").value.trim() || !base || !head || head === base;
    $("pr-submit").textContent = s?.busy === "create" ? "만드는 중…" : "PR 만들기";
    for (const control of $("pr-detail").querySelectorAll("[data-pr-mutation]")) control.disabled = busy || !!s?.unavailable || control.dataset.blocked === "true";
  }

  function setProject(project) {
    if (state?.project === project) return;
    state = { project, remote: "", context: null, pulls: [], number: null, detail: null, listVersion: 0, detailVersion: 0, loadedAt: 0, loading: false, busy: null };
    $("pr-create").hidden = true;
    $("pr-grid").hidden = true;
    $("pr-filter").value = "open";
    $("pr-remote").hidden = true;
    $("pr-repo").textContent = "";
    $("pr-repo").removeAttribute("href");
    $("pr-title").value = "";
    $("pr-description").value = "";
    $("pr-base").replaceChildren();
    $("pr-head").value = "";
    $("pr-draft").checked = true;
    $("pr-error").textContent = "";
    placeholder();
    notice();
    controls();
  }

  function contextView(s) {
    const c = s.context;
    $("pr-repo").textContent = c.repo;
    const url = prUrl(c.repo, 1)?.replace(/\/pull\/1$/, "");
    if (url) $("pr-repo").href = url;
    else $("pr-repo").removeAttribute("href");
    $("pr-remote").replaceChildren(...c.remotes.map((r) => node("option", { value: r.name }, r.name + " · " + r.repo)));
    $("pr-remote").value = c.remote;
    $("pr-remote").hidden = c.remotes.length < 2;
    const previous = $("pr-base").value;
    $("pr-base").replaceChildren(...c.baseBranches.map((branch) => node("option", { value: branch }, branch)));
    $("pr-base").value = c.baseBranches.includes(previous) ? previous : c.defaultBranch;
    $("pr-head").value = c.branch ?? "";
    $("pr-push").hidden = !c.needsPush;
    $("pr-publish-note").textContent = c.createReason || (c.dirtyCount ? "커밋된 내용으로 PR을 만듭니다. 작업 폴더의 변경 " + c.dirtyCount + "개는 포함되지 않습니다." : "현재 브랜치의 원격 커밋으로 PR을 만듭니다.");
  }

  function listView(s) {
    $("pr-list-note").textContent = s.pulls.length ? String(s.pulls.length) + "개 · 최근 50개까지" : "Pull Request가 없습니다.";
    $("pr-list").replaceChildren(...s.pulls.map((p) => node("li", {},
      node("button", { type: "button", class: "pr-list-item" + (s.number === p.number ? " active" : ""), "aria-pressed": String(s.number === p.number), "data-pr-number": p.number, onclick: () => detail(p.number) },
        node("span", { class: "pr-list-title" }, p.title),
        node("span", { class: "pr-list-meta" }, badge(p), node("span", {}, "#" + p.number + " · " + (p.author?.login ?? ""))),
        node("span", { class: "pr-list-branch mono", title: p.headRefName + " → " + p.baseRefName }, p.headRefName + " → " + p.baseRefName)))));
  }

  async function refresh() {
    const s = state;
    if (!s) return;
    const version = ++s.listVersion;
    s.loading = true;
    if (!s.context) notice("GitHub Pull Request를 불러오는 중…");
    controls();
    try {
      const data = await api("GET", "/api/git/pulls?" + query(s, { state: $("pr-filter").value }));
      if (!current(s) || version !== s.listVersion) return;
      s.context = data.context;
      s.remote = data.context.remote;
      s.pulls = data.pulls;
      s.unavailable = false;
      s.loadedAt = Date.now();
      contextView(s);
      listView(s);
      notice();
      $("pr-grid").hidden = false;
      if (s.number) await detail(s.number);
    } catch (err) {
      if (!current(s) || version !== s.listVersion) return;
      s.unavailable = true;
      s.loadedAt = Date.now();
      notice(err.message, ["gh-missing", "gh-auth"].includes(err.reason));
      if (!s.context) $("pr-grid").hidden = true;
    } finally {
      if (current(s) && version === s.listVersion) { s.loading = false; controls(); }
    }
  }

  async function detail(number) {
    const s = state;
    if (!s?.context) return;
    s.number = number;
    s.detail = null;
    const version = ++s.detailVersion;
    listView(s);
    $("pr-detail").replaceChildren(node("p", { class: "pr-empty muted", role: "status" }, "PR #" + number + " 불러오는 중…"));
    try {
      const data = await api("GET", "/api/git/pulls/" + number + "?" + query(s));
      if (!current(s) || version !== s.detailVersion) return;
      s.detail = data;
      detailView(s);
    } catch (err) {
      if (!current(s) || version !== s.detailVersion) return;
      $("pr-detail").replaceChildren(node("p", { class: "pr-empty error", role: "alert" }, err.message));
    }
  }

  function detailView(s) {
    const { pull: p, diff, diffError } = s.detail;
    const open = p.state === "OPEN";
    const checks = p.checks ?? {};
    const checkText = p.checksError ? "검사 상태를 불러오지 못했습니다." : checks.total ? [checks.passed ? "통과 " + checks.passed : "", checks.failed ? "실패 " + checks.failed : "", checks.pending ? "진행 중 " + checks.pending : ""].filter(Boolean).join(" · ") : "등록된 검사 없음";
    const checksRow = node("p", { class: "pr-checks" + (checks.failed ? " failed" : checks.pending || p.checksError ? " pending" : "") }, "검사 · " + checkText);
    const body = node("div", { class: "md pr-body" });
    body.innerHTML = renderMarkdown(p.body || "설명이 없습니다.");
    const files = node("details", { class: "pr-files" }, node("summary", {}, "변경 파일 " + (p.changedFiles ?? p.files?.length ?? 0) + "개 · +" + (p.additions ?? 0) + " −" + (p.deletions ?? 0)),
      node("ul", {}, ...(p.files ?? []).map((f) => node("li", {}, node("span", { class: "mono" }, f.path), node("span", { class: "muted" }, "+" + f.additions + " −" + f.deletions)))));
    const actions = node("div", { class: "pr-detail-actions" }, link("GitHub에서 보기", prUrl(s.context.repo, p.number)));
    if (open) {
      const method = node("select", { "aria-label": "PR 병합 방식", "data-pr-mutation": "method" }, ...s.context.mergeMethods.map((value) => node("option", { value }, ({ merge: "Merge commit", squash: "Squash", rebase: "Rebase" })[value])));
      const rulesBlocked = !["CLEAN", "HAS_HOOKS"].includes(p.mergeStateStatus) || !!p.checksError || ["REVIEW_REQUIRED", "CHANGES_REQUESTED"].includes(p.reviewDecision);
      const blocked = p.isDraft || p.mergeable !== true || rulesBlocked || !s.context.mergeMethods.length;
      const merge = node("button", { type: "button", class: "primary sm", "data-pr-mutation": "merge", "data-blocked": String(blocked), title: p.isDraft ? "초안은 GitHub에서 준비 완료로 바꾼 뒤 병합할 수 있습니다." : rulesBlocked ? "대상 브랜치의 병합 조건을 확인한 뒤 새로고침해 주세요." : p.mergeable === false ? "충돌을 해결한 뒤 병합할 수 있습니다." : p.mergeable === null ? "병합 가능 여부를 계산 중입니다. 새로고침해 주세요." : "", onclick: () => {
        if (s.busy || !confirm(s.context.repo + " #" + p.number + "\n" + p.headRefName + " → " + p.baseRefName + "\n" + method.value + " 방식으로 병합할까요?")) return;
        mutate("merge", "/api/git/pulls/" + p.number + "/merge", { method: method.value, sha: p.headRefOid });
      } }, "병합");
      const close = node("button", { type: "button", class: "ghost sm", "data-pr-mutation": "close", onclick: () => {
        if (s.busy || !confirm(s.context.repo + " #" + p.number + " PR을 닫을까요?")) return;
        mutate("close", "/api/git/pulls/" + p.number + "/close", {});
      } }, "PR 닫기");
      actions.append(method, merge, close);
    }
    const statusNote = p.isDraft ? "초안 · 병합하려면 GitHub에서 준비 완료로 바꿔 주세요." : !["CLEAN", "HAS_HOOKS"].includes(p.mergeStateStatus) && open && p.mergeable === true ? "검사·리뷰·최신 브랜치 반영 등 병합 조건을 GitHub에서 확인해 주세요." : p.mergeable === false ? "브랜치 사이에 충돌이 있습니다." : open && p.mergeable === null ? "병합 가능 여부를 계산 중입니다. 새로고침해 주세요." : "";
    const preview = node("pre", { class: "diff pr-diff" }, ...renderDiff(diff || (diffError ? "변경 내용을 불러오지 못했습니다." : "변경 내용이 없습니다.")));
    $("pr-detail").replaceChildren(...[
      node("header", { class: "pr-detail-head" }, node("div", { class: "pr-detail-meta" }, badge(p), node("span", { class: "muted" }, "#" + p.number + " · " + (p.author?.login ?? "") + " · " + time(p.updatedAt))), node("h4", {}, p.title), node("p", { class: "mono muted pr-refs" }, p.headRefName + " → " + p.baseRefName)),
      actions, checksRow,
      p.checksError ? node("p", { class: "error pr-review", role: "alert" }, p.checksError) : null,
      p.reviewDecision ? node("p", { class: "hint pr-review" }, "리뷰 · " + ({ APPROVED: "승인됨", CHANGES_REQUESTED: "변경 요청", REVIEW_REQUIRED: "리뷰 필요" }[p.reviewDecision] ?? p.reviewDecision)) : null,
      statusNote ? node("p", { class: "hint pr-review" }, statusNote) : null,
      body, files,
      p.filesError ? node("p", { class: "error pr-review", role: "alert" }, p.filesError) : null,
      p.filesTruncated ? node("p", { class: "hint pr-review" }, "변경 파일은 처음 100개까지 표시합니다. 전체 목록은 GitHub에서 확인하세요.") : null,
      diffError ? node("p", { class: "error pr-review", role: "alert" }, diffError) : null, preview].filter((child) => child !== null && child !== undefined && child !== false));
    controls();
  }

  async function mutate(kind, url, fields) {
    const s = state;
    if (!s?.context || s.busy || s.unavailable) return;
    s.busy = kind;
    $("pr-error").textContent = "";
    controls();
    let outcome;
    let failure;
    try {
      outcome = await api("POST", url, { path: s.project, remote: s.remote, repo: s.context.repo, ...fields });
      if (!current(s)) return;
      if (kind === "create") {
        s.number = outcome.pull?.number ?? null;
        $("pr-create").hidden = true;
        $("pr-title").value = "";
        $("pr-description").value = "";
        $("pr-issue").value = "";
        $("pr-filter").value = "open";
      }
    } catch (err) {
      failure = err;
    } finally {
      if (current(s)) {
        // 쓰기는 재시도하지 않는다. 성공 여부가 불확실한 경우에도 현재 원격 상태만 다시 읽는다.
        await refresh();
        s.busy = null;
        controls();
        if (failure) $("pr-error").textContent = failure.message;
        else if (outcome && !s.unavailable) notice(kind === "create" ? "PR을 만들었습니다." : kind === "push" ? "현재 브랜치를 게시했습니다." : kind === "close" ? "PR을 닫았습니다." : outcome.pull?.state === "MERGED" ? "PR을 병합했습니다." : "병합 요청을 처리했습니다. GitHub에서 현재 상태를 확인하세요.");
      }
    }
  }

  $("pr-filter").addEventListener("change", () => {
    if (!state) return;
    state.number = null;
    state.detail = null;
    ++state.detailVersion;
    placeholder();
    refresh();
  });
  $("pr-remote").addEventListener("change", () => {
    if (!state) return;
    state.remote = $("pr-remote").value;
    $("pr-base").replaceChildren();
    state.context = null;
    state.number = null;
    state.detail = null;
    ++state.detailVersion;
    $("pr-create").hidden = true;
    $("pr-grid").hidden = true;
    placeholder();
    refresh();
  });
  $("pr-refresh").addEventListener("click", () => { $("pr-error").textContent = ""; refresh(); });
  $("pr-setup").addEventListener("click", () => onSetup());
  $("pr-new").addEventListener("click", () => {
    if (!state?.context) return;
    $("pr-create").hidden = false;
    if (!$("pr-title").value) $("pr-title").value = state.context.lastCommit?.subject ?? "";
    // 받은 작업과 연결하면 PR이 병합될 때 GitHub가 그 이슈를 닫는다.
    const issues = pullIssues(state.project);
    $("pr-issue").replaceChildren(node("option", { value: "" }, "(연결 안 함)"), ...issues.map((i) => node("option", { value: String(i.number) }, "#" + i.number + " " + i.title)));
    $("pr-issue").closest("label").hidden = !issues.length;
    controls();
    $("pr-title").focus();
  });
  $("pr-cancel").addEventListener("click", () => { $("pr-create").hidden = true; });
  for (const id of ["pr-title", "pr-base", "pr-draft"]) $(id).addEventListener("input", controls);
  $("pr-create").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("pr-submit").disabled) return;
    const issue = $("pr-issue").value;
    const description = $("pr-description").value;
    const linked = new RegExp("\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #" + issue + "\\b", "i").test(description);
    const body = issue && !linked ? (description.trimEnd() + "\n\nCloses #" + issue).trimStart() : description;
    mutate("create", "/api/git/pulls", { title: $("pr-title").value.trim(), body, base: $("pr-base").value, head: $("pr-head").value, draft: $("pr-draft").checked, expectedHead: state.context.headSha });
  });
  $("pr-push").addEventListener("click", () => {
    const c = state?.context;
    if (!c || $("pr-push").disabled || !confirm(c.repo + "\n" + c.branch + " · " + c.headSha?.slice(0, 8) + " 커밋을 원격에 게시할까요?\n커밋하지 않은 변경은 포함되지 않습니다.")) return;
    mutate("push", "/api/git/push", { expectedHead: c.headSha, branch: c.branch });
  });

  return {
    setProject,
    refresh,
    activate(project) {
      setProject(project);
      if (!state.loading && !state.busy && (!state.loadedAt || Date.now() - state.loadedAt > 30000)) refresh();
    },
  };
}
