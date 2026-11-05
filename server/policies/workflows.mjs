// 연결 조건과 넘길 내용을 계산하는 순수 규칙. 실행·저장 부작용이 없다.
export const CONDITIONS = ["success", "keyword", "error", "always", "otherwise", "manual", "call", "ref"];
// 화면의 조건 선택지(보이는 순서). 서버가 내려 주고 같은 목록으로 검사한다.
export const CONDITION_LABELS = {
  keyword: "판정(handoff)이 키워드와 맞으면",
  success: "턴이 성공하면",
  error: "턴이 실패하면",
  otherwise: "다른 연결이 모두 안 맞으면 (그 외)",
  always: "턴이 끝날 때마다",
  manual: "수동으로만",
  call: "사용자가 요청하면 부르기",
  ref: "참고 (아트 레퍼런스 · 실행하지 않음)",
};
// 자동으로 이어지는 최대 단계. 서로를 가리키는 연결이 끝없이 돌지 않게 막는다.
export const MAX_HOPS = 8;
const ANSWER_MAX = 8000;

// 마지막 요청 이후 에이전트가 쓴 답변. max를 넘으면 앞부분을 줄인다(세션에 넘길 때). 명령 스크립트처럼 잘리면 안 되는 곳은 Infinity를 준다.
export function lastAnswer(session, max = ANSWER_MAX) {
  let start = 0;
  for (let i = session.events.length - 1; i >= 0; i--) {
    if (session.events[i].kind === "user") {
      start = i + 1;
      break;
    }
  }
  const text = session.events.slice(start).filter((e) => e.kind === "text").map((e) => e.text).join("\n\n").trim();
  return text.length > max ? `… (앞부분 생략)\n${text.slice(-max)}` : text;
}

// 이번 턴에 에이전트가 handoff 도구로 알린 판정과 전달할 내용. 마지막 요청(사용자·넘겨받은 작업) 이후의 것만 본다.
// 여러 번 알렸으면 마지막 것을 쓴다. 없으면 null
export function turnHandoff(session) {
  const events = session?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "user" && !event.injected) return null;
    if (event.kind === "handoff") return { verdict: String(event.verdict ?? ""), content: typeof event.content === "string" && event.content.trim() ? event.content : null };
  }
  return null;
}

// 세션에서 나가는 연결 중 판정으로 고를 수 있는 키워드 목록(중복 없이)
export function handoffKeywords(links) {
  return [...new Set(links.filter((l) => l.enabled !== false && l.when === "keyword").flatMap((l) => keywordList(l.keyword)))];
}

// 판정어가 키워드 목록 중 하나와 같은지(대소문자·앞뒤 공백 무시). 같으면 목록에 적힌 그대로 돌려준다.
export function canonicalVerdict(verdict, keywords) {
  const want = String(verdict ?? "").trim().toLowerCase();
  return want ? keywords.find((k) => k.toLowerCase() === want) ?? null : null;
}

