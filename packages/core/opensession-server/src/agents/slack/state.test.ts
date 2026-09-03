import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { SlackSession } from "./state";

// state.ts resolves SESSION_DIR at import, so redirect the state dir first.
const scratch = mkdtempSync(join(tmpdir(), "opensession-slack-state-"));
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = scratch;

const {
	SESSION_DIR,
	loadSession,
	saveSession,
	getSessionKey,
} = await import("./state");
const { writeJsonAtomic } = await import("../../server/shared/atomic-write");
const { SessionListStore, __setSessionListStoreForTest } = await import(
	"../../server/session-list-store"
);
const { findSessionAsync } = await import("../../server/session-cache");

afterAll(() => {
	if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
	else process.env.OPENSESSION_STATE_DIR = previousStateDir;
	rmSync(scratch, { recursive: true, force: true });
});

function session(patch: Partial<SlackSession> = {}): SlackSession {
	return {
		channel: "C1",
		threadTs: "1700000000.000100",
		userId: "U1",
		claudeSessionId: null,
		worktreeDir: null,
		branch: null,
		createdAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		...patch,
	} as SlackSession;
}

describe("saveSession", () => {
	test("round-trips repoId", async () => {
		const s = session({ threadTs: "1.1", repoId: "opensession" });
		await saveSession(s);
		const loaded = await loadSession(getSessionKey(s.channel, s.threadTs));
		expect(loaded?.repoId).toBe("opensession");
	});

	test("keeps fields written by other writers, e.g. piSessionId", async () => {
		const s = session({ threadTs: "2.2" });
		const key = getSessionKey(s.channel, s.threadTs);
		writeJsonAtomic(`${SESSION_DIR}/${key}.json`, {
			channel: s.channel,
			threadTs: s.threadTs,
			piSessionId: "pi-abc",
			message: "written by wt new-slack",
		});

		// The in-memory session has no piSessionId slot filled — the old
		// projection write dropped the key here.
		await saveSession(s);

		const loaded = await loadSession(key);
		expect(loaded?.piSessionId).toBe("pi-abc");
		expect((loaded as any).message).toBe("written by wt new-slack");
	});

	test("an undefined in-memory field doesn't erase the stored one, null does", async () => {
		const s = session({ threadTs: "3.3", model: "pi/anthropic/claude-opus-5" });
		const key = getSessionKey(s.channel, s.threadTs);
		await saveSession(s);
		await saveSession(session({ threadTs: "3.3", claudeSessionId: null }));
		const loaded = await loadSession(key);
		expect(loaded?.model).toBe("pi/anthropic/claude-opus-5");
		expect(loaded?.claudeSessionId).toBeNull();
	});
});

/**
 * The "Open in Open Session" link is posted in the same turn the session file
 * is written, so the file existing is not enough: the materialized list index
 * is what the UI reads, and once it has coverage nothing rescans the Slack
 * store to discover a file. A session nobody indexes is "Session not found"
 * for as long as it exists.
 */
describe("a saved session is visible to the UI immediately", () => {
	async function withCoveredIndex(
		body: (store: InstanceType<typeof SessionListStore>) => Promise<void>,
	): Promise<void> {
		const store = new SessionListStore(":memory:");
		const previous = __setSessionListStoreForTest(store);
		// state.ts pins SESSION_DIR at ITS import, which in a whole-directory run
		// is whatever an earlier test file's env said — so point the state root at
		// the dir saveSession is actually writing to. The reader under test
		// resolves it live, so the two then agree either way.
		const previousState = process.env.OPENSESSION_STATE_DIR;
		process.env.OPENSESSION_STATE_DIR = dirname(SESSION_DIR);
		// Coverage is what makes the index authoritative over the store scan.
		store.markCovered("include");
		try {
			await body(store);
		} finally {
			if (previousState === undefined)
				delete process.env.OPENSESSION_STATE_DIR;
			else process.env.OPENSESSION_STATE_DIR = previousState;
			__setSessionListStoreForTest(previous);
			store.close();
		}
	}

	test("lands in the list index and resolves by id", async () => {
		await withCoveredIndex(async (store) => {
			const s = session({ channel: "C9", threadTs: "4.4" });
			const id = `slack-${getSessionKey(s.channel, s.threadTs)}`;
			await saveSession(s);

			expect(store.list("include").map((row) => row.id)).toContain(id);
			expect((await findSessionAsync(id))?.id).toBe(id);
		});
	});

	test("a later write keeps the indexed row's activity current", async () => {
		await withCoveredIndex(async (store) => {
			const s = session({ channel: "C9", threadTs: "5.5" });
			const id = `slack-${getSessionKey(s.channel, s.threadTs)}`;
			await saveSession(s);
			const first = store.list("include").find((row) => row.id === id);

			await Bun.sleep(2);
			await saveSession({ ...s, title: "renamed by the loop" });
			const second = store.list("include").find((row) => row.id === id);

			expect(second?.title).toBe("renamed by the loop");
			expect(
				Date.parse(second!.lastActivity) > Date.parse(first!.lastActivity),
			).toBe(true);
		});
	});
});
