import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_DOCUMENTS } from "../seed/scenario-documents.js";
import { connectClient, readDocument, resetDocument } from "./support.js";

const log = createLogger("lab11:scenario:optimistic-concurrency");

const DOCUMENT_TITLE = "Scenario Document - Optimistic Concurrency";
const ORIGINAL_BODY = SCENARIO_DOCUMENTS.find((d) => d.title === DOCUMENT_TITLE)!.body;

const USER_A_EDIT_MARKER = "-- User A's addition: fixed the typo in Section 1.";
const USER_B_EDIT_MARKER = "-- User B's addition: added a Section 3 on rollout risks.";

export interface OptimisticConcurrencyResult {
  documentId: number;
  originalBody: string;
  userAReadVersion: number;
  userBReadVersion: number;
  userAUpdateRowCount: number;
  userAUpdateNewVersion: number | null;
  userBFirstAttemptRowCount: number;
  userBRetryReadBody: string;
  userBRetryReadVersion: number;
  userBRetryEditedBody: string;
  userBRetryUpdateRowCount: number;
  userBRetryNewVersion: number | null;
  finalBody: string;
  finalVersion: number;
  conflictDetected: boolean;
  retrySucceeded: boolean;
  bothEditsPresent: boolean;
}

/**
 * THE FIX: the exact same two-user edit as lost-update-naive.ts, but every
 * UPDATE is now conditional on the `version` the writer actually read:
 *
 *   UPDATE documents
 *   SET body = $1, version = version + 1, updated_at = now()
 *   WHERE id = $2 AND version = $3   -- $3 is the version this writer read
 *
 * User A reads version 1 and saves first: exactly one row has `id = A's id
 * AND version = 1` (the row itself), so `rowCount = 1` and the row's version
 * becomes 2.
 *
 * User B ALSO read version 1 (the same stale read as the naive scenario),
 * but by the time B's UPDATE runs, the row's version is already 2 - no row
 * matches `id = B's id AND version = 1` anymore, so `rowCount = 0`. This is
 * not an error or an exception: Postgres just reports that zero rows matched
 * the WHERE clause, exactly like any other UPDATE with a WHERE clause nobody
 * satisfies. The application is responsible for checking `rowCount === 0`
 * and treating it as "someone else edited this since you read it."
 *
 * This scenario's retry strategy: on conflict, re-read the CURRENT row (body
 * and version), re-apply the SAME edit on top of the fresh body (not the
 * stale one), and retry the conditional UPDATE with the fresh version. The
 * final body therefore contains both edits, applied in commit order: A's
 * edit first (A committed first), then B's edit appended on top of A's
 * already-committed text.
 */
export async function runOptimisticConcurrency(connectionString: string): Promise<OptimisticConcurrencyResult> {
  const { id: documentId } = await resetDocument(connectionString, DOCUMENT_TITLE, {
    body: ORIGINAL_BODY,
    version: 1,
    status: "draft",
  });

  const userA = await connectClient(connectionString);
  const userB = await connectClient(connectionString);

  try {
    const readA = await readDocument(userA, documentId);
    const readB = await readDocument(userB, documentId);
    log.info(
      { documentId, userAReadVersion: readA.version, userBReadVersion: readB.version },
      "both users read the document - same body, same version (a stale read is about to happen for B)",
    );

    const userAEditedBody = `${readA.body}\n\n${USER_A_EDIT_MARKER}`;

    const resultA = await userA.query<{ version: number }>(
      `UPDATE documents
       SET body = $1, version = version + 1, updated_at = now()
       WHERE id = $2 AND version = $3
       RETURNING version`,
      [userAEditedBody, documentId, readA.version],
    );
    log.info(
      { documentId, rowCount: resultA.rowCount, newVersion: resultA.rows[0]?.version },
      "user A: conditional UPDATE (WHERE id = ? AND version = ?) - matches, version advances",
    );

    // User B's FIRST attempt reuses B's own stale read version - the exact
    // same body/version A's UPDATE has already moved past.
    const userBEditedBodyFirstAttempt = `${readB.body}\n\n${USER_B_EDIT_MARKER}`;
    const resultBFirstAttempt = await userB.query<{ version: number }>(
      `UPDATE documents
       SET body = $1, version = version + 1, updated_at = now()
       WHERE id = $2 AND version = $3
       RETURNING version`,
      [userBEditedBodyFirstAttempt, documentId, readB.version],
    );
    const conflictDetected = (resultBFirstAttempt.rowCount ?? 0) === 0;
    log.warn(
      { documentId, rowCount: resultBFirstAttempt.rowCount, attemptedVersion: readB.version },
      conflictDetected
        ? "user B: conditional UPDATE matched ZERO rows - version already moved on. Conflict detected, no data was overwritten."
        : "UNEXPECTED: user B's stale-version UPDATE matched a row",
    );

    // Application-level conflict handling: re-read the CURRENT row and
    // reapply B's edit on top of it, then retry with the fresh version.
    const retryRead = await readDocument(userB, documentId);
    const userBRetryEditedBody = `${retryRead.body}\n\n${USER_B_EDIT_MARKER}`;
    const resultBRetry = await userB.query<{ version: number }>(
      `UPDATE documents
       SET body = $1, version = version + 1, updated_at = now()
       WHERE id = $2 AND version = $3
       RETURNING version`,
      [userBRetryEditedBody, documentId, retryRead.version],
    );
    log.info(
      { documentId, rowCount: resultBRetry.rowCount, retryVersion: retryRead.version },
      "user B: re-read the fresh version and retried the conditional UPDATE",
    );

    const finalRead = await readDocument(userA, documentId);

    return {
      documentId,
      originalBody: ORIGINAL_BODY,
      userAReadVersion: readA.version,
      userBReadVersion: readB.version,
      userAUpdateRowCount: resultA.rowCount ?? 0,
      userAUpdateNewVersion: resultA.rows[0]?.version ?? null,
      userBFirstAttemptRowCount: resultBFirstAttempt.rowCount ?? 0,
      userBRetryReadBody: retryRead.body,
      userBRetryReadVersion: retryRead.version,
      userBRetryEditedBody,
      userBRetryUpdateRowCount: resultBRetry.rowCount ?? 0,
      userBRetryNewVersion: resultBRetry.rows[0]?.version ?? null,
      finalBody: finalRead.body,
      finalVersion: finalRead.version,
      conflictDetected,
      retrySucceeded: (resultBRetry.rowCount ?? 0) === 1,
      bothEditsPresent: finalRead.body.includes(USER_A_EDIT_MARKER) && finalRead.body.includes(USER_B_EDIT_MARKER),
    };
  } finally {
    await userA.end();
    await userB.end();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const result = await runOptimisticConcurrency(connectionString);

  log.warn(
    { ...result },
    result.conflictDetected && result.retrySucceeded && result.bothEditsPresent
      ? "CONFLICT DETECTED AND RESOLVED: user B's stale write was rejected (rowCount=0), the retry succeeded, and the final document contains BOTH edits"
      : "UNEXPECTED: the optimistic-concurrency scenario did not behave as documented",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "optimistic-concurrency scenario failed");
    process.exit(1);
  });
}
