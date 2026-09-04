/**
 * Per-file fan-out for PR review — the recall stage of a three-stage review.
 *
 * One agent turn over 34 files spends ~9 seconds of attention per file and
 * finds ~1 defect where per-hunk reviewers find 30. The model is not the
 * problem (GPT-5.6 Sol and Sonnet 5 produced the same count), the prompt is not
 * the problem (Codex's own published rubric produced the same count), and an
 * explicit "one file at a time" instruction is not the fix (same count again).
 * What differs is pipeline shape: a separate request, with a separate attention
 * budget, per location.
 *
 * So: partition the diff into batches and run the review agent once per batch
 * with a recall bias (stage 1), hand each candidate to its OWN verifier with a
 * fresh context that tries to refute it (stage 2), then assemble the survivors
 * deterministically (stage 3). Greptile measured a model rating its own output
 * on a 1-10 scale as "nearly random", so a verifier is always a separate
 * conversation with its own tool access, never a self-rating turn appended to
 * the batch that produced the candidate.
 *
 * Stage 2 is fanned out for the same reason stage 1 is: the single adjudication
 * pass it replaces put one attention budget over the whole candidate list and
 * cut 8 of 9 real-looking findings. See VERIFY below.
 *
 * This module is the deterministic part: what the batches are, how their
 * candidates merge, which candidates get verified, and how the survivors become
 * a review. The prompts live in prompts.ts, the orchestration in review.ts.
 */
import { severityRank } from "./review-options";
import type { Finding, ReviewOutput } from "./review";

export interface ReviewBatch {
  /** 1-based, and part of the batch's session id — stable within one review. */
  index: number;
  files: string[];
  /** Added + removed lines across the batch's files, for its wall-clock share. */
  lines: number;
  /**
   * The one behaviour this batch investigates, when it came from stage 0.
   * Absent on coverage batches, which are scoped by file and nothing else.
   *
   * A batch with a question reviews a FLOW across its files; a batch without one
   * reviews the files. Both exist because they miss different things — see
   * `planHypothesisBatches`.
   */
  question?: string;
}

export const FANOUT = {
  /**
   * Below this many changed files, stay single-pass. A 2-file PR already gets
   * a correct review in ~18s on the existing path, and fanning it out buys
   * nothing but latency and spend.
   */
  minFiles: 5,
  /**
   * Files per batch. Measured 2026-09-04 on enterpret-showcase#12182 (34 files,
   * 2,015 lines): at 3 files per batch the sweep covered every file — 12/12
   * batches, all 34 files seen — and still found 0 of the 31 defects the
   * incumbent reviewers found. Their four densest files yielded 14 findings to
   * them and none to us, so the misses were not coverage. ~170 lines a batch is
   * roughly 7x the attention density of a single whole-diff pass, and that was
   * not enough to change what got noticed.
   *
   * One file per batch is the strongest signal available and the most
   * expensive. Take it: cost is the thing we can afford to spend here, and
   * coverage without depth has now been measured as worth nothing.
   */
  filesPerBatch: 1,
  /** …unless the slice is already big. A 900-line file gets its batch alone. */
  linesPerBatch: 300,
  /**
   * Hard ceiling on runs per review, so a 200-file PR cannot spawn 200 of them.
   * Past this the batches simply get bigger — recall degrades toward the
   * single-pass baseline instead of the cost exploding. The other giant-PR
   * escape hatch (`summaryOnlyOverFiles`, default 80) still fires first and
   * skips the sweep entirely.
   */
  maxBatches: 40,
  /** Batches in flight at once. The workflow runner already treats 8 parallel
   *  read-only agents as safe; reviews also run concurrently across PRs, so
   *  this stays well under that. */
  concurrency: 6,
  /**
   * Stage 1's share of the review's wall clock, as a fraction of the budget a
   * single-pass review of the same diff would get. Unchanged: on the measured
   * 34-file PR the sweep finished 12 batches in 438s against a 27-minute
   * deadline, so this is not what is binding, and stage 1's 9/31 discovery
   * ceiling is the next constraint — starving it would be the wrong move.
   * Stage 2 gets VERIFY.budgetFraction (0.4) and stage 3 costs nothing, so a
   * fanned-out review is bounded at ~1.0x the single-pass wall clock plus one
   * straggler per stage — DOWN from ~1.6x, because the full-budget adjudication
   * run it replaces is gone.
   */
  stageOneBudgetFraction: 0.6,
};

