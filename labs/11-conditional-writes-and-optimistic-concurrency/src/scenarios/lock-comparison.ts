import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_DOCUMENTS } from "../seed/scenario-documents.js";
import { connectClient, readDocument, resetDocument } from "./support.js";
import { runOptimisticConcurrency } from "./optimistic-concurrency.js";
import { runConditionalWritePublish } from "./conditional-write-publish.js";

const log = createLogger("lab11:scenario:lock-comparison");

const DOCUMENT_TITLE = "Scenario Document - Lock Comparison";
const ORIGINAL_BODY = SCENARIO_DOCUMENTS.find((d) => d.title === DOCUMENT_TITLE)!.body;

export interface PessimisticComparisonResult {
  documentId: number;
  userBBlockedForMs: number;
  finalBody: string;
}

/**
 * A SHORT, DIRECT SKETCH of pessimistic locking - `SELECT ... FOR UPDATE` -
 * for side-by-side comparison against this lab's optimistic and plain
 * conditional-write scenarios. Lab 10 is the deep-dive on row locks
 * (`FOR UPDATE`/`FOR NO KEY UPDATE`/`FOR SHARE`/`NOWAIT`/lock timeouts,
 * `pg_locks` inspection); this is just enough real code to measure and
 * contrast the one property that matters for this comparison: pessimistic
 * locking makes a concurrent writer WAIT, instead of letting it write and
 * fail fast.
 *
 * Transaction A takes `SELECT ... FOR UPDATE` (acquiring the row lock),
 * holds it for a bit (simulating "the user is still typing"), then updates
 * and commits. Transaction B's `SELECT ... FOR UPDATE`, issued while A still
 * holds the lock, blocks at the database level until A commits or rolls
 * back - B's query does not even return, let alone fail - and only then
 * proceeds with its own read-modify-write.
 */
async function runPessimisticComparison(connectionString: string): Promise<PessimisticComparisonResult> {
  const { id: documentId } = await resetDocument(connectionString, DOCUMENT_TITLE, {
    body: ORIGINAL_BODY,
    version: 1,
    status: "draft",
  });

  const txA = await connectClient(connectionString);
  const txB = await connectClient(connectionString);

  try {
    await txA.query("BEGIN");
    await txA.query("SELECT body FROM documents WHERE id = $1 FOR UPDATE", [documentId]);
    log.info({ documentId }, "pessimistic: transaction A took SELECT ... FOR UPDATE, holding the row lock");

    const bStart = Date.now();
    const bBlockedPromise = (async () => {
      await txB.query("BEGIN");
      await txB.query("SELECT body FROM documents WHERE id = $1 FOR UPDATE", [documentId]);
    })();

    // This sleep only sequences this DEMO SCRIPT's own log lines (so the
    // "B is blocked" log line prints before A releases the lock) - it is not
    // part of the locking mechanism itself. Postgres's row-lock queue is what
    // actually makes B's query wait, regardless of how long this sleep is.
    await new Promise((resolve) => setTimeout(resolve, 300));
    log.info({ documentId }, "pessimistic: transaction B's SELECT ... FOR UPDATE is blocked, waiting on A's row lock");

    await txA.query("UPDATE documents SET body = body || $1, version = version + 1, updated_at = now() WHERE id = $2", [
      "\n\n-- User A's addition (pessimistic).",
      documentId,
    ]);
    await txA.query("COMMIT");
    log.info({ documentId }, "pessimistic: transaction A committed and released the row lock");

    await bBlockedPromise;
    const userBBlockedForMs = Date.now() - bStart;
    log.info({ documentId, userBBlockedForMs }, "pessimistic: transaction B's SELECT ... FOR UPDATE finally returned");

    await txB.query("UPDATE documents SET body = body || $1, version = version + 1, updated_at = now() WHERE id = $2", [
      "\n\n-- User B's addition (pessimistic).",
      documentId,
    ]);
    await txB.query("COMMIT");

    const finalRead = await readDocument(txA, documentId);

    return { documentId, userBBlockedForMs, finalBody: finalRead.body };
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

  log.info("=== 1. PESSIMISTIC: SELECT ... FOR UPDATE ===");
  const pessimistic = await runPessimisticComparison(connectionString);
  log.warn(
    { ...pessimistic },
    `pessimistic: B's SELECT ... FOR UPDATE blocked for ~${pessimistic.userBBlockedForMs}ms waiting on A's row lock - both edits ended up applied, in order, because B literally could not proceed until A finished`,
  );

  log.info("=== 2. OPTIMISTIC: UPDATE ... WHERE id = ? AND version = ? ===");
  const optimistic = await runOptimisticConcurrency(connectionString);
  log.warn(
    {
      userAUpdateRowCount: optimistic.userAUpdateRowCount,
      userBFirstAttemptRowCount: optimistic.userBFirstAttemptRowCount,
      userBRetryUpdateRowCount: optimistic.userBRetryUpdateRowCount,
    },
    "optimistic: B's UPDATE never blocked - it returned IMMEDIATELY with rowCount=0, and the application had to notice the conflict and retry",
  );

  log.info("=== 3. PLAIN CONDITIONAL WRITE: UPDATE ... WHERE status = 'draft' ===");
  const conditional = await runConditionalWritePublish(connectionString, 10);
  log.warn(
    { successCount: conditional.successCount, conflictCount: conditional.conflictCount },
    `conditional write: exactly ${conditional.successCount} of ${conditional.attemptCount} concurrent publish attempts succeeded - no version column anywhere, the business column WAS the invariant`,
  );

  log.info(
    "SUMMARY: pessimistic blocks and waits (safe, reduces concurrency, needs an open transaction/connection for the lock's duration); " +
      "optimistic never blocks but requires the caller to detect and handle rowCount=0 (better concurrency, more application complexity, wasted work on conflict); " +
      "a plain conditional write is optimistic concurrency without a version counter - it only works when the WHERE condition IS the business invariant (a state transition), not for 'any concurrent edit should conflict'.",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "lock-comparison scenario failed");
    process.exit(1);
  });
}
