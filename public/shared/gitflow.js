// 작업 유형별 분기 기준·PR 대상·역반영 브랜치. 서버의 server/gitflow-settings.mjs와 같은 규칙이다.
export const DEFAULT_GITFLOW = Object.freeze({ main: 'main', develop: 'develop', featurePrefix: 'feature/', hotfixPrefix: 'hotfix/', releasePrefix: 'release/' });

export function gitflowBranches(type, settings = DEFAULT_GITFLOW) {
  const flow = { ...DEFAULT_GITFLOW, ...settings };
  return {
    prefix: flow[`${type}Prefix`] ?? `${type}/`,
    base: type === 'hotfix' ? flow.main : flow.develop,
    target: type === 'feature' ? flow.develop : flow.main,
    backMerge: type === 'feature' ? null : flow.develop,
  };
}