/**
 * Changed files and their churn, straight from the unified diff. `PrDetails.files`
 * would be tidier but `getPrAutomationDetails` returns it empty on the REST-lite
 * path, and reviews run from exactly that path.
 */
export function changedFilesFromPatch(patch: string): Array<{ path: string; lines: number }> {
  const out: Array<{ path: string; lines: number }> = [];
  let cur: { path: string; lines: number } | null = null;
  let inHunk = false;
  for (const line of (patch || "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      let p = line.slice(4).trim();
      if (p === "/dev/null") {
        cur = null; // deleted file — nothing on the right side to review
        continue;
      }
      // git quotes paths with spaces/unicode as "b/foo bar.ts"
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      if (p.startsWith("b/")) p = p.slice(2);
      cur = { path: p, lines: 0 };
      out.push(cur);
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (inHunk && cur && (line[0] === "+" || line[0] === "-")) cur.lines++;
  }
  return out;
}

/**
 * Partition a PR's changed files into recall batches. Returns `[]` when the PR
 * is small enough that the existing single pass is the right shape.
 *
 * `ignore` drops paths the repo excludes from review (.os-review.json
 * ignoreGlobs) before partitioning, so a lockfile never claims a batch slot.
 */
export function planReviewBatches(
  patch: string,
  ignore?: (path: string) => boolean,
  cfg = FANOUT,
): ReviewBatch[] {
  const files = changedFilesFromPatch(patch).filter((f) => !ignore?.(f.path));
  if (files.length < cfg.minFiles) return [];

  // Sizing the batch from the file count first is what makes the ceiling a
  // ceiling: `ceil(n / maxBatches)` files per batch can never produce more than
  // `maxBatches` splits, and the line cap below only ever splits earlier.
  const perBatch = Math.max(cfg.filesPerBatch, Math.ceil(files.length / cfg.maxBatches));
  const batches: ReviewBatch[] = [];
  let cur: ReviewBatch | null = null;
  for (const f of files) {
    const full = !!cur && (cur.files.length >= perBatch || cur.lines >= cfg.linesPerBatch);
    if (!cur || (full && batches.length < cfg.maxBatches)) {
      cur = { index: batches.length + 1, files: [], lines: 0 };
      batches.push(cur);
    }
    cur.files.push(f.path);
    cur.lines += f.lines;
  }
  // ponytail: at the ceiling the last batch absorbs the remainder, so a PR that
  // trips the line cap repeatedly can end with one oversized batch. Cheaper than
  // a bin-packer, and that PR was already over the fan-out budget.
  return batches;
}

const normalize = (s?: string): string =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Collapse the same defect reported by two batches into one finding.
 *
 * Batches own disjoint files, so a duplicate means both reached the same place:
 * usually a blast-radius finding about a caller that lives in someone else's
 * slice. Two keys, because the two batches rarely anchor identically — same
 * `path:line`, or the same claim anywhere in the same file. Ordering by
 * severity first means the surviving copy is the more severe one, and it also
 * puts P1s ahead of P2s, which is the order the contract asks for.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of [...findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  )) {
    const claim = normalize(f.title) || normalize(f.body).slice(0, 80);
    const keys = [`${f.path}:${f.line}`, `${f.path}|${claim}`];
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(f);
  }
  return out;
}

// ── Stage 2: per-candidate verification ──────────────────────
/**
 * Stage 2's knobs. Measured on enterpret-showcase#12182 (34 files, +1614/-401):
 * stage 1 raised discovery from ~1 to 9 candidates, and the single adjudication
 * pass that followed cut 8 of the 9. No `withheld` count was recorded, so the
 * downstream config/feedback filters are ruled out — the adjudicator itself did
 * it. That pass had the same shape stage 1 exists to escape (one attention
 * budget over many items) and the wrong prior on top of it: it applied
 * DEFAULT_REVIEW_PROMPT's seven-condition bar, which is tuned for a reviewer
 * with a noise problem, to a list produced by a reviewer biased for recall.
 *
 * So stage 2 is one verifier per candidate, fresh context, concurrent — the
 * same shape as stage 1, pointed at one claim instead of one slice — and its
 * default is KEEP. It drops a candidate only when it can name the concrete
 * reason the claim is wrong.
 */
