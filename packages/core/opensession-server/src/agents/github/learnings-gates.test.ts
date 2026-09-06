import { describe, expect, test } from "bun:test";
import {
  decideStatus, gateConsistent, gateReplay, gateSupported, gateWellFormed,
  runStaticGates, selectForPrompt, MAX_ACTIVE, MIN_EFFECT, STALE_AFTER_MS,
  type Learning, type LearningEffect,
} from "./learnings-gates";

const learning = (over: Partial<Learning> = {}): Learning => ({
  id: "l1",
  text: "Stop flagging missing null checks on values the ReScript type system proves non-null.",
  kind: "calibration",
  domain: "review",
  scope: "backend",
  status: "proposed",
  provenance: { signals: 5, prs: [1, 2, 3], createdAt: new Date().toISOString(), sources: ["dismissed"] },
  gates: [],
  ...over,
});

describe("well-formed", () => {
  test("accepts an imperative rule that names a condition", () => {
    expect(gateWellFormed(learning().text).status).toBe("pass");
  });

  test("rejects text too short to be specific", () => {
    expect(gateWellFormed("Be better.").status).toBe("fail");
  });

  test("rejects a paragraph", () => {
    expect(gateWellFormed("x".repeat(400)).status).toBe("fail");
  });

  test("rejects a question, which cannot be followed", () => {
    expect(gateWellFormed("Should we be flagging unused imports in test files?").status).toBe("fail");
  });

  test("rejects hedged wording", () => {
    // "consider" and its relatives describe a disposition, not an action, and a
    // rule that cannot be followed cannot be measured either.
    for (const t of [
      "Consider whether the null check on session.user is really needed here always.",
      "Maybe stop reporting unused imports inside the generated client directory.",
      "Generally avoid flagging style issues in the vendored parser directory tree.",
    ]) {
      expect(gateWellFormed(t).status).toBe("fail");
    }
  });

  test("rejects a rule that names nothing concrete", () => {
    // Applies to everything, so it changes nothing and cannot be replayed.
    expect(gateWellFormed("Do not report issues that are not very important to us").status).toBe("fail");
  });
});

describe("supported — the anti-anecdote gate", () => {
  test("accepts several signals across several pull requests", () => {
    expect(gateSupported(learning().provenance).status).toBe("pass");
  });

  test("rejects too few signals", () => {
    const p = { ...learning().provenance, signals: 1, prs: [7] };
    expect(gateSupported(p).status).toBe("fail");
  });

  test("rejects many signals that are all one incident", () => {
    // Three comments on one pull request is one engineer having one opinion on
    // one afternoon. This is what over-generalisation looks like from inside.
    const p = { ...learning().provenance, signals: 6, prs: [42, 42, 42] };
    const r = gateSupported(p);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("one incident");
  });
});

describe("consistent", () => {
  const active = [learning({ id: "a1", kind: "focus", text: "Check for missing null checks on ReScript option values before use." })];

  test("rejects a calibration that opposes an active focus on the same subject", () => {
    // "stop flagging X" beside "check for X" cannot both be followed.
    const r = gateConsistent(learning({ id: "new" }), active);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("a1");
  });

  test("allows an unrelated learning", () => {
    const other = learning({ id: "new", text: "Check that every added GraphQL field appears in the fragment its consumer reads." });
    expect(gateConsistent(other, active).status).toBe("pass");
  });

  test("allows the same claim in a different repo scope", () => {
    // Narrow scope is the defence against one repo's convention becoming law.
    const elsewhere = learning({ id: "new", scope: "frontend" });
    expect(gateConsistent(elsewhere, active.map((a) => ({ ...a, scope: "backend" }))).status).toBe("pass");
  });

  test("does not compare a learning with itself", () => {
    const self = learning({ id: "a1", kind: "calibration" });
    expect(gateConsistent(self, [self]).status).toBe("pass");
  });
});