// 명령 노드 출력의 판정 줄: 마지막 글 줄. 세션은 판정 줄을 쓰지 않고 handoff 도구로 알린다. 마크다운 꾸밈(#, >, -, **, `)과 감싼 따옴표는 걷어 낸다.
export function verdictLine(answer) {
  const lines = String(answer ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(```|~~~)/.test(l));
  return (lines.at(-1) ?? "")
    .replace(/^(?:[#>*+-]+\s*)+/, "")
    .replace(/[*_`~]/g, "")
    .replace(/^["'“‘](.*)["'”’]$/, "$1")
    .trim();
}

// 키워드는 쉼표로 여러 개를 적을 수 있고 하나라도 있으면 맞는다.
export const keywordList = (keyword) => String(keyword ?? "").split(/[,，]/).map((k) => k.trim()).filter(Boolean);

// 키워드 바로 뒤에 부정이 오면("수정 필요 없음", "검토 요청 아님") 맞지 않은 것으로 본다.
const NEGATION = /^\s*(?:은|는|이|가)?\s*(?:없|아니|아님|않|안\s|불필요|no\b|not\b|none\b)/i;

export function hasKeyword(text, keyword) {
  const hay = String(text ?? "").toLowerCase();
  return keywordList(keyword).some((k) => {
    const needle = k.toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
      if (!NEGATION.test(hay.slice(i + needle.length))) return true;
    }
    return false;
  });
}

// 연결 하나만 볼 때의 조건. "그 외"는 다른 연결과 함께 봐야 하므로 pickLinks에서 정한다.
// ok: 턴 성공 여부. 사용자가 중지한 턴(null)은 넘기지 않는다.
// verdict: 키워드를 찾을 글(명령 노드는 출력). exact면 세션이 handoff로 알린 판정어(줄마다 하나)와 키워드가 같아야 맞는다.
export function matches(link, ok, verdict, exact = false) {
  if (!link.enabled || ok === null) return false;
  switch (link.when) {
    case "success": return ok;
    case "error": return !ok;
    case "always": return true;
    // 키워드는 에이전트가 직접 쓴 판정이므로 턴이 실패로 끝났어도 따른다.
    case "keyword": {
      if (!exact) return hasKeyword(verdict, link.keyword);
      const said = String(verdict ?? "").split("\n").map((v) => v.trim().toLowerCase()).filter(Boolean);
      return keywordList(link.keyword).some((k) => said.includes(k.toLowerCase()));
    }
    default: return false;
  }
}

// 한 노드에서 나가는 연결 중 이번에 따라갈 것을 고른다. if / else-if / else처럼 동작한다.
// 1. 키워드가 맞은 연결이 있으면 그것만 따라간다(성공·실패 연결은 건너뛴다).
// 2. 없으면 맞은 성공·실패 연결을 따라간다.
// 3. 그것도 없으면 "그 외" 연결을 따라간다.
// "항상" 연결은 이와 상관없이 함께 따라간다.
export function pickLinks(links, ok, verdict, exact = false) {
  if (ok === null) return [];
  const on = links.filter((l) => l.enabled);
  const always = on.filter((l) => l.when === "always");
  const keyword = on.filter((l) => l.when === "keyword" && matches(l, ok, verdict, exact));
  if (keyword.length) return [...keyword, ...always];
  const plain = on.filter((l) => (l.when === "success" || l.when === "error") && matches(l, ok, verdict, exact));
  if (plain.length) return [...plain, ...always];
  return [...on.filter((l) => l.when === "otherwise"), ...always];
}

// 조건을 따지는 연결이 있는데 하나도 맞지 않았을 때 기록에 남길 설명. 남길 것이 없으면 null
// session: 세션이면 handoff 판정 기준으로 설명한다(명령 노드는 출력의 마지막 줄).
export function noMatchNote(links, verdict, session = false) {
  if (!links.some((l) => l.enabled && ["keyword", "success", "error"].includes(l.when))) return null;
  if (session) return verdict ? `조건에 맞는 연결이 없어 넘기지 않았습니다 (판정: "${verdict.slice(0, 80)}")`
    : `조건에 맞는 연결이 없어 넘기지 않았습니다 (판정 없음 · handoff 도구로 판정을 알리지 않았습니다)`;
  return `조건에 맞는 연결이 없어 넘기지 않았습니다 (마지막 줄: "${verdict.slice(0, 80) || "없음"}")`;
}

// 세션 묶음: 묶은 세션이 모두 진행 중이 아닐 때만 다음 노드로 넘어간다.
// 성공은 묶은 세션 중 오류로 끝난 것이 없을 때이고, 키워드는 어느 한 세션이 handoff로 알린 판정과 맞으면 맞는다.
export function groupOutcome(members) {
  return {
    ok: members.every((s) => s.state !== "error"),
    verdict: members.map((s) => turnHandoff(s)?.verdict ?? "").filter(Boolean).join("\n"),
  };
}

// members: [{ session, answer, files }]
export function groupHandoffText(group, members, link) {
  return [
    `[세션 묶음 "${group.title}"에서 넘어온 결과]`,
    `묶은 세션 ${members.length}개가 모두 끝났다. 각 세션의 결과는 아래와 같다.`,
    ...members.map(({ session, answer, files }) => [
      "",
      `--- ${session.title} (${session.agent}) ---`,
      `작업 폴더: ${session.cwd}${session.worktree ? ` (브랜치 ${session.worktree.branch})` : ""}`,
      `상태: ${session.state === "error" ? "실패" : "완료"}`,
      "변경 파일:",
      files?.trim() || "(없음)",
      "마지막 답변:",
      answer || "(답변 없음)",
    ].join("\n")),
    "",
    link.note?.trim() || "이 결과들을 모아 네 역할에 맞게 처리하라.",
  ].join("\n");
}

// 보낸 세션이 handoff로 전달할 내용을 알렸으면 그 글을 "전달 내용"으로, 아니면 마지막 답변을 넘긴다.
export function handoffText(source, link, answer, files) {
  const handoff = turnHandoff(source);
  const given = handoff?.content && answer === handoff.content;
  // 세션 지침이 있으면 지침 이름과 한 줄 설명을, 없으면 예전 역할의 첫 줄을 알린다.
  const role = source.guideName ? `\n보낸 세션의 지침: ${source.guideName}${source.guideSummary ? ` — ${source.guideSummary}` : ""}` : source.role ? `\n보낸 세션의 역할: ${source.role.split(/\r?\n/)[0]}` : "";
  const branch = source.worktree ? ` (브랜치 ${source.worktree.branch})` : "";
  return [
    `[연결된 세션에서 넘어온 작업]`,
    `보낸 세션: ${source.title} (${source.agent})${role}`,
    `작업 폴더: ${source.cwd}${branch}`,
    "",
    "변경 파일:",
    files.trim() || "(없음)",
    "",
    ...(handoff?.verdict ? [`판정: ${handoff.verdict}`, ""] : []),
    given ? "전달 내용:" : "마지막 답변:",
    answer || "(답변 없음)",
    "",
    link.note?.trim() || "이 결과를 이어받아 네 역할에 맞게 처리하라.",
  ].join("\n");
}

