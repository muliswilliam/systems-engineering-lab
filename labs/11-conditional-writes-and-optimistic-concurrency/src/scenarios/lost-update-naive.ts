import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_DOCUMENTS } from "../seed/scenario-documents.js";
import { connectClient, readDocument, resetDocument } from "./support.js";

const log = createLogger("lab11:scenario:lost-update-naive");

const DOCUMENT_TITLE = "Scenario Document - Lost Update";
const ORIGINAL_BODY = SCENARIO_DOCUMENTS.find((d) => d.title === DOCUMENT_TITLE)!.body;

export interface LostUpdateResult {
  documentId: number;
  originalBody: string;
  userAReadBody: string;
  userBReadBody: string;
  userAEditedBody: string;
  userBEditedBody: string;
  userAUpdateRowCount: number;
  userBUpdateRowCount: number;
  finalBody: string;
  userAEditSurvived: boolean;
  userBEditSurvived: boolean;
  lostUpdateOccurred: boolean;
}

/**
 * THE NAIVE (BROKEN) EDIT FLOW.
 *
 * Two users open the same document, each does a plain `SELECT`, computes an
 * edited body in application code, and saves it back with a plain
 * `UPDATE ... WHERE id = $1` - no version check, no lock, nothing in the
 * WHERE clause that could ever detect "did someone else change this since I
 * read it?" Both UPDATEs are individually valid, well-formed statements
 * against a row that exists, so Postgres reports `rowCount = 1` for BOTH of
 * them. Neither user's HTTP request (in a real app, this would be a
 * `PUT /documents/:id` handler) ever receives an error. The second UPDATE
 * silently overwrites everything the first one wrote - user A's edit is
 * gone, and nothing anywhere recorded that it ever existed.
 */
export async function runLostUpdateNaive(connectionString: string): Promise<LostUpdateResult> {
  const { id: documentId } = await resetDocument(connectionString, DOCUMENT_TITLE, {
    body: ORIGINAL_BODY,
    version: 1,
    status: "draft",
  });

  const userA = await connectClient(connectionString);
  const userB = await connectClient(connectionString);

  try {
    // Both users "open the document for editing" at roughly the same time -
    // a plain SELECT, no lock taken, no transaction even open.
    const readA = await readDocument(userA, documentId);
    log.info({ documentId, userAReadBody: readA.body }, "user A: opened the document for editing (plain SELECT)");

    const readB = await readDocument(userB, documentId);
    log.info(
      { documentId, userBReadBody: readB.body },
      "user B: opened the SAME document for editing (plain SELECT) - before A has saved anything",
    );

    const userAEditedBody = `${readA.body}\n\n-- User A's addition: fixed the typo in Section 1.`;
    const userBEditedBody = `${readB.body}\n\n-- User B's addition: added a Section 3 on rollout risks.`;

    // User A saves first. Plain UPDATE, no WHERE clause on version or any
    // other value that could detect B's concurrent read.
    const resultA = await userA.query("UPDATE documents SET body = $1, updated_at = now() WHERE id = $2", [
      userAEditedBody,
      documentId,
    ]);
    log.info(
      { documentId, rowCount: resultA.rowCount },
      "user A: UPDATE (plain, no version check) - looks successful to A's client",
    );

    // User B saves a moment later. B's UPDATE has no idea A's save ever
    // happened - B still has, and writes, a body computed from B's now-stale
    // read.
    const resultB = await userB.query("UPDATE documents SET body = $1, updated_at = now() WHERE id = $2", [
      userBEditedBody,
      documentId,
    ]);
    log.info(
      { documentId, rowCount: resultB.rowCount },
      "user B: UPDATE (plain, no version check) - ALSO looks successful to B's client",
    );

    const finalRead = await readDocument(userA, documentId);

    const userAEditSurvived = finalRead.body === userAEditedBody;
    const userBEditSurvived = finalRead.body === userBEditedBody;

    return {
      documentId,
      originalBody: ORIGINAL_BODY,
      userAReadBody: readA.body,
      userBReadBody: readB.body,
      userAEditedBody,
      userBEditedBody,
      userAUpdateRowCount: resultA.rowCount ?? 0,
      userBUpdateRowCount: resultB.rowCount ?? 0,
      finalBody: finalRead.body,
      userAEditSurvived,
      userBEditSurvived,
      lostUpdateOccurred: !userAEditSurvived && userBEditSurvived,
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

  const result = await runLostUpdateNaive(connectionString);

  log.warn(
    { ...result },
    result.lostUpdateOccurred
      ? "LOST UPDATE: both UPDATEs reported rowCount=1 (success), but user A's edit is gone - only user B's edit survived, and neither client ever saw an error"
      : "UNEXPECTED: no lost update occurred - this would mean the naive scenario is not reproducing the race",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "lost-update-naive scenario failed");
    process.exit(1);
  });
}
