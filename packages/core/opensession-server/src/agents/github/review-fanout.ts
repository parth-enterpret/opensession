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

/**
 * NO STAGE BUDGETS.
 *
 * Every stage used to get a fraction of what a single-pass review of the same
 * diff would be allowed: stage 0 took 0.12, stage 1 took 0.6, stage 2 took 0.4,
 * and each verifier took 0.25 of the floor. The intent was to keep a fanned-out
 * review near 1x the single-pass wall clock.
 *
 * It starved the pipeline instead. Measured on the first production run against
 * PR #12272: stage 0's planner ran for 5m24s against its 12% slice and was
 * killed mid-turn with `stopReason: "aborted"`, so it contributed zero
 * hypotheses and the sweep silently fell back to pure file coverage. A stage
 * that dies at its deadline does not degrade gracefully -- it returns nothing,
 * and nothing downstream can tell that apart from "found nothing".
 *
 * So each stage now gets the whole run allowance from `githubRunTimeoutMs`, and
 * the only bound on a review is that allowance itself, which an operator
 * controls absolutely through OPENSESSION_GITHUB_RUN_TIMEOUT_MS. A review takes
 * as long as it takes; the counts below still bound how MANY runs happen.
 */
/**
 * COST, AND THE ACCOUNT RATE LIMIT THAT SETS IT.
 *
 * Measured on the first full production run (PR #12272, 10 files, 482 lines):
 * 547 model calls, 33 agent sessions, 24m52s, $28.06.
 *
 * The dominant cost was not any single stage. It was that a Claude account is
 * capped at 300 requests/hour, the run spent 547, and every call past the cap
 * failed over to a second provider that then RE-RAN the same batch. We paid for
 * both halves:
 *
 *     17:33:27  sweep-11  claude-sonnet-5  $1.210
 *     17:38:02  sweep-11  gpt-5.6-sol      $1.063   <- same batch, again
 *
 * Three files per batch was tried and MEASURED AS WORSE. Batch size drives
 * turns per batch, and turns are unbounded: at one file a sweep ran 14-45 calls
 * for about $1, at three files it ran 76-94 calls for $7-9. Ten fat batches
 * cost more than eighteen thin ones. So coverage stays at one file per batch,
 * and the ceilings below bound the count instead.
 *
 * Concurrency stays at 4 because a wide fan-out does not spend fewer requests,
 * it spends them in a burst, and the cap is per hour.
 *
 * The remaining lever is turns per agent, which nothing currently bounds. Stage
 * 0 shows the shape of the fix that works: an absolute cap plus a prompt saying
 * what not to do took the planner from 41 calls and $1.86 to one call and about
 * 70 seconds. Sweeps need the same treatment.
 */
/**
 * Which model runs which stage, and why the review never falls back.
 *
 * The 2026-09-04 run spent $28.06 on a 10-file PR, and about half of that was
 * the same batches billed twice. A Claude account is capped at 300 requests per
 * hour, the review spent 547, and every call past the cap switched to
 * `automaticFallbackModel()` and RE-RAN:
 *
 *     17:33:27  sweep-11  claude-sonnet-5  $1.210
 *     17:38:02  sweep-11  gpt-5.6-sol      $1.063   <- the same batch, again
 *
 * Failover is right for an interactive session, where the alternative is a
 * human stuck. It is wrong here. A sweep batch is one slice of a best-effort
 * pass, and losing a slice costs far less than paying for every slice twice.
 * So every stage below runs with `noFallback` and gets the model it names.
 *
 * The split across providers is deliberate, for two reasons:
 *
 * RATE. There is one Claude account and one Codex account, each with its own
 * hourly cap. Putting every stage on one provider means one cap for the whole
 * review, which is what 547 calls hit. Splitting the two heaviest stages across
 * the two accounts roughly halves the requests either one sees.
 *
 * INDEPENDENCE. The verifier exists to refute the finder. In the measured run
 * all 13 candidates survived and NOTHING was refuted, which is either a clean
 * candidate list or a verifier agreeing with its own reasoning. Greptile
 * measured a model reviewing its own family's output as materially worse
 * (Claude recall 53.7% on Claude-authored code versus GPT's 62.0%), and a
 * verifier drawn from a different family is less likely to rubber-stamp the
 * finder. Whether that changes our refutation rate is untested and worth
 * measuring — it is the cheapest available test of whether stage 2 works.
 */
