/**
 * Slack Socket Mode: the same events, over a socket the instance dials out.
 *
 * The HTTP transport needs Slack to reach a public URL. A self-hosted instance
 * on a tailnet, behind NAT, or on a laptop has no such URL, and the usual
 * answers — a tunnel, a public ingress, an open port — all mean exposing the
 * instance to reach a service that was happy to call outbound instead. Socket
 * Mode inverts it: `apps.connections.open` returns a one-shot `wss://` ticket,
 * the instance dials it, and Slack delivers the identical payloads down it.
 *
 * Envelopes carry no `v0=` signature, and that is not a gap. The HMAC exists to
 * prove a POST to a public, unauthenticated endpoint really came from Slack.
 * Here the transport already proves it: TLS to Slack, on a single-use ticket
 * minted against this app's `xapp-` token. `dispatchSlackEvent` and
 * `dispatchSlackInteractive` do no verification of their own — the HTTP routes
 * verify before calling them — so calling them from here skips no check.
 *
 * The HTTP routes stay registered either way. Without `SLACK_SIGNING_SECRET`
 * they fail closed on every request, which is the correct posture for a
 * Socket-Mode-only install; do not add a branch that skips verification when a
 * socket is connected.
 *
 * Slack expects an acknowledgement within three seconds and redelivers when it
 * does not arrive, so the ack path is deliberately different per envelope type.
 * See `handleEnvelope`.
 */

import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";

/** Backoff for redialling Slack. Same curve as `relayRetryDelayMs` in
 *  `src/runner-host/sandbox-portal-agent.ts` — 1s doubling to a 30s ceiling —
 *  copied rather than imported so an agent does not reach into runner-host for
 *  two lines of arithmetic. */
export function socketRetryDelayMs(failedAttempts: number): number {
	return Math.min(30_000, 1_000 * 2 ** Math.min(Math.max(0, failedAttempts), 5));
}

export interface SlackSocketStatus {
	connected: boolean;
	connectionsOpened: number;
	reconnects: number;
	/** Diagnostic only, never liveness. Slack keeps the link alive with
	 *  protocol-level ping frames that Bun answers itself and never surfaces to
	 *  JS, so a quiet workspace looks identical to a dead socket from here.
	 *  `onclose` is the signal that a connection has gone. */
	lastEnvelopeAt: string | null;
	lastDisconnectReason: string | null;
}

export interface SlackEnvelopeDeps {
	onEvent(payload: unknown): Promise<void>;
	onInteractive(payload: unknown): void;
	ack(frame: string): void;
	reconnect(): void;
	stop(reason: string): void;
	onEnvelope?(): void;
}

/**
 * Route one envelope. Exported and dependency-injected so the routing — which
 * is where the redelivery contract lives — is testable without a socket.
 *
 * Never throws: a rejection out of a WebSocket message callback has nowhere to
 * go.
 */
export async function handleEnvelope(
	raw: string,
	deps: SlackEnvelopeDeps,
): Promise<void> {
	let envelope: {
		type?: string;
		envelope_id?: string;
		reason?: string;
		payload?: unknown;
		num_connections?: number;
	};
	try {
		envelope = JSON.parse(raw);
	} catch {
		console.error("[slack] socket: dropped a frame that was not JSON");
		return;
	}

	deps.onEnvelope?.();
	const id = envelope.envelope_id;

	switch (envelope.type) {
		case "hello":
			console.log(
				`[slack] socket connected (${envelope.num_connections ?? 1} connection(s))`,
			);
			return;

		case "events_api": {
			// Dispatch, then ack — the order the HTTP route uses, for the same
			// reason: `dispatchSlackEvent` persists the event to the durable inbox
			// before returning, so acking first would let a crash lose an event
			// Slack believes it delivered. If dispatch throws we deliberately do
			// not ack, which reproduces the 503 on the HTTP path and makes Slack
			// redeliver.
			try {
				await deps.onEvent(envelope.payload);
			} catch (e) {
				console.error("[slack] socket: event dispatch failed, not acking:", e);
				return;
			}
			if (id) deps.ack(JSON.stringify({ envelope_id: id }));
			return;
		}

		case "interactive": {
			// Ack first, then dispatch. Unlike events there is no durable store
			// behind an interactive payload, so awaiting buys nothing — and several
			// branches await multi-second `chat.update` calls before returning. A
			// missed three-second ack makes Slack replay the button press, which
			// would cancel a run twice or enqueue a review twice.
			if (id) deps.ack(JSON.stringify({ envelope_id: id }));
			deps.onInteractive(envelope.payload);
			return;
		}

		case "slash_commands":
			// Nothing handles slash commands and the generated manifest declares
			// none. Ack so Slack stops retrying, and say so once.
			if (id) deps.ack(JSON.stringify({ envelope_id: id }));
			console.warn("[slack] socket: ignoring a slash command (no handler)");
			return;

		case "disconnect":
			if (envelope.reason === "link_disabled") {
				// Socket Mode was turned off for this app. Redialling is a hot loop
				// against a permanent condition.
				deps.stop(envelope.reason);
				return;
			}
			// "refresh_requested" (Slack cycles connections roughly hourly) and
			// "warning" (advance notice of the same) both just mean redial.
			deps.reconnect();
			return;

		default:
			if (id) deps.ack(JSON.stringify({ envelope_id: id }));
			console.warn(`[slack] socket: unknown envelope type ${envelope.type}`);
			return;
	}
}

