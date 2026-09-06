import { describe, expect, test } from "bun:test";
import { expandPasses, FANOUT } from "./review-fanout";

const batches = [{ index: 1, files: ["a.ts"] }, { index: 2, files: ["b.ts"] }];

describe("expandPasses", () => {
  test("each batch runs once per pass", () => {
    const q = expandPasses(batches, 2);
    expect(q).toHaveLength(4);
    expect(q.filter((b) => b.index === 1)).toHaveLength(2);
  });

  test("pass-major order, so a truncated stage still covered every batch once", () => {
    // A review that exhausts its deadline mid-stage must have full single-pass
    // coverage, not two passes over the first half of the diff and none of the
    // rest. Batch-major ordering would give exactly that.
    const q = expandPasses(batches, 2);
    expect(q.map((b) => [b.pass, b.index])).toEqual([[0, 1], [0, 2], [1, 1], [1, 2]]);
  });

  test("one pass is the identity, with pass 0 attached", () => {
    expect(expandPasses(batches, 1)).toEqual([
      { index: 1, files: ["a.ts"], pass: 0 },
      { index: 2, files: ["b.ts"], pass: 0 },
    ]);
  });

  test("a nonsense pass count still runs every batch once", () => {
    for (const n of [0, -3, NaN, 0.4]) {
      expect(expandPasses(batches, n)).toHaveLength(batches.length);
    }
  });

  test("no batches yields no work regardless of passes", () => {
    expect(expandPasses([], 5)).toEqual([]);
  });

  test("the shipped pass count is the measured one", () => {
    // Two, because a third pass added nothing the first two had not found.
    expect(FANOUT.passes).toBe(2);
  });
});
