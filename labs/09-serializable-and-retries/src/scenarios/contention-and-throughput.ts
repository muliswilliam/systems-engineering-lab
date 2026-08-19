import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { CONTENTION_STAFF, CONTENTION_TEAM } from "../seed/scenario-staff.js";
import {
  beginWithIsolation,
  connectClient,
  countOnCall,
  countOthersOnCall,
  resetTeamOnCall,
  setOffCall,
  sleep,
} from "./support.js";
import { retryGoOffCall } from "./serializable-with-retry.js";

const log = createLogger("lab09:scenario:contention");

const FIRST_ATTEMPT_DELAY_MS = 150;

export interface SerializableContentionResult {
  team: string;
  staffCount: number;
  totalAttempts: number;
  totalConflicts: number;
  committedCount: number;
  rejectedCount: number;
  onCallCountAfter: number;
  invariantHeld: boolean;
  wallClockMs: number;
}

/**
 * Everyone on a `staffCount`-person team tries to go off call AT ONCE, under
 * SERIALIZABLE with the bounded retry loop from serializable-with-retry.ts.
 * With N staff all initially on call, the only safe final state is N-1
 * committed ("went off call") and exactly 1 rejected ("must stay on call") -
 * this measures how much retrying that safety costs: total attempts across
 * all N workers vs. the N that would be needed with zero contention, and how
 * many of those attempts were rejected by Postgres with a real 40001.
 */
export async function runContentionUnderSerializable(
  connectionString: string,
  staffCount = CONTENTION_STAFF.length,
): Promise<SerializableContentionResult> {
  const names = CONTENTION_STAFF.slice(0, staffCount).map((s) => s.name);
  const ids = await resetTeamOnCall(connectionString, CONTENTION_TEAM, names);

  const start = Date.now();
  const outcomes = await Promise.all(
    names.map((name) =>
      retryGoOffCall(connectionString, CONTENTION_TEAM, name, ids[name]!, {
        firstAttemptDelayMs: FIRST_ATTEMPT_DELAY_MS,
        maxAttempts: staffCount + 2,
      }),
    ),
  );
  const wallClockMs = Date.now() - start;

  const onCallCountAfter = await countOnCall(connectionString, CONTENTION_TEAM);
  const totalAttempts = outcomes.reduce((sum, o) => sum + o.attempts, 0);
  const totalConflicts = outcomes.reduce((sum, o) => sum + o.conflictsEncountered, 0);
  const committedCount = outcomes.filter((o) => o.finalOutcome === "committed").length;
  const rejectedCount = outcomes.filter((o) => o.finalOutcome === "rejected").length;

  return {
    team: CONTENTION_TEAM,
    staffCount,
    totalAttempts,
    totalConflicts,
    committedCount,
    rejectedCount,
    onCallCountAfter,
    invariantHeld: onCallCountAfter >= 1,
    wallClockMs,
  };
}

export interface NaiveContentionResult {
  team: string;
  staffCount: number;
  totalAttempts: number;
  totalConflicts: number;
  wentOffCallCount: number;
  onCallCountAfter: number;
  invariantHeld: boolean;
  wallClockMs: number;
}

/**
 * The SAME N-way concurrent "everyone tries to go off call at once" workload,
 * but under REPEATABLE READ with NO retry logic at all - because Repeatable
 * Read never raises a 40001 for this anomaly, there is nothing to retry.
 * Every worker takes its snapshot, sees plenty of other staff on call in
 * that snapshot, and commits "go off call". Zero aborts, zero retries,
 * zero extra latency - and (with enough concurrent staff) the team ends up
 * with FEWER than one person on call, silently violating the business
 * invariant. This is the throughput/contention comparison CLAUDE.md asks
 * for: Serializable is not free, but "free" here bought a wrong answer.
 */
export async function runContentionUnderRepeatableRead(
  connectionString: string,
  staffCount = CONTENTION_STAFF.length,
): Promise<NaiveContentionResult> {
  const names = CONTENTION_STAFF.slice(0, staffCount).map((s) => s.name);
  const ids = await resetTeamOnCall(connectionString, CONTENTION_TEAM, names);

  const start = Date.now();
  const wentOffCall = await Promise.all(
    names.map(async (name) => {
      const staffId = ids[name]!;
      const client = await connectClient(connectionString);
      try {
        await beginWithIsolation(client, "REPEATABLE READ");
        const othersOnCall = await countOthersOnCall(client, CONTENTION_TEAM, staffId);
        await sleep(FIRST_ATTEMPT_DELAY_MS);
        const decision = othersOnCall >= 1;
        if (decision) {
          await setOffCall(client, staffId);
        }
        await client.query("COMMIT");
        return decision;
      } finally {
        await client.end();
      }
    }),
  );
  const wallClockMs = Date.now() - start;

  const onCallCountAfter = await countOnCall(connectionString, CONTENTION_TEAM);

  return {
    team: CONTENTION_TEAM,
    staffCount,
    totalAttempts: staffCount,
    totalConflicts: 0,
    wentOffCallCount: wentOffCall.filter(Boolean).length,
    onCallCountAfter,
    invariantHeld: onCallCountAfter >= 1,
    wallClockMs,
  };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const serializableResult = await runContentionUnderSerializable(connectionString);
  log.warn(
    { ...serializableResult },
    serializableResult.invariantHeld
      ? "SERIALIZABLE + retry: invariant held, but paid for it in extra attempts/conflicts"
      : "UNEXPECTED: invariant violated even under Serializable",
  );

  const naiveResult = await runContentionUnderRepeatableRead(connectionString);
  log.warn(
    { ...naiveResult },
    naiveResult.invariantHeld
      ? "UNEXPECTED: naive Repeatable Read run happened to preserve the invariant this time"
      : "REPEATABLE READ, no retry: zero aborts, zero extra latency, but the invariant is VIOLATED",
  );

  log.info(
    {
      serializableAttempts: serializableResult.totalAttempts,
      serializableConflicts: serializableResult.totalConflicts,
      serializableWallClockMs: serializableResult.wallClockMs,
      naiveAttempts: naiveResult.totalAttempts,
      naiveConflicts: naiveResult.totalConflicts,
      naiveWallClockMs: naiveResult.wallClockMs,
    },
    "contention/throughput comparison: Serializable spends extra attempts and latency to buy correctness that Repeatable Read does not provide",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "contention-and-throughput scenario failed");
    process.exit(1);
  });
}
