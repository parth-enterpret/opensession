/**
 * The learnings store: what opensession has learned from its own work, and
 * which of it is allowed to change what an agent does.
 *
 * Decision logic lives in learnings-gates.ts. This module owns the store, the
 * distillation call, and the lifecycle transitions.
 *
 * ## How it differs from learned-rules.ts
 *
 * learned-rules distils rules from feedback and injects them into the next
 * review. There is no step at which a rule can be found wrong. Its validation
 * checks that a rule is well-formed, which is a different question from whether
 * it is true or whether it helps.
 *
 * This adds the missing step. A distilled rule becomes a `shadow` learning:
 * stored, visible, measured, and not yet used. It reaches a prompt only after a
 * replay shows the metric moved. That is the CI analogy the design is built on —
 * a change runs its tests before it merges, and a learning is a change to how
 * the agent behaves.
 *
 * ## Provenance is computed, not claimed
 *
 * The distiller is asked which numbered signals support each rule, and the
 * store maps those indices back to pull requests itself. A model that invents
 * support therefore fails the `supported` gate rather than passing it with a
 * confident sentence, because the pull-request count comes from the data.
 *
 * ## Domains
 *
 * `domain` is "review" today. Nothing here is review-specific: the gates take a
 * Learning, the store is keyed by domain, and a second agent adds a domain
 * rather than a parallel system.
 */
import { existsSync, readFileSync } from "fs";
import { stateDir } from "../../server/paths";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { audit } from "../../server/audit";
import { defaultRepo } from "../../server/config";
import { oneShot } from "../../server/one-shot";
import { repoForFullName } from "./constants";
import { readFeedback } from "./feedback";
import { isNegativeSignal, isPositiveSignal, type FeedbackRecord } from "./feedback-gates";
import {
  decideStatus, gateReplay, replayIsUnderpowered, runStaticGates, selectForPrompt,
  MAX_TEXT, MIN_DISTINCT_PRS, MIN_SIGNALS,
  type GateResult, type Learning, type LearningEffect, type LearningProvenance,
} from "./learnings-gates";

const STATE_DIR = stateDir("github");
/** Distillation is judgement work — which patterns generalise, which are one
 *  engineer's afternoon. It runs rarely, so it uses a frontier model. */
const DISTILL_MODEL = "pi/anthropic/claude-fable-5";

export interface LearningsFile {
  updatedAt: string;
  /** Signal count at the last distill, so the due-check has a progress marker. */
  signalCount: number;
  learnings: Learning[];
}

function repoKey(ghRepo?: string): string {
  return !ghRepo || ghRepo.toLowerCase() === defaultRepo().ghRepo.toLowerCase()
    ? "default"
    : repoForFullName(ghRepo)?.id || ghRepo.replace(/[^A-Za-z0-9._-]/g, "_");
}

function storePath(ghRepo?: string): string {
  return `${STATE_DIR}/learnings-${repoKey(ghRepo)}.json`;
}

export function readLearnings(ghRepo?: string): LearningsFile {
  const path = storePath(ghRepo);
  if (!existsSync(path)) return { updatedAt: "", signalCount: 0, learnings: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as LearningsFile;
    return Array.isArray(parsed?.learnings) ? parsed : { updatedAt: "", signalCount: 0, learnings: [] };
  } catch {
    // A corrupt store must not take the review with it. An empty store means
    // the agent behaves as it did before it learned anything, which is safe.
    return { updatedAt: "", signalCount: 0, learnings: [] };
  }
}

function writeLearnings(file: LearningsFile, ghRepo?: string): void {
  writeJsonAtomic(storePath(ghRepo), { ...file, updatedAt: new Date().toISOString() });
}

/**
 * Prompt section. Active learnings only — shadow ones are deliberately unused.
 *
 * One exception, and it is the mechanism the replay gate is built on:
 * `OPENSESSION_LEARNING_TRIAL=<id>` adds that one shadow learning for the
 * duration of a run. Running the evaluation corpus with the variable unset and
 * then set is the paired A/B the gate scores, and it is the only way a shadow
 * learning can influence output at all.
 *
 * Deliberately an environment variable rather than a stored flag. A trial is a
 * property of one measurement run, not of the learning, so it cannot leak into
 * production by being left set in a file somebody forgot about.
 */
