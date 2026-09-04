import { describe, expect, test } from "bun:test";
import {
  assembleReview,
  changedFilesFromPatch,
  dedupeFindings,
  FANOUT,
  HYPOTHESIS,
  planHypothesisBatches,
  planReviewBatches,
  planVerifications,
  VERIFY,
} from "./review-fanout";
import { buildReviewPrompt, buildVerifyPrompt } from "./prompts";
import {
  isCompleteReviewOutput,
  parseHypotheses,
  parseReviewOutput,
  parseVerifyOutput,
} from "./review";
import type { Finding } from "./review";
import type { PrDetails } from "../../server/pr-info";

/** One file's worth of unified diff with `changed` added lines. */
function fileDiff(path: string, changed = 2): string {
  const body = Array.from({ length: changed }, (_, i) => `+line ${i}`).join("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,5 @@",
    " context",
    body,
    " context",
  ].join("\n");
}

const patchOf = (files: Array<[string, number]>): string =>
  files.map(([p, n]) => fileDiff(p, n)).join("\n");

describe("changed files from a patch", () => {
  test("reads paths and churn, ignoring headers and context", () => {
    expect(changedFilesFromPatch(patchOf([["src/a.ts", 3], ["src/b.ts", 1]]))).toEqual([
      { path: "src/a.ts", lines: 3 },
      { path: "src/b.ts", lines: 1 },
    ]);
  });

  test("unquotes paths with spaces and skips deletions", () => {
    const patch = [
      'diff --git a/has space.ts b/has space.ts',
      '--- a/has space.ts',
      '+++ "b/has space.ts"',
      "@@ -1 +1,2 @@",
      "+added",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-was here",
    ].join("\n");
    expect(changedFilesFromPatch(patch)).toEqual([{ path: "has space.ts", lines: 1 }]);
  });

  test("counts a removed line whose content starts with dashes", () => {
    const patch = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1,2 +1,2 @@",
      "--- old front matter",
      "+++ new front matter",
    ].join("\n");
    expect(changedFilesFromPatch(patch)).toEqual([{ path: "x.md", lines: 2 }]);
  });
});

