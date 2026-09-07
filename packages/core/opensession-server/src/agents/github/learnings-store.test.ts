import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Learning } from "./learnings-gates";

// The store writes under stateDir("github"), so point HOME at a scratch dir
// before the module is imported and its STATE_DIR constant is resolved.
const scratch = mkdtempSync(join(tmpdir(), "learnings-"));
process.env.HOME = scratch;
process.env.OPENSESSION_STATE_DIR = scratch;

const {
  readLearnings, recordEffect, learningsSection, learningsReport,
  pendingReplay, revalidate,
} = await import("./learnings");
const { STALE_AFTER_MS } = await import("./learnings-gates");

const { writeFileSync, mkdirSync } = await import("fs");
const { stateDir } = await import("../../server/paths");
// Ask the module where it actually writes rather than guessing the layout —
// a test that seeds the wrong path passes an empty store and proves nothing.
const storeFile = () => join(stateDir("github"), "learnings-default.json");

const learning = (over: Partial<Learning> = {}): Learning => ({
  id: "L1",
  text: "Stop flagging missing null checks on values the ReScript type system proves non-null.",
  kind: "calibration",
  domain: "review",
  scope: "default",
  status: "shadow",
  provenance: { signals: 5, prs: [1, 2, 3], createdAt: new Date().toISOString(), sources: ["dismissed"] },
  gates: [],
  lastSupportedAt: new Date().toISOString(),
  ...over,
});

function seed(learnings: Learning[]) {
  const f = storeFile();
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify({ updatedAt: new Date().toISOString(), signalCount: 10, learnings }));
}

beforeEach(() => { try { rmSync(storeFile()); } catch { /* first run */ } });

describe("what reaches a prompt", () => {
  test("a shadow learning is stored and NOT shown to the agent", () => {
    // The whole point of the design: a learning exists and is measured before
    // it is allowed to change behaviour.
    seed([learning({ status: "shadow" })]);
    expect(readLearnings().learnings).toHaveLength(1);
    expect(learningsSection()).toBe("");
  });

  test("an active learning is shown, with its measurement", () => {
    seed([learning({ status: "active", effect: { metric: "recall", before: 0.5, after: 0.6, cases: 18, at: "" } })]);
    const s = learningsSection();
    expect(s).toContain("Stop flagging missing null checks");
    expect(s).toContain("measured");
    expect(s).toContain("18 cases");
  });

  test("a demoted learning is not shown", () => {
    seed([learning({ status: "demoted" })]);
    expect(learningsSection()).toBe("");
  });

  test("an empty store yields no section rather than an empty heading", () => {
    expect(learningsSection()).toBe("");
  });

  test("a corrupt store degrades to no learnings, not a crash", () => {
    // A broken file must not take the review down with it. Behaving as though
    // nothing was ever learned is the safe failure.
    const f = storeFile();
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, "{ not json");
    expect(readLearnings().learnings).toEqual([]);
    expect(learningsSection()).toBe("");
  });
});

describe("recordEffect is the only route to active", () => {
  test("a positive replay promotes shadow to active", () => {
    seed([learning({ status: "shadow" })]);
    const l = recordEffect("L1", { metric: "recall", before: 0.50, after: 0.58, cases: 18, at: "" });
    expect(l?.status).toBe("active");
    expect(learningsSection()).toContain("Stop flagging");
  });

  test("a regression demotes it, and it never reaches a prompt", () => {
    seed([learning({ status: "shadow" })]);
    const l = recordEffect("L1", { metric: "recall", before: 0.55, after: 0.42, cases: 18, at: "" });
    expect(l?.status).toBe("demoted");
    expect(learningsSection()).toBe("");
  });

  test("a movement inside the noise floor leaves it in shadow", () => {
    // Promoting on a rounding error is how a store fills with rules that do
    // nothing, each of which costs prompt budget on every run.
    seed([learning({ status: "shadow" })]);
    expect(recordEffect("L1", { metric: "recall", before: 0.520, after: 0.525, cases: 18, at: "" })?.status).toBe("shadow");
  });

  test("an unknown id returns null rather than writing a new record", () => {
    seed([learning()]);
    expect(recordEffect("nope", { metric: "recall", before: 0, after: 1, cases: 4, at: "" })).toBeNull();
    expect(readLearnings().learnings).toHaveLength(1);
  });

  test("the effect survives a round trip to disk", () => {
    seed([learning({ status: "shadow" })]);
    recordEffect("L1", { metric: "recall", before: 0.5, after: 0.6, cases: 18, at: "" });
    expect(readLearnings().learnings[0]!.effect?.after).toBe(0.6);
  });
});

