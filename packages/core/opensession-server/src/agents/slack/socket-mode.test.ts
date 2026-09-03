import { afterEach, describe, expect, test } from "bun:test";

import {
  handleEnvelope,
  openConnection,
  socketRetryDelayMs,
  type SlackEnvelopeDeps,
} from "./socket-mode";

/** The inner event shape Slack sends, wrapped as the Events API delivers it. */
function eventsApi(envelopeId = "env-1") {
  return JSON.stringify({
    type: "events_api",
    envelope_id: envelopeId,
    payload: {
      type: "event_callback",
      event: {
        type: "app_mention",
        channel: "C0A77HH0XPT",
        ts: "1787752607.643009",
        user: "U0866D7PCCU",
        text: "check?",
      },
    },
  });
}

interface Recorder {
  deps: SlackEnvelopeDeps;
  acks: string[];
  events: unknown[];
  interactives: unknown[];
  order: string[];
  reconnects: number;
  stops: string[];
}

function recorder(overrides: Partial<SlackEnvelopeDeps> = {}): Recorder {
  const r: Recorder = {
    acks: [],
    events: [],
    interactives: [],
    order: [],
    reconnects: 0,
    stops: [],
    deps: {} as SlackEnvelopeDeps,
  };
  r.deps = {
    onEvent: async (payload) => {
      r.order.push("event");
      r.events.push(payload);
    },
    onInteractive: (payload) => {
      r.order.push("interactive");
      r.interactives.push(payload);
    },
    ack: (frame) => {
      r.order.push("ack");
      r.acks.push(frame);
    },
    reconnect: () => {
      r.reconnects += 1;
    },
    stop: (reason) => {
      r.stops.push(reason);
    },
    ...overrides,
  };
  return r;
}

describe("socketRetryDelayMs", () => {
  test("doubles from one second and stops at thirty", () => {
    expect(socketRetryDelayMs(0)).toBe(1_000);
    expect(socketRetryDelayMs(1)).toBe(2_000);
    expect(socketRetryDelayMs(5)).toBe(30_000);
    expect(socketRetryDelayMs(50)).toBe(30_000);
  });

  test("treats a negative attempt count as the first attempt", () => {
    expect(socketRetryDelayMs(-1)).toBe(1_000);
  });
});

describe("handleEnvelope", () => {
  test("hello does not ack", async () => {
    const r = recorder();
    await handleEnvelope(
      JSON.stringify({ type: "hello", num_connections: 1 }),
      r.deps,
    );
    expect(r.acks).toEqual([]);
  });

  test("events_api dispatches the payload then acks its envelope id", async () => {
    const r = recorder();
    await handleEnvelope(eventsApi("env-abc"), r.deps);

    expect(r.events).toHaveLength(1);
    expect((r.events[0] as { type: string }).type).toBe("event_callback");
    expect(r.acks).toEqual([JSON.stringify({ envelope_id: "env-abc" })]);
    // Order is the durability contract: the event is persisted before Slack
    // is told it arrived.
    expect(r.order).toEqual(["event", "ack"]);
  });

  test("events_api does not ack when dispatch fails, so Slack redelivers", async () => {
    const r = recorder({
      onEvent: async () => {
        throw new Error("inbox write failed");
      },
    });
    await handleEnvelope(eventsApi(), r.deps);

    expect(r.acks).toEqual([]);
  });

  test("interactive acks before dispatching", async () => {
    const r = recorder();
    await handleEnvelope(
      JSON.stringify({
        type: "interactive",
        envelope_id: "env-i",
        payload: { type: "block_actions", actions: [{ action_id: "cancel" }] },
      }),
      r.deps,
    );

    expect(r.acks).toEqual([JSON.stringify({ envelope_id: "env-i" })]);
    expect(r.interactives).toHaveLength(1);
    // A slow handler must not push the ack past Slack's three-second deadline
    // and cause the button press to replay.
    expect(r.order).toEqual(["ack", "interactive"]);
  });

  test("slash_commands acks and dispatches nothing", async () => {
    const r = recorder();
    await handleEnvelope(
      JSON.stringify({
        type: "slash_commands",
        envelope_id: "env-s",
        payload: {},
      }),
      r.deps,
    );

    expect(r.acks).toEqual([JSON.stringify({ envelope_id: "env-s" })]);
    expect(r.events).toEqual([]);
    expect(r.interactives).toEqual([]);
  });

  test("disconnect refresh_requested redials", async () => {
    const r = recorder();
    await handleEnvelope(
      JSON.stringify({ type: "disconnect", reason: "refresh_requested" }),
      r.deps,
    );

    expect(r.reconnects).toBe(1);
    expect(r.stops).toEqual([]);
  });

  test("disconnect link_disabled stops instead of looping", async () => {
    const r = recorder();
    await handleEnvelope(
      JSON.stringify({ type: "disconnect", reason: "link_disabled" }),
      r.deps,
    );

    expect(r.stops).toEqual(["link_disabled"]);
    expect(r.reconnects).toBe(0);
  });

  test("a frame that is not JSON is dropped without throwing", async () => {
    const r = recorder();
    await handleEnvelope("<html>proxy error</html>", r.deps);

    expect(r.acks).toEqual([]);
    expect(r.events).toEqual([]);
  });

  test("an unknown envelope type is acked so Slack stops retrying", async () => {
    const r = recorder();
    await handleEnvelope(
      JSON.stringify({ type: "something_new", envelope_id: "env-u" }),
      r.deps,
    );

    expect(r.acks).toEqual([JSON.stringify({ envelope_id: "env-u" })]);
  });
});

describe("openConnection", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.SLACK_SOCKET_DEBUG_RECONNECTS;
  });

  test("sends the app token and returns the socket url", async () => {
    const seen: { auth?: string } = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.auth = (init.headers as Record<string, string>).Authorization;
      return new Response(
        JSON.stringify({ ok: true, url: "wss://slack/link?ticket=1" }),
      );
    }) as unknown as typeof fetch;

    const url = await openConnection("xapp-test");

    expect(seen.auth).toBe("Bearer xapp-test");
    expect(url).toBe("wss://slack/link?ticket=1");
  });

  test("returns null when Slack refuses", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, error: "not_allowed_token_type" }),
      )) as unknown as typeof fetch;

    expect(await openConnection("xoxb-wrong-kind")).toBeNull();
  });

  test("returns null when the call throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    expect(await openConnection("xapp-test")).toBeNull();
  });

  test("appends debug_reconnects only when asked", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: true, url: "wss://slack/link?ticket=1" }),
      )) as unknown as typeof fetch;

    process.env.SLACK_SOCKET_DEBUG_RECONNECTS = "true";
    expect(await openConnection("xapp-test")).toBe(
      "wss://slack/link?ticket=1&debug_reconnects=true",
    );
  });
});
