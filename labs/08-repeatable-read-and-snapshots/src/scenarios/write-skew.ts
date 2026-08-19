import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_STAFF } from "../seed/scenario-data.js";
import { beginWithIsolation, connectClient, countOnCall, readIsOnCall, resetOnCallStaff } from "./support.js";

const log = createLogger("lab08:scenario:write-skew");

const STAFF_NAMES: readonly [string, string] = [SCENARIO_STAFF[0].name, SCENARIO_STAFF[1].name];

export interface WriteSkewResult {
  staffAId: number;
  staffBId: number;
  staffAName: string;
  staffBName: string;
  aSawBOnCallBeforeWriting: boolean;
  bSawAOnCallBeforeWriting: boolean;
  aWentOffCall: boolean;
  bWentOffCall: boolean;
  aCommitted: boolean;
  bCommitted: boolean;
  finalOnCallCount: number;
  invariantViolated: boolean;
}

/**
 * The canonical write-skew example (Postgres docs, "13.2.3 Serializable
 * Isolation vs. Repeatable Read Isolation"): two on-call doctors, an
 * application-level invariant "at least one must remain on call", and two
 * concurrent REPEATABLE READ transactions that each independently check
 * "is my colleague still on call?" before deciding it is safe for THEM to
 * go off call.
 *
 * Both transactions take their snapshot before either writes anything, so
 * both see the other doctor as on call (true) and both proceed to update
 * their OWN row to off-call. Because A and B modify DIFFERENT rows, there is
 * no write-write conflict for Postgres's row-version checks to catch - the
 * mechanism behind Lab 08's concurrent-write-conflict.ts scenario simply
 * does not apply here. Both COMMITs succeed. The result: both doctors are
 * off call, even though neither transaction's individual read was wrong and
 * neither individual UPDATE violated any single-row constraint.
 *
 * REPEATABLE READ prevents non-repeatable reads (repeatable-read-snapshot.ts)
 * and detects same-row lost updates (concurrent-write-conflict.ts), but it
 * does NOT detect an anomaly that spans two different rows guarded by an
 * invariant that only your application code knows about. That is exactly
 * what Serializable Snapshot Isolation (Lab 09) is built to catch.
 */
export async function runWriteSkew(
  connectionString: string,
  staffNames: readonly [string, string] = STAFF_NAMES,
): Promise<WriteSkewResult> {
  const [staffAName, staffBName] = staffNames;
  const {
    ids: [staffAId, staffBId],
  } = await resetOnCallStaff(connectionString, staffNames);

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);

  try {
    await beginWithIsolation(txA, "REPEATABLE READ");
    await beginWithIsolation(txB, "REPEATABLE READ");

    // Each transaction checks the OTHER doctor's on-call status, from its
    // own snapshot, taken before either transaction has written anything.
    const aSawBOnCallBeforeWriting = await readIsOnCall(txA, staffBId);
    const bSawAOnCallBeforeWriting = await readIsOnCall(txB, staffAId);
    log.info(
      { staffAId, staffBId, aSawBOnCallBeforeWriting, bSawAOnCallBeforeWriting },
      "both transactions independently confirm 'someone else is on call' from their own snapshot",
    );

    // Each transaction, having seen the invariant satisfied by the OTHER
    // row, independently decides it is safe to take itself off call.
    const aWentOffCall = aSawBOnCallBeforeWriting;
    const bWentOffCall = bSawAOnCallBeforeWriting;

    if (aWentOffCall) {
      await txA.query("UPDATE on_call_staff SET is_on_call = false WHERE id = $1", [staffAId]);
    }
    if (bWentOffCall) {
      await txB.query("UPDATE on_call_staff SET is_on_call = false WHERE id = $1", [staffBId]);
    }

    // Different rows, no write-write conflict - both commits succeed.
    await txA.query("COMMIT");
    log.info({ staffAId, aWentOffCall }, "transaction A: COMMIT succeeded");
    await txB.query("COMMIT");
    log.info({ staffBId, bWentOffCall }, "transaction B: COMMIT succeeded");

    const verifyClient = await connectClient(connectionString);
    let finalOnCallCount: number;
    try {
      finalOnCallCount = await countOnCall(verifyClient, [staffAId, staffBId]);
    } finally {
      await verifyClient.end();
    }

    return {
      staffAId,
      staffBId,
      staffAName,
      staffBName,
      aSawBOnCallBeforeWriting,
      bSawAOnCallBeforeWriting,
      aWentOffCall,
      bWentOffCall,
      aCommitted: true,
      bCommitted: true,
      finalOnCallCount,
      invariantViolated: finalOnCallCount === 0,
    };
  } finally {
    await txA.end();
    await txB.end();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const result = await runWriteSkew(connectionString);

  log.warn(
    { ...result },
    result.invariantViolated
      ? "write skew reproduced: both transactions committed successfully under REPEATABLE READ, yet the invariant 'at least one doctor is on call' is now violated (finalOnCallCount=0)"
      : "did not reproduce write skew this run - see README 'Break it' for the expected outcome",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "write-skew scenario failed");
    process.exit(1);
  });
}
