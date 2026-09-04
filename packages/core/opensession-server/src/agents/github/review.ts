/**
 * Behavior 1: PR review. Runs an ask-mode agent that reads the diff and emits
 * structured findings. The module posts a fresh summary comment per review (the
 * previous one collapses under an "Outdated review" <details>) plus a formal GitHub
 * review carrying inline comments (GitHub auto-outdates stale ones across commits).
 * Deduped on head SHA so the same commit isn't reviewed twice.
 */
import { isGithubBotLogin, personaName } from "../../server/config";
import { isShuttingDown } from "../../server/shutdown-state";
import {
  getPrAutomationDetails,
  getPrDiff,
  type PrAutomationDetails,
} from "../../server/pr-info";
import {
  activeRunCancellationRequested,
  claimLock,
  releaseLock,
  getOrInitPrState,
  updatePrState,
  recordReviewed,
  clearActiveRun,
} from "./state";
import {
  announceGithubRun,
  discardRecoverableGithubRun,
  githubRunTimeoutMs,
  GithubRunRecoveryUncertainError,
  runGithubAgent,
  sessionUrl,
  type GithubRunResult,
} from "./run";
import { readFileSync } from "fs";
import {
  assembleReview,
  changedFilesFromPatch,
  dedupeFindings,
  FANOUT,
  HYPOTHESIS,
  planHypothesisBatches,
  planReviewBatches,
  planVerifications,
  VERIFY,
  type Hypothesis,
  type ReviewBatch,
} from "./review-fanout";
import {
  buildHypothesisPrompt,
  buildReviewPrompt,
  buildVerifyPrompt,
  DEFAULT_REVIEW_PROMPT,
} from "./prompts";
import {
  getComment,
  postIssueComment,
  postOrEditComment,
  editIssueComment,
  supersedeReviewComment,
  findActiveReviewComment,
  findReviewProgressComment,
  isReviewProgressForHead,
  submitReview,
  listReviewThreads,
  resolveReviewThread,
  REVIEW_MARKER,
  type ReviewInlineComment,
} from "./github-rest";
import { defaultRepo } from "../../server/config";
import { audit } from "../../server/audit";
import { modelLabel } from "../../server/models";
import { createReviewWorktreeForPrHead } from "../../server/worktree";
import { inverseReviewModel, authorFamilyFor } from "./model-inversion";
import { runTestOnBaseCheck, testOnBaseSection, type TestOnBaseResult } from "./test-on-base";
import { runSecretScanCheck, secretScanSection, type SecretScanResult } from "./secret-scan";
import {
  loadReviewOptions,
  pathIgnored,
  severityRank,
  REVIEW_OPTION_DEFAULTS,
  type ReviewOptions,
} from "./review-options";
import {
  recordPostedFindings,
  shouldSuppressFinding,
  harvestThreadOutcomes,
  harvestReplySignals,
  readFeedback,
} from "./feedback";
import {
  prIntentSection,
  repoConventionsSection,
  prDiscussionSection,
  classifyPriorFindings,
  openHumanThreadLines,
  priorReviewSection,
} from "./review-context";
import { learnedRulesSection } from "./learned-rules";
import { repoForFullName } from "./constants";

const DEFAULT_REPO_DIR = defaultRepo().repo;

const REVIEW_OUTPUT_REPAIR_PROMPT = `Your previous response was only a progress update, not a usable review result. Do not continue investigating unless a missing fact is essential. Synthesize the inspection already completed and end this turn with the required single fenced JSON review object now.`;

export interface PrRef {
  number: number;
  headRef: string;
  headSha: string;
  title: string;
  /** owner/name when the PR lives outside the default repo (multi-repo). */
  ghRepo?: string;
}

export interface ReviewConfig {
  prompt: string;
  model?: string;
}

export interface Finding {
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
  severity?: string;
  title?: string;
  body: string;
  suggestion?: string;
}

export interface ReviewOutput {
  verdict?: string;
  confidence?: number;
  summary_markdown?: string;
  /** Optional mermaid diagram for changes that warrant one (schema/flow). */
  diagram?: { type?: string; mermaid?: string };
  findings?: Finding[];
}

/**
 * Derive the contract's 1-5 merge-safety score when a model returns a usable
 * review in another schema. Codex's `overall_confidence_score` is a 0-1 measure
 * of certainty, not merge safety, so severity + verdict are the honest fallback.
 */
function deriveMergeSafetyScore(verdict: string | undefined, findings: Finding[]): number | undefined {
  if (!verdict) return undefined;

  let score = verdict === "approve" ? 5 : verdict === "comment" ? 4 : 2;
  for (const finding of findings) {
    switch ((finding.severity || "").toLowerCase()) {
      case "p0":
        score = Math.min(score, 1);
        break;
      case "p1":
      case "high":
        score = Math.min(score, 2);
        break;
      case "p2":
      case "medium":
        score = Math.min(score, 3);
        break;
      case "p3":
      case "low":
        score = Math.min(score, 4);
        break;
      default:
        // A structured finding with unknown severity is still an unresolved risk.
        score = Math.min(score, 3);
    }
  }
  return score;
}

/** What a review concluded, so callers (e.g. auto-fix) can gate on it. */
export interface ReviewResult {
  verdict?: string;
  confidence?: number;
  findings: number;
  /** Findings that should block merge: P0/P1 severity, or a request_changes verdict. */
  blocking: number;
  error?: string;
}

/** Count merge-blocking findings (P0/P1, with request_changes as a floor of 1). */
function reviewBlockingCount(parsed: ReviewOutput | null): number {
  const n = (parsed?.findings || []).filter((f) => {
    const s = (f.severity || "").toLowerCase();
    return s === "p0" || s === "p1" || s === "high";
  }).length;
  if (n === 0 && parsed?.verdict === "request_changes") return 1;
  return n;
}

// P0/P1 are blocking-ish (red), P2 should-fix (orange), P3 minor (white).
// Legacy high/medium/low kept as aliases in case a prompt variant emits them.
const SEV_EMOJI: Record<string, string> = {
  p0: "🔴", p1: "🔴", p2: "🟠", p3: "⚪",
  high: "🔴", medium: "🟠", low: "⚪",
};

/**
 * The repo's own convention files, read from the review checkout.
 *
 * Best-effort by construction: a repo with no AGENTS.md contributes "" and the
 * prompt is unchanged. See repoConventionsSection for why these are inlined
 * rather than left for the agent to go and find.
 */
function repoConventions(cwd: string): string {
  return repoConventionsSection((name) => {
    try {
      return readFileSync(`${cwd}/${name}`, "utf-8");
    } catch {
      return null;
    }
  });
}

/**
 * Stage 0 of the fanned-out review: ask what to investigate.
 *
 * One planning turn over the whole diff that emits investigation questions,
 * each naming a behaviour the PR changes and the changed files it passes
 * through. Stage 1 then runs one agent per question, alongside (never instead
 * of) the per-file coverage batches.
 *
 * Best-effort, like every other stage: a planner that errors, times out, or
 * emits nothing leaves the review exactly as it was before this stage existed.
 * That is why it returns batches to append rather than batches to substitute.
 */
