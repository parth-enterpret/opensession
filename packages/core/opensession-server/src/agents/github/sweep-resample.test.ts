import { describe, expect, test } from "bun:test";
import { FANOUT, sweepCameBackThin } from "./review-fanout";

describe("sweepCameBackThin", () => {
  test("a thin draw over many batches is resampled", () => {
    // The measured case: 13 candidates over 16 batches scored 0 of 2, while the
    // same configuration scored 4 of 4 on a draw of 39.
    expect(sweepCameBackThin(13, 16)).toBe(true);
  });

  test("a healthy draw is left alone", () => {
    for (const n of [39, 32, 52, 75]) expect(sweepCameBackThin(n, 16)).toBe(false);
  });

  test("a small diff is never called thin", () => {
    // Below the fan-out threshold there is no fan-out to resample, and four
    // candidates on a two-file diff is a complete review.
    expect(sweepCameBackThin(1, FANOUT.minFiles - 1)).toBe(false);
  });

  test("the floor protects small fan-outs from a per-batch rate", () => {
    // At 0.75/batch a 6-batch sweep would be "healthy" at 5 candidates. The
    // floor says otherwise: barely-ran is barely-ran regardless of diff size.
    expect(sweepCameBackThin(5, 6)).toBe(true);
    expect(sweepCameBackThin(FANOUT.resampleFloor, 6)).toBe(false);
  });

  test("zero candidates always resamples once", () => {
    expect(sweepCameBackThin(0, FANOUT.minFiles)).toBe(true);
  });

  test("the threshold sits well below the observed median", () => {
    // Observed yields: 8 39 39 32 37 52 29 75 24 32 30 22 13 26 22 24 13.
    // This exists to catch a generator that barely ran, not to drag every
    // review toward the median — so on a typical 16-batch sweep it must fire
    // for the low outliers and nothing else.
    const observed = [8, 39, 39, 32, 37, 52, 29, 75, 24, 32, 30, 22, 13, 26, 22, 24, 13];
    const fired = observed.filter((n) => sweepCameBackThin(n, 16));
    expect(fired).toEqual([8, 13, 13]);
  });

  test("one retry, not a loop", () => {
    expect(FANOUT.resampleAttempts).toBe(1);
  });
});
