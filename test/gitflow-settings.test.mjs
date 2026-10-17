import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GITFLOW_SETTINGS, normalizeGitflowSettings, projectGitflowSettings, gitflowSettingsKey, gitflowBranches } from "../server/gitflow-settings.mjs";
import { DEFAULT_GITFLOW, gitflowBranches as clientGitflowBranches } from "../public/shared/gitflow.js";

test("GitFlow 설정: 기존 프로젝트는 기본 이름을 쓰고 대소문자와 접두어 입력을 보존한다", () => {
  assert.deepEqual(projectGitflowSettings({}, "C:/fixture"), DEFAULT_GITFLOW_SETTINGS);
  const settings = normalizeGitflowSettings({ main: " Main ", develop: "Develop", featurePrefix: "Feature", hotfixPrefix: "Fix/", releasePrefix: "Release/" });
  assert.deepEqual(settings, { main: "Main", develop: "Develop", featurePrefix: "Feature/", hotfixPrefix: "Fix/", releasePrefix: "Release/" });
  const config = { gitflow: { [gitflowSettingsKey("C:/fixture")]: settings } };
  assert.deepEqual(projectGitflowSettings(config, "C:/fixture"), settings);
  assert.deepEqual(projectGitflowSettings(config, "C:/another"), DEFAULT_GITFLOW_SETTINGS);
});

test("GitFlow 설정: 빈 이름·잘못된 타입·같은 기준 브랜치를 저장하지 않는다", () => {
  for (const value of [null, [], { develop: " " }, { main: 1 }, { featurePrefix: "" }, { main: "Develop", develop: "develop" }]) {
    assert.throws(() => normalizeGitflowSettings(value), (error) => error.status === 400 && error.reason === "gitflow-settings");
  }
  assert.throws(() => gitflowSettingsKey(""), (error) => error.status === 400);
});

test("GitFlow 설정: 유형별 분기 기준과 PR 대상이 설정을 따르고 서버와 화면이 같다", () => {
  assert.deepEqual({ ...DEFAULT_GITFLOW }, { ...DEFAULT_GITFLOW_SETTINGS });
  const custom = normalizeGitflowSettings({ main: "Main", develop: "Develop", featurePrefix: "Feature/", hotfixPrefix: "Fix/", releasePrefix: "Rel/" });
  const expected = {
    default: {
      feature: { prefix: "feature/", base: "develop", target: "develop", backMerge: null },
      hotfix: { prefix: "hotfix/", base: "main", target: "main", backMerge: "develop" },
      release: { prefix: "release/", base: "develop", target: "main", backMerge: "develop" },
    },
    custom: {
      feature: { prefix: "Feature/", base: "Develop", target: "Develop", backMerge: null },
      hotfix: { prefix: "Fix/", base: "Main", target: "Main", backMerge: "Develop" },
      release: { prefix: "Rel/", base: "Develop", target: "Main", backMerge: "Develop" },
    },
  };
  for (const [name, settings] of [["default", DEFAULT_GITFLOW_SETTINGS], ["custom", custom]]) {
    for (const type of ["feature", "hotfix", "release"]) {
      assert.deepEqual(gitflowBranches(type, settings), expected[name][type], `${name} ${type}`);
      assert.deepEqual(clientGitflowBranches(type, settings), expected[name][type], `${name} ${type} 화면`);
    }
  }
});