async function planHypotheses(opts: {
  pr: PrRef;
  details: PrAutomationDetails;
  changed: Array<{ path: string; lines: number }>;
  startIndex: number;
  cwd: string;
  model?: string;
  title: string;
  cancelled: () => boolean;
}): Promise<ReviewBatch[]> {
  const { pr, changed } = opts;
  if (changed.length < HYPOTHESIS.minFiles) return [];
  if (opts.cancelled() || isShuttingDown()) return [];
  const totalLines = opts.details.additions + opts.details.deletions;
  const result = await runGithubAgent({
    prNumber: pr.number,
    ghRepo: pr.ghRepo,
    kind: "review",
    sessionSuffix: "plan",
    prompt: buildHypothesisPrompt({
      pr: opts.details,
      files: changed.map((f) => f.path),
      max: HYPOTHESIS.max,
      maxFilesPerQuestion: HYPOTHESIS.maxFilesPerQuestion,
      ghRepo: pr.ghRepo,
    }),
    cwd: opts.cwd,
    mode: "ask",
    model: opts.model,
    branch: pr.headRef,
    title: `${opts.title} · plan`.slice(0, 100),
    resume: false,
    detached: false,
    // No stage budget. Stage 0 gets the whole run allowance; see review-fanout.ts.
    timeoutMs: githubRunTimeoutMs(totalLines),
  }).catch((e): GithubRunResult => ({ bksId: "", text: "", error: String(e) }));
  if (result.error) {
    console.warn(`[github] review plan on PR #${pr.number} failed: ${result.error}`);
  }
  const raw = parseHypotheses(result.text);
  const batches = planHypothesisBatches(raw, changed, opts.startIndex);
  console.log(
    `[github] review plan on PR #${pr.number}: ${raw.length} question(s) proposed, ${batches.length} usable`,
  );
  return batches;
}

/**
 * Read stage 0's JSON block. Returns `[]` for anything unparseable — the
 * planner is an optimisation, and a malformed plan must cost the review
 * nothing beyond the turn already spent.
 */
export function parseHypotheses(text: string): Hypothesis[] {
  const blocks = [...(text || "").matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks[blocks.length - 1]?.[1];
  if (!last) return [];
  let data: unknown;
  try {
    data = JSON.parse(last);
  } catch {
    return [];
  }
  const list = (data as { hypotheses?: unknown })?.hypotheses;
  if (!Array.isArray(list)) return [];
  return list.flatMap((h): Hypothesis[] => {
    const question = typeof (h as Hypothesis)?.question === "string" ? (h as Hypothesis).question : "";
    const files = Array.isArray((h as Hypothesis)?.files)
      ? (h as Hypothesis).files.filter((f): f is string => typeof f === "string")
      : [];
    return question && files.length ? [{ question, files }] : [];
  });
}

/**
 * Stage 1 of the fanned-out review: run the review agent once per batch and
 * return the merged, deduplicated candidate list.
 *
 * Concurrency requires distinct session ids. Every per-session structure in
 * run.ts — the session file, the run journal, the detached-host recovery marker
 * — is keyed by `bksIdFor(pr, kind)`, and two concurrent runs sharing one id
 * discard each other's hosts on startup. So each batch gets a `sessionSuffix`,
 * and batches run NON-detached: restart recovery is the main pass's property,
 * and a server restart mid-sweep simply retries the whole review on the next
 * delivery rather than reattaching twelve orphaned hosts.
 *
 * Best-effort throughout. A batch that errors, times out, or emits nothing
 * contributes no candidates and never fails the review — the worst case is the
 * single-pass result we already get today.
 */
async function runRecallSweep(opts: {
  pr: PrRef;
  details: PrAutomationDetails;
  base: string;
  batches: ReviewBatch[];
  cwd: string;
  model?: string;
  title: string;
  steer?: string;
  authorFamily?: string | null;
  ignoreGlobs: string[];
  learnedRules: string;
  cancelled: () => boolean;
}): Promise<Finding[]> {
  const { pr, batches } = opts;
  // The whole stage shares one deadline, sized as a fraction of what a
  // single-pass review of this diff would get; each batch is additionally
  // capped at its own share of that. Total review wall clock therefore stays
  // bounded at roughly 1.6x the single-pass budget plus one straggler, instead
  // of multiplying by the batch count.
  const totalLines = opts.details.additions + opts.details.deletions;
  const deadline =
    Date.now() + githubRunTimeoutMs(totalLines);
  const queue = [...batches];
  const found: Finding[] = [];
  let ran = 0;
  const startedAt = Date.now();

  const worker = async (): Promise<void> => {
    for (;;) {
      const batch = queue.shift();
      if (!batch) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || opts.cancelled() || isShuttingDown()) {
        queue.length = 0;
        return;
      }
      ran++;
      const result = await runGithubAgent({
        prNumber: pr.number,
        ghRepo: pr.ghRepo,
        kind: "review",
        sessionSuffix: `sweep-${batch.index}`,
        prompt: buildReviewPrompt(opts.base, opts.details, false, opts.steer, pr.ghRepo, {
          authorFamily: opts.authorFamily,
          ignoreGlobs: opts.ignoreGlobs,
          intent: prIntentSection(opts.details),
          learnedRules: opts.learnedRules,
          repoConventions: repoConventions(opts.cwd),
          batch: {
            files: batch.files,
            index: batch.index,
            total: batches.length,
            question: batch.question,
          },
        }),
        cwd: opts.cwd,
        mode: "ask",
        model: opts.model,
        branch: pr.headRef,
        title: `${opts.title} · sweep ${batch.index}/${batches.length}`.slice(0, 100),
        // Each batch is its own context by construction; nothing to resume.
        resume: false,
        detached: false,
        timeoutMs: Math.min(githubRunTimeoutMs(batch.lines), remaining),
      }).catch((e): GithubRunResult => ({ bksId: "", text: "", error: String(e) }));
      if (result.error) {
        console.warn(
          `[github] review sweep batch ${batch.index}/${batches.length} on PR #${pr.number} failed: ${result.error}`,
        );
      }
      const parsed = parseReviewOutput(result.text, opts.cwd);
      if (parsed?.findings?.length) found.push(...parsed.findings);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(FANOUT.concurrency, batches.length) }, worker),
  );
  const candidates = dedupeFindings(found);
  console.log(
    `[github] review sweep on PR #${pr.number}: ${ran}/${batches.length} batches in ${Math.round((Date.now() - startedAt) / 1000)}s → ${found.length} candidates, ${candidates.length} after dedup`,
  );
  return candidates;
}

/** One verifier's verdict on one candidate. */
export interface VerifyVerdict {
  keep: boolean;
  /** Why. The refutation when dropped, what was confirmed when kept. Audited. */
  reason: string;
  /** The candidate, with any correction the verifier made applied. */
  finding: Finding;
}

/**
 * Read one verifier's verdict. Refute-to-drop: anything that is not an explicit,
 * parseable "drop" leaves the candidate in.
 *
 * That covers the failure cases too — a verifier that errored, timed out, or
 * narrated without emitting the contract returns no usable verdict, and the
 * candidate survives. A missing answer is not evidence about the code, and the
 * alternative makes recall a function of infrastructure flakiness. It is also
 * asymmetric in the direction we need: a stage-1 batch that fails already costs
 * us candidates outright, so a stage-2 failure must not cost us them twice.
 */
export function parseVerifyOutput(text: string, candidate: Finding): VerifyVerdict {
  const opener = (text || "").lastIndexOf("```json");
  const json = extractBalancedJson(opener === -1 ? text || "" : text.slice(opener));
  let o: any = null;
  if (json) {
    try {
      o = JSON.parse(json);
    } catch {
      o = null;
    }
  }
  if (!o || typeof o !== "object")
    return { keep: true, reason: "no usable verdict from the verifier", finding: candidate };

  const reason =
    typeof o.reason === "string" && o.reason.trim() ? o.reason.trim().slice(0, 300) : "";
  if (String(o.verdict ?? "").trim().toLowerCase() === "drop")
    return { keep: false, reason: reason || "refuted without a stated reason", finding: candidate };

  // Kept. Corrections are the verifier's other job: it has the file open, so its
  // anchor beats the sweep's. This matters more than it looks — filterToDiff()
  // silently discards any finding whose path:line is not in the diff, so a wrong
  // line is a lost finding, not a cosmetic problem.
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  return {
    keep: true,
    reason: reason || "not refuted",
    finding: {
      ...candidate,
      path: str(o.path) ?? candidate.path,
      line: Number.isInteger(o.line) && o.line > 0 ? o.line : candidate.line,
      severity: str(o.severity) ?? candidate.severity,
      title: str(o.title) ?? candidate.title,
      body: str(o.body) ?? candidate.body,
      suggestion: str(o.suggestion) ?? candidate.suggestion,
    },
  };
}

