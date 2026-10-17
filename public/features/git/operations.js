import { $, el, renderDiff } from "../../shared/dom.js";
import { samePath } from "../../shared/store.js";
import { icon } from "../../shared/icons.js";
import { gitflowBranches, DEFAULT_GITFLOW } from "../../shared/gitflow.js";

const LABELS = { merge: "브랜치 병합", push: "현재 브랜치 푸시", revert: "변경 되돌리기", uncommit: "커밋 취소 · 파일 유지", reset: "이 커밋으로 복귀", drop: "선택 커밋 제거" };
const NOTES = {
  merge: "선택한 브랜치의 변경을 현재 작업 폴더의 브랜치에 합칩니다. 충돌하면 병합을 취소합니다.",
  push: "아래 커밋을 선택한 원격 브랜치에 보냅니다. 미커밋 변경은 포함되지 않습니다.",
  revert: "선택한 커밋의 변경을 되돌리는 새 커밋을 만듭니다. 기존 기록은 유지됩니다.",
  uncommit: "마지막 커밋을 취소하고 파일 변경을 스테이징 전 상태로 남깁니다.",
  reset: "선택한 커밋까지 남기고 이후 커밋을 현재 브랜치에서 제외합니다. 파일도 선택한 커밋의 상태로 바뀝니다.",
  drop: "선택한 커밋을 제외하고 뒤의 커밋을 다시 적용합니다. 뒤의 커밋 ID가 바뀝니다.",
};
const displayRemote = (address) => String(address ?? "").replace(/^(https?:\/\/)[^/\s@]+@/i, "$1[인증정보]@");

