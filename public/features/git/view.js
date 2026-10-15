import { $, el, renderDiff, fmtDate } from "../../shared/dom.js";
import { layoutGitGraph, gitWorkRows } from "../../gitgraph.js";

export function createGitView({ getModel, selectSession, showSessionChanges, openBranchCommit, showGitBranch, mergeGitBranch, showGitFile, changeGitIndex, showGitTab, showGitCommit, onToggleFile }) {
  const gitBusy = () => !!(getModel()?.indexBusy || getModel()?.committing || getModel()?.merging);
  const gitFiles = (area) => (getModel()?.data?.files ?? []).filter((file) => file[area]);
  const gitBranchName = (branch) => branch.sessionTitle || branch.name;

  function renderGit() {
    const { data } = getModel();
    $("g-branch").textContent = data.branch;
    $("g-branch").title = "현재 브랜치: " + data.branch;
    $("g-sync").textContent = data.upstream
      ? (data.ahead ? "↑ " + data.ahead + " " : "") + (data.behind ? "↓ " + data.behind : "") + (!data.ahead && !data.behind ? "동기화됨" : "")
      : "";
    $("g-sync").title = data.upstream ? data.upstream + " · 마지막으로 받은 원격 기록 기준" : "";
    const n = data.files.length + data.moreFiles;
    $("p-tab-git").textContent = n ? String(n) : "";
    $("g-file-count").textContent = String(n);
    for (const area of ["unstaged", "staged"]) renderGitFiles(area);
    $("g-limit").hidden = !data.moreFiles;
    $("g-limit").textContent = "변경 파일 중 500개만 표시합니다. '모두'는 표시된 파일에 적용됩니다. 커밋에는 스테이징된 모든 파일이 포함됩니다.";
    renderGitControls();
    $("g-branch-count").textContent = String(data.branches.length);
    $("g-branches").replaceChildren(...data.branches.map(renderGitBranch));
    renderGitGraph();
  }

  function renderGitFiles(area) {
    const files = gitFiles(area);
    const selected = getModel().selected[area];
    const staged = area === "staged";
    const action = staged ? "unstage" : "stage";
    $("g-" + area + "-count").textContent = String(getModel().data[area + "Count"] ?? files.length);
    $("g-" + area).replaceChildren(...(files.length ? files.map((f) => {
      const label = (staged ? f.stageLabel : f.workLabel) || f.label;
      const box = el("input", { type: "checkbox", "aria-label": f.path + (staged ? " 스테이징됨 선택" : " 스테이징 전 선택"), onchange: (e) => {
        onToggleFile(area, f.path, e.target.checked);
      } });
      box.checked = selected.has(f.path);
      const active = getModel().activeFile?.file === f.path && getModel().activeFile?.area === area;
      return el("li", { class: "git-file" + (active ? " active" : ""), "data-file": f.path, "data-area": area }, box,
        el("span", { class: "git-status s-" + (["새 파일", "추가"].includes(label) ? "new" : label === "삭제" ? "del" : label === "충돌" ? "conflict" : "mod") }, label),
        el("button", { type: "button", class: "link mono", title: f.orig ? f.orig + " → " + f.path : f.path, onclick: () => showGitFile(f.path, area) }, f.path),
        el("button", { type: "button", class: "ghost sm git-file-action", "data-index-action": action, "aria-label": f.path + (staged ? " 스테이징 해제" : " 스테이징"), title: staged ? "스테이징 해제" : "스테이징", onclick: () => changeGitIndex(action, [f.path]) }, staged ? "−" : "+"));
    }) : [el("li", { class: "muted git-list-empty" }, staged ? "스테이징된 파일이 없습니다." : "스테이징 전 변경이 없습니다.")]));
  }

  function renderGitControls() {
    const current = getModel();
    if (!current?.data) return;
    const busy = gitBusy();
    for (const area of ["unstaged", "staged"]) {
      const files = gitFiles(area);
      const picked = files.filter((f) => current.selected[area].has(f.path)).length;
      const all = $("g-" + area + "-all");
      all.checked = files.length > 0 && picked === files.length;
      all.indeterminate = picked > 0 && picked < files.length;
      all.disabled = !files.length || busy;
      const action = area === "staged" ? "unstage" : "stage";
      $("g-" + action + "-selected").disabled = !picked || busy;
      $("g-" + action + "-selected").textContent = (area === "staged" ? "선택 해제" : "선택 스테이징") + (picked ? " (" + picked + ")" : "");
      $("g-" + action + "-all").disabled = !files.length || busy;
      $("g-" + action + "-all").title = current.data.moreFiles ? "표시된 파일 모두" : "모든 파일";
    }
    for (const input of $("g-changes").querySelectorAll(".git-file input, [data-index-action]")) input.disabled = busy;
    const staged = current.data.stagedCount ?? gitFiles("staged").length;
    $("g-commit").disabled = !staged || busy || !$("g-message").value.trim();
    $("g-commit").textContent = current.committing ? "커밋 중…" : staged ? "커밋 (" + staged + ")" : "커밋";
    $("g-commit-note").textContent = current.indexBusy ? "목록을 업데이트하는 중…" : "스테이징된 내용만 커밋합니다.";
    $("g-message").disabled = !!current.committing;
    $("g-refresh").disabled = busy;
  }

  function renderGitBranch(b) {
    const running = b.sessionState === "running";
    const status = running ? "작업 중" : b.dirty ? "변경 " + b.dirty : b.ahead ? "+" + b.ahead : b.current ? "현재" : "";
    const actions = [];
    const run = (label, fn, opts = {}) => {
      const button = el("button", { type: "button", class: "ghost sm", title: opts.title ?? "", onclick: fn }, label);
      button.disabled = !!opts.disabled;
      actions.push(button);
    };
    if (b.sessionId) run("세션 열기", () => selectSession(b.sessionId));
    if (b.sessionId && b.dirty) run("변경 보기", () => showSessionChanges(b));
    if (b.sessionId && b.dirty) run("커밋", (e) => openBranchCommit(e.target.closest("li"), b), { disabled: running, title: running ? "세션이 끝난 뒤 커밋할 수 있습니다." : "세션의 변경 전체를 커밋합니다." });
    if (!b.current && b.ahead) run("비교", () => showGitBranch(b));
    if (!b.current && b.ahead) run("병합", () => mergeGitBranch(b), { title: getModel().data.branch + "에 병합" });
    const summary = el("summary", { title: b.name },
      el("span", { class: "git-branch-dot" + (running ? " running" : "") }),
      el("span", { class: "name" }, gitBranchName(b)),
      el("span", { class: "git-branch-status" }, status));
    return el("li", { class: "git-branch" + (b.current ? " current" : "") },
      el("details", {}, summary,
        el("div", { class: "git-branch-info muted mono" }, b.name),
        b.dirty === null ? el("div", { class: "muted" }, "작업 폴더 없음") : null,
        actions.length ? el("div", { class: "git-actions" }, ...actions) : null));
  }

  function renderGitGraph() {
    const { data } = getModel();
    const work = gitWorkRows(data);
    const commits = data.graph?.commits ?? data.commits;
    const layout = layoutGitGraph([...work, ...commits]);
    const width = Math.max(60, layout.lanes * 22 + 26);
    $("g-graph").style.minWidth = (width + 470) + "px";
    const rows = layout.rows.map((row) => {
      const c = row.commit;
      const x = (lane) => 20 + lane * 22;
      const y = { top: 0, node: 24, bottom: 48 };
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", width);
      svg.setAttribute("height", 48);
      svg.setAttribute("viewBox", "0 0 " + width + " 48");
      svg.setAttribute("aria-hidden", "true");
      for (const s of row.segments) {
        const path = document.createElementNS(svg.namespaceURI, "path");
        const ax = x(s.fromLane), bx = x(s.toLane), ay = y[s.from], by = y[s.to];
        const middle = (ay + by) / 2;
        path.setAttribute("d", ax === bx ? "M" + ax + " " + ay + "V" + by : "M" + ax + " " + ay + "C" + ax + " " + middle + " " + bx + " " + middle + " " + bx + " " + by);
        path.setAttribute("class", "git-track git-track-" + s.color + (s.dashed ? " work" : ""));
        svg.append(path);
      }
      const circle = document.createElementNS(svg.namespaceURI, "circle");
      circle.setAttribute("cx", x(row.lane));
      circle.setAttribute("cy", 24);
      circle.setAttribute("r", c.work ? 5 : c.parents?.length > 1 ? 5.5 : 4);
      circle.setAttribute("class", "git-station git-track-" + row.color + (c.work ? " work" : ""));
      svg.append(circle);
      const branches = (c.refs ?? []).map((name) => data.branches.find((b) => b.name === name) ?? (c.branch?.name === name ? c.branch : { name }));
      const chips = branches.slice(0, 2).map((b) => el("span", { class: "git-ref" + (b.current ? " current" : ""), title: b.name }, gitBranchName(b)));
      if (branches.length > 2) chips.push(el("span", { class: "git-ref", title: branches.slice(2).map(gitBranchName).join("\n") }, "+" + (branches.length - 2)));
      const title = c.work ? [gitBranchName(c.branch), c.branch.sessionState === "running" ? "작업 중" : "", c.dirty ? "변경 " + c.dirty + "개" : ""].filter(Boolean).join(" · ") : c.subject;
      const button = el("button", { type: "button", class: "git-graph-row" + (c.work ? " work" : "") + (getModel().activeRow === c.hash ? " active" : ""),
        "data-hash": c.hash, "aria-pressed": String(getModel().activeRow === c.hash), title: c.work ? title : c.subject + "\n" + c.author + " · " + fmtDate(c.date) + "\n" + c.hash,
        onclick: () => {
          setGitActive(c.hash);
          if (!c.work) showGitCommit(c);
          else if (c.branch.sessionId) showSessionChanges(c.branch);
          else { showGitTab("changes"); $("g-changes").scrollIntoView({ block: "nearest" }); }
        } }, svg,
        el("span", { class: "git-graph-subject" }, title),
        el("span", { class: "git-graph-refs" }, ...chips),
        el("span", { class: "git-graph-meta mono" }, c.work ? "커밋 전" : c.short));
      return button;
    });
    $("g-graph").replaceChildren(...(rows.length ? rows : [el("p", { class: "git-empty muted" }, "아직 커밋이 없습니다.")]));
    $("g-summary").textContent = (work.length ? "작업 " + work.length + " · " : "") + "커밋 " + commits.length;
    $("g-history-note").textContent = data.graph?.truncated ? "최근 100개 · 아래로 이전 기록이 이어집니다." : "커밋을 누르면 변경 내용을 볼 수 있습니다.";
  }

  function setGitActive(hash) {
    getModel().activeRow = hash;
    for (const row of $("g-graph").querySelectorAll(".git-graph-row")) {
      row.classList.toggle("active", row.dataset.hash === hash);
      row.setAttribute("aria-pressed", String(row.dataset.hash === hash));
    }
  }

  function showGitView(title, text) {
    $("g-diff-empty").hidden = true;
    $("g-detail").hidden = false;
    $("g-view-title").textContent = title;
    $("g-view").replaceChildren(...renderDiff(text));
    $("g-view").scrollTop = 0;
  }

  return { renderGit, renderGitFiles, renderGitControls, setGitActive, showGitView };
}
