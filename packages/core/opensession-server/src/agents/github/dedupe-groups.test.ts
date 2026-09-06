import { describe, expect, test } from "bun:test";
import { applyDedupeGroups } from "./review-fanout";
import type { Finding } from "./review";

const f = (n: number): Finding => ({
  path: `src/${n}.ts`, line: n, severity: "P2", title: `t${n}`, body: `b${n}`,
});
const list = [f(0), f(1), f(2), f(3)];
const ids = (r: { findings: Finding[] }) => r.findings.map((x) => x.title);

describe("applyDedupeGroups", () => {
  test("merges a group down to its keep", () => {
    const r = applyDedupeGroups(list, [{ ids: ["B1", "B3"], keep: "B3" }]);
    expect(ids(r)).toEqual(["t0", "t2", "t3"]);
    expect(r.merged).toBe(1);
  });

  test("no groups changes nothing", () => {
    for (const g of [[], undefined as never]) {
      expect(applyDedupeGroups(list, g)).toEqual({ findings: list, merged: 0 });
    }
  });

  test("a group naming an unknown id is ignored entirely", () => {
    // The agent judged a set we cannot reconstruct, so acting on the part we do
    // recognise would merge a pair it never actually compared.
    const r = applyDedupeGroups(list, [{ ids: ["B1", "B9"], keep: "B1" }]);
    expect(r.merged).toBe(0);
    expect(ids(r)).toHaveLength(4);
  });

  test("a group of one merges nothing", () => {
    expect(applyDedupeGroups(list, [{ ids: ["B1"], keep: "B1" }]).merged).toBe(0);
  });

  test("keep outside its own group falls back to the first member", () => {
    const r = applyDedupeGroups(list, [{ ids: ["B1", "B2"], keep: "B0" }]);
    expect(ids(r)).toEqual(["t0", "t1", "t3"]);
  });

  test("missing keep falls back to the first member", () => {
    const r = applyDedupeGroups(list, [{ ids: ["B1", "B2"] }]);
    expect(ids(r)).toEqual(["t0", "t1", "t3"]);
  });

  test("a finding claimed by two groups only honours the first", () => {
    const r = applyDedupeGroups(list, [
      { ids: ["B0", "B1"], keep: "B0" },
      { ids: ["B1", "B2"], keep: "B2" },
    ]);
    expect(ids(r)).toEqual(["t0", "t2", "t3"]);
    expect(r.merged).toBe(1);
  });

  test("a verdict collapsing more than half the review is rejected wholesale", () => {
    // An adjudication pass once cut 8 of 9 findings. The worst real duplicate
    // group measured merged 4 of 20, so anything past half is a malfunction.
    // Four findings into one drops three, which is past half; three into one
    // drops two of four, which is not, and the next test pins that boundary.
    const r = applyDedupeGroups(list, [{ ids: ["B0", "B1", "B2", "B3"], keep: "B0" }]);
    expect(r).toEqual({ findings: list, merged: 0 });
  });

  test("merging exactly half is still allowed", () => {
    const r = applyDedupeGroups(list, [
      { ids: ["B0", "B1"], keep: "B0" },
      { ids: ["B2", "B3"], keep: "B2" },
    ]);
    expect(r.merged).toBe(2);
    expect(ids(r)).toEqual(["t0", "t2"]);
  });

  test("an empty finding list survives any verdict", () => {
    expect(applyDedupeGroups([], [{ ids: ["B0", "B1"], keep: "B0" }]))
      .toEqual({ findings: [], merged: 0 });
  });
});

import { parseDedupeOutput } from "./review";

describe("parseDedupeOutput", () => {
  const wrap = (o: unknown) => "reasoning first\n```json\n" + JSON.stringify(o) + "\n```";

  test("reads groups out of the last json block", () => {
    expect(parseDedupeOutput(wrap({ groups: [{ ids: ["B0", "B1"], keep: "B0" }] })))
      .toEqual([{ ids: ["B0", "B1"], keep: "B0" }]);
  });

  test("no duplicates is the common answer and parses to nothing", () => {
    for (const o of [{ groups: [] }, {}, { groups: null }]) {
      expect(parseDedupeOutput(wrap(o))).toEqual([]);
    }
  });

  test("unparseable output merges nothing rather than throwing", () => {
    for (const s of ["", "no json here", "```json\n{not json\n```"]) {
      expect(parseDedupeOutput(s)).toEqual([]);
    }
  });
});
