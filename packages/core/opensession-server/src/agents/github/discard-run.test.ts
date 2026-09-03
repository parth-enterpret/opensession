/**
 * A discard must stop exactly the host it is discarding.
 *
 * `bksIdFor` is deterministic, so cancelling a superseded run by its session id
 * cancels every run for that PR + kind — including one that started while the
 * discard was in flight. On 2026-09-03 a review on PR #3 was discarded, and the
 * replacement host launched one second later by the same repair path was killed
 * before it emitted an event ("cancel requested" / "run ended: no-terminal"),
 * leaving "⚠️ Review run errored" on a PR whose diff was never read.
 */
import { expect, test } from "bun:test";
import { bksIdFor, discardGithubRunRecord } from "./run";
import type { ActiveRunRecord } from "../../server/run-journal";
import type { StreamEvent } from "../../server/run-events";

const BKS = bksIdFor(3, "review");

function hostedRun(hostId: string): ActiveRunRecord {
  return {
    runKey: hostId,
    hostId,
    osSessionId: BKS,
    claudeSessionId: "ses_shared_engine",
    prompt: "review",
    cwd: "/tmp/nowhere",
    mode: "ask",
    kind: "github-review",
    startedAt: "2026-09-03T16:21:08.000Z",
  } as ActiveRunRecord;
}

/** A host that reattaches and immediately ends, as a superseded one does. */
async function* ended(): AsyncGenerator<StreamEvent> {}

test("discarding a superseded host cancels that host and nothing else", async () => {
  const superseded = hostedRun("rh-0000-f814");
  const cancelled: string[] = [];

  await discardGithubRunRecord(superseded, {
    resume: async () => ended(),
    cancel: async (token) => void cancelled.push(token),
  });

  expect(cancelled).toEqual(["rh-0000-f814"]);
  // The two ids that reach every run on the PR, not just this one: the
  // deterministic session id, and an engine session a successor can resume.
  expect(cancelled).not.toContain(BKS);
  expect(cancelled).not.toContain("ses_shared_engine");
});

test("the cancel is settled before the discard returns", async () => {
  // A floated cancel outlives its discard and lands on the next run to claim
  // the PR — which is how the replacement host died a second after attaching.
  let pending = true;
  await discardGithubRunRecord(hostedRun("rh-0000-fdbc"), {
    resume: async () => ended(),
    cancel: async () => {
      await Bun.sleep(5);
      pending = false;
    },
  });
  expect(pending).toBe(false);
});

test("an unproven host is left alone rather than cancelled", async () => {
  const cancelled: string[] = [];
  await expect(
    discardGithubRunRecord(hostedRun("rh-0000-abcd"), {
      resume: async () => "uncertain" as const,
      cancel: async (token) => void cancelled.push(token),
    }),
  ).rejects.toThrow(/not connectable but is not proven dead/);
  expect(cancelled).toEqual([]);
});
