import { HttpError } from "../../application/errors.mjs";
import { checkFigcraft, listFigcraftCommands, figcraftPreview, openInFigcraft } from "../../figcraft.mjs";
import { sendFileRange } from "../../session-artifacts.mjs";

// FigCraft CLI 설정·명령 찾기, 대화 속 .figcraft 파일 미리보기와 앱으로 열기
export function figcraftRoutes(settings, sessions) {
  const guard = async (run) => { try { return await run(); } catch (error) { throw error instanceof HttpError ? error : new HttpError(400, error.message); } };
  // 세션에서 열 수 있는 .figcraft 파일인지 확인한다(세션 파일 열기와 같은 규칙).
  const design = (id, file) => {
    const item = sessions.artifact(id, file);
    if (item.kind !== "figcraft") throw new HttpError(415, "FigCraft 파일(.figcraft)만 미리 볼 수 있습니다.");
    return item.path;
  };
  return [
    ["GET", "figcraft", () => settings.view()],
    ["PUT", "figcraft", ({ body }) => guard(() => settings.set(body))],
    ["POST", "figcraft/check", async () => {
      try { return { ok: true, message: await checkFigcraft(settings) }; }
      catch (error) { return { ok: false, message: error.message }; }
    }],
    ["GET", "figcraft/commands", ({ query }) => guard(() => listFigcraftCommands(settings, query.get("filter") ?? ""))],
    ["GET", "sessions/:id/artifact/figcraft-preview", async ({ params, query, req, res }) => {
      const file = design(params.id, query.get("path"));
      const png = await guard(() => figcraftPreview(settings, file));
      return sendFileRange(req, res, png, { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    }],
    ["POST", "sessions/:id/artifact/figcraft-open", ({ params, body }) => guard(() => openInFigcraft(settings, design(params.id, body.path)))],
  ];
}