describe("replay — the gate that costs money", () => {
  const eff = (before: number, after: number): LearningEffect =>
    ({ metric: "recall", before, after, cases: 18, at: new Date().toISOString() });

  test("passes on a real improvement", () => {
    expect(gateReplay(eff(0.52, 0.58)).status).toBe("pass");
  });

  test("fails on a regression", () => {
    const r = gateReplay(eff(0.55, 0.45));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("fell");
  });

  test("a movement inside noise is a skip, not a pass", () => {
    // Our own configuration arms differed by one finding in 44, so a change
    // smaller than that cannot be attributed to a single learning.
    expect(gateReplay(eff(0.52, 0.52 + MIN_EFFECT / 2)).status).toBe("skip");
  });

  test("never measured is a skip, not a fail", () => {
    // "not yet measured" and "measured and useless" are different states, and
    // only the second should block a learning forever.
    expect(gateReplay(undefined).status).toBe("skip");
  });
});

describe("decideStatus", () => {
  const t0 = Date.now();

  test("a clean static run with no replay sits in shadow, not active", () => {
    // Shadow is the CI stage: it exists, it is measured, it changes nothing.
    const gates = runStaticGates(learning(), []);
    const d = decideStatus(learning(), [...gates, gateReplay(undefined)], t0);
    expect(d.status).toBe("shadow");
  });

  test("a passing replay promotes to active", () => {
    const gates = runStaticGates(learning(), []);
    const replay = gateReplay({ metric: "recall", before: 0.5, after: 0.6, cases: 18, at: "" });
    expect(decideStatus(learning(), [...gates, replay], t0).status).toBe("active");
  });

  test("any failed gate demotes, and the reason names the gate", () => {
    const bad = learning({ text: "Be better." });
    const d = decideStatus(bad, runStaticGates(bad, []), t0);
    expect(d.status).toBe("demoted");
    expect(d.reason).toContain("well-formed");
  });

  test("a learning with no supporting signal for long enough retires", () => {
    const old = new Date(t0 - STALE_AFTER_MS - 1000).toISOString();
    const stale = learning({ lastSupportedAt: old });
    const d = decideStatus(stale, runStaticGates(stale, []), t0);
    expect(d.status).toBe("retired");
    expect(d.reason).toContain("days");
  });

  test("a failed gate outranks staleness, so the reason is the useful one", () => {
    const bad = learning({ text: "Be better.", lastSupportedAt: new Date(t0 - STALE_AFTER_MS - 1).toISOString() });
    expect(decideStatus(bad, runStaticGates(bad, []), t0).reason).toContain("well-formed");
  });
});

describe("selectForPrompt", () => {
  const mk = (id: string, over: Partial<Learning> = {}) =>
    learning({ id, status: "active", ...over });

  test("only active learnings reach a prompt", () => {
    const all = [mk("a"), learning({ id: "b", status: "shadow" }), learning({ id: "c", status: "demoted" })];
    expect(selectForPrompt(all, "review", "backend").map((l) => l.id)).toEqual(["a"]);
  });

  test("scope is respected, and a global learning applies everywhere", () => {
    const all = [mk("mine"), mk("other", { scope: "frontend" }), mk("global", { scope: "*" })];
    expect(selectForPrompt(all, "review", "backend").map((l) => l.id).sort()).toEqual(["global", "mine"]);
  });

  test("a different domain is excluded", () => {
    expect(selectForPrompt([mk("x", { domain: "triage" })], "review", "backend")).toEqual([]);
  });

  test("the cap trims what earned least, not what arrived last", () => {
    const many = Array.from({ length: MAX_ACTIVE + 5 }, (_u, i) =>
      mk(`l${i}`, { effect: { metric: "recall", before: 0.5, after: 0.5 + i / 100, cases: 18, at: "" } }));
    const chosen = selectForPrompt(many, "review", "backend");
    expect(chosen).toHaveLength(MAX_ACTIVE);
    // Highest measured effect first, so the trimmed tail is the weakest.
    expect(chosen[0]!.id).toBe(`l${MAX_ACTIVE + 4}`);
  });

  test("an unmeasured learning ranks below a measured winner", () => {
    const all = [
      mk("measured", { effect: { metric: "recall", before: 0.5, after: 0.6, cases: 18, at: "" } }),
      mk("unmeasured"),
    ];
    expect(selectForPrompt(all, "review", "backend")[0]!.id).toBe("measured");
  });

  test("an empty store yields nothing rather than throwing", () => {
    expect(selectForPrompt([], "review", "backend")).toEqual([]);
  });
});
