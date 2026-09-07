/**
 * The learnings type system: what a learning is, and the gates it must pass
 * before it changes what an agent does.
 *
 * Zero imports, like feedback-gates.ts, so the tests never touch a server
 * module. All I/O and model calls live in learnings.ts.
 *
 * ## Why gates at all
 *
 * An agent that writes down what it learned and then reads it back has no way
 * to be wrong about itself. The failure is documented across the literature and
 * we have a local instance of it: our review prompt carried a rule telling the
 * reviewer to ask for stricter test assertions, justified by authors acting on
 * 9 of 10 such requests. Those same requests are marked noise 94% of the time —
 * an author widens an assertion because it is cheaper than arguing. Read as
 * "was right", compliance taught us to produce more of the least valuable
 * finding we make.
 *
 * So an outcome signal is evidence, not truth, and a gate has to be able to
 * disagree with it.
 *
 * ## The lifecycle
 *
 *     proposed --[static gates]--> shadow --[replay gate]--> active
 *                    |                                        |
 *                    v                                        v
 *                 rejected                           demoted --> retired
 *
 * A learning changes behaviour only at `active`. `shadow` is the CI stage: the
 * learning exists, is measured, and is not yet allowed to affect anything —
 * the same reason a pull request runs its tests before it merges.
 *
 * ## The gates
 *
 * | gate | asks | fails when |
 * |---|---|---|
 * | well-formed | is this a usable instruction | too vague, too long, a question, hedged |
 * | supported | is this more than one incident | too few signals, or all from one pull request |
 * | consistent | does this fight something already active | contradicts an active learning |
 * | grounded | does the code it names still exist | a path or symbol it cites is gone |
 * | replay | does it actually help | measured effect is negative |
 *
 * The first four are static and cost nothing. `replay` costs a full evaluation
 * run, so it is the last one and only shadow learnings pay it.
 */

export type LearningStatus = "proposed" | "shadow" | "active" | "demoted" | "retired";

export type GateName = "well-formed" | "supported" | "consistent" | "grounded" | "replay";

export interface GateResult {
  gate: GateName;
  status: "pass" | "fail" | "skip";
  /** Why, in one line. Read by a human auditing why a rule is or is not live. */
  detail: string;
  at: string;
}

export interface LearningProvenance {
  /** How many feedback records support this. One is an anecdote. */
  signals: number;
  /** Distinct pull requests those signals came from. One is still an anecdote. */
  prs: number[];
  createdAt: string;
  /** What kind of signal produced it, for weighting and for audit. */
  sources: Array<"dismissed" | "ignored" | "addressed" | "reaction" | "reply" | "missed-bug">;
}

export interface LearningEffect {
  metric: string;
  before: number;
  after: number;
  /** How many evaluation cases the numbers came from. */
  cases: number;
  at: string;
}

export interface Learning {
  id: string;
  /** Imperative and specific. "Stop flagging X" or "Check for Y when Z". */
  text: string;
  /** calibration = stop or narrow something readers reject.
   *  focus = start checking something we demonstrably miss. */
  kind: "calibration" | "focus";
  /** Which agent this applies to. Review is the first; the machinery is not
   *  review-specific and the field is what keeps it that way. */
  domain: string;
  /** Repo key, or "*" for every repo. Narrow by default: a rule true of one
   *  codebase applied everywhere is the most-reported failure of these systems. */
  scope: string;
  status: LearningStatus;
  provenance: LearningProvenance;
  gates: GateResult[];
  effect?: LearningEffect;
  /** Ids this was found to contradict. Set by the consistent gate. */
  contradicts?: string[];
  /** Last time a signal supported this. Drives expiry. */
  lastSupportedAt?: string;
  statusChangedAt?: string;
}

// ── thresholds, all justified ────────────────────────────────

/** A learning shorter than this cannot be specific enough to act on. */
export const MIN_TEXT = 25;
/** Longer than this and it is a paragraph competing with the prompt itself. */
export const MAX_TEXT = 300;
/** Below this it is one person's opinion on one day. */
export const MIN_SIGNALS = 3;
/** The anti-anecdote rule. Three signals on one pull request is one incident
 *  with three comments on it, which is exactly what over-generalisation looks
 *  like from the inside. */