export interface VerifySweepResult {
  survivors: Finding[];
  /** Refuted candidates and the reason given, for the review_verify_sweep audit. */
  refuted: Array<{ path: string; line: number; title?: string; reason: string }>;
  /** Verifier runs that errored or timed out. Their candidates still survived. */
  errors: number;
  /** Candidates that never got a verifier (ceiling, deadline, shutdown). Survived. */
  unverified: number;
}

/**
 * Stage 2 of the fanned-out review: one verifier run per candidate, fresh
 * context, concurrent — the same shape as stage 1, pointed at one claim.
 *
 * The single adjudication pass this replaces cut 8 of 9 candidates on
 * enterpret-showcase#12182 for two compounding reasons: it was one attention
 * budget over the whole list (exactly the shape stage 1 exists to escape), and
 * it applied a reporting bar tuned for a reviewer with a noise problem to a list
 * produced by a reviewer biased for recall. So each verifier sees ONE candidate,
 * never the others, is never the conversation that produced it, and defaults to
 * keeping it (see buildVerifyPrompt).
 *
 * Same session-suffix and best-effort rules as runRecallSweep: distinct
 * `sessionSuffix` per run so concurrent hosts do not discard each other,
 * non-detached so a restart retries the whole review rather than reattaching N
 * orphans, and nothing here can fail the review.
 */
async function runVerifySweep(opts: {
  pr: PrRef;
  details: PrAutomationDetails;
  candidates: Finding[];
  cwd: string;
  model?: string;
  title: string;
  cancelled: () => boolean;
}): Promise<VerifySweepResult> {
  const { pr } = opts;
  const { verify, unverified } = planVerifications(opts.candidates);
  const totalLines = opts.details.additions + opts.details.deletions;
  const deadline =
    Date.now() + githubRunTimeoutMs(totalLines);
  const turnMs = githubRunTimeoutMs(0);
  const queue = verify.map((finding, i) => ({ finding, index: i + 1 }));
  const out: VerifySweepResult = {
    survivors: [],
    refuted: [],
    errors: 0,
    unverified: unverified.length,
  };
  out.survivors.push(...unverified);
  const startedAt = Date.now();

  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || opts.cancelled() || isShuttingDown()) {
        // Whatever is left never got looked at. It survives, same as an error.
        out.unverified += queue.length + 1;
        out.survivors.push(item.finding, ...queue.map((q) => q.finding));
        queue.length = 0;
        return;
      }
      const result = await runGithubAgent({
        prNumber: pr.number,
        ghRepo: pr.ghRepo,
        kind: "review",
        sessionSuffix: `verify-${item.index}`,
        prompt: buildVerifyPrompt({
          pr: opts.details,
          candidate: item.finding,
          index: item.index,
          total: verify.length,
          ghRepo: pr.ghRepo,
        }),
        cwd: opts.cwd,
        mode: "ask",
        model: opts.model,
        branch: pr.headRef,
        title: `${opts.title} · verify ${item.index}/${verify.length}`.slice(0, 100),
        resume: false,
        detached: false,
        timeoutMs: Math.min(turnMs, remaining),
      }).catch((e): GithubRunResult => ({ bksId: "", text: "", error: String(e) }));
      if (result.error) {
        out.errors++;
        console.warn(
          `[github] review verify ${item.index}/${verify.length} on PR #${pr.number} failed: ${result.error}`,
        );
      }
      const verdict = parseVerifyOutput(result.text, item.finding);
      if (verdict.keep) out.survivors.push(verdict.finding);
      else
        out.refuted.push({
          path: item.finding.path,
          line: item.finding.line,
          title: item.finding.title,
          reason: verdict.reason,
        });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(VERIFY.concurrency, Math.max(queue.length, 1)) }, worker),
  );
  console.log(
    `[github] review verify on PR #${pr.number}: ${opts.candidates.length} candidates in ${Math.round(
      (Date.now() - startedAt) / 1000,
    )}s → ${out.survivors.length} survived, ${out.refuted.length} refuted, ${out.errors} errored, ${out.unverified} unverified`,
  );
  return out;
}

/** Collapse duplicate findings before anything is posted, whatever produced them. */
function withDedupedFindings(parsed: ReviewOutput | null): ReviewOutput | null {
  if (!parsed?.findings?.length) return parsed;
  return { ...parsed, findings: dedupeFindings(parsed.findings) };
}

