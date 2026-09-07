/**
 * The confirmed-bug signal is the one this system cannot manufacture.
 *
 * A missed bug is recorded when a merged fix-PR blames lines that a PR we
 * reviewed introduced. Both halves have to be true, so the signal only appears
 * after production has run long enough for a reviewed PR to be fixed by a later
 * one. The live store carries 338 signals and zero of these.
 *
 * That makes the parsing below the part worth pinning down: it is the only part
 * that can be wrong today, and nothing will exercise it until the day it
 * matters. Both functions read text that GitHub and git produce, and both fail
 * silently when they mis-read it — `oldSideRanges` returning nothing blames
 * nothing, and `prNumberFromSubject` returning null drops the culprit.
 */
import { describe, expect, test } from "bun:test";
import { oldSideRanges, prNumberFromSubject } from "./missed-bugs";

describe("oldSideRanges — which lines the fix replaced", () => {
  test("reads the old-side start and count from a hunk header", () => {
    expect(oldSideRanges("@@ -10,3 +10,4 @@ func x()\n-a\n+b\n")).toEqual([{ start: 10, end: 12 }]);
  });

  test("a header with no count means exactly one line", () => {
    // git omits `,1`. Treating the absent count as zero would skip the hunk and
    // blame nothing, which reads as "no bug found" rather than as a parse miss.
    expect(oldSideRanges("@@ -42 +42,2 @@\n-a\n+b\n+c\n")).toEqual([{ start: 42, end: 42 }]);
  });

  test("a pure addition blames nobody", () => {
    // Old-side count zero: the fix added lines and replaced none, so no earlier
    // commit introduced anything it corrects.
    expect(oldSideRanges("@@ -7,0 +8,3 @@\n+a\n+b\n+c\n")).toEqual([]);
  });

  test("reads every hunk in a patch, in order", () => {
    const patch = "@@ -1,2 +1,2 @@\n-a\n+b\n@@ -20,1 +20,3 @@\n-c\n+d\n";
    expect(oldSideRanges(patch)).toEqual([{ start: 1, end: 2 }, { start: 20, end: 20 }]);
  });

  test("stops at the per-file hunk cap", () => {
    // Bounded on purpose: one blame call per hunk, and a large refactor would
    // otherwise spend the whole blame budget on a single file.
    const patch = Array.from({ length: 9 }, (_, i) => `@@ -${i * 10 + 1},2 +${i * 10 + 1},2 @@\n-a\n+b`).join("\n");
    expect(oldSideRanges(patch).length).toBe(3);
  });

  test("an empty or malformed patch yields nothing rather than throwing", () => {
    expect(oldSideRanges("")).toEqual([]);
    expect(oldSideRanges("not a patch at all")).toEqual([]);
  });
});

describe("prNumberFromSubject — which PR introduced the blamed line", () => {
  test("reads the squash-merge suffix", () => {
    expect(prNumberFromSubject("Fix the credits limit derivation (#1234)")).toBe(1234);
  });

  test("tolerates trailing whitespace", () => {
    expect(prNumberFromSubject("Add a thing (#7)  ")).toBe(7);
  });

  test("ignores an issue reference that is not the suffix", () => {
    // "(#12)" mid-subject is a mention, not the merge marker. Reading it as the
    // culprit would blame a PR that never touched the line.
    expect(prNumberFromSubject("Revert (#12) because it broke prod")).toBeNull();
  });

  test("a merge-commit subject is not a squash suffix", () => {
    expect(prNumberFromSubject("Merge pull request #99 from org/branch")).toBeNull();
  });

  test("a plain commit blames no PR", () => {
    expect(prNumberFromSubject("wip")).toBeNull();
  });
});
