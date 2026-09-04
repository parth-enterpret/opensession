import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

// state.ts resolves its dir once at import, so point the state root at a scratch
// dir BEFORE importing it and put the env back for everyone else.
const SCRATCH = mkdtempSync(join(tmpdir(), "gh-pr-state-"));
const savedRoot = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = SCRATCH;
const {
  activeRunCancellationRequested,
  getOrInitPrState,
  normalizePrState,
  readPrState,
  recordReviewed,
  requestActiveRunCancellation,
  setPendingMention,
  updatePrState,
} = await import("./state");
if (savedRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
else process.env.OPENSESSION_STATE_DIR = savedRoot;

const PR = 990101;
const HEAD = "some-feature-branch";

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  // Another test file in the same run may have imported state.ts first, pinning
  // it to the real root before the env override above. Sweep the fake PRs from
  // every root it could have resolved to, so no run leaves state behind.
  for (const root of [SCRATCH, savedRoot, process.env.HOME, homedir()]) {
    if (!root) continue;
    for (const pr of [PR, PR + 1, PR + 2])
      rmSync(`${root}/.opensession-github/${pr}.json`, { force: true });
  }
});

function pendingMention(commentId: number) {
  return {
    kind: "issue" as const,
    commentId,
    body: "@bot please look at this",
    author: "someone",
    receivedAt: new Date().toISOString(),
  };
}

describe("concurrent writers on one PR's state", () => {
  // Reviews and code actions hold DIFFERENT locks by design, so their windows
  // overlap: a mention webhook lands while a review is awaiting network work.
  test("a review-lane commit keeps a mention marker that landed mid-flight", () => {
    // The review's early read, taken before its (slow) model run.
    const snapshot = getOrInitPrState(PR, HEAD);
    updatePrState(PR, HEAD, (s) => { s.summaryCommentId = 11; });

    // A mention webhook arrives while the review is still awaiting.
    setPendingMention(PR, pendingMention(7));

    // The review's commit point, after the await.
    recordReviewed(PR, HEAD, "bbbbbbb", {
      verdict: "comment",
      confidence: 4,
      findings: 2,
      blocking: 0,
      sha: "bbbbbbb",
      at: new Date().toISOString(),
    });

    const after = readPrState(PR)!;
    // pendingMention exists to survive a crash in exactly this window; writing a
    // pre-await snapshot back would have reverted it.
    expect(after.pendingMention?.commentId).toBe(7);
    expect(after.lastReviewedSha).toBe("bbbbbbb");
    expect(after.reviewedShas).toContain("bbbbbbb");
    expect(after.summaryCommentId).toBe(11);
    // The snapshot the review started from never saw the mention.
    expect(snapshot.pendingMention).toBeUndefined();
  });

  test("a code-lane commit keeps the review verdict written during its run", () => {
    const pr = PR + 1;
    updatePrState(pr, HEAD, (s) => {
      s.autoFix = { active: true, iterations: 1, startedAt: new Date().toISOString() };
    });

    // The review lane records its verdict while the auto-fix loop is running.
    recordReviewed(pr, HEAD, "ccccccc", {
      findings: 0,
      blocking: 0,
      sha: "ccccccc",
      at: new Date().toISOString(),
    });

    // The loop's own locals win for its own fields, and nothing else is touched.
    updatePrState(pr, HEAD, (s) => {
      if (s.autoFix) { s.autoFix.active = false; s.autoFix.iterations = 3; s.autoFix.lastPushedSha = "ddddddd"; }
    });

    const after = readPrState(pr)!;
    expect(after.autoFix).toMatchObject({ active: false, iterations: 3, lastPushedSha: "ddddddd" });
    expect(after.lastReview?.sha).toBe("ccccccc");
    expect(after.lastReviewedSha).toBe("ccccccc");
  });

  test("a review cancellation is durable and kind-scoped", () => {
    const pr = PR + 2;
    updatePrState(pr, HEAD, (s) => {
      s.activeRun = {
        kind: "review",
        requestedBy: "Kent",
        startedAt: new Date().toISOString(),
      };
    });

    expect(requestActiveRunCancellation(pr, HEAD, "review")).toBe(true);
    expect(activeRunCancellationRequested(pr, "review")).toBe(true);
    expect(requestActiveRunCancellation(pr, HEAD, "simplify")).toBe(false);
    expect(readPrState(pr)?.activeRun?.cancelRequestedAt).toBeTruthy();
  });
});

describe("a malformed state object cannot take the server down", () => {
  // The shape that crashed the deployed server: a state file whose reviewed-SHA
  // list was gone. `.includes` on undefined threw out of runReview, nothing
  // caught it, and the process exited 1 — reviews down for every repo, with
  // Restart=always masking it as runs that silently never started.
  test("a missing reviewedShas becomes an empty array", () => {
    expect(normalizePrState({ prNumber: 1, headRef: "x" } as never).reviewedShas).toEqual([]);
  });

  test("a non-array reviewedShas becomes an empty array", () => {
    const s = { prNumber: 1, headRef: "x", reviewedShas: "nope" } as never;
    expect(normalizePrState(s).reviewedShas).toEqual([]);
  });

  test("a good list is left exactly as it is", () => {
    const s = { prNumber: 1, headRef: "x", reviewedShas: ["abc"] } as never;
    expect(normalizePrState(s).reviewedShas).toEqual(["abc"]);
  });
});
