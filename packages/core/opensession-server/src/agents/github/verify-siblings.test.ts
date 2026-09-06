import { describe, expect, test } from "bun:test";
import { parseVerifyOutput } from "./review";
import type { Finding } from "./review";

const candidate: Finding = {
  path: "src/a.ts",
  line: 100,
  severity: "P1",
  title: "candidate",
  body: "candidate body",
};

const wrap = (o: unknown) => "prose before\n```json\n" + JSON.stringify(o) + "\n```";

const sibling = (over: Record<string, unknown> = {}) => ({
  path: "src/a.ts",
  line: 130,
  severity: "P2",
  title: "a different defect",
  body: "when X, the code does Y, so Z",
  ...over,
});

describe("verifier siblings", () => {
  test("a well-formed sibling is kept alongside the candidate", () => {
    const v = parseVerifyOutput(wrap({ verdict: "keep", reason: "r", siblings: [sibling()] }), candidate);
    expect(v.keep).toBe(true);
    expect(v.siblings).toHaveLength(1);
    expect(v.siblings[0]!.line).toBe(130);
    // Unstated severity defaults to the non-blocking one.
    expect(v.siblings[0]!.severity).toBe("P2");
  });

  test("siblings survive a dropped candidate", () => {
    // Refuting the claim and noticing a real defect beside it are independent.
    // This is the case the whole feature exists for.
    const v = parseVerifyOutput(wrap({ verdict: "drop", reason: "no such path", siblings: [sibling()] }), candidate);
    expect(v.keep).toBe(false);
    expect(v.siblings).toHaveLength(1);
  });

  test("a sibling on the candidate's own line is a restatement, not a sibling", () => {
    const v = parseVerifyOutput(
      wrap({ verdict: "keep", siblings: [sibling({ line: candidate.line })] }),
      candidate,
    );
    expect(v.siblings).toHaveLength(0);
  });

  test("a sibling without an anchor or a claim is discarded", () => {
    const v = parseVerifyOutput(
      wrap({
        verdict: "keep",
        siblings: [sibling({ line: 0 }), sibling({ title: "" }), sibling({ body: "  " })],
      }),
      candidate,
    );
    expect(v.siblings).toHaveLength(0);
  });

  test("at most two siblings are taken", () => {
    const many = [131, 132, 133, 134].map((line) => sibling({ line }));
    const v = parseVerifyOutput(wrap({ verdict: "keep", siblings: many }), candidate);
    expect(v.siblings).toHaveLength(2);
  });

  test("absent, empty, or malformed siblings yield none and do not throw", () => {
    for (const s of [undefined, [], "nope", {}, [null, 3]]) {
      const v = parseVerifyOutput(wrap({ verdict: "keep", siblings: s }), candidate);
      expect(v.siblings).toEqual([]);
      expect(v.keep).toBe(true);
    }
  });

  test("an unparseable verifier turn still keeps the candidate", () => {
    const v = parseVerifyOutput("no json here at all", candidate);
    expect(v.keep).toBe(true);
    expect(v.siblings).toEqual([]);
  });
});