export function learningsSection(ghRepo?: string, domain = "review"): string {
  const all = readLearnings(ghRepo).learnings;
  const chosen = selectForPrompt(all, domain, repoKey(ghRepo));
  const trialId = process.env.OPENSESSION_LEARNING_TRIAL;
  if (trialId) {
    const trial = all.find((l) => l.id === trialId && l.status === "shadow" && l.domain === domain);
    if (trial && !chosen.some((l) => l.id === trial.id)) {
      chosen.push(trial);
      console.log(`[github] learning trial: ${trial.id} included for this run only`);
    }
  }
  if (!chosen.length) return "";
  const line = (l: Learning) => {
    const e = l.effect ? ` [measured: ${l.effect.metric} ${(100 * (l.effect.after - l.effect.before)).toFixed(0)}pt over ${l.effect.cases} cases]` : "";
    return `- (${l.kind}) ${l.text}${e}`;
  };
  return `## Learned calibration for this repo

Each line below was distilled from reader feedback on past reviews, and then
measured: it is here because a replay over recorded pull requests showed it
moved the outcome. Learnings that failed that check are not shown to you.

${chosen.map(line).join("\n")}

These adjust how you weigh and word findings. They never override the reporting
bar, and never justify suppressing a P1 or inventing one.`;
}

// ── extraction ───────────────────────────────────────────────

function hasSignal(r: FeedbackRecord): boolean {
  return !!(r.outcome || r.falseNegative || r.replySignal || (r.plus || 0) > 0 || (r.minus || 0) > 0);
}

function sourceOf(r: FeedbackRecord): LearningProvenance["sources"][number] {
  if (r.falseNegative) return "missed-bug";
  if (r.replySignal) return "reply";
  if ((r.plus || 0) > 0 || (r.minus || 0) > 0) return "reaction";
  return r.outcome === "addressed" ? "addressed" : "ignored";
}

function clip(text: string, cap: number): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

/**
 * Build the distill prompt over NUMBERED signals.
 *
 * The numbering is the point. The model returns which indices support each
 * rule, and the store resolves those to pull requests itself, so the
 * `supported` gate is checking data rather than a claim.
 */
function buildPrompt(ghRepo: string, indexed: Array<{ i: number; r: FeedbackRecord }>, current: Learning[]): string {
  const fmt = (x: { i: number; r: FeedbackRecord }) => {
    const r = x.r;
    const tag = r.falseNegative ? "MISSED BUG"
      : r.replySignal === "dismissive" ? "author pushed back"
      : isNegativeSignal(r) ? "rejected"
      : isPositiveSignal(r) ? "valued" : "signal";
    return `[${x.i}] (${tag}, PR #${r.pr}) ${clip(`${r.title}: ${r.text}`, 200)}`;
  };
  const live = current.filter((l) => l.status === "active" || l.status === "shadow");
  return `You maintain the learnings for an automated pull request reviewer on ${ghRepo}.

Below are numbered outcome signals from its past findings. Distil them into a
small number of learnings the reviewer will read before each review.

SIGNALS
${indexed.map(fmt).join("\n")}

CURRENT LEARNINGS (refine or drop what the signals no longer support)
${live.length ? live.map((l) => `- [${l.status}] (${l.kind}) ${l.text}`).join("\n") : "(none yet)"}

Write each learning as one or two imperative sentences that name something
concrete: a symbol, a path, a condition, a bug class. A learning that names
nothing applies to everything, which is the same as applying to nothing.

The gates below run on your output automatically and reject it without asking
you again, so treat them as the contract rather than as advice:

- HARD LIMIT ${MAX_TEXT} CHARACTERS per learning. The first run of this prompt had
  two of three candidates rejected at 418 and 372 characters. If you cannot say
  it in ${MAX_TEXT}, you are describing an incident rather than a rule.
- At least ${MIN_SIGNALS} supporting signals, from at least ${MIN_DISTINCT_PRS} different pull
  requests.
- No hedging. "consider", "maybe", "generally", "be careful", "as needed" and a
  trailing question mark are each an automatic rejection, because a disposition
  cannot be followed and cannot be measured.

- "calibration" narrows a pattern readers reject. It must be scoped so it could
  never suppress a genuine P1.
- "focus" adds a check, and comes from a signal marked MISSED BUG.

Two rules about evidence, and they are checked mechanically after you answer:

1. Cite the signal indices that support each learning in "supportedBy". Do not
   cite a signal that does not support it — the store resolves your indices to
   pull requests and rejects a learning whose support is thin.
2. A learning supported by signals from only ONE pull request is rejected
   automatically, however many signals that is. Three comments on one pull
   request is one incident. Prefer patterns you can see in more than one place.

Fewer, sharper learnings beat coverage. Returning an empty list is a correct
answer when the signals do not support anything general.

Output ONLY JSON: {"learnings":[{"text":"...","kind":"calibration"|"focus","supportedBy":[1,4,9]}]}`;
}

