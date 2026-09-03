/**
 * A GitHub turn had no upper bound: PI_SDK_MAX_TURNS caps one model response,
 * and pi's agent loop caps nothing, so a mention on a 26-line diff looped for
 * 17 minutes re-reading the same two files and had to be killed by hand
 * (2026-09-03). These cover the two shapes a runaway takes — one that keeps
 * emitting, and one that goes silent — plus the promise that a run finishing
 * inside its budget is untouched.
 */
import { afterEach, expect, test } from "bun:test";
import { githubRunTimeoutMs, withRunDeadline } from "./run";

const ORIGINAL = process.env.OPENSESSION_GITHUB_RUN_TIMEOUT_MS;

afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.OPENSESSION_GITHUB_RUN_TIMEOUT_MS;
	else process.env.OPENSESSION_GITHUB_RUN_TIMEOUT_MS = ORIGINAL;
});

async function* forever(): AsyncGenerator<number> {
	for (let i = 0; ; i++) {
		await Bun.sleep(1);
		yield i;
	}
}

async function* silent(): AsyncGenerator<number> {
	await new Promise(() => {});
	yield 0;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const value of source) out.push(value);
	return out;
}

test("a run that never stops emitting is cut off at the deadline", async () => {
	let expired = 0;
	const events = await collect(withRunDeadline(forever(), 25, () => { expired++; }));
	expect(expired).toBe(1);
	expect(events.length).toBeGreaterThan(0);
});

test("a run that goes silent is bounded too", async () => {
	let expired = 0;
	const started = Date.now();
	const events = await collect(withRunDeadline(silent(), 25, () => { expired++; }));
	expect(expired).toBe(1);
	expect(events).toEqual([]);
	expect(Date.now() - started).toBeLessThan(5_000);
});

test("a run that finishes inside its budget is left alone", async () => {
	let expired = 0;
	async function* short() {
		yield "a";
		yield "b";
	}
	expect(await collect(withRunDeadline(short(), 60_000, () => { expired++; }))).toEqual(["a", "b"]);
	expect(expired).toBe(0);
});

test("the limit defaults to 15 minutes and takes a positive override", () => {
	delete process.env.OPENSESSION_GITHUB_RUN_TIMEOUT_MS;
	expect(githubRunTimeoutMs()).toBe(15 * 60 * 1000);
	process.env.OPENSESSION_GITHUB_RUN_TIMEOUT_MS = "60000";
	expect(githubRunTimeoutMs()).toBe(60_000);
	// Junk or a disable attempt falls back rather than removing the bound.
	for (const raw of ["", "0", "-1", "nope"]) {
		process.env.OPENSESSION_GITHUB_RUN_TIMEOUT_MS = raw;
		expect(githubRunTimeoutMs()).toBe(15 * 60 * 1000);
	}
});

test("the limit scales with the diff, between a floor and a ceiling", () => {
	delete process.env.OPENSESSION_GITHUB_RUN_TIMEOUT_MS;
	// Small PRs keep exactly the budget the flat default gave them.
	expect(githubRunTimeoutMs(0)).toBe(15 * 60 * 1000);
	expect(githubRunTimeoutMs(68)).toBe(15 * 60 * 1000 + 68 * 2_500);
	// The sizes the flat 900 s cap killed now get room: the 411-line run that
	// finished needed 890 s, and 362 lines is inside the same band.
	expect(githubRunTimeoutMs(362)).toBeGreaterThan(890_000 * 2);
	expect(githubRunTimeoutMs(692)).toBeGreaterThan(900_000);
	// A 10 000-line PR cannot run forever.
	expect(githubRunTimeoutMs(10_000)).toBe(45 * 60 * 1000);
	// The override is absolute, not a floor: no scaling on top of it.
	process.env.OPENSESSION_GITHUB_RUN_TIMEOUT_MS = "60000";
	expect(githubRunTimeoutMs(10_000)).toBe(60_000);
	delete process.env.OPENSESSION_GITHUB_RUN_TIMEOUT_MS;
});