describe("batch planning", () => {
  test("a small PR stays single-pass", () => {
    // hello-world-backend#3 shape: the existing one-shot path reviews it correctly in ~18s.
    expect(planReviewBatches(patchOf([["a.ts", 5], ["b.ts", 5]]))).toEqual([]);
    const four = patchOf([["a.ts", 5], ["b.ts", 5], ["c.ts", 5], ["d.ts", 5]]);
    expect(changedFilesFromPatch(four)).toHaveLength(FANOUT.minFiles - 1);
    expect(planReviewBatches(four)).toEqual([]);
  });

  test("fans a real PR out at one file per batch", () => {
    // enterpret-showcase#12182: 34 files, ~2,015 lines. Every file is covered
    // exactly once and the run stays inside the batch ceiling — which is what
    // keeps a review inside one account-hour (see FANOUT's cost note).
    const files: Array<[string, number]> = Array.from({ length: 34 }, (_, i) => [
      `src/f${i}.ts`,
      59,
    ]);
    const batches = planReviewBatches(patchOf(files));
    expect(batches.length).toBeLessThanOrEqual(FANOUT.maxBatches);
    expect(batches.flatMap((b) => b.files)).toHaveLength(34);
    expect(new Set(batches.flatMap((b) => b.files)).size).toBe(34);
  });

  test("a big file does not drag its whole batch over the line cap", () => {
    const batches = planReviewBatches(
      patchOf([["small.ts", 5], ["huge.ts", 900], ["next.ts", 5], ["last.ts", 5], ["x.ts", 5]]),
    );
    // The 900-line file trips linesPerBatch, so the batch closes and the files
    // after it start a new one rather than being read alongside it.
    const withHuge = batches.find((b) => b.files.includes("huge.ts"))!;
    expect(withHuge.files).toContain("huge.ts");
    expect(withHuge.files).not.toContain("last.ts");
  });

  test("the ceiling holds — a 200-file PR cannot spawn 200 runs", () => {
    const files: Array<[string, number]> = Array.from({ length: 200 }, (_, i) => [
      `src/f${i}.ts`,
      400,
    ]);
    const batches = planReviewBatches(patchOf(files));
    expect(batches.length).toBeLessThanOrEqual(FANOUT.maxBatches);
    expect(batches.flatMap((b) => b.files)).toHaveLength(200);
  });

  test("ignored paths never claim a batch slot", () => {
    const patch = patchOf([
      ["bun.lock", 4000],
      ["a.ts", 5],
      ["b.ts", 5],
      ["c.ts", 5],
      ["d.ts", 5],
      ["e.ts", 5],
    ]);
    const batches = planReviewBatches(patch, (p) => p === "bun.lock");
    expect(batches.flatMap((b) => b.files)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  });

  test("line accounting is per batch, for the per-batch wall clock", () => {
    const batches = planReviewBatches(
      patchOf([["a.ts", 10], ["b.ts", 20], ["c.ts", 30], ["d.ts", 1], ["e.ts", 1]]),
    );
    // Each batch reports the churn of exactly the files it holds.
    for (const b of batches) {
      const expected = b.files
        .map((f) => ({ "a.ts": 10, "b.ts": 20, "c.ts": 30, "d.ts": 1, "e.ts": 1 })[f]!)
        .reduce((n, x) => n + x, 0);
      expect(b.lines).toBe(expected);
    }
  });
});

describe("dedup across batches", () => {
  const f = (over: Partial<Finding>): Finding => ({
    path: "src/a.ts",
    line: 10,
    body: "When items is empty, it throws.",
    ...over,
  });

  test("the same anchor found by two batches posts once, keeping the severe copy", () => {
    const out = dedupeFindings([
      f({ severity: "P2", title: "Maybe null" }),
      f({ severity: "P1", title: "Null deref", suggestion: "guard" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("P1");
    expect(out[0]!.suggestion).toBe("guard");
  });

  test("the same claim at different lines in one file collapses too", () => {
    const out = dedupeFindings([
      f({ line: 10, title: "Null deref on empty items" }),
      f({ line: 14, title: "null   DEREF on empty items!" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.line).toBe(10);
  });

  test("distinct defects survive, and P1s sort first", () => {
    const out = dedupeFindings([
      f({ line: 10, severity: "P2", title: "Slow loop" }),
      f({ path: "src/b.ts", line: 10, severity: "P1", title: "Auth bypass" }),
      f({ line: 40, severity: "P2", title: "Wrong default" }),
    ]);
    expect(out.map((x) => x.title)).toEqual(["Auth bypass", "Slow loop", "Wrong default"]);
  });

  test("an untitled candidate dedups on its body", () => {
    expect(dedupeFindings([f({ line: 10 }), f({ line: 22 })])).toHaveLength(1);
  });

  test("nothing in, nothing out", () => {
    expect(dedupeFindings([])).toEqual([]);
  });
});

const prDetails = {
  number: 12182,
  title: "Linkify pasted URLs",
  url: "https://example.test/pr/12182",
  baseRefName: "master",
  headRefName: "feat/linkify",
  additions: 1500,
  deletions: 515,
  changedFiles: 34,
  body: "",
  author: "someone",
  comments: [],
} as unknown as PrDetails;

describe("the three stages keep the output contract", () => {
  test("stage 1 scopes to its files and overrides the reporting bar", () => {
    const p = buildReviewPrompt("BASE", prDetails, false, undefined, "o/r", {
      batch: { files: ["src/a.ts", "src/b.ts"], index: 2, total: 12 },
    });
    expect(p).toContain("stage 1 of 3");
    expect(p).toContain("`src/a.ts`");
    expect(p).toContain("-- 'src/a.ts' 'src/b.ts'");
    expect(p).toContain("the bias is recall");
    // The contract is unchanged, so parseReviewOutput reads a batch's output.
    expect(p).toContain('"summary_markdown"');
    expect(p.indexOf("stage 1 of 3")).toBeGreaterThan(p.indexOf("BASE"));
  });

  test("no fan-out means the batch section does not appear", () => {
    const p = buildReviewPrompt("BASE", prDetails, false, undefined, "o/r", {});
    expect(p).not.toContain("stage 1 of 3");
  });

  test("the verifier prompt carries one candidate and not the reporting bar", () => {
    const p = buildVerifyPrompt({
      pr: prDetails,
      candidate: { path: "src/a.ts", line: 10, severity: "P1", title: "Null deref", body: "Boom." },
      index: 3,
      total: 9,
      ghRepo: "o/r",
    });
    expect(p).toContain("`src/a.ts:10` [P1] — Null deref");
    expect(p).toContain("(3 of 9)");
    expect(p).toContain("try to disprove");
    expect(p).toContain("KEEP is the default");
    // The seven-condition bar tuned for a noise problem must NOT come along.
    expect(p).not.toContain("The reporting bar");
    expect(p).not.toContain("What NOT to flag");
  });

  test("merged batch output still parses as a complete review", () => {
    // Two batches emit the contract; their findings merge into one review object.
    const batchOut = (finding: string) => `Looked at my slice.

\`\`\`json
{ "verdict": "comment", "confidence": 3, "summary_markdown": "batch", "findings": [${finding}] }
\`\`\``;
    const a = parseReviewOutput(
      batchOut('{"path":"src/a.ts","line":10,"side":"RIGHT","severity":"P1","title":"Null deref","body":"Boom."}'),
    );
    const b = parseReviewOutput(
      batchOut('{"path":"src/b.ts","line":4,"side":"RIGHT","severity":"P2","title":"Wrong default","body":"Nope."}'),
    );
    const merged = {
      verdict: "request_changes",
      confidence: 2,
      summary_markdown: "Two defects.",
      findings: dedupeFindings([...(a?.findings || []), ...(b?.findings || [])]),
    };
    expect(isCompleteReviewOutput(merged)).toBe(true);
    expect(merged.findings.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("stage 2 — refute to drop", () => {
  const candidate: Finding = {
    path: "src/a.ts",
    line: 10,
    severity: "P2",
    title: "Null deref on empty items",
    body: "When items is empty, it throws.",
  };
  const out = (o: unknown) => `Read the file.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

  test("a refuted candidate drops, carrying its reason", () => {
    const v = parseVerifyOutput(
      out({ verdict: "drop", reason: "src/a.ts:4 guards `items.length` before the call." }),
      candidate,
    );
    expect(v.keep).toBe(false);
    expect(v.reason).toContain("src/a.ts:4 guards");
  });

  test("a drop with no reason still drops, and says so for the audit", () => {
    expect(parseVerifyOutput(out({ verdict: "drop" }), candidate)).toMatchObject({
      keep: false,
      reason: "refuted without a stated reason",
    });
  });

  test("an unrefuted candidate survives", () => {
    const v = parseVerifyOutput(out({ verdict: "keep", reason: "Traced it from the handler." }), candidate);
    expect(v.keep).toBe(true);
    expect(v.finding).toEqual(candidate);
  });

  test("a keep re-anchors and rewrites the candidate", () => {
    // A wrong line is a lost finding — filterToDiff discards off-diff anchors.
    const v = parseVerifyOutput(
      out({
        verdict: "keep",
        reason: "Real, but it fires at line 42.",
        line: 42,
        severity: "P1",
        title: "Null deref",
        body: "When items is empty, render() dereferences items[0].",
        suggestion: "if (!items.length) return null;",
      }),
      candidate,
    );
    expect(v.finding).toEqual({
      path: "src/a.ts",
      line: 42,
      severity: "P1",
      title: "Null deref",
      body: "When items is empty, render() dereferences items[0].",
      suggestion: "if (!items.length) return null;",
    });
  });

  test("a verifier that errors, times out, or narrates leaves the candidate in", () => {
    // Refute-to-drop: no answer is not evidence about the code, and the other
    // way round makes recall a function of infrastructure flakiness.
    for (const text of ["", "I ran out of time before I could trace the caller.", "{not json"]) {
      const v = parseVerifyOutput(text, candidate);
      expect(v.keep).toBe(true);
      expect(v.finding).toEqual(candidate);
    }
    expect(parseVerifyOutput("", candidate).reason).toBe("no usable verdict from the verifier");
  });

  test("an unrecognised verdict is not a refutation", () => {
    expect(parseVerifyOutput(out({ verdict: "unsure", reason: "hmm" }), candidate).keep).toBe(true);
  });

  test("the ceiling holds, and the overflow survives unverified", () => {
    const many: Finding[] = Array.from({ length: VERIFY.max + 7 }, (_, i) => ({
      ...candidate,
      line: i + 1,
    }));
    const { verify, unverified } = planVerifications(many);
    expect(verify).toHaveLength(VERIFY.max);
    expect(unverified).toHaveLength(7);
    // Candidates arrive severity-sorted, so the overflow is the least severe.
    expect(verify.concat(unverified)).toEqual(many);
  });
});

describe("stage 3 — deterministic assembly", () => {
  const f = (over: Partial<Finding>): Finding => ({
    path: "src/a.ts",
    line: 10,
    body: "Boom.",
    ...over,
  });
  const ctx = { changedFiles: 34, changedLines: 2015, batches: 12, candidates: 9, refuted: 4 };

  test("survivors become a postable review with no model call", () => {
    const r = assembleReview([f({ line: 1, severity: "P2", title: "Wrong default" })], ctx);
    expect(isCompleteReviewOutput(r)).toBe(true);
    expect(r.verdict).toBe("comment");
    expect(r.findings).toHaveLength(1);
    expect(r.summary_markdown).toContain("12 independent passes");
    expect(r.summary_markdown).toContain("9 candidates");
    expect(r.summary_markdown).toContain("4 of them refuted");
  });

  test("a P1 survivor blocks the merge", () => {
    const r = assembleReview(
      [f({ line: 1, severity: "P2", title: "Slow" }), f({ line: 2, severity: "P1", title: "Auth bypass" })],
      ctx,
    );
    expect(r.verdict).toBe("request_changes");
    expect(r.confidence).toBe(2);
    expect(r.findings![0]!.title).toBe("Auth bypass");
  });

  test("nothing surviving is a complete review, and says what was checked", () => {
    const r = assembleReview([], ctx);
    expect(isCompleteReviewOutput(r)).toBe(true);
    expect(r.verdict).toBe("approve");
    expect(r.findings).toEqual([]);
    expect(r.summary_markdown).toContain("no candidate survived");
  });

  test("the volume bar trims the least severe tail on a small diff", () => {
    const survivors = Array.from({ length: 9 }, (_, i) =>
      f({ line: i + 1, severity: i === 0 ? "P1" : "P2", title: `Finding ${i}` }),
    );
    const r = assembleReview(survivors, { ...ctx, changedLines: 60, candidates: 9, refuted: 0 });
    expect(r.findings).toHaveLength(VERIFY.minFindings);
    expect(r.findings![0]!.title).toBe("Finding 0");
    expect(r.summary_markdown).toContain("4 further findings held back");
  });

  test("a big diff is not trimmed", () => {
    const survivors = Array.from({ length: 9 }, (_, i) => f({ line: i + 1, title: `Finding ${i}` }));
    expect(assembleReview(survivors, ctx).findings).toHaveLength(9);
  });

  test("assembly dedups what the verifiers handed back", () => {
    // Two verifiers can re-anchor two copies of one defect onto the same line.
    const r = assembleReview([f({ line: 7, title: "Null deref" }), f({ line: 7, title: "Null deref" })], ctx);
    expect(r.findings).toHaveLength(1);
  });
});

describe("stage 0: hypothesis batches", () => {
  const changed = [
    { path: "src/a.ts", lines: 10 },
    { path: "src/b.ts", lines: 5 },
    { path: "src/c.ts", lines: 2 },
  ];

  test("numbers from startIndex and sums the churn it claims", () => {
    const out = planHypothesisBatches(
      [{ question: "Does a value survive a to b?", files: ["src/a.ts", "src/b.ts"] }],
      changed,
      13,
    );
    expect(out).toEqual([
      {
        index: 13,
        files: ["src/a.ts", "src/b.ts"],
        lines: 15,
        question: "Does a value survive a to b?",
      },
    ]);
  });

  test("drops paths the diff does not contain, keeping the rest of the question", () => {
    const out = planHypothesisBatches(
      [{ question: "q", files: ["src/a.ts", "src/invented.ts"] }],
      changed,
      1,
    );
    expect(out[0]?.files).toEqual(["src/a.ts"]);
  });

  test("drops a question left with no real files at all", () => {
    expect(planHypothesisBatches([{ question: "q", files: ["nope.ts"] }], changed, 1)).toEqual([]);
  });

  test("drops a question that restates the whole diff", () => {
    const wide = Array.from({ length: 9 }, (_, i) => ({ path: `src/f${i}.ts`, lines: 1 }));
    const out = planHypothesisBatches(
      [{ question: "q", files: wide.map((f) => f.path) }],
      wide,
      1,
      { ...HYPOTHESIS, maxFilesPerQuestion: 6 },
    );
    expect(out).toEqual([]);
  });

  test("collapses two questions over the same files into one batch", () => {
    const out = planHypothesisBatches(
      [
        { question: "first", files: ["src/a.ts", "src/b.ts"] },
        { question: "second", files: ["src/b.ts", "src/a.ts"] },
      ],
      changed,
      1,
    );
    expect(out.map((b) => b.question)).toEqual(["first"]);
  });

  test("honours the ceiling on extra agent runs", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      question: `q${i}`,
      files: [changed[i % changed.length]!.path],
    }));
    expect(planHypothesisBatches(many, changed, 1).length).toBeLessThanOrEqual(HYPOTHESIS.max);
  });

  test("skips a question with no text", () => {
    expect(planHypothesisBatches([{ question: "  ", files: ["src/a.ts"] }], changed, 1)).toEqual([]);
  });
});

describe("stage 0: reading the planner's output", () => {
  const block = (body: string): string => `narration\n\`\`\`json\n${body}\n\`\`\``;

  test("reads questions and files", () => {
    expect(
      parseHypotheses(block('{"hypotheses":[{"question":"q","files":["a.ts"]}]}')),
    ).toEqual([{ question: "q", files: ["a.ts"] }]);
  });

  test("takes the last block when the agent narrated with earlier ones", () => {
    const text = `${block('{"hypotheses":[{"question":"draft","files":["a.ts"]}]}')}\n${block(
      '{"hypotheses":[{"question":"final","files":["b.ts"]}]}',
    )}`;
    expect(parseHypotheses(text).map((h) => h.question)).toEqual(["final"]);
  });

  test("returns nothing for malformed json rather than throwing", () => {
    expect(parseHypotheses(block("{not json"))).toEqual([]);
  });

  test("returns nothing when the agent emitted no block at all", () => {
    expect(parseHypotheses("I could not plan this PR.")).toEqual([]);
  });

  test("drops entries missing a question or files", () => {
    expect(
      parseHypotheses(
        block('{"hypotheses":[{"question":"q"},{"files":["a.ts"]},{"question":"ok","files":["a.ts"]}]}'),
      ),
    ).toEqual([{ question: "ok", files: ["a.ts"] }]);
  });

  test("empty plan is a valid plan", () => {
    expect(parseHypotheses(block('{"hypotheses":[]}'))).toEqual([]);
  });
});

describe("the batch prompt adapts to what the batch is for", () => {
  const pr = {
    number: 7,
    title: "t",
    url: "https://example.test/pr/7",
    baseRefName: "master",
    headRefName: "feat",
    additions: 10,
    deletions: 1,
    changedFiles: 6,
  } as PrDetails;

  test("a question batch is told to trace the flow, not to read files one at a time", () => {
    const p = buildReviewPrompt("base", pr, false, undefined, "o/r", {
      batch: { files: ["a.ts", "b.ts"], index: 1, total: 3, question: "Does X survive Y?" },
    });
    expect(p).toContain("Does X survive Y?");
    expect(p).toContain("follow the behaviour");
    expect(p).not.toContain("Take them one at a time");
  });

  test("a coverage batch keeps the per-file instruction", () => {
    const p = buildReviewPrompt("base", pr, false, undefined, "o/r", {
      batch: { files: ["a.ts"], index: 1, total: 3 },
    });
    expect(p).toContain("Take them one at a time");
    expect(p).toContain("recall sweep");
  });
});
