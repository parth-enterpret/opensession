/**
 * Characterisation tests for the vendored Pullfrog coverage tracker.
 *
 * The module is upstream code we do not modify, so these do not test Pullfrog —
 * they pin the behaviour WE depend on, so a future re-vendor that changes it
 * fails here instead of silently weakening the gate. Every case below maps to a
 * property `agent-gates` needs to be true.
 */
import { describe, expect, test } from "bun:test";
import {
  createDiffCoverageState,
  getDiffCoverageBreakdown,
  parseDiffTocEntries,
  recordDiffReadFromToolUse,
} from "./diff-coverage";

const DIFF_PATH = "/tmp/wt/.diff/pr.diff";
const CWD = "/tmp/wt";

/** Two files, 100 diff lines: a.ts on 1-40, b.ts on 41-100. */
const TOC = ["- src/a.ts → lines 1-40", "- src/b.ts → lines 41-100"].join("\n");

const state = () =>
  createDiffCoverageState({ diffPath: DIFF_PATH, totalLines: 100, toc: TOC });

/**
 * Read `count` lines starting at 1-based `from`.
 *
 * NOTE the conversion. `resolveOffsetBase` treats `read` as ZERO-based (only
 * `readFile` is one-based), so a read tool reporting `offset: 1` has skipped a
 * line. Getting this backwards silently under-counts coverage by one line per
 * read, which is exactly the kind of off-by-one that would make a gate fire on
 * a reviewer that did nothing wrong.
 */
const read = (s: ReturnType<typeof state>, from: number, count: number, path = DIFF_PATH) =>
  recordDiffReadFromToolUse({
    state: s,
    toolName: "read",
    input: { path, offset: from - 1, limit: count },
    cwd: CWD,
  });

describe("the table of contents", () => {
  test("maps each file to its line range in the diff", () => {
    expect(parseDiffTocEntries({ toc: TOC })).toEqual([
      { filename: "src/a.ts", startLine: 1, endLine: 40 },
      { filename: "src/b.ts", startLine: 41, endLine: 100 },
    ]);
  });

  test("ignores prose around the entries", () => {
    const toc = `Files changed:\n${TOC}\n(generated)`;
    expect(parseDiffTocEntries({ toc })).toHaveLength(2);
  });
});

describe("what the agent read", () => {
  test("a fresh run has read nothing", () => {
    const b = getDiffCoverageBreakdown({ state: state() });
    expect(b.coveredLines).toBe(0);
    expect(b.coveragePercent).toBe(0);
    expect(b.unreadLines).toBe(100);
  });

  test("reading the whole diff covers it", () => {
    const s = state();
    expect(read(s, 1, 100)).toBe(true);
    const b = getDiffCoverageBreakdown({ state: s });
    expect(b.coveragePercent).toBe(100);
    expect(b.unreadRanges).toEqual([]);
  });

  test("a partial read leaves the rest attributable to a file", () => {
    const s = state();
    read(s, 1, 40);
    const b = getDiffCoverageBreakdown({ state: s });
    expect(b.coveredLines).toBe(40);
    const a = b.files.find((f) => f.filename === "src/a.ts")!;
    const bb = b.files.find((f) => f.filename === "src/b.ts")!;
    expect(a.unreadRanges).toEqual([]);
    expect(bb.coveredLines).toBe(0);
    expect(bb.unreadRanges).toEqual([{ startLine: 41, endLine: 100 }]);
  });

  test("overlapping reads are merged, not double counted", () => {
    const s = state();
    read(s, 1, 50);
    read(s, 25, 50);
    expect(getDiffCoverageBreakdown({ state: s }).coveredLines).toBe(74);
  });

  test("reads of other files do not count as diff coverage", () => {
    const s = state();
    expect(read(s, 1, 100, "/tmp/wt/src/a.ts")).toBe(false);
    expect(getDiffCoverageBreakdown({ state: s }).coveredLines).toBe(0);
  });

  test("a non-read tool does not count", () => {
    const s = state();
    const counted = recordDiffReadFromToolUse({
      state: s,
      toolName: "bash",
      input: { command: `cat ${DIFF_PATH}` },
      cwd: CWD,
    });
    expect(counted).toBe(false);
  });

  test("a relative path resolves against the run cwd", () => {
    const s = state();
    expect(read(s, 1, 100, ".diff/pr.diff")).toBe(true);
    expect(getDiffCoverageBreakdown({ state: s }).coveragePercent).toBe(100);
  });
});

describe("the property the gate is built on", () => {
  test("an agent that read nothing is distinguishable from one that read it all", () => {
    const skimmed = state();
    const thorough = state();
    read(thorough, 1, 100);
    expect(getDiffCoverageBreakdown({ state: skimmed }).coveragePercent).toBe(0);
    expect(getDiffCoverageBreakdown({ state: thorough }).coveragePercent).toBe(100);
  });

  test("unread regions are reportable per file, so a refusal can name them", () => {
    const s = state();
    // Straddles the file boundary: covers a.ts 20-40 and b.ts 41-59, so BOTH
    // files keep an unread tail and the refusal has to name two files.
    read(s, 20, 40);
    const unread = getDiffCoverageBreakdown({ state: s })
      .files.filter((f) => f.unreadRanges.length)
      .map((f) => f.filename);
    expect(unread).toContain("src/a.ts");
    expect(unread).toContain("src/b.ts");
  });
});