/** All writes capture the project/worktree and are explicitly reviewed before submission. */
export function createGitOperations({ api, getModel, isCurrent, isBusy, setWorkspace, reload, controls }) {
  let requestVersion = 0, dialogModel = null, writing = false;
  const toolbar = el("div", { id: "g-operations", class: "git-operations" });
  const workspace = button("작업 폴더", () => worktrees(), "g-workspaces");
  const location = el("span", { id: "g-location", class: "mono muted git-location" });
  const notice = el("p", { id: "g-operation-notice", class: "hint git-operation-notice", role: "status" });
  notice.hidden = true;
  // Fork처럼 아이콘과 영어 이름을 함께 쓰는 도구 막대. 꺼진 버튼은 이유를 툴팁과 아래 한 줄로 알린다.
  const tools = {
    fetch: tool("fetch", "Fetch", "원격 기록 가져오기 · 작업 파일은 바뀌지 않습니다", () => remote("fetch"), "g-fetch"),
    pull: tool("pull", "Pull", "원격 변경을 현재 브랜치에 받기", () => pull(), "g-pull"),
    push: tool("push", "Push", "현재 브랜치를 원격에 보내기", () => remote("push"), "g-push"),
    branch: tool("branch", "Branch", "새 브랜치 만들기", () => branch(), "g-new-branch"),
    merge: tool("merge", "Merge", "다른 브랜치를 현재 브랜치에 병합", () => merge(), "g-merge"),
    recovery: tool("recovery", "Recovery", "기록을 바꾸기 전 위치로 복구", () => recoveries(), "g-recovery"),
  };
  const toolReason = el("p", { id: "g-tool-reason", class: "hint git-tool-reason", role: "status" });
  toolReason.hidden = true;
  toolbar.append(el("div", { class: "git-workspace" }, workspace, location),
    el("div", { class: "git-tools", role: "toolbar", "aria-label": "Git 동작" }, tools.fetch, tools.pull, tools.push, tools.branch,
      el("span", { class: "git-tool-sep", "aria-hidden": "true" }), tools.merge, tools.recovery), toolReason, notice);
  $("g-note").before(toolbar);
  const commitActions = el("div", { id: "g-commit-actions", class: "git-commit-actions" });
  commitActions.hidden = true;
  $("g-view").before(commitActions);

  const title = el("h3", { id: "g-operation-title" });
  const content = el("div", { id: "g-operation-content", class: "git-operation-content" });
  const error = el("p", { id: "g-operation-error", class: "error", role: "alert" });
  const closeButton = button("닫기", close, "g-operation-close");
  const dialog = el("dialog", { id: "g-operation-dialog", class: "git-operation-dialog", "aria-labelledby": title.id },
    el("div", { class: "git-operation-head" }, title, closeButton), content, error);
  document.body.append(dialog);
  dialog.addEventListener("cancel", (event) => { if (writing) event.preventDefault(); else ++requestVersion; });
  dialog.addEventListener("close", () => { if (!dialog.open) { ++requestVersion; dialogModel = null; } });

  function tool(name, label, description, click, id) {
    const b = el("button", { type: "button", class: "git-tool", id, title: description, "aria-label": label + " · " + description, onclick: click },
      icon(name, { size: 18 }), el("span", { class: "git-tool-label" }, label), el("span", { class: "git-tool-badge", "aria-hidden": "true" }));
    b.dataset.description = description;
    return b;
  }
  function button(text, click, id) {
    const b = el("button", { type: "button", class: "ghost sm", onclick: click }, text);
    if (id) b.id = id;
    return b;
  }
  const context = (m) => ({ path: m.project, cwd: m.cwd ?? m.project });
  const query = (m, extra = {}) => new URLSearchParams({ ...context(m), ...extra });
  const valid = (m, version) => getModel() === m && isCurrent(m) && dialogModel === m && dialog.open && version === requestVersion;
  function close() { if (!writing) { ++requestVersion; dialog.close(); } }
  function open(name, allowMissing = false) {
    const m = getModel();
    if (!m || (!m.data && !allowMissing) || isBusy()) return null;
    dialogModel = m;
    title.textContent = name;
    error.textContent = "";
    content.replaceChildren(el("p", { class: "muted", role: "status", "data-git-operation-loading": "" }, "불러오는 중…"));
    if (!dialog.open) dialog.showModal();
    return { m, version: ++requestVersion };
  }
  function fail(errorValue, m, version) {
    if (!valid(m, version)) return;
    error.textContent = errorValue.message
      + (errorValue.hint ? "\n해결 방법: " + errorValue.hint : "")
      + (errorValue.outcomeUnknown ? "\n완료 여부가 불확실합니다. 현재 상태를 확인하기 전에는 다시 실행하지 마세요." : "")
      + (errorValue.recoveryId ? "\n복구 기록: " + errorValue.recoveryId + "\n이 창을 닫고 ‘복구 기록’에서 확인하세요." : "");
    const loading = content.querySelector("[data-git-operation-loading]");
    if (loading) loading.textContent = "작업을 준비하지 못했습니다. 내용을 확인한 뒤 다시 열어 주세요.";
  }
  function info(m, snapshot = {}) {
    return el("p", { class: "git-operation-context mono" }, (snapshot.branch || m.data?.branch || "브랜치 없음") + " · " + (snapshot.cwd ?? m.cwd ?? m.project));
  }
  function action(text, callback, disabled = false) {
    const b = button(text, callback, "g-operation-apply"); b.className = "primary"; b.disabled = disabled; return b;
  }
  async function write(m, version, endpoint, fields, next) {
    if (!valid(m, version) || writing || isBusy()) return;
    writing = true; m.operationBusy = true; controls(); update();
    error.textContent = "";
    let needsReview = false;
    const pending = [...dialog.querySelectorAll("button, input, select")].map((node) => ({ node, disabled: node.disabled }));
    for (const { node } of pending) node.disabled = true;
    try {
      const result = await api("POST", endpoint, { ...context(m), ...fields });
      if (!valid(m, version)) return;
      notice.textContent = result.warning || ""; notice.hidden = !result.warning; notice.dataset.project = m.project;
      ++m.viewVersion;
      commitActions.hidden = true;
      await reload();
      if (!valid(m, version)) return;
      if (next) { writing = false; m.operationBusy = false; await next(result); }
      else content.replaceChildren(el("p", { class: "git-operation-success", role: "status" }, "완료했습니다."),
        typeof result.result === "string" && result.result ? el("pre", { class: "git-operation-output" }, result.result) : null,
        result.warning ? el("p", { class: "error", role: "alert" }, result.warning) : null);
    } catch (err) {
      needsReview = endpoint === "/api/git/execute" || !!err.outcomeUnknown || !!err.recoveryId;
      fail(err, m, version);
      // A write with an uncertain response is not retried automatically.
      if (getModel() === m && isCurrent(m)) await reload();
    } finally {
      writing = false; m.operationBusy = false;
      for (const { node, disabled } of pending) node.disabled = disabled || (needsReview && node.id === "g-operation-apply");
      controls(); update();
    }
  }

  async function preview(actionName, fields = {}) {
    const request = open(LABELS[actionName]); if (!request) return;
    const { m, version } = request;
    try {
      const data = await api("POST", "/api/git/preview", { ...context(m), action: actionName, ...fields });
      if (!valid(m, version)) return;
      const commits = data.affectedCommits ?? [];
      const description = el("p", {}, NOTES[actionName]);
      const list = el("ol", { class: "git-operation-commits" }, ...commits.map((commit) => el("li", {},
        el("code", {}, commit.short || commit.hash?.slice(0, 8) || ""), " ", commit.subject || "")));
      content.replaceChildren(info(m, data), description,
        actionName === "merge" ? el("p", { class: "git-operation-summary mono" }, fields.branch + " → " + (data.targetBranch || m.data.branch)) : null,
        actionName === "push" ? el("p", { class: "git-operation-summary mono" }, (data.branch || m.data.branch) + " → " + (data.remote || fields.remote) + "/" + (data.branch || m.data.branch)) : null,
        actionName === "push" && data.pushUrl ? el("p", { class: "mono git-operation-remote" }, "게시 주소: " + displayRemote(data.pushUrl)) : null,
        actionName === "push" && data.head ? el("p", { class: "mono hint" }, "보낼 커밋: " + data.head) : null,
        data.summary ? el("p", { class: "git-operation-summary" }, data.summary) : null,
        el("h4", {}, "영향받는 커밋 " + commits.length + "개"), list,
        data.files?.length ? el("details", {}, el("summary", {}, "변경 파일 " + data.files.length + "개"), el("ul", { class: "mono git-operation-files" }, ...data.files.map((file) => el("li", {}, typeof file === "string" ? file : file.path)))) : null,
        data.diff ? el("pre", { class: "diff git-operation-diff" }, ...renderDiff(data.diff)) : null,
        data.diffTruncated ? el("p", { class: "hint" }, "변경 내용이 길어 일부만 표시했습니다.") : null,
        ["uncommit", "reset", "drop"].includes(actionName) ? el("p", { class: "hint" }, "실행 전의 커밋은 복구 기록에 보관됩니다.") : null,
        data.blockedReason ? el("p", { class: "error", role: "alert" }, data.blockedReason) : null,
        data.published && ["uncommit", "reset", "drop"].includes(actionName) ? el("p", { class: "hint" }, "이미 공유한 커밋은 ‘변경 되돌리기’를 사용하세요. 원격 기록을 강제로 덮어쓰지 않습니다.") : null,
        action(LABELS[actionName] + " 실행", () => write(m, version, "/api/git/execute", { previewId: data.previewId }), !!data.blockedReason || !data.previewId));
    } catch (err) { fail(err, m, version); }
  }

  function merge(branch) {
    if (branch) return preview("merge", { branch });
    const request = open("브랜치 병합"); if (!request) return;
    const { m } = request;
    const branches = (m.data.branches ?? []).filter((b) => !b.current);
    const source = el("select", { id: "g-merge-source", "aria-label": "가져올 브랜치" }, ...branches.map((b) => el("option", { value: b.name }, b.name)));
    content.replaceChildren(info(m), el("p", {}, "가져올 브랜치를 고르면 커밋과 변경 내용을 먼저 확인합니다."),
      el("label", {}, "가져올 브랜치", source), el("p", { class: "mono" }, "대상 브랜치: " + m.data.branch),
      action("병합 미리보기", () => preview("merge", { branch: source.value }), !branches.length));
  }

  async function worktrees() {
    const request = open("작업 폴더 · 워크트리", true); if (!request) return;
    const { m, version } = request;
    try {
      // Listing the project still works when the previously selected folder disappeared.
      const data = await api("GET", "/api/git/worktrees?" + new URLSearchParams({ path: m.project }));
      if (!valid(m, version)) return;
      const rows = (data.worktrees ?? []).map((tree) => {
        const active = samePath(tree.cwd, m.cwd ?? m.project);
        const choose = button(active ? "선택됨" : "이 폴더 사용", async () => { close(); await setWorkspace(tree.cwd); });
        choose.disabled = active || tree.missing;
        choose.dataset.workspace = tree.cwd;
        const remove = button("폴더 정리", () => removeTree(tree));
        remove.disabled = !tree.canRemove; remove.title = tree.reason || "워크트리 폴더를 삭제합니다.";
        return el("li", { class: "git-worktree" }, el("strong", {}, tree.branch || "브랜치 없음"),
          tree.original ? el("span", { class: "muted" }, "원본 폴더") : null,
          el("p", { class: "mono" }, tree.cwd),
          el("p", { class: "hint" }, [tree.locked ? "잠김" : "", tree.missing ? "폴더 없음" : "", tree.dirty ? typeof tree.dirty === "number" ? "미커밋 변경 " + tree.dirty + "개" : "미커밋 변경 있음" : "", tree.sessionIds?.length ? "연결 세션 " + tree.sessionIds.length + "개" : "", tree.taskIds?.length ? "연결 작업 " + tree.taskIds.length + "개" : ""].filter(Boolean).join(" · ")),
          el("div", { class: "git-operation-buttons" }, choose, remove));
      });
      const name = el("input", { id: "g-worktree-name", required: "", maxlength: "80", placeholder: "예: login-fix" });
      const mode = el("select", { id: "g-worktree-mode" }, el("option", { value: "new" }, "새 브랜치"), el("option", { value: "existing" }, "기존 브랜치"));
      const branch = el("input", { id: "g-worktree-branch", placeholder: "비우면 폴더 이름으로 생성" });
      const base = el("select", { id: "g-worktree-base" }, ...(m.data?.branches ?? []).map((b) => el("option", { value: b.name }, b.name)));
      base.value = m.data?.branch ?? "";
      const baseLabel = el("label", {}, "기준 브랜치", base);
      mode.addEventListener("change", () => { baseLabel.hidden = mode.value === "existing"; branch.placeholder = mode.value === "existing" ? "사용할 기존 브랜치 이름" : "비우면 폴더 이름으로 생성"; branch.required = mode.value === "existing"; });
      const form = el("form", { class: "git-worktree-form", onsubmit: (event) => {
        event.preventDefault();
        if (!form.reportValidity() || writing) return;
        const values = { name: name.value.trim(), ...(mode.value === "existing" ? { existingBranch: branch.value.trim() } : { ...(branch.value.trim() ? { branch: branch.value.trim() } : {}), startPoint: base.value }) };
        const summary = values.existingBranch || values.branch || "agenthub/" + values.name;
        if (!confirm("워크트리를 만들까요?\n프로젝트: " + m.project + "\n폴더 이름: " + values.name + "\n브랜치: " + summary + (values.startPoint ? "\n기준: " + values.startPoint : ""))) return;
        write(m, version, "/api/git/worktrees", values, async () => { content.replaceChildren(el("p", {}, "작업 폴더를 만들었습니다."), button("작업 폴더 목록 보기", () => worktrees())); });
      } }, el("h4", {}, "새 작업 폴더"), el("label", {}, "폴더 이름", name), el("label", {}, "브랜치 방식", mode), el("label", {}, "브랜치 이름", branch), baseLabel,
      el("button", { type: "submit", class: "primary" }, "워크트리 만들기"));
      // 폴더가 사라졌는데 Git 기록만 남은 워크트리는 브랜치를 계속 점유하므로 한 번에 정리할 수 있게 한다.
      const missing = (data.worktrees ?? []).filter((tree) => tree.missing).length;
      const prune = missing ? el("p", { class: "hint" }, `폴더가 사라진 워크트리 기록 ${missing}개가 브랜치를 점유하고 있습니다. `,
        button("사라진 폴더 기록 정리", () => write(m, version, "/api/git/worktrees/prune", {}, async () => { await worktrees(); }))) : null;
      content.replaceChildren(el("p", { class: "hint" }, "폴더를 선택하면 변경사항, 커밋 기록, 병합, 푸시와 PR에 같은 폴더가 적용됩니다."), ...(prune ? [prune] : []), el("ul", { class: "git-worktrees" }, ...rows), form);
    } catch (err) { fail(err, m, version); }
  }

  function removeTree(tree) {
    const request = open("워크트리 정리"); if (!request) return;
    const { m, version } = request;
    const removeBranch = el("input", { id: "g-worktree-delete-branch", type: "checkbox" });
    const removeIgnored = el("input", { id: "g-worktree-delete-ignored", type: "checkbox" });
    content.replaceChildren(el("p", {}, "다음 작업 폴더를 삭제합니다."), el("p", { class: "mono" }, tree.cwd),
      el("p", { class: "mono" }, "브랜치: " + tree.branch + " · " + tree.head?.slice(0, 8)),
      el("label", { class: "check" }, removeBranch, " 로컬 브랜치도 삭제"),
      el("label", { class: "check" }, removeIgnored, " Git이 무시하는 파일(node_modules, 빌드 결과 등)도 함께 삭제"),
      el("p", { class: "hint" }, "연결된 작업·세션, 미커밋 변경, 다른 브랜치에 반영되지 않은 커밋이 있으면 삭제할 수 없습니다."),
      action("이 작업 폴더 삭제", () => write(m, version, "/api/git/worktrees/remove", { cwd: tree.cwd, removeFolder: true, deleteBranch: removeBranch.checked, removeIgnored: removeIgnored.checked, expectedHead: tree.head, expectedBranch: tree.branch }, async () => {
        if (samePath(tree.cwd, m.cwd ?? m.project)) { dialog.close(); await setWorkspace(m.project); }
        else content.replaceChildren(el("p", {}, "작업 폴더를 정리했습니다."), button("작업 폴더 목록 보기", () => worktrees()));
      })));
  }

  async function remote(kind, remoteName = "") {
    const request = open(kind === "push" ? "현재 브랜치 푸시" : "원격 가져오기"); if (!request) return;
    const { m, version } = request;
    try {
      const data = await api("GET", "/api/git/remotes?" + query(m, remoteName ? { remote: remoteName } : {}));
      if (!valid(m, version)) return;
      const remotes = data.remotes ?? [];
      const select = el("select", { id: "g-remote-choice", "aria-label": "원격 저장소" }, ...remotes.map((r) => el("option", { value: r.name }, r.name)));
      select.value = remoteName || data.remote || (remotes.some((r) => r.name === "origin") ? "origin" : remotes[0]?.name || "");
      select.addEventListener("change", () => remote(kind, select.value));
      const selected = remotes.find((r) => r.name === select.value);
      const upstream = el("input", { id: "g-push-upstream", type: "checkbox" }); upstream.checked = !data.upstream;
      const branch = data.currentBranch || m.data.branch;
      const head = data.head || m.data.head;
      content.replaceChildren(info(m), el("label", {}, "원격 저장소", select),
        selected ? el("p", { class: "mono git-operation-remote" }, displayRemote(kind === "push" ? selected.pushUrl : selected.fetchUrl)) : el("p", { class: "hint" }, "등록된 원격 저장소가 없습니다."),
        kind === "push" ? el("p", { class: "git-operation-summary mono" }, branch + " → " + select.value + "/" + branch) : null,
        kind === "push" ? el("p", {}, data.newBranch ? "원격에 새 브랜치를 만듭니다." : data.ahead === null || data.behind === null ? "새 원격 커밋이 있습니다. 원격 가져오기로 커밋 수를 확인해 주세요." : "보낼 커밋 " + (data.ahead ?? 0) + "개 · 받을 커밋 " + (data.behind ?? 0) + "개") : el("p", {}, "원격의 최신 브랜치와 커밋을 가져옵니다. 작업 파일은 바뀌지 않습니다."),
        kind === "push" ? el("p", { class: "hint mono" }, "보낼 커밋: " + (head?.slice(0, 12) || "없음") + " · 미커밋 변경은 포함되지 않습니다.") : null,
        kind === "push" ? el("label", { class: "check" }, upstream, " 이 원격 브랜치를 추적") : null,
        action(kind === "push" ? "푸시 미리보기" : "원격 가져오기 실행", () => kind === "push"
          ? preview("push", { remote: select.value, setUpstream: upstream.checked })
          : write(m, version, "/api/git/fetch", { remote: select.value }), !remotes.length || (kind === "push" && (!head || !branch))));
    } catch (err) { fail(err, m, version); }
  }

  // 원격 변경 받기. 앞으로 감기를 기본으로 하고, 갈라졌으면 병합·리베이스 중에서 고른다.
  async function pull() {
    const request = open("원격 변경 받기 (Pull)"); if (!request) return;
    const { m, version } = request;
    try {
      const data = await api("GET", "/api/git/pull-state?" + query(m));
      if (!valid(m, version)) return;
      const diverged = data.ahead > 0 && data.behind > 0;
      const strategy = el("select", { id: "g-pull-strategy", "aria-label": "받기 방식" },
        el("option", { value: "ff-only" }, "앞으로 감기만 (기록을 바꾸지 않음)"),
        el("option", { value: "merge" }, "Merge · 병합 커밋으로 합치기"),
        el("option", { value: "rebase" }, "Rebase · 내 커밋을 원격 뒤로 옮기기"));
      strategy.value = diverged ? "merge" : "ff-only";
      const counts = data.behind === null ? "원격 기록을 아직 가져오지 않았습니다. 받으면서 함께 가져옵니다."
        : "받을 커밋 " + data.behind + "개 · 내 커밋 " + data.ahead + "개 (마지막으로 가져온 기록 기준)";
      content.replaceChildren(info(m, data),
        el("p", { class: "git-operation-summary mono" }, data.upstream + " → " + data.branch),
        el("p", {}, counts),
        diverged ? el("p", { class: "hint" }, "로컬과 원격이 서로 다른 커밋을 가지고 있습니다. 앞으로 감기만으로는 받을 수 없어 합치는 방식을 골라야 합니다.") : null,
        data.dirty ? el("p", { class: "hint" }, "커밋하지 않은 변경이 있습니다. 받을 변경과 겹치면 Git이 거절하고 아무것도 바꾸지 않습니다.") : null,
        el("label", {}, "받기 방식", strategy),
        el("p", { class: "hint" }, "충돌이 나면 받기를 취소하고 실행 전 상태로 되돌립니다."),
        action("Pull 실행", () => write(m, version, "/api/git/pull-remote", { strategy: strategy.value, expectedHead: data.head })));
    } catch (err) { fail(err, m, version); }
  }

  // 새 브랜치 만들기. 유형을 고르면 GitFlow 설정의 접두어와 기준 브랜치를 채운다.
  async function branch(startPoint = "") {
    const request = open("새 브랜치 만들기"); if (!request) return;
    const { m, version } = request;
    let flow = DEFAULT_GITFLOW;
    try { flow = { ...DEFAULT_GITFLOW, ...(await api("GET", "/api/tasks/settings?" + new URLSearchParams({ path: m.project })))?.settings }; } catch { /* 기본 접두어를 쓴다. */ }
    if (!valid(m, version)) return;
    const branches = (m.data.branches ?? []).map((b) => b.name);
    const kind = el("select", { id: "g-branch-kind", "aria-label": "브랜치 유형" },
      el("option", { value: "feature" }, "기능 개발 (" + flow.featurePrefix + ")"), el("option", { value: "hotfix" }, "긴급 수정 (" + flow.hotfixPrefix + ")"),
      el("option", { value: "release" }, "배포 준비 (" + flow.releasePrefix + ")"), el("option", { value: "custom" }, "직접 입력"));
    const name = el("input", { id: "g-branch-name", required: "", maxlength: "200", autocomplete: "off", spellcheck: "false", placeholder: "예: login-fix" });
    const prefix = el("span", { class: "git-branch-prefix mono" });
    const start = el("select", { id: "g-branch-start", "aria-label": "시작 지점" },
      el("option", { value: "" }, "현재 위치 (" + (m.data.branch || "HEAD") + ")"),
      ...(startPoint ? [el("option", { value: startPoint }, "선택한 커밋 " + startPoint.slice(0, 8))] : []),
      ...branches.map((value) => el("option", { value }, value)));
    const checkout = el("input", { id: "g-branch-checkout", type: "checkbox" });
    checkout.checked = true;
    const preview = el("p", { class: "git-operation-summary mono", id: "g-branch-preview" });
    const sync = (fromKind) => {
      const type = kind.value;
      prefix.textContent = type === "custom" ? "" : flow[type + "Prefix"];
      if (fromKind && type !== "custom") {
        const base = gitflowBranches(type, flow).base;
        start.value = branches.includes(base) ? base : start.value;
      }
      preview.textContent = (start.value || m.data.branch || "HEAD") + "에서 " + (prefix.textContent + (name.value.trim() || "<이름>")) + " 만들기" + (checkout.checked ? " · 바로 전환" : "");
    };
    kind.addEventListener("change", () => sync(true));
    for (const input of [name, start, checkout]) input.addEventListener(input === name ? "input" : "change", () => sync(false));
    const form = el("form", { class: "git-branch-form", onsubmit: (event) => {
      event.preventDefault();
      if (!form.reportValidity() || writing) return;
      write(m, version, "/api/git/branches", { name: prefix.textContent + name.value.trim(), ...(start.value ? { startPoint: start.value } : {}), checkout: checkout.checked });
    } }, el("label", {}, "유형", kind), el("label", {}, "브랜치 이름", el("span", { class: "git-branch-name-input" }, prefix, name)),
      el("label", {}, "시작 지점", start), el("label", { class: "check" }, checkout, " 만든 뒤 이 브랜치로 전환"),
      m.data.files?.length ? el("p", { class: "hint" }, "커밋하지 않은 변경은 새 브랜치로 그대로 가져갑니다. 시작 지점과 겹치는 파일이 있으면 Git이 전환을 거절합니다.") : null,
      preview, el("button", { type: "submit", class: "primary", id: "g-operation-apply" }, "브랜치 만들기"));
    content.replaceChildren(info(m), form);
    sync(true);
    name.focus();
  }

  async function recoveries() {
    const request = open("커밋 복구 기록"); if (!request) return;
    const { m, version } = request;
    try {
      const data = await api("GET", "/api/git/recovery?" + query(m));
      if (!valid(m, version)) return;
      content.replaceChildren(info(m), el("p", { class: "hint" }, "커밋 기록을 변경하기 전의 위치입니다. 선택한 기록으로 현재 브랜치와 파일을 복구합니다."),
        el("ul", { class: "git-worktrees" }, ...(data.recoveries ?? []).map((record) => el("li", { class: "git-worktree" },
          el("strong", {}, record.branch + " · " + (LABELS[record.action] || record.action)),
          el("p", { class: "mono" }, record.head?.slice(0, 12) + " · " + new Date(record.createdAt).toLocaleString()),
          button("이 기록으로 복구…", () => {
            const expectedHead = m.data.head || m.data.commits?.[0]?.hash;
            title.textContent = "커밋 복구 확인";
            content.replaceChildren(info(m), el("p", {}, "현재 브랜치와 파일을 아래 커밋의 상태로 복구합니다."),
              el("p", { class: "mono" }, record.branch + " · " + record.head),
              action("이 기록으로 복구", () => write(m, version, "/api/git/restore", { recoveryId: record.id, expectedHead })));
          })))),
        !data.recoveries?.length ? el("p", {}, "아직 복구 기록이 없습니다.") : null);
    } catch (err) { fail(err, m, version); }
  }

  function update() {
    const m = getModel();
    if (notice.dataset.project && !samePath(notice.dataset.project, m?.project)) notice.hidden = true;
    location.textContent = m?.cwd ?? m?.project ?? ""; location.title = location.textContent;
    workspace.textContent = m && !samePath(m.cwd ?? m.project, m.project) ? "워크트리 선택 ▾" : "원본 폴더 ▾";
    const data = m?.data;
    const reasons = !data ? {} : {
      pull: !data.branch || data.branch === "HEAD" ? "브랜치가 아닌 커밋을 보고 있어 받을 수 없습니다." : !data.upstream ? "따라갈 원격 브랜치가 없습니다. 먼저 Push로 게시하세요." : "",
      push: !data.branch || data.branch === "HEAD" ? "브랜치가 아닌 커밋은 푸시할 수 없습니다." : data.upstream && data.behind > 0 ? "원격이 " + data.behind + "개 앞서 있습니다. 먼저 Pull로 받으세요." : "",
      merge: !(data.branches ?? []).some((b) => !b.current) ? "병합할 다른 브랜치가 없습니다." : "",
    };
    for (const [key, b] of Object.entries(tools)) {
      b.dataset.blocked = String(!!reasons[key]);
      b.title = reasons[key] || b.dataset.description;
      const count = key === "pull" ? data?.behind : key === "push" ? data?.ahead : 0;
      const badge = b.querySelector(".git-tool-badge");
      badge.textContent = count > 0 ? String(count) : "";
      badge.hidden = !(count > 0);
    }
    const shown = Object.entries(reasons).filter(([, text]) => text).map(([key, text]) => tools[key].querySelector(".git-tool-label").textContent + ": " + text);
    toolReason.textContent = shown.join(" · ");
    toolReason.hidden = !shown.length;
    for (const b of [...toolbar.querySelectorAll("button"), ...commitActions.querySelectorAll("button")]) b.disabled = !m?.data || isBusy() || b.dataset.blocked === "true";
    workspace.disabled = !m || isBusy();
    if (dialogModel && (dialogModel !== m || !isCurrent(dialogModel))) { ++requestVersion; if (!writing) dialog.close(); }
  }

  function commit(c) {
    const basic = ["revert", "uncommit"].map((name) => button(LABELS[name], () => preview(name, { commit: c.hash }), "g-history-" + name));
    if (c.hash !== (getModel()?.data?.head || getModel()?.data?.commits?.[0]?.hash)) {
      basic[1].dataset.blocked = "true";
      basic[1].title = "가장 최근 커밋에서 사용할 수 있습니다. 이전 커밋은 변경 되돌리기 또는 기록 정리를 선택하세요.";
    }
    const advanced = el("details", { class: "git-history-advanced" }, el("summary", {}, "기록 정리…"),
      ...["reset", "drop"].map((name) => button(LABELS[name], () => preview(name, { commit: c.hash }), "g-history-" + name)));
    const fromHere = button("여기서 새 브랜치", () => branch(c.hash), "g-history-branch");
    commitActions.replaceChildren(fromHere, ...basic, advanced);
    commitActions.hidden = false;
    update();
  }

  return { update, commit, merge, push: () => remote("push"), branch, clearCommit: () => { commitActions.hidden = true; } };
}
