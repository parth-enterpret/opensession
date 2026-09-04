/**
 * A disabled automation must contribute nothing to the review config.
 *
 * Regression test for a bug that cost weeks of misdirected work: the deployed
 * host carried an automation with `enabled: false` and a frozen 5,955-character
 * prompt, and `resolveReviewConfig` read `enabled` only for `autoEnabled` while
 * taking the prompt and model unconditionally. Every edit to the review prompt
 * in this repo was therefore dead on arrival in production, and no amount of
 * local testing could reproduce it, because locally there was no automation
 * file at all.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

const automations: Array<Record<string, unknown>> = [];
mock.module("../../server/automations", () => ({
  listAutomations: () => automations,
  fireAutomationsForEvent: () => {},
}));

const { resolveReviewConfig } = await import("./webhook");
const { DEFAULT_REVIEW_PROMPT } = await import("./prompts");

/** Same key `resolveReviewConfig` filters on. */
const PR_EVENT_KEY = (await import("./constants")).PR_EVENT_KEY as string;

afterEach(() => {
  automations.length = 0;
});

describe("resolveReviewConfig", () => {
  test("with no automation at all, the repo's own prompt is used", () => {
    const { autoEnabled, config } = resolveReviewConfig();
    expect(autoEnabled).toBe(false);
    expect(config.prompt).toBe(DEFAULT_REVIEW_PROMPT);
    expect(config.model).toBeUndefined();
  });

  test("an ENABLED automation supplies its prompt and model", () => {
    automations.push({
      eventKey: PR_EVENT_KEY,
      enabled: true,
      prompt: "custom prompt",
      model: "some-model",
    });
    const { autoEnabled, config } = resolveReviewConfig();
    expect(autoEnabled).toBe(true);
    expect(config.prompt).toBe("custom prompt");
    expect(config.model).toBe("some-model");
  });

  test("a DISABLED automation supplies NOTHING — this is the regression", () => {
    automations.push({
      eventKey: PR_EVENT_KEY,
      enabled: false,
      prompt: "a frozen prompt nobody meant to still be live",
      model: "a-stale-model",
    });
    const { autoEnabled, config } = resolveReviewConfig();
    expect(autoEnabled).toBe(false);
    // Both of these were wrong before the fix.
    expect(config.prompt).toBe(DEFAULT_REVIEW_PROMPT);
    expect(config.model).toBeUndefined();
  });

  test("an enabled automation wins over a disabled one for the same event", () => {
    automations.push({ eventKey: PR_EVENT_KEY, enabled: false, prompt: "stale" });
    automations.push({ eventKey: PR_EVENT_KEY, enabled: true, prompt: "live" });
    expect(resolveReviewConfig().config.prompt).toBe("live");
  });

  test("an automation for a different event is ignored", () => {
    automations.push({ eventKey: "some.other.event", enabled: true, prompt: "not ours" });
    expect(resolveReviewConfig().config.prompt).toBe(DEFAULT_REVIEW_PROMPT);
  });
});
