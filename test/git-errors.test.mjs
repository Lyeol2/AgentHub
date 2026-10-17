import test from "node:test";
import assert from "node:assert/strict";
import { translateGitError, gitErrorDetails } from "../server/git-errors.mjs";

const SAMPLES = {
  "git-push-rejected": [
    "To https://github.com/o/r.git\n ! [rejected]        feature/x -> feature/x (fetch first)\nerror: failed to push some refs to 'https://github.com/o/r.git'\nhint: Updates were rejected because the remote contains work that you do not have locally.",
    " ! [rejected]        main -> main (non-fast-forward)",
  ],
  "git-push-protected": [
    "remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)",
  ],
  "git-conflict": [
    "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.",
    "error: Pulling is not possible because you have unmerged files.",
  ],
  "git-dirty": [
    "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.\nAborting",
    "error: The following untracked working tree files would be overwritten by merge:\n\tb.txt",
  ],
  "git-locked": [
    "fatal: Unable to create 'E:/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
  ],
  "git-diverged": [
    "hint: Diverging branches can't be fast-forwarded, you need to either:\nfatal: Not possible to fast-forward, aborting.",
  ],
  "git-no-upstream": [
    "There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.",
  ],
  "git-network": [
    "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
  ],
  "git-auth": [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
  ],
  "git-auth-ssh": [
    "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
  ],
};

test("git 오류 변환: 자주 나는 오류 원문을 한국어 설명과 해결 방법으로 바꾼다", () => {
  for (const [reason, samples] of Object.entries(SAMPLES)) {
    for (const sample of samples) {
      const result = translateGitError(sample);
      assert.equal(result?.reason, reason, sample);
      assert.match(result.message, /[가-힣]/, `${reason} 메시지`);
      if (!reason.startsWith("git-auth")) assert.match(result.hint, /[가-힣]/, `${reason} 해결 방법`);
    }
  }
});

test("git 오류 변환: 인증 실패는 푸시 거부 문구와 함께 나와도 인증을 먼저 안내한다", () => {
  const text = "fatal: Authentication failed for 'https://github.com/o/r.git/'\nerror: failed to push some refs";
  assert.equal(translateGitError(text).reason, "git-auth");
  assert.equal(translateGitError(text).status, 401);
});

test("git 오류 변환: 모르는 오류는 바꾸지 않고, 바꾼 오류는 원문을 남긴다", () => {
  assert.equal(translateGitError("fatal: bad revision 'nope'"), null);
  assert.equal(translateGitError(""), null);
  const details = gitErrorDetails(" ! [rejected] main -> main (non-fast-forward) ");
  assert.equal(details.reason, "git-push-rejected");
  assert.equal(details.raw, "! [rejected] main -> main (non-fast-forward)");
});
