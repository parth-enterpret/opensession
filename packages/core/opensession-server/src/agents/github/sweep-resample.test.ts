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

describe("the resample's time budget", () => {
  // The first guard asked for githubRunTimeoutMs(0) of remaining budget. The
  // stage deadline is set to exactly that at the start, so the remainder is
  // always below it and the resample fired on nothing. These pin the arithmetic
  // that replaced it: price a resample at one more pass, not one more review.
  const budget = (elapsedMs: number, passes: number) =>
    Math.max(60_000, elapsedMs / Math.max(1, passes));

  test("one more pass is priced at what one pass just cost", () => {
    // Two passes taking 200s together means one pass costs about 100s.
    expect(budget(200_000, 2)).toBe(100_000);
  });

  test("a fast sweep still reserves a floor", () => {
    // A sweep that returned in seconds must not conclude a resample is free.
    expect(budget(4_000, 2)).toBe(60_000);
  });

  test("the guard is satisfiable, which the old one was not", () => {
    // 45 minutes of stage budget, 200s spent: plenty of room for another pass.
    const deadlineLeft = 45 * 60_000 - 200_000;
    expect(deadlineLeft > budget(200_000, 2) * 1.5).toBe(true);
    // The old condition, for contrast: deadlineLeft > the full stage timeout.
    expect(deadlineLeft > 45 * 60_000).toBe(false);
  });

  test("a nearly exhausted stage does not start a resample it cannot finish", () => {
    const deadlineLeft = 30_000;
    expect(deadlineLeft > budget(200_000, 2) * 1.5).toBe(false);
  });
});
