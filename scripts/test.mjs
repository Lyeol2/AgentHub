// npm test: 모든 테스트를 실행한다. 파일을 고르지 않고 커밋하지 않은 변경 없이 통과하면
// 그 커밋을 통과로 기록해 릴리스가 같은 코드를 다시 테스트하지 않게 한다(scripts/test-stamp.mjs).
import { spawnSync } from "node:child_process";
import { recordPass } from "./test-stamp.mjs";

const args = process.argv.slice(2);
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=8", ...args], { stdio: "inherit" });
const code = result.status ?? 1;
if (code === 0 && !args.length) {
  const commit = recordPass();
  if (commit) console.log(`\n전체 테스트 통과를 기록했습니다: ${commit.slice(0, 7)} (같은 코드면 릴리스에서 테스트를 건너뜁니다)`);
}
process.exit(code);
