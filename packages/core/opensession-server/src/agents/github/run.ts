/**
 * Shared headless-run helper for the github agent. Persists its own visible
 * NativeSessionFile so each PR review/fix/simplify shows up as a session in the
 * web UI, and resumes the engine conversation across rounds via the
 * deterministic per-PR session file. Reviews use a detached run host so the
 * model turn can outlive a service restart; the GitHub recovery marker resumes
 * the surrounding posting workflow.
 */
import { existsSync, readFileSync } from "fs";
import { OPENSESSION_SESSIONS_DIR } from "../../server/paths";
import { invalidateSessionsCache, recordRunOutcome, updateSessionFile } from "../../server/session-cache";
import {
  cancelAgentRun,
  cancelAgentRunToken,
  runAgent,
  resumeContinuationPrompt,
} from "../../server/agent-runner";
import { runAgentHosted, resumeLocalHostRun } from "../../server/host-client";
import {
  activeRunRecords,
  journalClearIfLineage,
  journalMarkRecoveryAttached,
  journalStartRecovery,
  type ActiveRunRecord,
} from "../../server/run-journal";
import { listAutomations } from "../../server/automations";
import { automaticFallbackModel, providerFor, modelLabel } from "../../server/models";
import { engineSessionPatch } from "../../server/sessions";
import { STRIPE_CONFIRM_TOOLS } from "../../server/runner-shared";
import { gitIdentityFor, type GitIdentity } from "../../server/shared/user-mappings";
import { resolvePrWorkspace } from "../../server/workspace-resolve";
import { repoForPath } from "../../server/worktree";
import { PR_EVENT_KEY, prKey, repoForFullName } from "./constants";
import type { NativeSessionFile } from "../../server/types";
import { configuredServer, defaultRepo } from "../../server/config";
import { githubServiceCredentialEnv } from "../../server/github-app";
import {
  shouldPersistModelSwitch,
  type StreamEvent,
} from "../../server/run-events";

const SESSIONS_DIR = OPENSESSION_SESSIONS_DIR;

/**
 * Default external MCP servers for a PR flow, used when the review automation
 * doesn't pin its own list (see githubFlowMcpServers). Everything else in
 * mcp-config is withheld: these runs read a diff, the repo, and CI, and
 * mounting the full connector set put ~430 external tool schemas in front of
 * every one of them.
 *
 * Measured over the retained audit window (1,410 github-* sessions): only ~20
 * sessions (1.4%) ever called an external MCP tool at all, and the calls
 * concentrate in grafana (149 calls / 7 sessions — checking Loki + Prometheus
 * for a change under review) and linear (13 / 8 — pulling the issue a PR
 * references). The tail this drops by default is stripe, an internal support
 * server and plain (all in single digits); a run that needs one of
 * those reports it can't reach it instead of silently costing every other run
 * the schemas.
 */
export const DEFAULT_GITHUB_FLOW_MCP_SERVERS = ["grafana", "linear"];

/**
 * Which MCP servers this PR flow mounts — configurable, not baked in. The
 * review automation (eventKey `github:pull_request`) is already the config
 * surface for these runs' prompt, model and on/off switch (resolveReviewConfig
 * in webhook.ts); its `mcpServers` field now steers their connectors too, so
 * the list is editable in Settings → Automations (the form has an MCP picker)
 * and through opensession-admin, with no deploy.
 *
 * Unset on the automation → the lean default above. Explicitly set to `[]` →
 * no external servers at all, which is a legitimate choice here (built-ins,
 * the repo and gh cover the job). Note this is NOT the same as the runner's
 * `undefined`, which means "every server" — that distinction is why the
 * default is applied here rather than by passing the automation's value
 * straight through.
 */
export function githubFlowMcpServers(): string[] {
  const automation = listAutomations().find((a) => a.eventKey === PR_EVENT_KEY);
  return automation?.mcpServers ?? DEFAULT_GITHUB_FLOW_MCP_SERVERS;
}