describe("pendingReplay", () => {
  test("lists shadow learnings that have never been measured", () => {
    seed([
      learning({ id: "a", status: "shadow" }),
      learning({ id: "b", status: "active", effect: { metric: "recall", before: 0.5, after: 0.6, cases: 9, at: "" } }),
      learning({ id: "c", status: "demoted" }),
    ]);
    expect(pendingReplay().map((l) => l.id)).toEqual(["a"]);
  });

  test("a measured shadow learning is not re-queued", () => {
    // It moved the metric by less than the noise floor over a run big enough to
    // say so. Measuring it again spends an evaluation run to learn the same thing.
    seed([learning({ status: "shadow", effect: { metric: "recall", before: 0.5, after: 0.501, cases: 18, at: "" } })]);
    expect(pendingReplay()).toEqual([]);
  });

  test("a null result on too few cases IS re-queued", () => {
    // The counterpart to the test above, and the reason it names a case count.
    // Our first live replay went 9/13 to 9/13 over four cases. Treating that as
    // a verdict leaves the learning in shadow forever, and shadow never reaches
    // a prompt — the learning would be neither used nor ever re-examined.
    seed([learning({ status: "shadow", effect: { metric: "recall", before: 0.6923, after: 0.6923, cases: 4, at: "" } })]);
    expect(pendingReplay().map((l) => l.id)).toEqual(["L1"]);
  });

  test("a demoted learning is never re-queued, however small the run", () => {
    seed([learning({ status: "demoted", effect: { metric: "recall", before: 0.55, after: 0.40, cases: 2, at: "" } })]);
    expect(pendingReplay()).toEqual([]);
  });
});

describe("revalidate", () => {
  test("retires a learning nothing has supported for long enough", () => {
    const old = new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString();
    seed([learning({ status: "active", lastSupportedAt: old, effect: { metric: "recall", before: 0.5, after: 0.6, cases: 9, at: "" } })]);
    expect(revalidate().changed).toBe(1);
    expect(readLearnings().learnings[0]!.status).toBe("retired");
  });

  test("leaves a healthy store alone", () => {
    seed([learning({ status: "active", effect: { metric: "recall", before: 0.5, after: 0.6, cases: 9, at: "" } })]);
    expect(revalidate().changed).toBe(0);
  });

  test("demotes an active learning that a newer active one contradicts", () => {
    const eff = { metric: "recall", before: 0.5, after: 0.6, cases: 9, at: "" };
    seed([
      learning({ id: "stop", status: "active", kind: "calibration", effect: eff }),
      learning({ id: "start", status: "active", kind: "focus", effect: eff,
                 text: "Check for missing null checks on ReScript option values before dereferencing them." }),
    ]);
    revalidate();
    const statuses = readLearnings().learnings.map((l) => l.status);
    // They cannot both be followed, so at least one must stop being live.
    expect(statuses).toContain("demoted");
  });
});

describe("learningsReport", () => {
  test("says why a learning is blocked", () => {
    seed([learning({
      status: "demoted",
      gates: [{ gate: "supported", status: "fail", detail: "all 6 signals from 1 pull request — one incident, not a pattern", at: "" }],
    })]);
    const r = learningsReport();
    expect(r).toContain("demoted");
    expect(r).toContain("one incident");
  });

  test("reports an empty store plainly", () => {
    expect(learningsReport()).toContain("No learnings recorded yet");
  });

  test("shows evidence and replay for an active learning", () => {
    seed([learning({ status: "active", effect: { metric: "recall", before: 0.5, after: 0.6, cases: 18, at: "" } })]);
    const r = learningsReport();
    expect(r).toContain("5 signals across 3 PRs");
    expect(r).toContain("recall 0.5 -> 0.6 over 18 cases");
  });
});
