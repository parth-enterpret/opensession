import { describe, expect, test } from "bun:test";
import {
  publicWebhookAvailable,
  savedSlackTransport,
  slackCredentialRequired,
} from "./slack-setup";

describe("savedSlackTransport", () => {
  test("preserves configured Socket Mode and HTTP installs", () => {
    // A saved credential decides the transport whatever the ingress looks
    // like, so opening setup on a reachable host cannot silently retarget an
    // instance that already runs on a socket.
    for (const httpAvailable of [true, false]) {
      expect(
        savedSlackTransport(
          [{ name: "SLACK_APP_TOKEN", present: true }],
          httpAvailable,
        ),
      ).toBe("socket");
      expect(
        savedSlackTransport(
          [{ name: "SLACK_SIGNING_SECRET", present: true }],
          httpAvailable,
        ),
      ).toBe("http");
    }
  });

  test("a new install follows the ingress it has", () => {
    expect(savedSlackTransport([], true)).toBe("http");
    expect(savedSlackTransport([], false)).toBe("socket");
  });
});

describe("publicWebhookAvailable", () => {
  test("rejects simple-mode and loopback URLs", () => {
    for (const url of [
      "http://127.0.0.1:3850",
      "http://localhost:3850",
      "http://[::1]:3850",
      "http://0.0.0.0:3848",
      "not a url",
    ]) {
      expect(publicWebhookAvailable(url)).toBe(false);
    }
  });

  test("accepts an internet-facing webhook URL", () => {
    expect(publicWebhookAvailable("https://hooks.example.com")).toBe(true);
  });
});

describe("slackCredentialRequired", () => {
  test("follows the transport currently selected in the UI", () => {
    expect(slackCredentialRequired("SLACK_APP_TOKEN", false, "socket")).toBe(
      true,
    );
    expect(
      slackCredentialRequired("SLACK_SIGNING_SECRET", false, "socket"),
    ).toBe(false);
    expect(slackCredentialRequired("SLACK_APP_TOKEN", false, "http")).toBe(
      false,
    );
    expect(slackCredentialRequired("SLACK_SIGNING_SECRET", false, "http")).toBe(
      true,
    );
  });

  test("keeps unconditional requirements", () => {
    expect(slackCredentialRequired("SLACK_BOT_TOKEN", true, "socket")).toBe(
      true,
    );
    expect(slackCredentialRequired("SLACK_BOT_TOKEN", true, "http")).toBe(true);
  });
});
