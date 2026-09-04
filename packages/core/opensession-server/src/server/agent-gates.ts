/**
 * Tool gates — server-side checks an agent cannot talk its way past.
 *
 * A gate observes every tool call an agent makes and may refuse one with a
 * reason. The reason is thrown from `execute`, which Pi delivers back to the
 * model as the tool result, so a refusal is a correction the agent reads and
 * acts on rather than a silent drop.
 *
 * This is not a new idea here so much as a name for one we already had. The
 * read-only bash allowlist is exactly this shape (`pi-runner.ts:1297`):
 *
 *     const reason = askBashDenyReason(command);
 *     if (reason) throw new Error(reason);
 *
 * and `piRepeatCallGuardTools` already wraps the whole tool array to enforce a
 * cross-cutting rule. Gates generalise both so that a rule is declared once,
 * named, tested on its own, and attached to the agents that want it.
 *
 * The design target is Pullfrog's diff-coverage gate, which is the only
 * mechanism in the surveyed field (Greptile, CodeRabbit, Cloudflare, kodus,
 * qodo, Wealthfront) that verifies an agent actually LOOKED at what it claims to
 * have reviewed. Pullfrog needs an MCP server and a separate gate process to do
 * it, because it drives agent SDKs it does not own. We own our tools in-process,
 * so a gate is a function wrapper. See docs/design/agent-gates.md.
 *
 * Why this matters concretely: the worst review failure this project has
 * measured was an agent whose shell allowlist denied bare `cat`, so every read
 * failed and it emitted findings anyway. Nothing noticed, because nothing was
 * watching what it read. A coverage gate turns that from an invisible quality
 * regression into a named error at submission time.
 */

/** One tool call, as a gate sees it. */
export interface GateCall {
  name: string;
  input: unknown;
}

/**
 * A cross-cutting rule over an agent's tool use.
 *
 * Every hook is optional; a gate that only observes implements `afterCall`
 * alone, and a gate that only guards submission implements `beforeSubmit`.
 */
export interface ToolGate {
  /** Stable identifier. Appears in refusal messages and audit events. */
  name: string;
  /**
   * Runs before the tool does. Return a string to refuse the call with that
   * reason, or null to allow it. The reason reaches the model verbatim, so
   * write it as an instruction — say what to do instead, not just what is
   * wrong.
   */
  beforeCall?(call: GateCall): string | null;
  /**
   * Runs after the tool did, purely to observe. Never blocks, and never throws:
   * a gate that breaks the run it is measuring is worse than no gate.
   */
  afterCall?(call: GateCall, ok: boolean): void;
  /**
   * Runs when the agent submits its result. Return a string to refuse the
   * submission with that reason, or null to accept.
   *
   * Refusals here are capped (see `maxSubmitRejections`). An agent that cannot
   * satisfy a gate must eventually be allowed through, because a review is
   * best-effort and a gate that can refuse forever converts a flaky agent into
   * a hung one.
   */
  beforeSubmit?(output: unknown): string | null;
}

/**
 * How many times the whole gate set may refuse a submission before it is let
 * through regardless.
 *
 * One, matching Pullfrog. The point of a refusal is to catch the agent that
 * skimmed and would have fixed it if asked; the agent that genuinely cannot
 * satisfy the gate is not improved by being asked twice, and every extra round
 * costs a full turn.
 */
export const MAX_SUBMIT_REJECTIONS = 1;

/** Mutable per-run gate bookkeeping. One of these per agent run. */
export interface GateSession {
  gates: ToolGate[];
  submitRejections: number;
  /** Refusals issued, for the audit event. */
  log: Array<{ gate: string; phase: "call" | "submit"; reason: string }>;
}

export function createGateSession(gates: ToolGate[]): GateSession {
  return { gates, submitRejections: 0, log: [] };
}

/**
 * The minimum of Pi's `ToolDefinition` this module needs. Declared structurally
 * rather than imported so gates stay unit-testable without pulling the runner —
 * the same reason `feedback-gates.ts` and `review-context.ts` are pure.
 */
export interface GatedTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
  [key: string]: unknown;
}

/**
 * Wrap every tool so the session's gates see its calls.
 *
 * Composes with the existing wrappers rather than replacing them: apply this
 * INSIDE `piRepeatCallGuardTools`, so a call the repeat guard skips never
 * reaches a gate and cannot be counted as read coverage it never got.
 */
