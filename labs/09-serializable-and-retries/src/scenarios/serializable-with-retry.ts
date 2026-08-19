import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { WRITE_SKEW_STAFF, WRITE_SKEW_TEAM } from "../seed/scenario-staff.js";
import {
  beginWithIsolation,
  connectClient,
  countOnCall,
  countOthersOnCall,
  isSerializationFailure,
  randomizedBackoffMs,
  resetTeamOnCall,
  setOffCall,
  sleep,
} from "./support.js";

const log = createLogger("lab09:scenario:serializable-retry");

export type AttemptOutcome = "committed" | "rejected" | "conflict";

export interface AttemptResult {
  outcome: AttemptOutcome;
  othersOnCall: number;
  sqlstate?: string;
}

export interface RetryOutcome {
  staffName: string;
  staffId: number;
  finalOutcome: Extract<AttemptOutcome, "committed" | "rejected">;
  attempts: number;
  conflictsEncountered: number;
}

/**
 * A single attempt at "go off call if it's still safe", run in its own fresh
 * transaction/connection (simulating a fresh pool checkout per retry - the
 * whole point of a correct retry loop is that it re-reads state, it does not
 * replay a stale decision).
 *
 * `firstAttemptDelayMs` is a deliberate, documented delay inserted between
 * the read and the write ONLY on a transaction's first attempt, widening the
 * window during which two concurrent callers can both read "before" either
 * one writes. This is the CLAUDE.md-sanctioned use of a delay: not to fake
 * correctness, but to make a real race reliably observable instead of
 * depending on accidental scheduler timing. Retries never add this delay -
 * a retry re-reads fresh, already-resolved state, so there is nothing left
 * to race against.
 */
export async function attemptGoOffCall(
  connectionString: string,
  team: string,
  staffId: number,
  opts: { firstAttemptDelayMs?: number } = {},
): Promise<AttemptResult> {
  const client = await connectClient(connectionString);
  try {
    await beginWithIsolation(client, "SERIALIZABLE");
    const othersOnCall = await countOthersOnCall(client, team, staffId);

    if (opts.firstAttemptDelayMs) {
      await sleep(opts.firstAttemptDelayMs);
    }

    if (othersOnCall < 1) {
      // Re-checked, fresh, right now: nobody else is on call. Going off call
      // would violate the invariant. This is a correct, permanent refusal -
      // not a failure that should be retried.
      await client.query("ROLLBACK");
      return { outcome: "rejected", othersOnCall };
    }

    await setOffCall(client, staffId);
    await client.query("COMMIT");
    return { outcome: "committed", othersOnCall };
  } catch (error) {
    if (isSerializationFailure(error)) {
      await client.query("ROLLBACK").catch(() => undefined);
      return { outcome: "conflict", othersOnCall: -1, sqlstate: error.code };
    }
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Bounded retry loop around attemptGoOffCall: on SQLSTATE 40001, wait a
 * randomized (jittered, exponentially-growing) backoff and try again - a
 * FRESH attempt with a FRESH read, not a replay of the original decision.
 * On `committed` or `rejected`, stop immediately: both are legitimate
 * terminal outcomes, only `conflict` is retryable.
 */
export async function retryGoOffCall(
  connectionString: string,
  team: string,
  staffName: string,
  staffId: number,
  opts: { maxAttempts?: number; firstAttemptDelayMs?: number } = {},
): Promise<RetryOutcome> {
  const maxAttempts = opts.maxAttempts ?? 5;
  let conflictsEncountered = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await attemptGoOffCall(connectionString, team, staffId, {
      firstAttemptDelayMs: attempt === 1 ? opts.firstAttemptDelayMs : undefined,
    });

    if (result.outcome === "committed" || result.outcome === "rejected") {
      log.info(
        { staffName, staffId, attempt, outcome: result.outcome, othersOnCall: result.othersOnCall },
        `attempt ${attempt}: terminal outcome`,
      );
      return { staffName, staffId, finalOutcome: result.outcome, attempts: attempt, conflictsEncountered };
    }

    conflictsEncountered += 1;
    const backoffMs = randomizedBackoffMs(attempt);
    log.warn(
      { staffName, staffId, attempt, sqlstate: result.sqlstate, backoffMs: Math.round(backoffMs) },
      `attempt ${attempt}: serialization failure (${result.sqlstate}) - backing off and retrying with fresh reads`,
    );
    await sleep(backoffMs);
  }

  throw new Error(`${staffName}: exhausted ${maxAttempts} attempts without a terminal outcome`);
}

export interface RetryDemoResult {
  team: string;
  alice: RetryOutcome;
  bob: RetryOutcome;
  onCallCountAfter: number;
  invariantHeld: boolean;
  exactlyOneSucceeded: boolean;
}

/**
 * Runs Alice's and Bob's "go off call" requests CONCURRENTLY (real
 * concurrency via Promise.all, not a hand-scripted interleaving) with a
 * shared first-attempt delay so both transactions' reads overlap and a real
 * conflict is very likely. Whichever one loses the race gets SQLSTATE 40001,
 * retries, re-reads fresh state, discovers the other has already gone off
 * call, and correctly refuses - a bounded retry loop reaching a safe,
 * invariant-respecting terminal state without ever needing to know in
 * advance who would "win".
 */
export async function runSerializableWithRetry(connectionString: string): Promise<RetryDemoResult> {
  const ids = await resetTeamOnCall(connectionString, WRITE_SKEW_TEAM, WRITE_SKEW_STAFF.map((s) => s.name));
  const aliceId = ids["Dr. Alice Chen"]!;
  const bobId = ids["Dr. Bob Nkemelu"]!;

  const [alice, bob] = await Promise.all([
    retryGoOffCall(connectionString, WRITE_SKEW_TEAM, "Dr. Alice Chen", aliceId, { firstAttemptDelayMs: 200 }),
    retryGoOffCall(connectionString, WRITE_SKEW_TEAM, "Dr. Bob Nkemelu", bobId, { firstAttemptDelayMs: 200 }),
  ]);

  const onCallCountAfter = await countOnCall(connectionString, WRITE_SKEW_TEAM);
  const outcomes = [alice.finalOutcome, bob.finalOutcome];

  return {
    team: WRITE_SKEW_TEAM,
    alice,
    bob,
    onCallCountAfter,
    invariantHeld: onCallCountAfter >= 1,
    exactlyOneSucceeded: outcomes.filter((o) => o === "committed").length === 1,
  };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const result = await runSerializableWithRetry(connectionString);

  log.warn(
    { ...result },
    result.invariantHeld && result.exactlyOneSucceeded
      ? "retry loop reached a valid terminal state: exactly one of Alice/Bob went off call, invariant held"
      : "UNEXPECTED: retry loop did not reach the expected terminal state",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "serializable-with-retry scenario failed");
    process.exit(1);
  });
}