/**
 * Ask Slack for a socket URL. Returns null on any failure — the caller backs
 * off and asks again.
 *
 * Form-encoded with no body: Slack documents this endpoint as form-encoded and
 * takes the app token from the header.
 */
export async function openConnection(appToken: string): Promise<string | null> {
	try {
		const response = await fetchWithTimeout(
			"https://slack.com/api/apps.connections.open",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${appToken}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
			},
		);
		const data = (await response.json()) as { ok?: boolean; url?: string; error?: string };
		if (!data.ok || !data.url) {
			console.error(
				`[slack] apps.connections.open failed: ${data.error ?? "unknown error"}`,
			);
			return null;
		}
		// Slack cycles the connection every ~30s with this on, which is the only
		// practical way to exercise the redial path. Never on by default.
		return process.env.SLACK_SOCKET_DEBUG_RECONNECTS === "true"
			? `${data.url}&debug_reconnects=true`
			: data.url;
	} catch (e) {
		console.error("[slack] apps.connections.open threw:", e);
		return null;
	}
}

export interface SlackSocketModeOptions {
	/** App-level token (`xapp-…`) with `connections:write`. Passed in rather than
	 *  read from the environment so tests need no import-order gymnastics. */
	appToken: string;
	onEvent(payload: unknown): Promise<void>;
	onInteractive(payload: unknown): void;
}

/**
 * One outbound connection to Slack, redialled until stopped.
 *
 * Slack permits ten concurrent connections per app; this opens exactly one.
 * On `refresh_requested` it closes and immediately redials rather than opening
 * the replacement first and draining the old one. That leaves a gap of roughly
 * a second during which Slack queues rather than drops, and anything already
 * in flight is redelivered and then absorbed by the existing dedup — the
 * processed-event set and the durable inbox both already guard against
 * duplicates, because the HTTP path needs them for Slack's own retries.
 * Overlapping the two sockets would be strictly better and is worth doing if
 * that gap ever shows up in practice.
 */
export class SlackSocketMode {
	readonly #appToken: string;
	readonly #onEvent: (payload: unknown) => Promise<void>;
	readonly #onInteractive: (payload: unknown) => void;

	#stopping = false;
	#socket: WebSocket | null = null;
	#status: SlackSocketStatus = {
		connected: false,
		connectionsOpened: 0,
		reconnects: 0,
		lastEnvelopeAt: null,
		lastDisconnectReason: null,
	};

	constructor(options: SlackSocketModeOptions) {
		this.#appToken = options.appToken;
		this.#onEvent = options.onEvent;
		this.#onInteractive = options.onInteractive;
	}

	/** Fire-and-forget. `startup()` runs agents one at a time with no timeout,
	 *  so awaiting a dial here would hold up every agent behind this one. */
	start(): void {
		void this.#loop();
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		try {
			this.#socket?.close();
		} catch {
			// Already closing or already gone; either way there is nothing to do.
		}
		this.#socket = null;
		this.#status.connected = false;
	}

	status(): SlackSocketStatus {
		return { ...this.#status };
	}

	async #loop(): Promise<void> {
		let failedAttempts = 0;
		while (!this.#stopping) {
			const opened = await this.#connectOnce();
			failedAttempts = opened ? 0 : failedAttempts + 1;
			if (this.#stopping) break;
			await Bun.sleep(socketRetryDelayMs(failedAttempts));
		}
	}

	/** Resolves when the connection is over, with whether it ever opened. */
	#connectOnce(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			void (async () => {
				const url = await openConnection(this.#appToken);
				if (!url || this.#stopping) {
					resolve(false);
					return;
				}

				let opened = false;
				let settled = false;
				const settle = (): void => {
					if (settled) return;
					settled = true;
					this.#status.connected = false;
					this.#socket = null;
					resolve(opened);
				};

				let socket: WebSocket;
				try {
					socket = new WebSocket(url);
				} catch (e) {
					console.error("[slack] socket: dial failed:", e);
					resolve(false);
					return;
				}
				this.#socket = socket;

				socket.onopen = () => {
					opened = true;
					this.#status.connected = true;
					this.#status.connectionsOpened += 1;
					if (this.#status.connectionsOpened > 1) this.#status.reconnects += 1;
				};

				socket.onmessage = (message: MessageEvent) => {
					const raw =
						typeof message.data === "string"
							? message.data
							: String(message.data);
					void handleEnvelope(raw, {
						onEvent: this.#onEvent,
						onInteractive: this.#onInteractive,
						ack: (frame) => {
							try {
								socket.send(frame);
							} catch (e) {
								console.error("[slack] socket: could not send ack:", e);
							}
						},
						reconnect: () => {
							this.#status.lastDisconnectReason = "refresh_requested";
							try {
								socket.close();
							} catch {
								// onclose still runs and owns the redial.
							}
						},
						stop: (reason) => {
							this.#status.lastDisconnectReason = reason;
							console.error(
								"[slack] socket: Slack disabled Socket Mode for this app. " +
									"Re-enable it or clear SLACK_APP_TOKEN to fall back to HTTP.",
							);
							this.#stopping = true;
							try {
								socket.close();
							} catch {
								// Nothing to do; the loop exits on #stopping either way.
							}
						},
						onEnvelope: () => {
							this.#status.lastEnvelopeAt = new Date().toISOString();
						},
					});
				};

				// onclose follows every error and owns the redial.
				socket.onerror = () => {};
				socket.onclose = () => settle();
			})();
		});
	}
}