export async function runReview(
  pr: PrRef,
  config: ReviewConfig,
  onSessionCreated?: (bksId: string) => void,
  force = false,
  steer?: string,
): Promise<ReviewResult | null> {
  if (isShuttingDown()) {
    console.log(`[github] PR #${pr.number} review parked during shutdown`);
    return null;
  }
  if (!claimLock("review", pr.number, pr.ghRepo)) {
    console.log(`[github] review already running for PR #${pr.number}, skipping`);
    return null;
  }
  let preserveRecovery = false;
  try {
    const prRepo = pr.ghRepo ? repoForFullName(pr.ghRepo) : null;
    const state = getOrInitPrState(pr.number, pr.headRef, pr.ghRepo);
    const priorRun = state.activeRun?.kind === "review" ? state.activeRun : undefined;
    const recovering = Boolean(priorRun);
    // Manual triggers review an already-reviewed SHA. Restart recovery does not:
    // if the prior run completed its durable commit point before the process died,
    // its leftover marker only needs clearing.
    const forceFreshReview = force && !recovering;
    if (!forceFreshReview && pr.headSha && state.reviewedShas.includes(pr.headSha)) {
      console.log(`[github] PR #${pr.number} @ ${pr.headSha.slice(0, 7)} already reviewed`);
      return null;
    }
    // Concurrent deliveries are coalesced by the in-process "review" lock above;
    // the SHA is recorded only AFTER a successful run (below) so a transient
    // failure can be retried rather than permanently suppressed.
    // `state` stays a read-only snapshot of what the PREVIOUS review left behind
    // (lastReview / lastReviewedSha below); every mutation goes through updatePrState.
    const isUpdate = state.reviewedShas.length > 0;
    const startedAt = new Date().toISOString();
    const sameHeadRecovery = Boolean(
      priorRun?.headSha && pr.headSha && priorRun.headSha === pr.headSha,
    );
    const legacyRecovery = recovering && !priorRun?.headSha;
    const recoveredReviewResult = sameHeadRecovery
      ? priorRun?.reviewResult
      : undefined;
    updatePrState(
      pr.number,
      pr.headRef,
      (s) => {
        s.activeRun = {
          kind: "review",
          requestedBy: "",
          startedAt,
          headSha: pr.headSha || priorRun?.headSha,
          progressCommentId: sameHeadRecovery ? priorRun?.progressCommentId : undefined,
          reviewResult: recoveredReviewResult,
          steer,
        };
      },
      pr.ghRepo,
    );
    const cancellationRequested = () =>
      activeRunCancellationRequested(pr.number, "review", pr.ghRepo);
    const finishCancelled = async (commentId?: number): Promise<null> => {
      if (commentId)
        await editIssueComment(
          commentId,
          `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\nReview cancelled.`,
          pr.ghRepo,
        ).catch(() => {});
      audit({
        msg: "review_cancelled",
        pr_number: pr.number,
        repo: pr.ghRepo || defaultRepo().ghRepo,
      });
      return null;
    };

    // Look up by number before publishing the session link. If details are
    // unavailable, no worker exists and the next delivery remains retryable.
    const details = await getPrAutomationDetails(pr.number ? String(pr.number) : pr.headRef, pr.ghRepo || undefined);
    if (!details) {
      console.warn(`[github] no PR details for #${pr.number} (${pr.headRef}); review not started`);
      return null;
    }
    if (cancellationRequested()) return finishCancelled();
    const title = `Review · PR #${pr.number} ${details.title}`.slice(0, 100);
    const bksId = await announceGithubRun({
      prNumber: pr.number,
      ghRepo: pr.ghRepo,
      kind: "review",
      branch: pr.headRef,
      title,
      mode: "ask",
    });
    onSessionCreated?.(bksId);

    // A fresh review posts a new placeholder and collapses the previous summary.
    // Restart recovery edits the interrupted run's placeholder instead, so every
    // server restart does not manufacture another "Outdated review" comment for
    // the same head. Old state files only have summaryCommentId, so adopt it when
    // its live body proves it is this head's unfinished placeholder.
    let reuseId = sameHeadRecovery ? priorRun?.progressCommentId : undefined;
    if (!reuseId && (sameHeadRecovery || legacyRecovery)) {
      const candidateId = priorRun?.progressCommentId ?? state.summaryCommentId;
      const candidate = candidateId ? await getComment(candidateId, pr.ghRepo) : null;
      if (candidate && isReviewProgressForHead(candidate.body, pr.headSha)) {
        reuseId = candidateId;
      } else {
        reuseId = (await findReviewProgressComment(pr.number, pr.headSha, pr.ghRepo)) ?? undefined;
      }
    }
    const prevId = state.summaryCommentId ?? (await findActiveReviewComment(pr.number, pr.ghRepo)) ?? undefined;
    const shortSha0 = (pr.headSha || "").slice(0, 7);
    const placeholderId = await postOrEditComment(
      pr.number,
      reuseId,
      `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\n🔄 Reviewing${shortSha0 ? ` \`${shortSha0}\`` : ""}… · [📺 open session](${sessionUrl(pr.number, "review", pr.ghRepo)})`,
      pr.ghRepo,
    );
    if (placeholderId) {
      let ownsRun = false;
      updatePrState(
        pr.number,
        pr.headRef,
        (s) => {
          if (s.activeRun?.kind !== "review" || s.activeRun.startedAt !== startedAt) return;
          ownsRun = true;
          s.summaryCommentId = placeholderId;
          s.activeRun.progressCommentId = placeholderId;
        },
        pr.ghRepo,
      );
      if (ownsRun && prevId && prevId !== placeholderId) {
        await supersedeReviewComment(prevId, pr.ghRepo).catch(() => {});
      }
    }
    // If the placeholder failed, summaryCommentId keeps prevId and postReview edits it.
    if (cancellationRequested()) return finishCancelled(placeholderId || undefined);

    // Pin a read-only worktree to the PR head so the files the agent Reads are
    // the exact tree the local git diff describes. Without that guarantee, fail
    // the run instead of reviewing a stale shared checkout.
    let cwd = prRepo?.repo || DEFAULT_REPO_DIR;
    try {
      cwd = await createReviewWorktreeForPrHead(pr.headRef, prRepo?.id, details.baseRefName);
    } catch (e) {
      console.warn(`[github] review worktree for ${pr.headRef} failed:`, e);
      if (placeholderId)
        await editIssueComment(
          placeholderId,
          `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\n⚠️ Couldn't prepare the PR checkout to review the diff. It will retry on the next push, or ask ${personaName()} to review manually.`,
          pr.ghRepo,
        ).catch(() => {});
      return { findings: 0, blocking: 0, error: "Could not prepare the PR review worktree" };
    }
    if (cancellationRequested()) return finishCancelled(placeholderId || undefined);

    // Per-repo knobs from the PR-head worktree (.os-review.json), the author's
    // model family for the targeted sweep, and the giant-PR summary-only mode.
    const reviewOpts = loadReviewOptions(cwd);
    const summaryOnly = details.changedFiles > reviewOpts.summaryOnlyOverFiles;
    const author = authorFamilyFor(pr);

    // Deterministic test-fails-on-base check, concurrent with the model review
    // (independent work in a throwaway base worktree; awaited before posting).
    const testOnBase: Promise<TestOnBaseResult | null> = reviewOpts.testOnBase
      ? runTestOnBaseCheck({
          cwd,
          baseRefName: details.baseRefName,
          mainCheckout: prRepo?.repo || DEFAULT_REPO_DIR,
          sharedCheckout: prRepo?.sharedCheckout,
          prNumber: pr.number,
          ghRepo: pr.ghRepo,
        }).catch((e) => {
          console.warn(`[github] test-on-base check failed for PR #${pr.number}:`, e);
          return null;
        })
      : Promise.resolve(null);

    // Deterministic TruffleHog secret scan on the PR's added lines, also
    // concurrent with the model review (fails soft when not installed).
    const secretScan: Promise<SecretScanResult | null> = reviewOpts.secretScan
      ? runSecretScanCheck({
          cwd,
          baseRefName: details.baseRefName,
          prNumber: pr.number,
          ghRepo: pr.ghRepo,
        }).catch((e) => {
          console.warn(`[github] secret scan failed for PR #${pr.number}:`, e);
          return null;
        })
      : Promise.resolve(null);

    // Continuity context — the "same reviewer returning" inputs: the PR's
    // stated intent and human conversation on every round; on re-reviews, a
    // digest of our prior findings joined with live thread state so round N+1
    // converges instead of re-deriving the PR from scratch. Learned rules are
    // the cross-PR channel (learned-rules.ts). All best-effort: a failed
    // thread fetch degrades to the old stateless prompt, never blocks the run.
    const preThreads = isUpdate
      ? await listReviewThreads(pr.number, pr.ghRepo).catch(() => [])
      : [];
    const priorReview = isUpdate
      ? priorReviewSection({
          lastReview: state.lastReview,
          priorFindings: classifyPriorFindings(readFeedback(pr.ghRepo), pr.number, preThreads, isGithubBotLogin),
          humanThreadLines: openHumanThreadLines(preThreads, isGithubBotLogin),
        })
      : "";

    const base = (config.prompt || "").trim() || DEFAULT_REVIEW_PROMPT;

    // Model inversion: never review code with the model family that wrote it
    // (shared blind spots — see model-inversion.ts). Falls back to the
    // configured model for human-authored PRs.
    let reviewModel = config.model;
    const inversion = inverseReviewModel(pr, reviewModel);
    if (inversion) {
      reviewModel = inversion.model;
      console.log(
        `[github] model inversion for PR #${pr.number}: ${inversion.family}-authored (${inversion.source}) → reviewing with ${reviewModel}`,
      );
      audit({
        msg: "review_model_inversion",
        pr_number: pr.number,
        repo: pr.ghRepo || defaultRepo().ghRepo,
        author_family: inversion.family,
        review_model: reviewModel,
        source: inversion.source,
      });
    }

    // ── Stages 1-3: fanned-out review (review-fanout.ts) ───────
    // One pass over a 34-file diff spends ~9s of attention per file and finds
    // ~1 defect where per-hunk reviewers find 30. Split the files across
    // batches so each location gets its own request and its own attention
    // budget, and bias every batch toward finding things (stage 1). Then hand
    // each candidate to its own verifier that tries to refute it (stage 2) and
    // assemble whatever survives (stage 3).
    //
    // Skipped for small PRs (the existing single pass already reviews those
    // correctly, in seconds), for giant ones (summaryOnly is the pre-existing
    // escape hatch and fires first), and on restart recovery, where the
    // durable model result already exists and re-running the sweep would spend
    // the whole budget again to reach the same place.
    let candidates: Finding[] = [];
    let batches: ReviewBatch[] = [];
    // Non-null once stages 1-3 own the outcome: the review is then assembled
    // deterministically below and no whole-diff model pass runs at all.
    let assembled: ReviewOutput | null = null;
    if (!recoveredReviewResult && !summaryOnly) {
      const diff = await getPrDiff(pr.headRef, pr.ghRepo || undefined).catch((e) => {
        console.warn(`[github] diff fetch for review fan-out failed on PR #${pr.number}:`, e);
        return null;
      });
      batches = diff?.patch
        ? planReviewBatches(diff.patch, (path) => pathIgnored(path, reviewOpts))
        : [];
      // Stage 0 runs only once coverage batching has already decided this PR is
      // big enough to fan out at all, and its output is APPENDED: the file
      // batches still read every file. See HYPOTHESIS in review-fanout.ts.
      if (batches.length && diff?.patch) {
        const changed = changedFilesFromPatch(diff.patch).filter(
          (f) => !pathIgnored(f.path, reviewOpts),
        );
        const hypothesisBatches = await planHypotheses({
          pr,
          details,
          changed,
          startIndex: batches.length + 1,
          cwd,
          model: reviewModel,
          title,
          cancelled: cancellationRequested,
        });
        batches = [...batches, ...hypothesisBatches];
      }
    }
    if (batches.length) {
      if (cancellationRequested()) return finishCancelled(placeholderId || undefined);
      candidates = await runRecallSweep({
        pr,
        details,
        base,
        batches,
        cwd,
        model: reviewModel,
        title,
        steer,
        authorFamily: author?.family,
        ignoreGlobs: reviewOpts.ignoreGlobs,
        learnedRules: learnedRulesSection(pr.ghRepo),
        cancelled: cancellationRequested,
      });
      audit({
        msg: "review_recall_sweep",
        pr_number: pr.number,
        repo: pr.ghRepo || defaultRepo().ghRepo,
        batches: batches.length,
        hypothesis_batches: batches.filter((b) => b.question).length,
        candidates: candidates.length,
      });
      // A fanned-out review runs for minutes. Keep the placeholder honest about
      // which stage it is in — the "🔄 Reviewing `sha`…" prefix is what restart
      // recovery matches on, so this only ever appends after it.
      const progress = async (tail: string): Promise<void> => {
        if (!placeholderId) return;
        await editIssueComment(
          placeholderId,
          `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\n🔄 Reviewing${shortSha0 ? ` \`${shortSha0}\`` : ""}… · ${tail} · [📺 open session](${sessionUrl(pr.number, "review", pr.ghRepo)})`,
          pr.ghRepo,
        ).catch(() => {});
      };
      const swept = `swept ${batches.length} batch${batches.length === 1 ? "" : "es"}, ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}`;
      await progress(`${swept} to verify`);

      // ── Stage 2: one verifier per candidate ────────────────
      // A sweep that produced nothing is NOT a clean bill of health — every
      // batch may have errored — so that case falls through to the ordinary
      // whole-diff pass below, which is exactly today's pre-fan-out behavior.
      // The fan-out can then only ever add findings, never remove the floor.
      if (candidates.length) {
        if (cancellationRequested()) return finishCancelled(placeholderId || undefined);
        const verified = await runVerifySweep({
          pr,
          details,
          candidates,
          cwd,
          model: reviewModel,
          title,
          cancelled: cancellationRequested,
        });
        audit({
          msg: "review_verify_sweep",
          pr_number: pr.number,
          repo: pr.ghRepo || defaultRepo().ghRepo,
          batches: batches.length,
          candidates: candidates.length,
          survivors: verified.survivors.length,
          refuted: verified.refuted.length,
          errors: verified.errors,
          unverified: verified.unverified,
          // The reasons are the whole point of the event: without them we cannot
          // tell next time whether the verifier or the finder is what is short.
          refutations: verified.refuted
            .slice(0, 40)
            .map((r) => `${r.path}:${r.line} — ${r.title || "(untitled)"} — ${r.reason}`),
        });

        // ── Stage 3: deterministic assembly ──────────────────
        assembled = assembleReview(verified.survivors, {
          changedFiles: details.changedFiles,
          changedLines: details.additions + details.deletions,
          batches: batches.length,
          candidates: candidates.length,
          refuted: verified.refuted.length,
        });
        await progress(
          `${swept}, ${assembled.findings?.length || 0} verified — writing the review`,
        );
      }
    }

    // The whole-diff single pass. It runs when the PR did not warrant a fan-out
    // (small, giant, or restart recovery) and, deliberately, when a fan-out ran
    // but produced no candidate at all — twelve batches that all errored look
    // identical to a clean PR from here, and posting "approve" off that would be
    // a false endorsement. The string is always built (it is cheap); the run
    // below is skipped when `assembled` already owns the outcome.
    const prompt = buildReviewPrompt(base, details, isUpdate, steer, pr.ghRepo, {
      authorFamily: author?.family,
      ignoreGlobs: reviewOpts.ignoreGlobs,
      summaryOnly,
      intent: prIntentSection(details),
      discussion: prDiscussionSection(details, isGithubBotLogin, REVIEW_MARKER),
      priorReview,
      learnedRules: learnedRulesSection(pr.ghRepo),
      repoConventions: repoConventions(cwd),
      lastReviewedSha:
        isUpdate && state.lastReviewedSha && state.lastReviewedSha !== pr.headSha
          ? state.lastReviewedSha
          : undefined,
    });

    const persistReviewResult = (result: GithubRunResult) => {
      updatePrState(
        pr.number,
        pr.headRef,
        (s) => {
          if (
            s.activeRun?.kind !== "review" ||
            s.activeRun.startedAt !== startedAt
          ) return;
          s.activeRun.reviewResult = {
            text: result.text,
            error: result.error,
            model: result.model,
          };
        },
        pr.ghRepo,
      );
    };

    if (cancellationRequested()) return finishCancelled(placeholderId || undefined);
    if (isShuttingDown()) {
      preserveRecovery = true;
      console.log(`[github] PR #${pr.number} review parked for restart`);
      return null;
    }
    console.log(`[github] Reviewing PR #${pr.number} @ ${pr.headSha.slice(0, 7)} (${isUpdate ? "update" : "initial"})`);
    let finalResult: GithubRunResult;
    if (assembled) {
      // Stages 1-3 already produced the review. There is deliberately no model
      // call here: re-running the reporting bar over survivors a verifier has
      // already checked one at a time is precisely the bottleneck this replaces,
      // and any model that reaches the findings list at all can cut it.
      finalResult = { bksId, text: "", model: reviewModel };
      console.log(
        `[github] PR #${pr.number} review assembled from ${assembled.findings?.length || 0} verified finding(s); no adjudication pass`,
      );
    } else if (recoveredReviewResult) {
      finalResult = { bksId, ...recoveredReviewResult };
      console.log(
        `[github] Reusing the durable model result for PR #${pr.number} after restart`,
      );
    } else {
      finalResult = await runGithubAgent({
        prNumber: pr.number,
        ghRepo: pr.ghRepo,
        kind: "review",
        prompt,
        cwd,
        mode: "ask",
        model: reviewModel,
        branch: pr.headRef,
        title,
        // Each review is self-contained: it reads the CURRENT full diff from the
        // pinned worktree and posts a fresh full assessment, so
        // we do NOT resume the prior engine session. Resuming accumulated the whole
        // transcript across every push, and on actively-updated PRs the context grew
        // past the engine's 1M-token limit. The run then hard-failed with "Prompt is
        // too long" and could not be compacted because a single over-limit exchange
        // has nothing to drop. See the 2026-07-11 dream: 12 such failures, all
        // github-review, e.g. PR #4638 (15 errors / 0 turns). `isUpdate` still drives
        // the "re-review the current diff" prompt framing above.
        resume: false,
        detached: true,
        recoverDetached: sameHeadRecovery || legacyRecovery,
        changedLines: details.additions + details.deletions,
      });
      if (finalResult.uncertain) {
        preserveRecovery = true;
        throw new Error(finalResult.error || "Detached review ownership is uncertain");
      }
      persistReviewResult(finalResult);
    }

    if (cancellationRequested()) return finishCancelled(placeholderId || undefined);
    let parsed = assembled ?? withDedupedFindings(parseReviewOutput(finalResult.text, cwd));
    // A repair turn can only re-express what the first turn already produced.
    // When that turn emitted nothing at all, the repair resumes an engine
    // session with no inspection in it and the model says so, at length, in
    // ~35 s — "No prior inspection artifacts (diffs, findings, or tool
    // outputs) are present in this conversation to synthesize". That output
    // then reads as a completed review of the PR, which it is not. A run that
    // said nothing is not repairable; report it as the failure it is.
    const producedNothing = !assembled && !finalResult.error && !finalResult.text.trim();
    // Fable occasionally declares a progress narration complete before it emits
    // the review contract. Give the same engine session one bounded chance to
    // turn its completed inspection into a postable verdict.
    if (!assembled && !finalResult.error && !producedNothing && !isCompleteReviewOutput(parsed)) {
      if (isShuttingDown()) {
        preserveRecovery = true;
        console.log(`[github] PR #${pr.number} review repair parked for restart`);
        return null;
      }
      console.warn(`[github] PR #${pr.number} review ended without structured output; repairing once`);
      finalResult = await runGithubAgent({
        prNumber: pr.number,
        ghRepo: pr.ghRepo,
        kind: "review",
        prompt: REVIEW_OUTPUT_REPAIR_PROMPT,
        cwd,
        mode: "ask",
        model: finalResult.model || reviewModel,
        branch: pr.headRef,
        title,
        resume: true,
        detached: true,
        // If the process died during this bounded repair turn, the initial
        // result above is durable and the surviving host belongs to the repair.
        recoverDetached: recovering,
      });
      if (finalResult.uncertain) {
        preserveRecovery = true;
        throw new Error(finalResult.error || "Detached review ownership is uncertain");
      }
      persistReviewResult(finalResult);
      if (cancellationRequested()) return finishCancelled(placeholderId || undefined);
      parsed = withDedupedFindings(parseReviewOutput(finalResult.text, cwd));
    }
    const reviewError =
      finalResult.error ||
      (producedNothing
        ? "The review turn ended without producing any output; nothing was inspected."
        : isCompleteReviewOutput(parsed)
          ? undefined
          : "The review did not produce the required structured verdict after one continuation.");
    const tob = await testOnBase;
    const secrets = await secretScan;
    if (cancellationRequested()) return finishCancelled(placeholderId || undefined);

    // Never publish an assessment against a different commit from the one the
    // worktree and prompt were pinned to. A push while the review was running
    // gets its own webhook/reconcile review; this result is now stale.
    const latestPr = await getPrAutomationDetails(
      pr.number ? String(pr.number) : pr.headRef,
      pr.ghRepo || undefined,
    );
    if (
      pr.headSha &&
      latestPr?.headRefOid &&
      latestPr.headRefOid !== pr.headSha
    ) {
      console.log(
        `[github] PR #${pr.number} moved from ${pr.headSha.slice(0, 7)} to ${latestPr.headRefOid.slice(0, 7)} during review; discarding the stale result`,
      );
      if (placeholderId) {
        await editIssueComment(
          placeholderId,
          `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\nNew commits arrived before this review finished. Waiting for the updated review.`,
          pr.ghRepo,
        ).catch(() => {});
      }
      audit({
        msg: "review_superseded_during_run",
        pr_number: pr.number,
        repo: pr.ghRepo || defaultRepo().ghRepo,
        reviewed_sha: pr.headSha,
        current_sha: latestPr.headRefOid,
      });
      return null;
    }

    // A leaked credential blocks regardless of what the model concluded: the
    // verdict drops to request_changes and confidence caps at 2/5. (Not counted
    // as a "blocking finding" for the auto-fix gate — rotation is human work a
    // fixer loop can't do.)
    if (parsed && secrets?.findings.length) {
      parsed.verdict = "request_changes";
      parsed.confidence = Math.min(typeof parsed.confidence === "number" ? parsed.confidence : 2, 2);
    }
    await postReview(pr, details, parsed, finalResult.text, reviewError, forceFreshReview, finalResult.model, reviewOpts, summaryOnly, testOnBaseSection(tob) + secretScanSection(secrets));

    const outcome: ReviewResult = {
      verdict: parsed?.verdict,
      confidence: parsed?.confidence,
      findings: parsed?.findings?.length || 0,
      blocking: reviewBlockingCount(parsed),
      error: reviewError,
    };

    // Per-review telemetry for the Analytics review-quality trend.
    if (!reviewError) {
      audit({
        msg: "review_completed",
        pr_number: pr.number,
        repo: pr.ghRepo || defaultRepo().ghRepo,
        verdict: outcome.verdict,
        confidence: outcome.confidence,
        findings: outcome.findings,
        blocking: outcome.blocking,
        is_update: isUpdate,
        model: finalResult.model,
      });
    }

    // Record the SHA as reviewed only on a successful run, so a transient failure
    // (model error/timeout) leaves it eligible for retry on the next delivery.
    if (!reviewError && pr.headSha) {
      // The verdict is kept alongside the SHA so the sidebar can show the score
      // without reading the PR's comments back off GitHub.
      recordReviewed(
        pr.number,
        pr.headRef,
        pr.headSha,
        {
          verdict: outcome.verdict,
          confidence: outcome.confidence,
          findings: outcome.findings,
          blocking: outcome.blocking,
          sha: pr.headSha,
          at: new Date().toISOString(),
        },
        pr.ghRepo,
      );
    }

    return outcome;
  } catch (e) {
    console.error(`[github] review failed for PR #${pr.number}:`, e);
    return null;
  } finally {
    if (!preserveRecovery) {
      // Any detached host still present here belongs to a workflow that returned
      // before consuming it. Clear the marker only after absence is proven.
      try {
        await discardRecoverableGithubRun(pr.number, "review", pr.ghRepo);
      } catch (error) {
        if (error instanceof GithubRunRecoveryUncertainError)
          preserveRecovery = true;
        else
          console.warn(
            `[github] failed to stop orphaned review host for PR #${pr.number}:`,
            error,
          );
      }
      if (!preserveRecovery)
        clearActiveRun(pr.number, pr.headRef, "review", pr.ghRepo);
    }
    releaseLock("review", pr.number, pr.ghRepo);
  }
}