/**
 * All sessions for one PR (its review/autofix/simplify/adversarial/mention runs,
 * plus whatever session originally opened the PR) belong in one Project folder.
 * Delegates to the shared adopt-don't-duplicate resolver (workspace-resolve.ts)
 * so the sidebar's PR clicks and these headless runs can never mint diverging
 * workspaces for the same PR. Best-effort: never block a run on this.
 */
async function workspaceIdForPr(prNumber: number, branch: string, title: string, repoId: string | null): Promise<string | null> {
  if (!repoId) return null;
  try {
    // opts.title is per-kind ("Review · PR #123 <PR title>"). The folder groups
    // ALL kinds for the PR, so name it PR-level: strip the kind + "PR #n" prefix
    // down to the bare PR title (fall back to the full title if it doesn't match).
    const prTitle = title.replace(/^.*?PR #\d+[:\s-]*/i, "").trim() || title;
    const resolved = await resolvePrWorkspace({
      repoId,
      number: prNumber,
      branch,
      title: prTitle,
      createdBy: "GitHub (automation)",
    });
    return resolved?.workspace.id ?? null;
  } catch {
    return null;
  }
}

export type GithubRunKind =
  | "review"
  | "autofix"
  | "simplify"
  | "mention"
  | "adversarial"
  | "followup";

/**
 * Stable, deterministic opensession session id per PR + behavior (one resumable
 * session each). `suffix` splits one behavior into sibling sessions that run at
 * the same time — the review's recall sweep gives each batch its own id, because
 * every per-session structure here (session file, run journal, detached-host
 * recovery marker) is keyed by this string and concurrent runs sharing one id
 * discard each other's hosts.
 */
export function bksIdFor(
  prNumber: number,
  kind: GithubRunKind,
  ghRepo?: string,
  suffix?: string,
): string {
  return `bks-ghpr-${prKey(prNumber, ghRepo)}-${kind}${suffix ? `-${suffix}` : ""}`;
}

const UI_BASE =
  process.env.OPENSESSION_UI_BASE ||
  configuredServer().publicBaseUrl;

/** Open Session UI link to any session id (also used for handoff "open session" links). */
export function uiSessionUrl(sessionId: string): string {
  return `${UI_BASE}/session/${sessionId}`;
}

/** Open Session UI link to a run's session, for "open to monitor" links in PR comments. */
export function sessionUrl(prNumber: number, kind: GithubRunKind, ghRepo?: string): string {
  return uiSessionUrl(bksIdFor(prNumber, kind, ghRepo));
}

export interface AnnouncedRun {
  prNumber: number;
  ghRepo?: string;
  kind: GithubRunKind;
  branch: string;
  title: string;
  mode: "ask" | "code";
}

/**
 * The session file an announce writes: create-if-absent defaults first (an
 * existing file wins, so a resumed round keeps its engine ids and model
 * history), then the fields this round owns. Same field-scoped shape as
 * runGithubAgent's persist, minus everything only the engine can know.
 * Exported for its test; call announceGithubRun.
 */
export function announcedSessionFile(
  existing: NativeSessionFile,
  bksId: string,
  opts: AnnouncedRun,
  workspaceId: string | null,
  repoId: string,
  now = new Date().toISOString(),
): NativeSessionFile {
  return {
    id: bksId,
    claudeSessionId: "",
    // The worktree doesn't exist yet. That checkout is what an announce is
    // getting ahead of; runGithubAgent fills it in once it has one.
    worktreeDir: "",
    createdAt: now,
    ...(existing as Partial<NativeSessionFile>),
    branch: opts.branch,
    createdBy: "GitHub (automation)",
    lastActivity: now,
    title: opts.title,
    mode: opts.mode,
    repo: repoId,
    automation: "github-pr-review",
    ...(workspaceId ? { workspaceId } : {}),
  };
}

/**
 * Make a run's session exist before its engine does.
 *
 * `bksIdFor` is deterministic, so every behavior hands out the run's session
 * link the moment it starts: the PR's "📺 open session" comment, and the info
 * panel's "open run" after a Review/Simplify/Adversarial click. The file behind
 * that id was only written on the engine's FIRST event, which comes after a PR
 * fetch and a worktree checkout that can install dependencies. Anyone who
 * followed the link inside that window landed on "Session not found".
 *
 * Each behavior calls this where it mints the link. One small atomic write, and
 * runGithubAgent's own persist overlays the engine ids on top of it.
 */
export async function announceGithubRun(opts: AnnouncedRun): Promise<string> {
  const bksId = bksIdFor(opts.prNumber, opts.kind, opts.ghRepo);
  const repoId =
    (opts.ghRepo ? repoForFullName(opts.ghRepo)?.id : undefined) ??
    defaultRepo().id;
  const workspaceId = await workspaceIdForPr(
    opts.prNumber,
    opts.branch,
    opts.title,
    repoId,
  );
  await updateSessionFile(bksId, (data) =>
    announcedSessionFile(data, bksId, opts, workspaceId, repoId),
  );
  // updateSessionFile drops the session cache but not the list route's
  // serialized snapshot on top of it. Without this the new session can stay
  // invisible to the UI for the rest of that snapshot's TTL.
  invalidateSessionsCache();
  return bksId;
}

/** Map a GitHub login to a git identity for commit attribution (fix/simplify). */
export function authorForLogin(login?: string): GitIdentity | null {
  return gitIdentityFor(login || null);
}

/**
 * Marker the code-mode behaviors emit right before their final summary. We post
 * only the text after it, so the agent's working narration ("let me run the
 * subagents…") never lands on the PR.
 */
export const SUMMARY_SENTINEL = "===OPENSESSION-SUMMARY===";

/** Text after the last summary sentinel; falls back to the full trimmed text. */
export function finalSummary(text: string): string {
  if (!text) return "";
  const idx = text.lastIndexOf(SUMMARY_SENTINEL);
  return idx === -1 ? text.trim() : text.slice(idx + SUMMARY_SENTINEL.length).trim();
}

function readSessionFile(bksId: string): NativeSessionFile | null {
  const path = `${SESSIONS_DIR}/${bksId}.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as NativeSessionFile;
  } catch {}
  return null;
}

function readEngineSessionId(
  file: NativeSessionFile | null,
  model?: string
): string {
  if (!file) return "";
  const provider = providerFor(model || file.model);
  if (provider === "codex") return file.codexThreadId || "";
  return file.claudeSessionId || "";
}

export interface GithubRunOpts {
  prNumber: number;
  /** owner/name when the PR lives outside the default repo (multi-repo). */
  ghRepo?: string;
  kind: GithubRunKind;
  prompt: string;
  cwd: string;
  mode: "ask" | "code";
  model?: string;
  branch: string;
  title: string;
  /** Resume the prior engine conversation for this PR+behavior if one exists. */
  resume?: boolean;
  /** Changed lines (additions + deletions) this turn has to get through, for
   *  the wall-clock budget. Omitted = the floor. */
  changedLines?: number;
  /** Absolute wall-clock budget for this turn, overriding the `changedLines`
   *  scale. Used by the review's recall sweep to fit N batches inside a stage
   *  deadline instead of giving each batch a whole review's budget. */
  timeoutMs?: number;
  /** Sibling-session discriminator (see bksIdFor). Concurrent runs of the same
   *  behavior on one PR MUST each pass a distinct suffix. */
  sessionSuffix?: string;
  /** Run this turn in a detached host so it survives a service restart. */
  detached?: boolean;
  /** Reattach the detached turn left by this behavior's persisted recovery marker. */
  recoverDetached?: boolean;
  /** Commit attribution for code-mode runs (the human who asked). */
  author?: GitIdentity | null;
  onSessionCreated?: (bksId: string) => void;
}

export interface GithubRunResult {
  bksId: string;
  text: string;
  error?: string;
  /** Model that actually drove the run (after any fallback switches). */
  model?: string;
  /** Ownership remains with a detached host whose absence is not proven. */
  uncertain?: true;
}

/** Pick the newest detached turn belonging to this deterministic GitHub session. */
export function recoverableGithubRun(
  records: ActiveRunRecord[],
  bksId: string,
  kind: GithubRunKind,
): ActiveRunRecord | undefined {
  const journalKind = `github-${kind}`;
  return records
    .filter(
      (run) =>
        run.osSessionId === bksId &&
        !!run.hostId &&
        (run.kind === journalKind || run.kind?.startsWith(`${journalKind}-`)),
    )
    .sort(
      (a, b) =>
        (Date.parse(b.startedAt || "") || 0) -
        (Date.parse(a.startedAt || "") || 0),
    )[0];
}

export class GithubRunRecoveryUncertainError extends Error {
  constructor(readonly hostId: string) {
    super(`Detached host ${hostId} is not connectable but is not proven dead`);
    this.name = "GithubRunRecoveryUncertainError";
  }
}

/**
 * Stop the one superseded host, and nothing else on this PR.
 *
 * `bksIdFor` is deterministic, so every run for a PR+kind shares one
 * osSessionId, and cancelAgentRun latches every pending token, live token and
 * journal record filed under any id it is handed. Cancelling by the shared
 * session id therefore hit whichever run owned the PR when the call reached
 * its journal sweep — and because the call was not awaited, that could be a
 * run started after the discard returned. On 2026-09-03 it was: the repair
 * path that requested this discard launched its replacement review host one
 * second later, the predecessor's cancel took the current-run projection away
 * from it, and it ended with no terminal event on a PR that had done nothing
 * wrong.
 *
 * `run.runKey` is the host's immutable dispatch id — its hostId, which
 * resumeLocalHostRun above just registered as a cancellable control — and no
 * successor ever reuses it, so cancelAgentRunToken reaches this host and only
 * this host. Awaited rather than floated for the same reason the old call was
 * wrong: a cancel still in flight after the discard returns can outlive the
 * run it was aimed at. Scoped to one token it takes no journal-wide await, so
 * awaiting costs the drain nothing.
 *
 * Deliberately not settling the session's run state: the runGithubAgent turn
 * that owned this host settled it through recordRunOutcome when it returned.
 * Re-settling here is the same mistake in a different shape — it would take
 * the session away from whoever owns it now.
 *
 * `deps` is test seam only (same default-parameter idiom as journalSet).
 */
export async function discardGithubRunRecord(
  run: ActiveRunRecord,
  deps: {
    resume?: typeof resumeLocalHostRun;
    cancel?: (runToken: string) => Promise<unknown>;
  } = {},
): Promise<void> {
  const events = await (deps.resume ?? resumeLocalHostRun)(run, {});
  if (events === "uncertain") {
    throw new GithubRunRecoveryUncertainError(run.hostId || run.runKey);
  }
  if (events) {
    await (deps.cancel ?? cancelAgentRunToken)(run.runKey);
    for await (const _event of events) {}
  }
  journalClearIfLineage(run);
}

/** Stop a detached turn whose surrounding GitHub workflow is no longer recoverable. */
export async function discardRecoverableGithubRun(
  prNumber: number,
  kind: GithubRunKind,
  ghRepo?: string,
): Promise<boolean> {
  const bksId = bksIdFor(prNumber, kind, ghRepo);
  const run = recoverableGithubRun(activeRunRecords(), bksId, kind);
  if (!run) return false;
  await discardGithubRunRecord(run);
  return true;
}

/** Floor: what every run gets regardless of size, and what a run with no
 *  known diff size gets. Unchanged from the flat default it replaces. */
export const GITHUB_RUN_TIMEOUT_FLOOR_MS = 15 * 60 * 1000;
/** Added per changed line (additions + deletions). */
export const GITHUB_RUN_TIMEOUT_PER_LINE_MS = 2_500;
/** Hard stop, so a 10 000-line PR cannot hold a host all afternoon. */
export const GITHUB_RUN_TIMEOUT_CEILING_MS = 45 * 60 * 1000;

/**
 * Wall clock one GitHub turn may burn before it is cancelled.
 *
 * Nothing else bounds it. PI_SDK_MAX_TURNS caps a single model response — pi
 * drives the Claude Code SDK as a model *provider* — and pi's own agent loop
 * has no step limit, so a model that keeps re-reading the same files just keeps
 * going. On 2026-09-03 a mention on a 26-line diff spent 17 minutes and 103
 * events re-reading the same two files, twice announced it was done and then
 * carried on, and had to be killed by stopping the service.
 *
 * The budget scales with the diff because review cost does. Measured over five
 * clean review runs (reviewer scorecard, 2026-09-03): 26 lines → 18 s, 68 →
 * 183 s, 411 → 890 s with 10 s to spare, and 362 / 372 / 692 all still working
 * when the flat 900 s cap killed them. The only large run that finished spent
 * ~2.2 s per changed line, and that is a LOWER bound — the three that died had
 * not finished at their own 2.5 s/line. So: 2.5 s per changed line on top of
 * the old 15-minute floor, which gives the 362-line case ~30 min (about twice
 * what the comparable 411-line success needed) and leaves every PR under ~100
 * lines on exactly the budget it has today. The corpus median is ~382 lines,
 * i.e. squarely in the band the flat default was failing.
 *
 * The env var stays an absolute override, not a floor: an operator setting it
 * means that number and no scaling.
 */
export function githubRunTimeoutMs(changedLines?: number): number {
  const n = Number(process.env.OPENSESSION_GITHUB_RUN_TIMEOUT_MS);
  if (Number.isFinite(n) && n > 0) return n;
  const lines = Number.isFinite(changedLines) && changedLines! > 0 ? changedLines! : 0;
  return Math.min(
    GITHUB_RUN_TIMEOUT_FLOOR_MS + lines * GITHUB_RUN_TIMEOUT_PER_LINE_MS,
    GITHUB_RUN_TIMEOUT_CEILING_MS,
  );
}

const DEADLINE = Symbol("github-run-deadline");

/**
 * Yield a run's events until the source ends or `timeoutMs` elapses.
 *
 * The race is against the pending `next()`, not against each delivered event:
 * a turn that stops emitting altogether never reaches a loop body, so a check
 * inside the consumer could not bound it. `onExpire` cancels the engine; the
 * abandoned source unwinds behind us rather than being drained, because
 * draining a run that would not stop is what we are here to avoid.
 */
export async function* withRunDeadline<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  onExpire: () => void | Promise<void>,
): AsyncGenerator<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), timeoutMs);
  });
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await Promise.race([it.next(), expired]);
      if (next === DEADLINE) {
        // Awaited, not floated: a cancel still in flight when this turn ends
        // lands on whoever owns the session next, which is exactly how the
        // superseded-host discard used to kill its own replacement.
        await onExpire();
        void it.return?.().catch(() => {});
        return;
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Run one headless turn for a PR behavior; returns the agent's accumulated text. */
export async function runGithubAgent(opts: GithubRunOpts): Promise<GithubRunResult> {
  const bksId = bksIdFor(opts.prNumber, opts.kind, opts.ghRepo, opts.sessionSuffix);
  const startedAt = new Date();

  // Group this and the PR's other sessions under one Project folder.
  let repoId: string | null = null;
  let runGhRepo = opts.ghRepo;
  try {
    const repo = repoForPath(opts.cwd);
    repoId = repo.id;
    runGhRepo ||= repo.ghRepo;
  } catch {}
  if (opts.mode === "code" && opts.detached) {
    throw new Error("GitHub code runs cannot be detached with an ephemeral credential");
  }
  const githubEnv =
    opts.mode === "code" ? await githubServiceCredentialEnv(runGhRepo) : undefined;
  const workspaceId = await workspaceIdForPr(opts.prNumber, opts.branch, opts.title, repoId);

  const existingSessionFile = readSessionFile(bksId);
  // Engine sessions are scoped to their directory; a session started under a
  // different cwd (e.g. a review from before reviews got per-PR worktrees)
  // won't resolve there — start fresh rather than resuming across cwds.
  const cwdMatches =
    !existingSessionFile?.worktreeDir || existingSessionFile.worktreeDir === opts.cwd;
  const resumeFrom = opts.resume && cwdMatches
    ? readEngineSessionId(existingSessionFile, opts.model)
    : "";

  let effectiveModel = opts.model || existingSessionFile?.model;
  let selectedModel = effectiveModel;
  let effectiveProvider = providerFor(effectiveModel);
  const modelHistory: NonNullable<NativeSessionFile["modelHistory"]> = [
    ...(existingSessionFile?.modelHistory || []),
  ];
  // Field-scoped write via the session-file mutex (transcript-v2 §6, same
  // shape as the six W3 conversions): creation fields are create-if-absent
  // defaults (an existing file wins), and each call overlays only the fields
  // this run owns — engine ids, effective model + history, and the per-round
  // PR shape (branch/cwd/title/mode/workspaceId). Prior engine ids (e.g. a
  // codexThreadId from an earlier round) and any concurrent writer's fields
  // survive via the fresh-read spread instead of being rebuilt from closures.
  const persist = (engineSessionId: string) =>
    updateSessionFile(bksId, (data) => {
      // Widen to Partial: the file may not exist yet (create-if-absent).
      const existing: Partial<NativeSessionFile> = data;
      return {
        id: bksId,
        claudeSessionId: "",
        createdAt: startedAt.toISOString(),
        ...existing,
        ...(engineSessionId
          ? engineSessionPatch(effectiveProvider, engineSessionId)
          : {}),
        ...(engineSessionId ? { lastEngineProvider: effectiveProvider } : {}),
        ...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(modelHistory.length ? { modelHistory } : {}),
        branch: opts.branch,
        worktreeDir: opts.cwd,
        createdBy: "GitHub (automation)",
        lastActivity: new Date().toISOString(),
        title: opts.title,
        mode: opts.mode,
        ...(repoId ? { repo: repoId } : {}),
        automation: "github-pr-review",
        ...(workspaceId ? { workspaceId } : {}),
      };
    }).catch((e) => {
      console.error(`[github-run] failed to persist session ${bksId}:`, e);
    });

  let text = "";
  let engineSessionId = resumeFrom;
  let errorMsg = "";
  let recoveryUncertain = false;
  let timedOut = false;
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs! > 0
      ? opts.timeoutMs!
      : githubRunTimeoutMs(opts.changedLines);

  // Write the file before the engine boots, not on its first event: the run's
  // session link is already public by now (see announceGithubRun), and booting
  // an engine takes long enough that following it hit "Session not found".
  await persist(resumeFrom);
  invalidateSessionsCache();

  const existingDetachedRun = opts.detached
    ? recoverableGithubRun(activeRunRecords(), bksId, opts.kind)
    : undefined;
  let recoveredRun = opts.recoverDetached ? existingDetachedRun : undefined;

  try {
    // A new head supersedes the detached review that was running when the
    // server stopped. Cancel and consume it before starting the replacement so
    // two models never inspect different commits under the same session id.
    if (existingDetachedRun && !opts.recoverDetached) {
      console.log(
        `[github-run] Discarding superseded ${opts.kind} host ${existingDetachedRun.hostId} for ${bksId}`,
      );
      await discardGithubRunRecord(existingDetachedRun);
    }

    let events: AsyncIterable<StreamEvent>;
    if (recoveredRun) {
      recoveredRun = journalStartRecovery(recoveredRun);
      engineSessionId = recoveredRun.claudeSessionId || engineSessionId;
      const reattached = await resumeLocalHostRun(recoveredRun, {});
      if (reattached === "uncertain") {
        recoveryUncertain = true;
        throw new GithubRunRecoveryUncertainError(
          recoveredRun.hostId || recoveredRun.runKey,
        );
      }
      if (reattached) {
        console.log(
          `[github-run] Reattached ${opts.kind} session ${bksId} to host ${recoveredRun.hostId}`,
        );
        Object.assign(
          recoveredRun,
          journalMarkRecoveryAttached(recoveredRun) || {},
        );
        events = reattached;
      } else {
        journalClearIfLineage(recoveredRun);
        console.warn(
          `[github-run] Detached host ${recoveredRun.hostId} is gone; resuming ${bksId} from its engine session`,
        );
        events = runAgentHosted({
          osSessionId: bksId,
          prompt: recoveredRun.claudeSessionId
            ? resumeContinuationPrompt(recoveredRun.prompt)
            : opts.prompt,
          sessionId: recoveredRun.claudeSessionId || undefined,
          cwd: opts.cwd,
          mode: opts.mode,
          model: effectiveModel,
          confirmTools: STRIPE_CONFIRM_TOOLS,
          aws: true,
          author: opts.author,
          fallbackModel: automaticFallbackModel(effectiveModel),
          mcpServers: githubFlowMcpServers(),
          trustProfile: "automation",
          journalKind: `github-${opts.kind}`,
          firstJournaledAt: recoveredRun.firstJournaledAt,
          resumeAttempts: recoveredRun.resumeAttempts,
          lastResumeAt: recoveredRun.lastResumeAt,
        });
      }
    } else if (opts.detached) {
      events = runAgentHosted({
        osSessionId: bksId,
        prompt: opts.prompt,
        sessionId: resumeFrom || undefined,
        cwd: opts.cwd,
        mode: opts.mode,
        model: effectiveModel,
        confirmTools: STRIPE_CONFIRM_TOOLS,
        aws: true,
        author: opts.author,
        fallbackModel: automaticFallbackModel(effectiveModel),
        mcpServers: githubFlowMcpServers(),
        trustProfile: "automation",
        journalKind: `github-${opts.kind}`,
      });
    } else {
      events = runAgent({
        prompt: opts.prompt,
        sessionId: resumeFrom || undefined,
        cwd: opts.cwd,
        mode: opts.mode,
        model: effectiveModel,
        confirmTools: STRIPE_CONFIRM_TOOLS,
        aws: true,
        author: opts.author,
        fallbackModel: automaticFallbackModel(effectiveModel),
        mcpServers: githubFlowMcpServers(),
        githubEnv,
        journal: { osSessionId: bksId, kind: `github-${opts.kind}` },
      });
    }

    for await (const event of withRunDeadline(events, timeoutMs, async () => {
      timedOut = true;
      console.error(
        `[github-run] ${opts.kind} on PR #${opts.prNumber} hit the ${Math.round(timeoutMs / 1000)}s wall clock after ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s; cancelling`,
      );
      await cancelAgentRun(bksId, engineSessionId, recoveredRun?.runKey);
    })) {
      if (event.type === "init") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) {
          effectiveModel = event.model;
          if (!selectedModel) selectedModel = event.model;
        }
        persist(engineSessionId);
        opts.onSessionCreated?.(bksId);
      } else if (event.type === "text_chunk") {
        text += event.text;
      } else if (event.type === "model_switch") {
        const to = event.toModel || "";
        if (to) {
          effectiveModel = to;
          effectiveProvider = providerFor(to);
          if (shouldPersistModelSwitch(event)) {
            selectedModel = to;
            modelHistory.push({
              model: to,
              at: new Date().toISOString(),
              by: `auto-switch · ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`,
            });
          }
        }
      } else if (event.type === "done") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.result) text = event.result;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) effectiveModel = event.model;
      } else if (event.type === "error") {
        errorMsg = event.content || "Unknown error";
      }
    }
  } catch (e: any) {
    errorMsg = e.message || String(e);
  }
  // Last word, over whatever the cancelled engine managed to emit on its way
  // out: without a named reason the behaviors post "Unknown error", or (mention)
  // the half-finished narration, and the run reads as if it just gave up.
  if (timedOut)
    errorMsg = `Run exceeded its ${Math.round(timeoutMs / 1000)}s wall-clock limit and was cancelled`;

  await persist(engineSessionId);
  // An uncertain host still owns the turn. Settling the visible run or clearing
  // its journal here would let a retry overlap it. A settled run keeps its
  // recovery record until durable outcome projection completes.
  if (!recoveryUncertain) {
    await recordRunOutcome(bksId, errorMsg || null);
    if (recoveredRun) journalClearIfLineage(recoveredRun);
  }
  return {
    bksId,
    text,
    error: errorMsg || undefined,
    model: effectiveModel,
    ...(recoveryUncertain ? { uncertain: true as const } : {}),
  };
}