function parseCandidates(text: string): Array<{ text: string; kind: string; supportedBy: number[] }> {
  const open = (text || "").lastIndexOf("{");
  if (open === -1) return [];
  for (const slice of [text.slice(open), text]) {
    try {
      const o = JSON.parse(slice.slice(slice.indexOf("{"), slice.lastIndexOf("}") + 1));
      const arr = Array.isArray(o?.learnings) ? o.learnings : [];
      return arr.filter((x: any) => x && typeof x.text === "string").map((x: any) => ({
        text: String(x.text),
        kind: x.kind === "focus" ? "focus" : "calibration",
        supportedBy: Array.isArray(x.supportedBy) ? x.supportedBy.filter((n: any) => Number.isInteger(n)) : [],
      }));
    } catch { /* try the next slice */ }
  }
  return [];
}

let seq = 0;
const newId = () => `L${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Distil candidates from feedback, gate them, and store the result.
 *
 * Everything admitted lands in `shadow`. Nothing here can promote a learning to
 * active — only a recorded replay effect does that, through recordEffect.
 */
export async function distillLearnings(ghRepo?: string, force = false): Promise<{ proposed: number; admitted: number }> {
  const records = readFeedback(ghRepo).filter(hasSignal);
  const file = readLearnings(ghRepo);
  if (!force && records.length - file.signalCount < 5) return { proposed: 0, admitted: 0 };

  const indexed = records.slice(-60).map((r, i) => ({ i: i + 1, r }));
  const repoFull = ghRepo || defaultRepo().ghRepo;
  const out = await oneShot(
    buildPrompt(repoFull, indexed, file.learnings),
    { model: DISTILL_MODEL },
  ).catch(() => "");
  const candidates = parseCandidates(String(out || ""));

  const nowIso = new Date().toISOString();
  const active = file.learnings.filter((l) => l.status === "active");
  const admitted: Learning[] = [];

  for (const c of candidates) {
    // Provenance from the data, not from the model's sentence about the data.
    const cited = c.supportedBy
      .map((i) => indexed.find((x) => x.i === i)?.r)
      .filter((r): r is FeedbackRecord => !!r);
    const prov: LearningProvenance = {
      signals: cited.length,
      prs: [...new Set(cited.map((r) => r.pr))],
      createdAt: nowIso,
      sources: [...new Set(cited.map(sourceOf))],
    };
    const candidate: Learning = {
      id: newId(),
      text: c.text.replace(/\s+/g, " ").trim(),
      kind: c.kind === "focus" ? "focus" : "calibration",
      domain: "review",
      scope: repoKey(ghRepo),
      status: "proposed",
      provenance: prov,
      gates: [],
      lastSupportedAt: nowIso,
    };
    const gates = [...runStaticGates(candidate, active), gateReplay(undefined)];
    const { status, reason } = decideStatus(candidate, gates, Date.now());
    candidate.gates = gates;
    candidate.status = status;
    candidate.statusChangedAt = nowIso;
    if (status === "shadow") admitted.push(candidate);
    audit({
      msg: "learning_gated", repo: repoFull, learning_id: candidate.id,
      status, reason, kind: candidate.kind,
      signals: prov.signals, prs: prov.prs.length,
      gates: gates.map((g) => `${g.gate}:${g.status}`).join(","),
    });
  }

  // Keep everything that already had a status; add the newly admitted.
  writeLearnings({
    updatedAt: nowIso,
    signalCount: records.length,
    learnings: [...file.learnings.filter((l) => l.status !== "retired"), ...admitted],
  }, ghRepo);
  console.log(
    `[github] learnings on ${repoFull}: ${candidates.length} proposed, ${admitted.length} admitted to shadow`,
  );
  return { proposed: candidates.length, admitted: admitted.length };
}

/**
 * Attach a replay measurement and re-decide the learning's status.
 *
 * This is the only path to `active`. A measurement that regresses demotes, and
 * one inside the noise floor leaves the learning in shadow rather than
 * promoting it on a rounding error.
 */
export function recordEffect(id: string, effect: LearningEffect, ghRepo?: string): Learning | null {
  const file = readLearnings(ghRepo);
  const l = file.learnings.find((x) => x.id === id);
  if (!l) return null;
  const active = file.learnings.filter((x) => x.status === "active" && x.id !== id);
  l.effect = effect;
  const gates: GateResult[] = [...runStaticGates(l, active), gateReplay(effect)];
  const { status, reason } = decideStatus(l, gates, Date.now());
  l.gates = gates;
  l.status = status;
  l.statusChangedAt = new Date().toISOString();
  writeLearnings(file, ghRepo);
  audit({
    msg: "learning_effect_recorded", repo: ghRepo || defaultRepo().ghRepo,
    learning_id: id, status, reason,
    metric: effect.metric, delta: effect.after - effect.before, cases: effect.cases,
  });
  console.log(`[github] learning ${id}: ${status} — ${reason}`);
  return l;
}

/** Learnings waiting on a measurement, oldest first. What the replay runs next. */
export function pendingReplay(ghRepo?: string, domain = "review"): Learning[] {
  return readLearnings(ghRepo).learnings
    .filter((l) => l.status === "shadow" && l.domain === domain
      && (!l.effect || replayIsUnderpowered(l.effect)))
    .sort((a, b) => (a.provenance.createdAt || "").localeCompare(b.provenance.createdAt || ""));
}

/** Re-run the static gates over the whole store, for staleness and contradiction. */
export function revalidate(ghRepo?: string): { changed: number } {
  const file = readLearnings(ghRepo);
  const nowMs = Date.now();
  let changed = 0;
  for (const l of file.learnings) {
    if (l.status === "retired") continue;
    const others = file.learnings.filter((x) => x.status === "active" && x.id !== l.id);
    const gates = [...runStaticGates(l, others), gateReplay(l.effect)];
    const { status, reason } = decideStatus(l, gates, nowMs);
    if (status !== l.status) {
      audit({ msg: "learning_status_changed", learning_id: l.id, from: l.status, to: status, reason });
      l.status = status;
      l.statusChangedAt = new Date().toISOString();
      changed++;
    }
    l.gates = gates;
  }
  if (changed) writeLearnings(file, ghRepo);
  return { changed };
}

/** Human-readable audit of the store. Why is this rule live, and what proved it. */
export function learningsReport(ghRepo?: string): string {
  const file = readLearnings(ghRepo);
  if (!file.learnings.length) return "No learnings recorded yet.";
  const order: Learning["status"][] = ["active", "shadow", "demoted", "retired"];
  const lines: string[] = [`Learnings for ${ghRepo || defaultRepo().ghRepo} (updated ${file.updatedAt || "never"})`, ""];
  for (const status of order) {
    const group = file.learnings.filter((l) => l.status === status);
    if (!group.length) continue;
    lines.push(`## ${status} (${group.length})`, "");
    for (const l of group) {
      const e = l.effect ? `${l.effect.metric} ${l.effect.before} -> ${l.effect.after} over ${l.effect.cases} cases` : "not measured";
      lines.push(`- [${l.kind}] ${l.text}`);
      lines.push(`    evidence : ${l.provenance.signals} signals across ${l.provenance.prs.length} PRs (${l.provenance.sources.join(", ")})`);
      lines.push(`    replay   : ${e}`);
      lines.push(`    gates    : ${l.gates.map((g) => `${g.gate}=${g.status}`).join(" ")}`);
      const failed = l.gates.find((g) => g.status === "fail");
      if (failed) lines.push(`    blocked  : ${failed.detail}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