export const REVIEW_MODELS = {
  /**
   * One or two turns, no tools, names the questions. Too small to matter for
   * cost, so this is on the cheap Claude tier purely to keep the Claude account
   * warm for the verifier below.
   */
  plan: "claude-haiku-4-5",
  /**
   * The reasoning work, and about 90% of a review's turns. On the CODEX
   * account, for three measured reasons.
   *
   * RATE. The Claude account is capped at 300 requests an hour and a single
   * review exceeds it. Two consecutive runs proved it: the first paid twice for
   * every batch past the cap, and the second -- with failover removed -- had
   * TEN sweeps killed outright. Sweeps are the turns, so sweeps are what has to
   * move off the capped account. The Codex account logged no usage-limit error
   * on either day.
   *
   * CACHE WRITES. Anthropic bills a cache write at 1.25x input, and this
   * workload writes ~18k cache tokens per turn: 85.3% of the Sonnet sweep bill
   * was cache writes alone. OpenAI does not bill writes at all. Measured on the
   * same PR, Sonnet cost $0.054 per turn and Sol $0.042 -- Sol is twice the
   * per-token price and still cheaper, because the line this workload spends
   * most on is the one it does not charge for.
   *
   * PRICE. Luna over Sol is the open experiment. Projecting the measured sweep
   * tokens puts Sol at $9.65 and Luna at $0.50 for identical work. Sol is known
   * to complete a sweep (its legs reached `stop` with findings where Sonnet's
   * were still going at 57 turns); Luna is not yet known to. Recall is the
   * thing worth protecting, so if Luna's recall drops against the 9-of-12
   * baseline, move this back to Sol and keep the account split -- that alone
   * fixes the rate limit and still beats Sonnet per turn.
   */
  sweep: "gpt-5.6-luna",
  /**
   * Narrow refutation, ~100 short turns. Back on the CLAUDE account, and
   * deliberately a different family from the sweep model above.
   *
   * The independence argument is the whole reason stage 2 exists: it is there
   * to refute the finder, and in the measured run it refuted nothing at all.
   * Greptile measured a model reviewing its own family's output as materially
   * worse (Claude recall 53.7% on Claude-authored code against GPT's 62.0%), so
   * with the finder on Codex the verifier belongs on Claude.
   *
   * Haiku rather than Sonnet because the task is narrow and the account has
   * budget to spare: ~100 verifier turns sit well inside the 300/hour cap once
   * the sweeps have moved off it. This also balances the two accounts instead
   * of stacking one.
   */
  verify: "claude-haiku-4-5",
} as const;

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
  maxBatches: 12,
  /** Batches in flight at once. The workflow runner already treats 8 parallel
   *  read-only agents as safe; reviews also run concurrently across PRs, so
   *  this stays well under that. */
  concurrency: 4,
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
  concurrency: 4,
  /**
   * Hard ceiling on verifier runs per review. Candidates arrive severity-sorted
   * out of `dedupeFindings`, so anything past the ceiling is the least severe of
   * the list — those survive UNVERIFIED rather than dropping (see
   * `planVerifications`), and `assembleReview`'s volume cap trims the tail.
   */
  max: 12,
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
  max: 6,
  /**
   * Wall clock for the planning turn, absolute.
   *
   * NOT a fraction of the review budget. The fraction (0.12) was killed because
   * it cut the planner off mid-turn and it contributed nothing; removing it
   * entirely was the opposite mistake. With 45 minutes and no pressure the
   * planner stopped planning and started reviewing -- 41 calls and $1.86 in ten
   * minutes, reading files and checking whether a permission gap was covered,
   * while every sweep waited on it. That work belongs in the sweeps, which run
   * in parallel; done here it is serial and it blocks.
   *
   * Ten minutes is generous for naming questions from a diff already read once,
   * and short enough that sprawl cannot get expensive. A planner that overruns
   * still contributes nothing, but it now costs ten minutes instead of an hour,
   * and the prompt tells it not to investigate in the first place.
   */
  timeoutMs: 10 * 60 * 1000,
  /**
   * Files a single question may claim. A question that implicates half the PR
   * is not a hypothesis, it is a restatement of the diff, and it would inherit
   * exactly the shallow-sweep failure stage 0 exists to escape.
   */
  maxFilesPerQuestion: 6,
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