export function applyGates<T extends GatedTool>(tools: T[], session: GateSession): T[] {
  if (!session.gates.length) return tools;
  return tools.map((tool) => {
    const inner = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(...args: any[]): Promise<any> {
        // Pi's signature is (toolCallId, params, signal, onUpdate, ctx).
        const input = args[1];
        const call: GateCall = { name: tool.name, input };
        for (const gate of session.gates) {
          const reason = gate.beforeCall?.(call) ?? null;
          if (reason) {
            session.log.push({ gate: gate.name, phase: "call", reason });
            throw new Error(reason);
          }
        }
        let ok = false;
        try {
          const result = await inner(...args);
          ok = true;
          return result;
        } finally {
          for (const gate of session.gates) {
            // An observer that throws would fail a call that actually
            // succeeded, so observation is never allowed to be fatal.
            try {
              gate.afterCall?.(call, ok);
            } catch {
              /* a broken gate must not break the run it is measuring */
            }
          }
        }
      },
    } as T;
  });
}

/**
 * Run the submission gates. Returns the refusal reason, or null to accept.
 *
 * Collects every gate's objection rather than stopping at the first, because
 * the agent gets one retry: telling it about one problem, letting it fix that,
 * and then accepting a submission that still fails a second gate wastes the
 * only correction available.
 */
export function checkSubmission(session: GateSession, output: unknown): string | null {
  if (session.submitRejections >= MAX_SUBMIT_REJECTIONS) return null;
  const reasons: string[] = [];
  for (const gate of session.gates) {
    const reason = gate.beforeSubmit?.(output) ?? null;
    if (reason) {
      reasons.push(reason);
      session.log.push({ gate: gate.name, phase: "submit", reason });
    }
  }
  if (!reasons.length) return null;
  session.submitRejections++;
  return reasons.join("\n\n");
}

// ── Gates ────────────────────────────────────────────────────

/**
 * The read-only bash allowlist, expressed as a gate.
 *
 * Behaviourally identical to the check inlined in the bash tool today; this
 * exists so the rule is declared alongside the others rather than buried in one
 * tool's `execute`, and so an agent that should NOT be read-only simply omits
 * the gate instead of threading an `askReadOnly` flag down.
 *
 * `deny` is injected rather than imported to keep this module free of the
 * runner, matching the purity rule the other gate modules follow.
 */
export function readOnlyBashGate(deny: (command: string) => string | null): ToolGate {
  return {
    name: "read-only-bash",
    beforeCall(call) {
      if (call.name !== "bash") return null;
      const command = String((call.input as { command?: unknown })?.command ?? "");
      if (!command.trim()) return null;
      return deny(command);
    },
  };
}

/**
 * Every finding must anchor to a line the diff actually touches.
 *
 * Today `snapLinesToDiff` drops off-diff findings after the fact, so a reviewer
 * that anchors badly loses the finding and never learns why. As a gate the
 * reviewer is told which anchor is wrong while it can still fix it — the
 * difference between losing a real defect and re-anchoring it.
 *
 * `inDiff` is supplied by the caller, which already knows the patch.
 */
export function anchorsInDiffGate(
  inDiff: (path: string, line: number) => boolean,
): ToolGate {
  return {
    name: "anchors-in-diff",
    beforeSubmit(output) {
      const findings = (output as { findings?: unknown })?.findings;
      if (!Array.isArray(findings)) return null;
      const bad = findings
        .map((f, i) => ({ f: f as { path?: unknown; line?: unknown }, i }))
        .filter(
          ({ f }) =>
            typeof f?.path === "string" &&
            typeof f?.line === "number" &&
            !inDiff(f.path, f.line),
        );
      if (!bad.length) return null;
      const list = bad
        .map(({ f, i }) => `  - finding ${i + 1}: ${String(f.path)}:${String(f.line)}`)
        .join("\n");
      return (
        `${bad.length} finding(s) anchor to a line this PR's diff does not touch, so they cannot ` +
        `be posted as inline comments:\n${list}\n\n` +
        `Re-anchor each one to a line that appears in the diff — for a problem in unchanged code, ` +
        `anchor to the changed line that reaches it. Drop any finding you cannot anchor, and keep ` +
        `the rest. Then submit again.`
      );
    },
  };
}

/**
 * A finding about a file the agent never opened.
 *
 * Kodus runs the same rule as a forced re-verification pass; as a gate it costs
 * nothing and fires before the claim is made rather than after. `wasRead` is
 * supplied by whatever is tracking reads for this run.
 */
export function evidenceGate(wasRead: (path: string) => boolean): ToolGate {
  return {
    name: "evidence",
    beforeSubmit(output) {
      const findings = (output as { findings?: unknown })?.findings;
      if (!Array.isArray(findings)) return null;
      const unread = [
        ...new Set(
          findings
            .map((f) => (f as { path?: unknown })?.path)
            .filter((p): p is string => typeof p === "string" && !wasRead(p)),
        ),
      ];
      if (!unread.length) return null;
      return (
        `You are reporting findings in files you never opened:\n` +
        unread.map((p) => `  - ${p}`).join("\n") +
        `\n\nRead each of those files and confirm the finding against the code on disk. ` +
        `Drop the ones that do not survive, keep the ones that do, then submit again.`
      );
    },
  };
}
