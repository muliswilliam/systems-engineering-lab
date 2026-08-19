import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_DOCUMENTS } from "../seed/scenario-documents.js";
import { connectClient, resetDocument } from "./support.js";

const log = createLogger("lab11:scenario:conditional-write-publish");

const DOCUMENT_TITLE = "Scenario Document - Conditional Write (Publish Race)";
const ORIGINAL_BODY = SCENARIO_DOCUMENTS.find((d) => d.title === DOCUMENT_TITLE)!.body;
const DEFAULT_ATTEMPT_COUNT = 10;

export interface ConditionalWritePublishResult {
  documentId: number;
  attemptCount: number;
  rowCounts: number[];
  successCount: number;
  conflictCount: number;
  finalStatus: string;
}

/**
 * A PLAIN CONDITIONAL WRITE ON A BUSINESS COLUMN - optimistic concurrency
 * control WITHOUT a dedicated version counter.
 *
 *   UPDATE documents
 *   SET status = 'published', updated_at = now()
 *   WHERE id = $1 AND status = 'draft'
 *
 * There is no `version` column involved at all. The WHERE clause's
 * `status = 'draft'` predicate IS the business invariant being protected:
 * "only publish a document that is still a draft." `attemptCount` publish
 * attempts fire concurrently at the same row - Postgres's row-level locking
 * serializes them (whichever UPDATE's WHERE clause evaluates first wins the
 * row and changes its status; every UPDATE queued behind it re-evaluates the
 * WHERE clause against the now-`published` row and matches zero rows). No
 * advisory lock, no application-level mutex, no version column - exactly one
 * concurrent attempt succeeds, and it is Postgres's own row lock, not
 * anything this script coordinates, that guarantees it.
 *
 * This technique's limit: it only works because "not yet published" is
 * exactly the condition that should block a duplicate publish. It says
 * nothing about two people concurrently editing the BODY of an
 * already-published document - for that, you are back to needing a version
 * column (or a lock), because there is no single business-state column whose
 * value captures "nobody has touched this since I read it."
 */
export async function runConditionalWritePublish(
  connectionString: string,
  attemptCount: number = DEFAULT_ATTEMPT_COUNT,
): Promise<ConditionalWritePublishResult> {
  const { id: documentId } = await resetDocument(connectionString, DOCUMENT_TITLE, {
    body: ORIGINAL_BODY,
    version: 1,
    status: "draft",
  });

  const clients = await Promise.all(Array.from({ length: attemptCount }, () => connectClient(connectionString)));

  try {
    log.info({ documentId, attemptCount }, "firing concurrent publish attempts at the same draft document");

    const results = await Promise.all(
      clients.map((client) =>
        client.query<{ id: number }>(
          "UPDATE documents SET status = 'published', updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING id",
          [documentId],
        ),
      ),
    );

    const rowCounts = results.map((r) => r.rowCount ?? 0);
    const successCount = rowCounts.filter((c) => c === 1).length;
    const conflictCount = rowCounts.filter((c) => c === 0).length;

    const finalStatusResult = await clients[0]!.query<{ status: string }>(
      "SELECT status FROM documents WHERE id = $1",
      [documentId],
    );

    return {
      documentId,
      attemptCount,
      rowCounts,
      successCount,
      conflictCount,
      finalStatus: finalStatusResult.rows[0]!.status,
    };
  } finally {
    await Promise.all(clients.map((c) => c.end()));
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const result = await runConditionalWritePublish(connectionString);

  log.warn(
    { ...result },
    result.successCount === 1 && result.conflictCount === result.attemptCount - 1
      ? `EXACTLY ONE publish succeeded out of ${result.attemptCount} concurrent attempts - WHERE status = 'draft' is the invariant`
      : "UNEXPECTED: more or fewer than exactly one concurrent publish attempt succeeded",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "conditional-write-publish scenario failed");
    process.exit(1);
  });
}
