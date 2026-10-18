// 단계별 소요 시간 디버그 로그. AGENTHUB_DEBUG=timing(또는 1·all)일 때만 남겨 평소 로그를 어지럽히지 않는다.
// 예) AGENTHUB_DEBUG=timing npm start → "[timing] session.send git-context 12ms (s1)"
let sink = (line) => console.debug(line);

export const timingEnabled = () => /^(1|true|all|timing)$/i.test(process.env.AGENTHUB_DEBUG ?? "");

// 테스트에서 로그를 모으거나 끌 때 쓴다. null이면 기본(console.debug)으로 돌린다.
export function setTimingSink(next) { sink = next ?? ((line) => console.debug(line)); }

export function logTiming(scope, step, ms, tag = "") {
  if (!timingEnabled()) return;
  try { sink(`[timing] ${scope} ${step} ${Math.round(ms)}ms${tag ? ` (${tag})` : ""}`); } catch {}
}

// 한 흐름(작업 생성, 세션 실행 등)의 단계를 차례로 잰다. step(name)은 직전 단계부터 지금까지를 남긴다.
export function stopwatch(scope, tag = "") {
  const started = performance.now();
  let last = started;
  return {
    step(name) {
      const now = performance.now();
      logTiming(scope, name, now - last, tag);
      last = now;
    },
    total(name = "total") { logTiming(scope, name, performance.now() - started, tag); },
    elapsed: () => performance.now() - started,
  };
}

// 함수 하나(동기·비동기)의 소요 시간을 남긴다.
export function timed(scope, step, fn, tag = "") {
  const started = performance.now();
  const done = () => logTiming(scope, step, performance.now() - started, tag);
  let result;
  try { result = fn(); }
  catch (error) { done(); throw error; }
  if (result && typeof result.then === "function") return result.finally(done);
  done();
  return result;
}
