import { describe, expect, test } from "bun:test";
import {
  anchorsInDiffGate,
  applyGates,
  checkSubmission,
  createGateSession,
  evidenceGate,
  MAX_SUBMIT_REJECTIONS,
  readOnlyBashGate,
  type GatedTool,
  type ToolGate,
} from "./agent-gates";

/** A tool that records what it was called with, so we can prove it did or did
 *  not run rather than inferring it from the return value. */
function spyTool(name: string, result: unknown = "ok") {
  const calls: unknown[] = [];
  const tool: GatedTool = {
    name,
    async execute(_id: string, params: unknown) {
      calls.push(params);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { tool, calls };
}

const run = (t: GatedTool, input: unknown) => t.execute("id-1", input, null, null, null);

describe("gates wrap tool execution", () => {
  test("a gate that allows lets the tool run untouched", async () => {
    const { tool, calls } = spyTool("read");
    const session = createGateSession([{ name: "noop" }]);
    const [wrapped] = applyGates([tool], session);
    expect(await run(wrapped!, { path: "a.ts" })).toBe("ok");
    expect(calls).toEqual([{ path: "a.ts" }]);
  });

  test("a refusal throws the reason and the tool never runs", async () => {
    const { tool, calls } = spyTool("bash");
    const gate: ToolGate = { name: "no-bash", beforeCall: () => "bash is not available here" };
    const [wrapped] = applyGates([tool], createGateSession([gate]));
    expect(run(wrapped!, { command: "ls" })).rejects.toThrow("bash is not available here");
    expect(calls).toEqual([]);
  });

  test("the refusal is recorded for the audit event", async () => {
    const { tool } = spyTool("bash");
    const session = createGateSession([{ name: "no-bash", beforeCall: () => "nope" }]);
    const [wrapped] = applyGates([tool], session);
    await run(wrapped!, { command: "ls" }).catch(() => {});
    expect(session.log).toEqual([{ gate: "no-bash", phase: "call", reason: "nope" }]);
  });

  test("observers see the call and whether it succeeded", async () => {
    const seen: Array<[string, boolean]> = [];
    const gate: ToolGate = { name: "watch", afterCall: (c, ok) => void seen.push([c.name, ok]) };
    const good = applyGates([spyTool("read").tool], createGateSession([gate]))[0]!;
    const bad = applyGates(
      [spyTool("grep", new Error("boom")).tool],
      createGateSession([gate]),
    )[0]!;
    await run(good, {});
    await run(bad, {}).catch(() => {});
    expect(seen).toEqual([["read", true], ["grep", false]]);
  });

  test("a broken observer cannot fail the call it is measuring", async () => {
    const gate: ToolGate = {
      name: "broken",
      afterCall: () => {
        throw new Error("gate bug");
      },
    };
    const [wrapped] = applyGates([spyTool("read").tool], createGateSession([gate]));
    expect(await run(wrapped!, {})).toBe("ok");
  });

  test("no gates means no wrapper at all", () => {
    const { tool } = spyTool("read");
    expect(applyGates([tool], createGateSession([]))[0]).toBe(tool);
  });
});

describe("submission gates", () => {
  const failing = (name: string, reason: string): ToolGate => ({
    name,
    beforeSubmit: () => reason,
  });

  test("accepts when every gate is satisfied", () => {
    const s = createGateSession([{ name: "ok", beforeSubmit: () => null }]);
    expect(checkSubmission(s, { findings: [] })).toBeNull();
  });

  test("reports every objection at once, not just the first", () => {
    const s = createGateSession([failing("a", "first problem"), failing("b", "second problem")]);
    const reason = checkSubmission(s, {})!;
    expect(reason).toContain("first problem");
    expect(reason).toContain("second problem");
  });

  test("stops refusing once the cap is reached, so a run cannot hang", () => {
    const s = createGateSession([failing("a", "nope")]);
    for (let i = 0; i < MAX_SUBMIT_REJECTIONS; i++) expect(checkSubmission(s, {})).not.toBeNull();
    expect(checkSubmission(s, {})).toBeNull();
  });
});

describe("read-only bash gate", () => {
  const deny = (c: string) => (c.startsWith("rm") ? "writes are refused" : null);

  test("refuses what the allowlist refuses", () => {
    expect(readOnlyBashGate(deny).beforeCall!({ name: "bash", input: { command: "rm -rf /" } }))
      .toBe("writes are refused");
  });

  test("allows what it allows", () => {
    expect(readOnlyBashGate(deny).beforeCall!({ name: "bash", input: { command: "ls" } })).toBeNull();
  });

  test("ignores tools that are not bash", () => {
    expect(readOnlyBashGate(deny).beforeCall!({ name: "read", input: { command: "rm -rf /" } }))
      .toBeNull();
  });

  test("an empty command is not the allowlist's problem", () => {
    expect(readOnlyBashGate(deny).beforeCall!({ name: "bash", input: { command: "  " } })).toBeNull();
  });
});

describe("anchors-in-diff gate", () => {
  const inDiff = (p: string, l: number) => p === "src/a.ts" && l >= 10 && l <= 20;

  test("accepts findings anchored inside the diff", () => {
    const out = { findings: [{ path: "src/a.ts", line: 12 }] };
    expect(anchorsInDiffGate(inDiff).beforeSubmit!(out)).toBeNull();
  });

  test("names each bad anchor so the agent can fix it", () => {
    const out = {
      findings: [
        { path: "src/a.ts", line: 12 },
        { path: "src/a.ts", line: 99 },
        { path: "src/other.ts", line: 3 },
      ],
    };
    const reason = anchorsInDiffGate(inDiff).beforeSubmit!(out)!;
    expect(reason).toContain("src/a.ts:99");
    expect(reason).toContain("src/other.ts:3");
    expect(reason).not.toContain("src/a.ts:12");
    expect(reason).toContain("2 finding(s)");
  });

  test("an empty or absent findings list is a valid submission", () => {
    expect(anchorsInDiffGate(inDiff).beforeSubmit!({ findings: [] })).toBeNull();
    expect(anchorsInDiffGate(inDiff).beforeSubmit!({})).toBeNull();
  });
});

describe("evidence gate", () => {
  const wasRead = (p: string) => p === "src/read.ts";

  test("accepts a finding in a file that was opened", () => {
    expect(evidenceGate(wasRead).beforeSubmit!({ findings: [{ path: "src/read.ts" }] })).toBeNull();
  });

  test("refuses a finding in a file that was never opened", () => {
    const reason = evidenceGate(wasRead).beforeSubmit!({
      findings: [{ path: "src/read.ts" }, { path: "src/never.ts" }],
    })!;
    expect(reason).toContain("src/never.ts");
    expect(reason).not.toContain("src/read.ts");
  });

  test("names each unread file once, however many findings cite it", () => {
    const reason = evidenceGate(wasRead).beforeSubmit!({
      findings: [{ path: "src/never.ts" }, { path: "src/never.ts" }],
    })!;
    expect(reason.match(/src\/never\.ts/g)).toHaveLength(1);
  });
});