/** Render one finding as an inline comment: severity badge + title, body, optional suggestion block. */
function composeInlineBody(f: Finding): string {
  const sev = (f.severity || "").toUpperCase();
  const emoji = SEV_EMOJI[(f.severity || "").toLowerCase()] || "";
  const head = [emoji, sev && `**${sev}**`, f.title && `— ${f.title}`].filter(Boolean).join(" ").trim();
  let out = [head, f.body?.trim()].filter(Boolean).join("\n\n");
  if (f.suggestion?.trim()) {
    out += `\n\n\`\`\`suggestion\n${f.suggestion.replace(/\n+$/, "")}\n\`\`\``;
  }
  return out.trim();
}

async function postReview(
  pr: PrRef,
  details: PrAutomationDetails,
  parsed: ReviewOutput | null,
  rawText: string,
  runError?: string,
  force = false,
  modelUsed?: string,
  opts: ReviewOptions = REVIEW_OPTION_DEFAULTS,
  summaryOnly = false,
  extraSummary = "",
): Promise<void> {
  const knownCommentId = getOrInitPrState(pr.number, pr.headRef, pr.ghRepo).summaryCommentId;
  const shortSha = (pr.headSha || "").slice(0, 7);

  // Summary comment (single, edited in place).
  let summaryBody = parsed?.summary_markdown?.trim() || fallbackSummary(rawText, runError);
  // Optional change diagram (schema/flow PRs) — GitHub renders mermaid natively.
  const mermaid = parsed?.diagram?.mermaid?.trim();
  if (mermaid && mermaid.length <= 4000) {
    summaryBody += `\n\n<details><summary>📈 Change diagram</summary>\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n</details>`;
  }
  // Deterministic checks (test-on-base) append below the model's assessment.
  summaryBody += extraSummary;
  // Before anything posts, findings pass the repo/config/feedback filter chain:
  // ignored paths, the per-repo severity floor, giant-PR P0/P1-only mode, and
  // the learned feedback filter (recurring-nit suppression — never P0/P1).
  const allFindings = parsed?.findings || [];
  let withheld = 0;
  const findings = allFindings.filter((f) => {
    if (pathIgnored(f.path, opts)) return withheld++, false;
    if (severityRank(f.severity) > severityRank(opts.minInlineSeverity)) return withheld++, false;
    if (summaryOnly && severityRank(f.severity) > 1) return withheld++, false;
    if (shouldSuppressFinding(pr.ghRepo, { severity: f.severity, title: f.title, body: f.body }))
      return withheld++, false;
    return true;
  });
  if (withheld > 0) {
    console.log(`[github] withheld ${withheld} finding(s) on PR #${pr.number} (config/feedback filters)`);
    audit({
      msg: "review_findings_withheld",
      pr_number: pr.number,
      repo: pr.ghRepo || defaultRepo().ghRepo,
      withheld,
      posted: findings.length,
    });
  }

  const verdict = parsed?.verdict ? ` · **${parsed.verdict.replace(/_/g, " ")}**` : "";
  const confidence =
    typeof parsed?.confidence === "number" ? ` · confidence ${parsed.confidence}/5` : "";
  const findingCount = findings.length;
  // Next-steps footer pointing at the action labels.
  const tip = findingCount
    ? "> 💡 Labels: **`os-auto-fix`** — I fix these and push until CI passes · **`os-adversarial`** — deeper two-pass review · **`os-simplify`** — quality cleanup pass."
    : "> 💡 Labels: **`os-adversarial`** — deeper two-pass review · **`os-simplify`** — quality cleanup pass · **`os-auto-fix`** — fix anything outstanding and push until CI passes.";
  const composed = [
    REVIEW_MARKER,
    `### 🤖 ${personaName()} review${verdict}${confidence}`,
    "",
    summaryBody,
    "",
    findingCount ? `_${findingCount} inline comment${findingCount === 1 ? "" : "s"} below._` : "",
    withheld ? `<sub>${withheld} low-signal finding${withheld === 1 ? "" : "s"} withheld by repo config / feedback history.</sub>` : "",
    tip,
    `<sub>Reviewed \`${shortSha}\`${modelUsed ? ` · ${modelLabel(modelUsed)}` : ""} · earlier reviews collapse above · [open session](${sessionUrl(pr.number, "review", pr.ghRepo)})</sub>`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  // Edit the placeholder posted at the start; fall back to a new comment if it's gone.
  let id: number | null = knownCommentId ?? null;
  if (id) {
    const ok = await editIssueComment(id, composed, pr.ghRepo);
    if (!ok) id = await postIssueComment(pr.number, composed, pr.ghRepo);
  } else {
    id = await postIssueComment(pr.number, composed, pr.ghRepo);
  }
  if (id && id !== knownCommentId) {
    const postedId = id;
    updatePrState(
      pr.number,
      pr.headRef,
      (s) => {
        s.summaryCommentId = postedId;
      },
      pr.ghRepo,
    );
  }

  // Existing inline threads on the PR: used to (a) resolve our own threads GitHub
  // has marked outdated (their code moved with this push) so they collapse instead
  // of piling up, and (b) dedup — a re-review after a push must NOT re-post a
  // finding we already have an open comment on. GitHub only auto-outdates an inline
  // comment when its anchored line changes, so a finding on an unchanged line
  // (e.g. Dockerfile:96) would otherwise get a fresh duplicate every single push.
  const existingThreads = await listReviewThreads(pr.number, pr.ghRepo).catch(() => []);

  // Learning pass over the threads we already fetched: pick up 👍/👎 reactions
  // on our comments and mark outdated/resolved ones "addressed" (the author
  // acted). The "ignored" verdict only lands at PR close (webhook.ts).
  try {
    harvestThreadOutcomes(pr.ghRepo, pr.number, existingThreads, false);
  } catch (e) {
    console.warn(`[github] feedback harvest failed for PR #${pr.number}:`, e);
  }
  // Classify new human replies in our threads ("intentional" vs "good catch")
  // into replySignal — async model call, fire-and-forget.
  void harvestReplySignals(pr.ghRepo, pr.number, existingThreads).catch((e) =>
    console.warn(`[github] reply-signal harvest failed for PR #${pr.number}:`, e),
  );

  // Anchors (path:line) where we already have an open, still-current bot comment.
  // Skip re-posting these — the existing comment already covers the same spot.
  // `force` (manual "review again") bypasses dedup so an explicit re-review is fresh.
  const openBotAnchors = new Set<string>();
  if (!force) {
    for (const t of existingThreads) {
      if (isGithubBotLogin(t.rootAuthor) && !t.isResolved && !t.isOutdated && t.path && t.line != null) {
        openBotAnchors.add(`${t.path}:${t.line}`);
      }
    }
  }

  // Formal review with inline comments, anchored to the diff.
  if (findings.length && pr.headSha) {
    const diff = await getPrDiff(pr.headRef, pr.ghRepo || undefined);
    const commitId = diff?.headRefOid || pr.headSha;
    const onDiff = diff ? filterToDiff(findings, diff.patch) : findings;
    const fresh = onDiff.filter((f) => !openBotAnchors.has(`${f.path}:${f.line}`));
    const inline: ReviewInlineComment[] = fresh.map((f) => ({
      path: f.path,
      line: f.line,
      side: f.side === "LEFT" ? "LEFT" : "RIGHT",
      body: composeInlineBody(f),
    }));
    const deduped = onDiff.length - fresh.length;
    if (deduped > 0) {
      console.log(`[github] skipped ${deduped} finding(s) already commented on PR #${pr.number}`);
    }
    if (inline.length) {
      const ok = await submitReview(pr.number, commitId, `${personaName()} review · \`${shortSha}\``, inline, pr.ghRepo);
      if (!ok) console.warn(`[github] submitReview failed for PR #${pr.number}`);
      // Remember what we posted so future reactions/outcomes can be joined
      // back to it (the feedback filter's training data).
      if (ok) {
        try {
          recordPostedFindings(pr.ghRepo, pr.number, fresh);
        } catch (e) {
          console.warn(`[github] recording findings failed for PR #${pr.number}:`, e);
        }
      }
      if (inline.length < onDiff.length - deduped) {
        console.log(`[github] dropped ${onDiff.length - deduped - inline.length} off-diff finding(s) for PR #${pr.number}`);
      }
    }
  }

  // Auto-resolve our own inline threads GitHub has marked outdated — their code
  // moved or vanished with this push, so the finding no longer anchors anywhere
  // useful. Collapsing them keeps the PR clean without a human resolving by hand.
  // Only ever touches bot-rooted threads; human threads are never resolved here.
  for (const t of existingThreads) {
    if (!t.isResolved && t.isOutdated && isGithubBotLogin(t.rootAuthor)) {
      await resolveReviewThread(t.id).catch(() => {});
    }
  }
}

function fallbackSummary(rawText: string, runError?: string): string {
  if (runError) return `⚠️ Review run errored: ${runError}`;
  const trimmed = (rawText || "").trim();
  if (!trimmed) return "⚠️ The review produced no output.";
  // Couldn't parse the JSON contract — surface the raw text so the review isn't lost.
  return trimmed.slice(0, 4000);
}

/**
 * Extract the first balanced top-level JSON object from `s`, tracking string and
 * escape state so braces (and ``` fences) inside string values don't cut it short.
 */
export function extractBalancedJson(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Pull the JSON object out of the last fenced ```json block in the agent's text
 * and parse it. Extraction is brace-balanced rather than fence-delimited: a
 * finding's markdown `body` can legitimately contain a ``` fence inside the JSON
 * string (e.g. a suggested shell command), and a naive non-greedy ```…``` regex
 * cuts the block at that inner fence — that's exactly what dumped raw narration
 * onto PR #4388.
 */
export function parseReviewOutput(text: string, cwd?: string): ReviewOutput | null {
  if (!text) return null;
  const opener = text.lastIndexOf("```json");
  const candidate = extractBalancedJson(opener === -1 ? text : text.slice(opener)) ?? text;
  try {
    const obj = JSON.parse(candidate.trim());
    if (obj && typeof obj === "object") {
      // Models drift from the contract's exact field names. Sol has emitted both
      // summary/file/details aliases and its native code-review shape
      // (overall_correctness, overall_explanation, priority, code_location).
      // Normalize those known structured forms instead of discarding a usable
      // verdict and spending a continuation that may contradict the first pass.
      const findingPath = (f: any): string | undefined => {
        const raw =
          typeof f.path === "string"
            ? f.path
            : typeof f.file === "string"
              ? f.file
              : typeof f.code_location?.absolute_file_path === "string"
                ? f.code_location.absolute_file_path
                : undefined;
        if (!raw || !raw.startsWith("/")) return raw;
        const root = cwd?.replace(/\/+$/, "");
        return root && raw.startsWith(`${root}/`) ? raw.slice(root.length + 1) : undefined;
      };
      const findings: Finding[] = Array.isArray(obj.findings)
        ? obj.findings
            .map((f: any) => {
              if (!f || typeof f !== "object") return f;
              const priority = Number.isInteger(f.priority) && f.priority >= 0 && f.priority <= 3
                ? `P${f.priority}`
                : undefined;
              const title = typeof f.title === "string"
                ? f.title.replace(/^\[P[0-3]\]\s*/, "")
                : undefined;
              return {
                ...f,
                path: findingPath(f),
                line: Number.isFinite(f.line) ? f.line : f.code_location?.line_range?.start,
                severity: typeof f.severity === "string" ? f.severity : priority,
                title,
                body:
                  typeof f.body === "string"
                    ? f.body
                    : typeof f.details === "string"
                      ? f.details
                      : f.description,
              };
            })
            .filter((f: any) => f && typeof f.path === "string" && Number.isFinite(f.line) && typeof f.body === "string")
            .map((f: any) => ({
              path: f.path,
              line: f.line,
              side: f.side === "LEFT" ? "LEFT" : "RIGHT",
              severity: typeof f.severity === "string" ? f.severity : undefined,
              title: typeof f.title === "string" ? f.title : undefined,
              body: f.body,
              suggestion: typeof f.suggestion === "string" && f.suggestion.trim() ? f.suggestion : undefined,
            }))
        : [];
      // Contract confidence is integer merge-safety on a 1-5 scale. An invalid
      // value (typically Codex's 0-1 self-certainty probability) measures a
      // different quantity. Derive merge safety from the normalized verdict and
      // finding severities instead, so every postable review still has a score.
      const rawConfidence = typeof obj.confidence === "number" ? obj.confidence : undefined;
      const verdict =
        typeof obj.verdict === "string"
          ? obj.verdict
          : obj.overall_correctness === "patch is correct"
            ? "approve"
            : obj.overall_correctness === "patch is incorrect"
              ? "request_changes"
              : undefined;
      const confidence =
        rawConfidence !== undefined && Number.isInteger(rawConfidence) && rawConfidence >= 1 && rawConfidence <= 5
          ? rawConfidence
          : deriveMergeSafetyScore(verdict, findings);
      return {
        verdict,
        confidence,
        summary_markdown:
          typeof obj.summary_markdown === "string"
            ? obj.summary_markdown
            : typeof obj.summary === "string"
              ? obj.summary
              : typeof obj.overall_explanation === "string"
                ? obj.overall_explanation
                : undefined,
        diagram:
          obj.diagram && typeof obj.diagram === "object" && typeof obj.diagram.mermaid === "string"
            ? { type: typeof obj.diagram.type === "string" ? obj.diagram.type : undefined, mermaid: obj.diagram.mermaid }
            : undefined,
        findings,
      };
    }
  } catch {}
  return null;
}

/** A review is postable only when it has a supported verdict and a real summary. */
export function isCompleteReviewOutput(output: ReviewOutput | null): output is ReviewOutput {
  return (
    !!output &&
    (output.verdict === "approve" || output.verdict === "comment" || output.verdict === "request_changes") &&
    typeof output.summary_markdown === "string" &&
    output.summary_markdown.trim().length > 0
  );
}

// ── Unified-diff line validation ─────────────────────────────
// Keep only findings whose (path, line, side) anchor to a line present in the
// diff — GitHub rejects an entire review if any inline comment is off-diff.

interface DiffLineSet {
  right: Set<number>; // new-file line numbers in the diff (added + context)
  left: Set<number>; // old-file line numbers in the diff (removed + context)
}

export function parseDiffLineSets(patch: string): Map<string, DiffLineSet> {
  const byFile = new Map<string, DiffLineSet>();
  let current: DiffLineSet | null = null;
  let newLine = 0;
  let oldLine = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      let p = line.slice(4).trim();
      if (p === "/dev/null") { current = null; continue; } // deleted file
      // git quotes paths with spaces/unicode as "b/foo bar.ts"
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      if (p.startsWith("b/")) p = p.slice(2);
      current = { right: new Set(), left: new Set() };
      byFile.set(p, current);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      current.right.add(newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      current.left.add(oldLine);
      oldLine++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — not a real line.
    } else {
      // context line — valid on both sides
      current.right.add(newLine);
      current.left.add(oldLine);
      newLine++;
      oldLine++;
    }
  }
  return byFile;
}

function filterToDiff(findings: Finding[], patch: string): Finding[] {
  const sets = parseDiffLineSets(patch);
  return findings.filter((f) => {
    const set = sets.get(f.path);
    if (!set) return false;
    return f.side === "LEFT" ? set.left.has(f.line) : set.right.has(f.line);
  });
}