export const VERIFY = {
  /**
   * Verifier runs in flight. Above stage 1's 4: a verifier reads one file and
   * greps its callers where a batch reads three files whole, so the turns are
   * shorter and the wave finishes sooner. Still under the 8 parallel read-only
   * agents the workflow runner treats as safe, which reviews share across PRs.
   */
  concurrency: 6,
  /**
   * Hard ceiling on verifier runs per review. Candidates arrive severity-sorted
   * out of `dedupeFindings`, so anything past the ceiling is the least severe of
   * the list — those survive UNVERIFIED rather than dropping (see
   * `planVerifications`), and `assembleReview`'s volume cap trims the tail.
   */
  max: 24,
  /**
   * Stage 2's share of the wall clock a single-pass review of this diff would
   * get. Stage 1 keeps its 0.6 unchanged — it is the binding constraint on the
   * 9/31 discovery ceiling and there is no reason to starve it — and assembly
   * costs nothing, so a fanned-out review now runs at ~1.0x the single-pass
   * budget, DOWN from ~1.6x, because the full-budget adjudication run this
   * replaces is gone.
   */
  budgetFraction: 0.4,
  /**
   * Per-verifier wall clock, as a fraction of the review budget's floor. One
   * claim against one file is a small fraction of a whole review; the fraction
   * (rather than a constant) keeps `OPENSESSION_GITHUB_RUN_TIMEOUT_MS` working
   * as the operator override it already is.
   */
  turnFraction: 0.25,
  /**
   * Volume guidance, lifted from the review prompt: ~3 findings per 100 changed
   * lines is where relevance starts falling.
   */
  perHundredLines: 3,
  /**
   * …with a floor, because under ~165 lines that ratio is tighter than the
   * finder's own error bar and would cut real defects to satisfy a heuristic.
   */
  minFindings: 5,
};

/**
 * Split candidates into the ones that get a verifier and the ones that do not.
 *
 * The overflow survives unverified. Dropping it would make recall depend on how
 * many candidates happened to fit under a constant, which is the failure this
 * whole stage exists to remove.
 */
export function planVerifications(
  candidates: Finding[],
  cfg = VERIFY,
): { verify: Finding[]; unverified: Finding[] } {
  return { verify: candidates.slice(0, cfg.max), unverified: candidates.slice(cfg.max) };
}

/**
 * Stage 3: assemble the survivors into the review the contract expects.
 *
 * No model call. Everything here is derivable — the verdict from the severities,
 * the volume cap from the diff size, the summary from the counts the pipeline
 * already has. Re-running the seven-condition bar over survivors that a verifier
 * has already checked one at a time would reinstate exactly the bottleneck this
 * change removes, and a model that reaches the findings list at all can cut it.
 *
 * The cost is the prose: a fanned-out review's summary no longer describes what
 * the PR does (the author knows) and carries no mermaid diagram. What it does
 * carry — how many passes ran, how many candidates were raised, how many
 * survived — is the thing a reader actually needs to judge the review by, and
 * it is the same accounting the audit event records.
 */
export function assembleReview(
  survivors: Finding[],
  ctx: {
    changedFiles: number;
    changedLines: number;
    batches: number;
    candidates: number;
    refuted: number;
  },
  cfg = VERIFY,
): ReviewOutput {
  const cap = Math.max(
    cfg.minFindings,
    Math.ceil((cfg.perHundredLines * Math.max(ctx.changedLines, 0)) / 100),
  );
  // dedupeFindings sorts severity-first, so the cap trims the least severe tail.
  const ranked = dedupeFindings(survivors);
  const findings = ranked.slice(0, cap);
  const trimmed = ranked.length - findings.length;
  const blocking = findings.filter((f) => severityRank(f.severity) <= 1).length;

  const n = (count: number, word: string, plural = `${word}s`) =>
    `${count} ${count === 1 ? word : plural}`;
  const lead = blocking
    ? `Not safe to merge yet — ${n(blocking, "P1 finding")} below.`
    : findings.length
      ? `Nothing blocking. ${n(findings.length, "non-blocking finding")} below.`
      : "Nothing to report: no candidate survived verification against the code on disk.";
  const how =
    `Reviewed ${n(ctx.changedFiles, "changed file")} (${ctx.changedLines} lines) as ` +
    `${n(ctx.batches, "independent pass", "independent passes")}, which raised ` +
    `${n(ctx.candidates, "candidate")}; ` +
    `each was then re-checked in its own fresh context against the code on disk` +
    (ctx.refuted ? `, and ${ctx.refuted} of them refuted` : "") +
    `.` +
    (trimmed ? ` ${n(trimmed, "further finding")} held back by the volume bar.` : "");

  return {
    verdict: blocking ? "request_changes" : findings.length ? "comment" : "approve",
    confidence: blocking ? 2 : findings.length ? 4 : 5,
    summary_markdown: `${lead} ${how}`,
    findings,
  };
}

