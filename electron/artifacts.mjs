import path from "node:path";

// Opening an artifact delegates to the user's file association. Keep executable,
// script, shortcut and macro document formats out of that operation.
const OPEN_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".avif", ".tif", ".tiff",
  ".md", ".markdown", ".txt", ".log", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml",
  ".html", ".htm", ".pdf", ".doc", ".docx", ".odt", ".xls", ".xlsx", ".ods", ".ppt", ".pptx", ".odp",
]);
const ARTIFACT_KINDS = new Set(["image", "markdown", "text", "html", "file"]);

function isAppPage(target, base) {
  try {
    const url = new URL(target);
    const app = new URL(base);
    return app.protocol === "http:" && app.hostname === "127.0.0.1"
      && url.origin === app.origin && !url.username && !url.password
      && ["/", "/index.html"].includes(url.pathname);
  } catch { return false; }
}

// Resolve renderer references through the same session-scoped server validation
// as previews. The renderer never chooses a path for the operating system directly.
export function createArtifactAccess({ fetchMetadata = fetch, openPath, showItemInFolder }) {
  const registered = new Map();
  function grantFor(event) {
    const grant = registered.get(event.sender);
    return grant && event.senderFrame === event.sender.mainFrame
      && isAppPage(event.senderFrame?.url, grant.base) ? grant : null;
  }
  return {
    register(contents, base) {
      registered.set(contents, { base });
      contents.once("destroyed", () => registered.delete(contents));
    },
    async open(event, request) {
      const grant = grantFor(event);
      if (!grant) throw new Error("AgentHub 화면에서 파일을 열어 주세요.");
      if (!request || !["open", "reveal"].includes(request.action)
        || typeof request.sessionId !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(request.sessionId)
        || typeof request.path !== "string" || !request.path.trim() || request.path.length > 32768 || request.path.includes("\0")) {
        throw new Error("올바른 파일 참조가 아닙니다.");
      }
      const endpoint = new URL(`/api/sessions/${encodeURIComponent(request.sessionId)}/artifact`, grant.base);
      endpoint.searchParams.set("path", request.path);
      const response = await fetchMetadata(endpoint.href, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("파일을 찾을 수 없거나 이 세션에서 접근할 수 없습니다.");
      const artifact = await response.json();
      if (grantFor(event) !== grant) throw new Error("파일을 여는 동안 화면이 바뀌었습니다. 다시 눌러 주세요.");
      if (!artifact || typeof artifact.path !== "string" || !path.isAbsolute(artifact.path)
        || artifact.path.includes("\0") || !ARTIFACT_KINDS.has(artifact.kind)) {
        throw new Error("서버가 확인한 파일 경로가 올바르지 않습니다.");
      }
      if (request.action === "reveal") {
        await showItemInFolder(artifact.path);
      } else {
        if (!OPEN_EXTENSIONS.has(path.extname(artifact.path).toLowerCase())) throw new Error("이 파일 형식은 위치 보기로 확인해 주세요.");
        const error = await openPath(artifact.path);
        if (error) throw new Error("파일을 열 수 없습니다. 위치 보기로 확인해 주세요.");
      }
      return { ok: true };
    },
  };
}
