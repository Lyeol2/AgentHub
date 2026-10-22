const validSeq = (value) => Number.isSafeInteger(value) && value >= -1;

export function sessionReadState(session) {
  const result = session.events?.findLast((event) => event.kind === "result");
  const lastResultSeq = validSeq(result?.seq) ? result.seq : -1;
  // 추적을 시작하기 전의 기록은 이미 읽은 것으로 간주한다.
  const readResultSeq = validSeq(session.readResultSeq) ? session.readResultSeq : lastResultSeq;
  return { lastResultSeq, readResultSeq, unread: lastResultSeq > readResultSeq };
}

// 새 완료 이벤트를 붙이기 전에 호출한다. 기존 기록의 기준점만 한 번 저장한다.
export function recordCompletion(session) {
  if (!validSeq(session.readResultSeq)) session.readResultSeq = sessionReadState(session).lastResultSeq;
}