export const MIN_DISTINCT_PRS = 2;
/** Active learnings are prompt budget on every single run, so they compete. */
export const MAX_ACTIVE = 12;
/** No supporting signal for this long and the code has probably moved on. */
export const STALE_AFTER_MS = 60 * 24 * 60 * 60 * 1000;
/** A replay that moves the metric by less than this is noise, not evidence.
 *  Our own arms differed by one finding in 44 across a whole configuration
 *  change, so anything smaller cannot be attributed to one learning. */
export const MIN_EFFECT = 0.02;
/** A replay smaller than this cannot settle the question either way, so an
 *  inconclusive result at this size is a reason to measure again rather than a
 *  verdict. Our own first replay ran four cases and moved recall by zero
 *  points; that says the sample was too small, not that the learning is inert. */
export const REPLAY_MIN_CASES = 12;

/** Was this measurement large enough for its inconclusive result to mean
 *  anything? A regression or an improvement stands at any size — only the
 *  "inside noise" verdict depends on how much was measured. */
export function replayIsUnderpowered(effect: LearningEffect | undefined): boolean {
  if (!effect) return false;
  const delta = effect.after - effect.before;
  return Math.abs(delta) < MIN_EFFECT && effect.cases < REPLAY_MIN_CASES;
}

const now = () => new Date().toISOString();

/** Hedged or interrogative text cannot be followed. */
const VAGUE = /\b(consider|maybe|perhaps|might want|could be|try to|generally|sometimes|as needed|if possible|be careful|keep in mind)\b/i;
/** A learning that names nothing concrete applies to everything, which is the
 *  same as applying to nothing. */
