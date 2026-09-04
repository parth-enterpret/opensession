/**
 * Per-file fan-out for PR review — the recall half of a two-stage review.
 *
 * One agent turn over 34 files spends ~9 seconds of attention per file and
 * finds ~1 defect where per-hunk reviewers find 30. The model is not the
 * problem (GPT-5.6 Sol and Sonnet 5 produced the same count), the prompt is not
 * the problem (Codex's own published rubric produced the same count), and an
 * explicit "one file at a time" instruction is not the fix (same count again).
 * What differs is pipeline shape: a separate request, with a separate attention
 * budget, per location.
 *
 * So: partition the diff into batches, run the review agent once per batch with
 * a recall bias, then hand every candidate to ONE adjudication pass with a
 * fresh context that applies the reporting bar and cuts. Greptile measured a
 * model rating its own output on a 1-10 scale as "nearly random", so stage 2 is
 * a fresh conversation with tool access, never a self-rating turn appended to a
 * stage-1 batch.
 *
 * This module is the deterministic part: what the batches are, and how their
 * candidates merge. The prompts live in prompts.ts, the orchestration in
 * review.ts.
 */
import { severityRank } from "./review-options";
import type { Finding } from "./review";

export interface ReviewBatch {
  /** 1-based, and part of the batch's session id — stable within one review. */
  index: number;
  files: string[];
  /** Added + removed lines across the batch's files, for its wall-clock share. */
  lines: number;
}

export const FANOUT = {
  /**
   * Below this many changed files, stay single-pass. A 2-file PR already gets
   * a correct review in ~18s on the existing path, and fanning it out buys
   * nothing but latency and spend.
   */
  minFiles: 5,
  /**
   * Files per batch. One file per batch is the strongest signal and the most
   * expensive; 3 keeps a batch's slice small enough that the model reads each
   * file whole, while cutting the run count (and the fixed per-run prompt cost)
   * by a third. Files arrive in git's own diff order, which groups a directory
   * together, so a batch is usually related code rather than a random sample.
   */
  filesPerBatch: 3,
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
  /**
   * Stage 1's share of the review's wall clock, as a fraction of the budget a
   * single-pass review of the same diff would get. Stage 2 then gets a full
   * budget of its own, so a fanned-out review is bounded at ~1.6x the
   * single-pass wall clock plus one straggler batch.
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

/** Render stage 1's candidates for stage 2's prompt. */
export function candidatesBlock(findings: Finding[]): string {
  return findings
    .map(
      (f, i) =>
        `${i + 1}. \`${f.path}:${f.line}\`${f.severity ? ` [${f.severity}]` : ""} — ${
          (f.title || "").trim() || "(untitled)"
        }\n   ${(f.body || "").replace(/\s+/g, " ").trim().slice(0, 500)}`,
    )
    .join("\n");
}
