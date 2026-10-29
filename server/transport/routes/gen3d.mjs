import { HttpError } from "../../application/errors.mjs";
import { GEN3D_STEPS, GEN3D_PRESETS, GEN3D_FORMATS, checkGen3dProvider, loginGen3dProvider } from "../../gen3d.mjs";

// 3D 생성 도구(Meshy·Tripo) 설정. 키는 저장만 하고 돌려주지 않는다.
export function gen3dRoutes(keys) {
  const guard = (run) => { try { return run(); } catch (error) { throw new HttpError(400, error.message); } };
  return [
    ["GET", "gen3d", () => ({ providers: keys.list(), steps: GEN3D_STEPS, presets: GEN3D_PRESETS, formats: GEN3D_FORMATS })],
    ["PUT", "gen3d/:id", ({ params, body }) => guard(() => keys.set(params.id, body))],
    ["POST", "gen3d/:id/login", ({ params }) => guard(() => ({ message: loginGen3dProvider(params.id, keys) }))],
    ["POST", "gen3d/:id/check", async ({ params }) => {
      try { return { ok: true, message: await checkGen3dProvider(params.id, keys) }; }
      catch (error) { return { ok: false, message: error.message }; }
    }],
  ];
}
