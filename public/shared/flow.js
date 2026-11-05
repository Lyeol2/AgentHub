// 연결선 위의 짧은 이름. 대화상자의 선택지는 서버가 내려 준다(/api/status의 linkConditions).
export const WHEN_LABEL = { success: "성공 시", error: "실패 시", always: "항상", otherwise: "그 외", manual: "수동", call: "요청 시 부르기", ref: "참고" };
export const keywordText = (keyword) => keyword.split(/[,，]/).map((k) => k.trim()).filter(Boolean).map((k) => `"${k}"`).join(" 또는 ");
// 키워드 연결은 세션이 handoff로 알린 판정(명령 노드는 출력 마지막 줄)과 맞으면 넘어간다.
export const linkLabel = (l) => `${l.when === "keyword" ? `판정 ${keywordText(l.keyword)}` : WHEN_LABEL[l.when] ?? l.when}${l.approve ? " · 승인 후" : ""}`;