// -- Stage 0: hypothesis planning ----------------------------
/**
 * Stage 0's knobs, and the reason this stage exists at all.
 *
 * Per-file batching was measured and found insufficient in a specific way.
 * Giving `PromptEditorRoot.tsx` an entire batch to itself produced 0 findings
 * where the incumbent reviewers found 4 in that same file. More attention on
 * one file did not surface them, so attention density was never the binding
 * constraint. Their 31 findings are feature-semantic: a defect in how a pasted
 * link survives serialize / render / copy / edit, spread across five files that
 * each look locally correct. A reviewer scoped to one file cannot see a
 * five-file behaviour, however long it stares.
 *
 * Every incumbent that beats us made the same move away from file scope.
 * Greptile's v2 flowchart looped `for each changed file`, and their v5 replaced
 * it with "a swarm of agents that each explore one hypothesis for a potential
 * bug". Wealthfront spawns sub-agents per proposed problem. pr-af partitions by
 * LLM-chosen "dimensions". So stage 0 asks one cheap pass over the whole diff
 * which behaviours this PR changes, and stage 1 runs one agent per behaviour.
 *
 * Hypothesis batches are ADDED TO file coverage, never substituted for it. A
 * question the planner failed to ask would otherwise silently un-review a file,
 * and coverage is still necessary even though it has been shown insufficient.
 * The cost of running both is real and affordable: published per-PR cost for
 * comparable agentic pipelines sits at $1-5, and Cloudflare runs a seven-agent
 * fleet at $1.19 average.
 */
export const HYPOTHESIS = {
  /**
   * Below this many changed files there is no cross-file flow to miss, and the
   * coverage batches already read every line. Matches FANOUT.minFiles so the
   * two stages switch on together.
   */
  minFiles: 5,
  /** Hard ceiling on questions, i.e. on extra agent runs per review. */
  max: 12,
  /**
   * Files a single question may claim. A question that implicates half the PR
   * is not a hypothesis, it is a restatement of the diff, and it would inherit
   * exactly the shallow-sweep failure stage 0 exists to escape.
   */
  maxFilesPerQuestion: 6,
  /** Stage 0's share of the review's wall clock. One cheap planning turn. */
  budgetFraction: 0.12,
};

/** One investigation question, as stage 0's agent emits it. */
export interface Hypothesis {
  question: string;
  files: string[];
}

/**
 * Turn stage 0's raw output into batches, dropping what cannot be acted on.
 *
 * Rejects a question whose files are not in the diff (the planner invented a
 * path), whose file set is empty after that filter, or which claims more than
 * `maxFilesPerQuestion`. Deduplicates by file set, because two questions over
 * the same files are one batch's worth of attention split in half.
 *
 * `startIndex` continues the numbering of the coverage batches these run
 * alongside, so `sweep-<index>` stays unique across the whole stage.
 */
export function planHypothesisBatches(
  hypotheses: Hypothesis[],
  changed: Array<{ path: string; lines: number }>,
  startIndex: number,
  cfg = HYPOTHESIS,
): ReviewBatch[] {
  const linesOf = new Map(changed.map((f) => [f.path, f.lines]));
  const seen = new Set<string>();
  const out: ReviewBatch[] = [];
  for (const h of hypotheses) {
    const question = (h?.question || "").trim();
    if (!question) continue;
    const files = [...new Set(h?.files || [])].filter((f) => linesOf.has(f));
    if (!files.length || files.length > cfg.maxFilesPerQuestion) continue;
    const key = [...files].sort().join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      index: startIndex + out.length,
      files,
      lines: files.reduce((n, f) => n + (linesOf.get(f) || 0), 0),
      question,
    });
    if (out.length >= cfg.max) break;
  }
  return out;
}
