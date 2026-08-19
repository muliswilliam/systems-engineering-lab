import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { WRITE_SKEW_STAFF, WRITE_SKEW_TEAM } from "../seed/scenario-staff.js";
import { beginWithIsolation, connectClient, countOnCall, countOthersOnCall, resetTeamOnCall, setOffCall } from "./support.js";

const log = createLogger("lab09:scenario:write-skew");

export interface WriteSkewResult {
  team: string;
  aliceId: number;
  bobId: number;
  actualIsolationLevel: string;
  othersOnCallSeenByAlice: number;
  othersOnCallSeenByBob: number;
  aliceDecision: "go-off-call" | "stay-on-call";
  bobDecision: "go-off-call" | "stay-on-call";
  onCallCountAfter: number;
  invariantHeld: boolean;
}

/**
 * The naive baseline this lab exists to break: two on-call doctors, Alice and
 * Bob, both start fully staffed (both on call). Each independently decides
 * "I can go off call as long as someone else is still on call". Both check
 * that condition, both see the other still on call, both act on it, both
 * commit.
 *
 * The two transactions are driven with two independent `pg.Client`
 * connections under an EXPLICIT, hand-scripted interleaving (not real
 * concurrency/timing) so this is 100% reproducible on every run:
 *
 *   BEGIN A (REPEATABLE READ)
 *   BEGIN B (REPEATABLE READ)
 *   SELECT (A checks: is anyone else on call?)   -> sees Bob, still true in A's snapshot
 *   SELECT (B checks: is anyone else on call?)   -> sees Alice, still true in B's snapshot
 *   UPDATE A sets itself off call; COMMIT A
 *   UPDATE B sets itself off call; COMMIT B
 *
 * Postgres's REPEATABLE READ is snapshot isolation: it prevents two
 * transactions from making conflicting writes to the SAME row, but it does
 * NOT detect a dangerous read/write dependency that spans two DIFFERENT rows
 * (Alice's row and Bob's row). Both commits succeed. The result: zero staff
 * remain on call, even though every individual transaction's read-then-write
 * looked locally correct. This is classic write skew.
 */
export async function runWriteSkewUnderRepeatableRead(connectionString: string): Promise<WriteSkewResult> {
  const ids = await resetTeamOnCall(connectionString, WRITE_SKEW_TEAM, WRITE_SKEW_STAFF.map((s) => s.name));
  const aliceId = ids["Dr. Alice Chen"]!;
  const bobId = ids["Dr. Bob Nkemelu"]!;

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);

  try {
    const { actual: actualA } = await beginWithIsolation(txA, "REPEATABLE READ");
    const { actual: actualB } = await beginWithIsolation(txB, "REPEATABLE READ");
    log.info({ aliceId, bobId, actualIsolationLevel: actualA }, "transaction A (Alice) and B (Bob): BEGIN REPEATABLE READ");

    const othersOnCallSeenByAlice = await countOthersOnCall(txA, WRITE_SKEW_TEAM, aliceId);
    log.info({ othersOnCallSeenByAlice }, "transaction A: Alice checks - is anyone else on call?");

    const othersOnCallSeenByBob = await countOthersOnCall(txB, WRITE_SKEW_TEAM, bobId);
    log.info({ othersOnCallSeenByBob }, "transaction B: Bob checks - is anyone else on call?");

    const aliceDecision = othersOnCallSeenByAlice >= 1 ? "go-off-call" : "stay-on-call";
    const bobDecision = othersOnCallSeenByBob >= 1 ? "go-off-call" : "stay-on-call";

    if (aliceDecision === "go-off-call") {
      await setOffCall(txA, aliceId);
    }
    await txA.query("COMMIT");
    log.info({ aliceDecision }, "transaction A: Alice commits her decision");

    if (bobDecision === "go-off-call") {
      await setOffCall(txB, bobId);
    }
    await txB.query("COMMIT");
    log.info({ bobDecision }, "transaction B: Bob commits his decision");

    const onCallCountAfter = await countOnCall(connectionString, WRITE_SKEW_TEAM);

    return {
      team: WRITE_SKEW_TEAM,
      aliceId,
      bobId,
      actualIsolationLevel: actualA,
      othersOnCallSeenByAlice,
      othersOnCallSeenByBob,
      aliceDecision,
      bobDecision,
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

  const result = await runWriteSkewUnderRepeatableRead(connectionString);

  log.warn(
    { ...result },
    result.invariantHeld
      ? "UNEXPECTED: at least one staff member is still on call - write skew did not reproduce"
      : "write skew confirmed: both Alice and Bob committed 'go off call', and nobody is on call anymore",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "write-skew-under-repeatable-read scenario failed");
    process.exit(1);
  });
}
