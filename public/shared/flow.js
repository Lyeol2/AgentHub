// 연결선 위의 짧은 이름. 대화상자의 선택지는 서버가 내려 준다(/api/status의 linkConditions).
export const WHEN_LABEL = { success: "성공 시", error: "실패 시", always: "항상", otherwise: "그 외", manual: "수동" };
export const keywordText = (keyword) => keyword.split(/[,，]/).map((k) => k.trim()).filter(Boolean).map((k) => `"${k}"`).join(" 또는 ");
export const linkLabel = (l) => `${l.when === "keyword" ? `${keywordText(l.keyword)} 있으면` : WHEN_LABEL[l.when] ?? l.when}${l.approve ? " · 승인 후" : ""}`;