const CONCRETE = /[`_.]|\b[a-z]+[A-Z][a-zA-Z]*\b|\b(when|unless|before|after|only)\b/;

export function gateWellFormed(text: string): GateResult {
  const t = (text || "").trim();
  const mk = (status: "pass" | "fail", detail: string): GateResult =>
    ({ gate: "well-formed", status, detail, at: now() });
  if (t.length < MIN_TEXT) return mk("fail", `${t.length} chars, under the ${MIN_TEXT} needed to be specific`);
  if (t.length > MAX_TEXT) return mk("fail", `${t.length} chars, over ${MAX_TEXT} — this is a paragraph, not a rule`);
  if (t.endsWith("?")) return mk("fail", "a question cannot be followed");
  if (VAGUE.test(t)) return mk("fail", `hedged wording: ${(t.match(VAGUE) || [])[0]}`);
  if (!CONCRETE.test(t)) return mk("fail", "names nothing concrete — no symbol, path, or condition");
  return mk("pass", `${t.length} chars, imperative, names a condition or symbol`);
}

export function gateSupported(p: LearningProvenance): GateResult {
  const mk = (status: "pass" | "fail", detail: string): GateResult =>
    ({ gate: "supported", status, detail, at: now() });
  const prs = new Set(p?.prs || []).size;
  if (!p || p.signals < MIN_SIGNALS)
    return mk("fail", `${p?.signals ?? 0} signals, under the ${MIN_SIGNALS} needed`);
  if (prs < MIN_DISTINCT_PRS)
    return mk("fail", `all ${p.signals} signals from ${prs} pull request — one incident, not a pattern`);
  return mk("pass", `${p.signals} signals across ${prs} pull requests`);
}

/**
 * Does this fight something already live?
 *
 * Deliberately narrow. A model decides semantic contradiction elsewhere; this
 * catches the mechanical case, which is a calibration rule and a focus rule
 * that name the same thing in opposite directions — "stop flagging X" beside
 * "check for X". Those cannot both be followed, and shipping both is how a
 * store starts contradicting itself.
 */
export function gateConsistent(candidate: Learning, active: Learning[]): GateResult {
  const mk = (status: "pass" | "fail", detail: string, ids?: string[]): GateResult =>
    ({ gate: "consistent", status, detail: ids?.length ? `${detail}: ${ids.join(", ")}` : detail, at: now() });
  const key = (t: string) =>
    new Set((t.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || [])
      .filter((w) => !STOP.has(w)));
  const mine = key(candidate.text);
  if (!mine.size) return mk("pass", "no comparable terms");
  const clash: string[] = [];
  for (const a of active) {
    if (a.id === candidate.id) continue;
    if (a.domain !== candidate.domain) continue;
    if (a.scope !== candidate.scope && a.scope !== "*" && candidate.scope !== "*") continue;
    if (a.kind === candidate.kind) continue;
    const theirs = key(a.text);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    const overlap = shared / Math.min(mine.size, theirs.size);
    if (overlap >= 0.5) clash.push(a.id);
  }
  return clash.length
    ? mk("fail", `opposes an active learning on the same subject`, clash)
    : mk("pass", `no active learning opposes it`);
}

const STOP = new Set([
  "the","this","that","with","from","into","when","then","than","they","them",
  "have","has","had","will","would","should","could","must","not","and","for",
  "are","was","were","been","being","its","it's","which","what","where","only",
  "flag","flagging","report","reporting","raise","raising","check","checking",
]);

/**
 * Did it help?
 *
 * The strongest gate and the only one that costs money. `resolve` reports what
 * a replay measured; a learning with no measurement skips rather than fails,
 * because "not yet measured" and "measured and useless" are different states
 * and only the second should block promotion.
 */
export function gateReplay(effect: LearningEffect | undefined): GateResult {
  const mk = (status: "pass" | "fail" | "skip", detail: string): GateResult =>
    ({ gate: "replay", status, detail, at: now() });
  if (!effect) return mk("skip", "not measured yet");
  const delta = effect.after - effect.before;
  if (delta < -MIN_EFFECT)
    return mk("fail", `${effect.metric} fell ${(-delta * 100).toFixed(1)} points over ${effect.cases} cases`);
  if (delta < MIN_EFFECT) {
    const short = effect.cases < REPLAY_MIN_CASES ? ` — inside noise on too few cases, needs ${REPLAY_MIN_CASES}` : " — inside noise";
    return mk("skip", `${effect.metric} moved ${(delta * 100).toFixed(1)} points over ${effect.cases} cases${short}`);
  }
  return mk("pass", `${effect.metric} rose ${(delta * 100).toFixed(1)} points over ${effect.cases} cases`);
}

/** The static gates, in the order they should run: cheapest first. */
export function runStaticGates(candidate: Learning, active: Learning[]): GateResult[] {
  return [
    gateWellFormed(candidate.text),
    gateSupported(candidate.provenance),
    gateConsistent(candidate, active),
  ];
}

/**
 * Where should this learning sit, given its gates?
 *
 * Pure, and the single place status is decided, so the rule is auditable in one
 * function rather than spread across the callers that write the store.
 */
export function decideStatus(
  candidate: Learning,
  gates: GateResult[],
  nowMs: number,
): { status: LearningStatus; reason: string } {
  const failed = gates.filter((g) => g.status === "fail");
  if (failed.length)
    return { status: "demoted", reason: `${failed[0]!.gate} failed: ${failed[0]!.detail}` };

  const last = Date.parse(candidate.lastSupportedAt || candidate.provenance?.createdAt || "");
  if (Number.isFinite(last) && nowMs - last > STALE_AFTER_MS)
    return { status: "retired", reason: `no supporting signal in ${Math.round((nowMs - last) / 86400000)} days` };

  const replay = gates.find((g) => g.gate === "replay");
  if (replay?.status === "pass")
    return { status: "active", reason: `replay: ${replay.detail}` };
  return { status: "shadow", reason: replay ? `awaiting a measurable effect (${replay.detail})` : "static gates passed, not yet replayed" };
}

/**
 * The learnings that actually reach a prompt.
 *
 * Active only, capped, and ordered by measured effect so the cap trims what has
 * earned least. A learning with no measurement sorts below one with a positive
 * effect and above one with none — it passed its static gates, which is more
 * than nothing.
 */
export function selectForPrompt(all: Learning[], domain: string, scope: string): Learning[] {
  return all
    .filter((l) => l.status === "active" && l.domain === domain)
    .filter((l) => l.scope === "*" || l.scope === scope)
    .sort((a, b) => effectOf(b) - effectOf(a))
    .slice(0, MAX_ACTIVE);
}

function effectOf(l: Learning): number {
  return l.effect ? l.effect.after - l.effect.before : 0;
}
