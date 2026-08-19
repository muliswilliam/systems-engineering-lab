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
  resetTeamOnCall,
  setOffCall,
} from "./support.js";

const log = createLogger("lab09:scenario:serializable-conflict");

export interface SerializableConflictResult {
  team: string;
  aliceId: number;
  bobId: number;
  actualIsolationLevel: string;
  othersOnCallSeenByAlice: number;
  othersOnCallSeenByBob: number;
  aliceCommitted: boolean;
  bobCommitted: boolean;
  bobFailure: { sqlstate: string; message: string } | null;
  onCallCountAfter: number;
  invariantHeld: boolean;
}

/**
 * The EXACT SAME two transactions and the EXACT SAME hand-scripted
 * interleaving as write-skew-under-repeatable-read.ts - only the requested
 * isolation level changes, from REPEATABLE READ to SERIALIZABLE.
 *
 * Postgres's Serializable Snapshot Isolation (SSI) tracks read/write
 * dependencies between concurrently-running transactions. Here it sees:
 *   - Alice's transaction READ Bob's row (via the "anyone else on call?"
 *     query) while it was still `true`, then Bob's transaction later WROTE
 *     that row to `false` -> a rw-antidependency edge Alice -> Bob.
 *   - Bob's transaction READ Alice's row while it was still `true`, then
 *     Alice's transaction later WROTE that row to `false` -> a
 *     rw-antidependency edge Bob -> Alice.
 * Two edges in opposite directions between the same two transactions form a
 * cycle - the "dangerous structure" SSI exists to catch. Since Alice's
 * transaction already committed by the time Bob's transaction tries to
 * commit, Postgres cannot undo Alice - so it aborts Bob's transaction
 * instead, at COMMIT time, with SQLSTATE 40001
 * ("could not serialize access due to read/write dependencies among
 * transactions").
 */
export async function runSerializableDetectsConflict(connectionString: string): Promise<SerializableConflictResult> {
  const ids = await resetTeamOnCall(connectionString, WRITE_SKEW_TEAM, WRITE_SKEW_STAFF.map((s) => s.name));
  const aliceId = ids["Dr. Alice Chen"]!;
  const bobId = ids["Dr. Bob Nkemelu"]!;

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);

  try {
    const { actual: actualA } = await beginWithIsolation(txA, "SERIALIZABLE");
    const { actual: actualB } = await beginWithIsolation(txB, "SERIALIZABLE");
    log.info({ aliceId, bobId, actualIsolationLevel: actualA }, "transaction A (Alice) and B (Bob): BEGIN SERIALIZABLE");

    const othersOnCallSeenByAlice = await countOthersOnCall(txA, WRITE_SKEW_TEAM, aliceId);
    log.info({ othersOnCallSeenByAlice }, "transaction A: Alice checks - is anyone else on call?");

    const othersOnCallSeenByBob = await countOthersOnCall(txB, WRITE_SKEW_TEAM, bobId);
    log.info({ othersOnCallSeenByBob }, "transaction B: Bob checks - is anyone else on call?");

    await setOffCall(txA, aliceId);
    await txA.query("COMMIT");
    log.info({ aliceId }, "transaction A: Alice commits 'go off call' - succeeds, no conflict yet");

    let bobCommitted = false;
    let bobFailure: { sqlstate: string; message: string } | null = null;
    try {
      await setOffCall(txB, bobId);
      await txB.query("COMMIT");
      bobCommitted = true;
      log.info({ bobId }, "transaction B: Bob commits 'go off call'");
    } catch (error) {
      if (isSerializationFailure(error)) {
        bobFailure = { sqlstate: error.code ?? "40001", message: error.message ?? "serialization failure" };
        log.warn(
          { sqlstate: bobFailure.sqlstate, message: bobFailure.message },
          "transaction B: Bob's commit was REJECTED - Postgres detected the dangerous read/write dependency cycle",
        );
        await txB.query("ROLLBACK");
      } else {
        throw error;
      }
    }

    const onCallCountAfter = await countOnCall(connectionString, WRITE_SKEW_TEAM);

    return {
      team: WRITE_SKEW_TEAM,
      aliceId,
      bobId,
      actualIsolationLevel: actualA,
      othersOnCallSeenByAlice,
      othersOnCallSeenByBob,
      aliceCommitted: true,
      bobCommitted,
      bobFailure,
      onCallCountAfter,
      invariantHeld: onCallCountAfter >= 1,
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

  const result = await runSerializableDetectsConflict(connectionString);

  log.warn(
    { ...result },
    !result.bobCommitted && result.invariantHeld
      ? "serialization failure confirmed: Bob's commit was aborted with SQLSTATE 40001, invariant preserved (>=1 on call)"
      : "UNEXPECTED: either Bob's commit succeeded or the invariant was violated - Serializable did not behave as documented",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "serializable-detects-conflict scenario failed");
    process.exit(1);
  });
}
