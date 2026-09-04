import { describe, expect, test } from "bun:test";
import {
  candidatesBlock,
  changedFilesFromPatch,
  dedupeFindings,
  FANOUT,
  planReviewBatches,
} from "./review-fanout";
import { buildReviewPrompt } from "./prompts";
import { isCompleteReviewOutput, parseReviewOutput } from "./review";
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

  test("fans a real PR out at three files per batch", () => {
    // enterpret-showcase#12182: 34 files, ~2,015 lines, 1 finding single-pass.
    const files: Array<[string, number]> = Array.from({ length: 34 }, (_, i) => [
      `src/f${i}.ts`,
      59,
    ]);
    const batches = planReviewBatches(patchOf(files));
    expect(batches).toHaveLength(12);
    expect(batches.map((b) => b.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(batches.flatMap((b) => b.files)).toHaveLength(34);
    expect(new Set(batches.flatMap((b) => b.files)).size).toBe(34);
    for (const b of batches) expect(b.files.length).toBeLessThanOrEqual(3);
  });

  test("a big file gets its batch to itself", () => {
    const batches = planReviewBatches(
      patchOf([["small.ts", 5], ["huge.ts", 900], ["next.ts", 5], ["last.ts", 5], ["x.ts", 5]]),
    );
    expect(batches[0]!.files).toEqual(["small.ts", "huge.ts"]);
    expect(batches[1]!.files[0]).toBe("next.ts");
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
    expect(batches[0]!.lines).toBe(60);
    expect(batches[1]!.lines).toBe(2);
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

describe("the two stages keep the output contract", () => {
  test("stage 1 scopes to its files and overrides the reporting bar", () => {
    const p = buildReviewPrompt("BASE", prDetails, false, undefined, "o/r", {
      batch: { files: ["src/a.ts", "src/b.ts"], index: 2, total: 12 },
    });
    expect(p).toContain("stage 1 of 2");
    expect(p).toContain("`src/a.ts`");
    expect(p).toContain("-- 'src/a.ts' 'src/b.ts'");
    expect(p).toContain("the bias is recall");
    // The contract is unchanged, so parseReviewOutput reads a batch's output.
    expect(p).toContain('"summary_markdown"');
    expect(p.indexOf("stage 1 of 2")).toBeGreaterThan(p.indexOf("BASE"));
  });

  test("stage 2 carries the candidates and is not a batch", () => {
    const p = buildReviewPrompt("BASE", prDetails, false, undefined, "o/r", {
      candidates: candidatesBlock([
        { path: "src/a.ts", line: 10, severity: "P1", title: "Null deref", body: "Boom." },
      ]),
    });
    expect(p).toContain("stage 2 of 2");
    expect(p).toContain("`src/a.ts:10` [P1] — Null deref");
    expect(p).not.toContain("stage 1 of 2");
  });

  test("no fan-out means neither section appears", () => {
    const p = buildReviewPrompt("BASE", prDetails, false, undefined, "o/r", {});
    expect(p).not.toContain("stage 1 of 2");
    expect(p).not.toContain("stage 2 of 2");
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
    expect(candidatesBlock(merged.findings)).toContain("2. `src/b.ts:4` [P2] — Wrong default");
  });
});
