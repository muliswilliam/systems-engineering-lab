import "dotenv/config";
import { createLogger } from "@labs/logging";
import { openSession } from "../db/session.js";

const log = createLogger("lab06:scenario:snapshot-isolation");

const LABEL = "page-views";

interface RowSnapshot {
  value: number;
  xmin: string;
  ctid: string;
}

async function readRow(session: Awaited<ReturnType<typeof openSession>>): Promise<RowSnapshot> {
  const rows = await session.query<{ value: number; xmin: string; ctid: string }>(
    "SELECT value, xmin::text AS xmin, ctid::text AS ctid FROM counters WHERE label = $1",
    [LABEL],
  );
  const row = rows[0];
  if (!row) throw new Error(`counter "${LABEL}" not found - run \`pnpm seed\` first`);
  return row;
}

/**
 * Demonstrates the underlying MVCC mechanism behind two facts that surprise
 * engineers coming from other databases:
 *
 * 1. Postgres never exposes a dirty read - session A cannot see session B's
 *    UPDATE until B commits, even though A's transaction is still open and
 *    re-queries the row.
 * 2. Under the default READ COMMITTED isolation level, a transaction does
 *    NOT keep re-using the snapshot from its first statement - each new
 *    statement takes a fresh snapshot. So the instant B commits, A's *next*
 *    statement (still inside A's still-open transaction) sees B's change.
 *    A transaction-long consistent snapshot is REPEATABLE READ behavior,
 *    covered in Lab 08; the isolation-level semantics themselves (why
 *    non-repeatable reads happen, when they matter) are Lab 07's job. This
 *    script only shows the tuple-versioning mechanism (xmin/ctid) that
 *    makes both of those behaviors possible.
 */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set - copy .env.example to .env first");

  const sessionA = await openSession(databaseUrl);
  const sessionB = await openSession(databaseUrl);
  log.info({ pidA: sessionA.pid, pidB: sessionB.pid }, "opened two independent backend connections");

  // Baseline, outside any transaction, so the demo is reproducible on rerun.
  await sessionA.query("UPDATE counters SET value = 0 WHERE label = $1", [LABEL]);

  await sessionA.begin();
  log.info({ session: "A" }, "BEGIN");

  const read1 = await readRow(sessionA);
  log.info({ session: "A", statement: 1, ...read1 }, "A's first read, inside its open transaction");

  await sessionB.begin();
  await sessionB.query("UPDATE counters SET value = value + 100 WHERE label = $1", [LABEL]);
  log.info({ session: "B" }, "B updated the row (+100) but has NOT committed yet");

  const read2 = await readRow(sessionA);
  log.info({ session: "A", statement: 2, ...read2 }, "A's second read, while B's transaction is still open");

  const sawDirtyRead = read2.value !== read1.value;
  log.info(
    { sawDirtyRead, read1Value: read1.value, read2Value: read2.value },
    sawDirtyRead
      ? "UNEXPECTED: A saw B's uncommitted write (this should never happen in Postgres)"
      : "confirmed: no dirty read - A still sees the pre-update value and the same xmin/ctid",
  );

  await sessionB.commit();
  log.info({ session: "B" }, "B committed");

  const read3 = await readRow(sessionA);
  log.info({ session: "A", statement: 3, ...read3 }, "A's third read, same open transaction, AFTER B committed");

  const sawCommittedChange = read3.value !== read1.value;
  const tupleChanged = read3.xmin !== read1.xmin && read3.ctid !== read1.ctid;
  log.info(
    { sawCommittedChange, tupleChanged, read1Xmin: read1.xmin, read3Xmin: read3.xmin, read1Ctid: read1.ctid, read3Ctid: read3.ctid },
    sawCommittedChange
      ? "READ COMMITTED re-snapshots per statement: A's next statement sees B's committed UPDATE (new xmin/ctid = a new physical tuple version), even mid-transaction. This is why Lab 07 exists - transaction-scoped consistency is not the default."
      : "UNEXPECTED: A's third read did not observe B's committed change under READ COMMITTED",
  );

  await sessionA.commit();
  log.info({ session: "A" }, "COMMIT");

  await sessionA.close();
  await sessionB.close();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "snapshot-isolation scenario failed");
  process.exit(1);
});
