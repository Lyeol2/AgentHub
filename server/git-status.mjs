// `git status --porcelain=v1 -z` 결과. 이름이 바뀐 파일은 원래 이름(orig)도 담는다.
export function parseStatus(out) {
  const parts = out.split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = { x, y, path: entry.slice(3) };
    if (x === "R" || x === "C" || y === "R" || y === "C") file.orig = parts[++i];
    files.push(file);
  }
  return files;
}

// 상태 두 글자를 사람이 읽는 말로
export function statusLabel({ x, y }) {
  if (x === "?" && y === "?") return "새 파일";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "충돌";
  const code = x !== " " ? x : y;
  return { M: "수정", A: "추가", D: "삭제", R: "이름 바꿈", C: "복사", T: "형식 바꿈" }[code] ?? code;
}
