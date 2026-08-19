import "dotenv/config";
import { createLogger } from "@labs/logging";
import { openSession } from "../db/session.js";

const log = createLogger("lab06:scenario:xmin-xmax-ctid");

const LABEL = "mvcc-demo-counter";

function parseCtid(ctid: string): { page: number; lp: number } {
  const match = /^\((\d+),(\d+)\)$/.exec(ctid);
  if (!match) throw new Error(`unexpected ctid format: ${ctid}`);
  return { page: Number(match[1]), lp: Number(match[2]) };
}

/**
 * The single most important non-obvious Postgres fact for anyone coming
 * from a database that mutates rows in place: `UPDATE` in Postgres never
 * overwrites a tuple. It marks the current tuple dead (sets its `xmax` to
 * the updating transaction's id) and inserts a brand-new tuple (a new
 * physical location - a new `ctid` - and a new `xmin` equal to the updating
 * transaction's id). The old, dead tuple keeps physically existing on disk
 * (as a "heap-only tuple" chain link) until VACUUM reclaims it.
 *
 * A plain `SELECT ... WHERE ctid = $1` from a *fresh* snapshot will NOT
 * find that old tuple once the UPDATE has committed - ordinary queries
 * still apply MVCC visibility rules even when filtering by ctid, and the
 * old tuple is dead under any snapshot taken after the UPDATE committed
 * (this script hit exactly that while it was being developed - see README
 * "Observe"). To look at the raw, physical page contents regardless of
 * visibility - the only way to actually see a dead tuple sitting on disk -
 * this script uses the `pageinspect` extension's `heap_page_items`, the
 * same tool you would reach for in production to answer "is this table
 * bloated with dead tuples that VACUUM hasn't reclaimed yet?" (Lab 31).
 */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set - copy .env.example to .env first");

  const session = await openSession(databaseUrl);
  log.info({ pid: session.pid }, "opened connection");

  await session.query("CREATE EXTENSION IF NOT EXISTS pageinspect");

  await session.query("DELETE FROM counters WHERE label = $1", [LABEL]);

  const inserted = await session.query<{ xmin: string; ctid: string; value: number }>(
    "INSERT INTO counters (label, value) VALUES ($1, $2) RETURNING xmin::text AS xmin, ctid::text AS ctid, value",
    [LABEL, 1],
  );
  const original = inserted[0]!;
  log.info({ ...original }, "inserted row: original tuple version (committed)");

  const updated = await session.query<{ xmin: string; ctid: string; xmax: string; value: number }>(
    "UPDATE counters SET value = value + 1 WHERE label = $1 RETURNING xmin::text AS xmin, xmax::text AS xmax, ctid::text AS ctid, value",
    [LABEL],
  );
  const afterUpdate = updated[0]!;
  log.info({ ...afterUpdate }, "updated row: NEW tuple version (new ctid, new xmin, committed)");

  const ctidChanged = afterUpdate.ctid !== original.ctid;
  const xminChanged = afterUpdate.xmin !== original.xmin;
  log.info(
    { ctidChanged, xminChanged, originalCtid: original.ctid, newCtid: afterUpdate.ctid },
    ctidChanged && xminChanged
      ? "confirmed: UPDATE did not mutate the row in place - it produced a physically new tuple"
      : "UNEXPECTED: ctid/xmin did not change after UPDATE",
  );

  const ordinarySelectRows = await session.query<{ value: number }>(
    "SELECT value FROM counters WHERE ctid = $1::tid",
    [original.ctid],
  );
  log.info(
    { foundViaOrdinarySelect: ordinarySelectRows.length > 0, originalCtid: original.ctid },
    "an ordinary SELECT filtered by the OLD ctid, using a snapshot taken AFTER the UPDATE committed, finds nothing - MVCC visibility applies to ctid scans too, it is not a raw disk read",
  );

  // Read the raw page instead - this bypasses MVCC visibility entirely and
  // shows exactly what is physically stored, dead tuples included.
  const { page, lp: originalLp } = parseCtid(original.ctid);
  const { lp: newLp } = parseCtid(afterUpdate.ctid);

  const pageItems = await session.query<{
    lp: number;
    lp_flags: number;
    t_xmin: string;
    t_xmax: string;
    t_ctid: string;
  }>(
    `SELECT lp, lp_flags, t_xmin::text, t_xmax::text, t_ctid::text
     FROM heap_page_items(get_raw_page('counters', $1))
     WHERE lp = ANY($2)
     ORDER BY lp`,
    [page, [originalLp, newLp]],
  );

  const oldItem = pageItems.find((row) => row.lp === originalLp);
  const newItem = pageItems.find((row) => row.lp === newLp);

  log.info(
    { ...oldItem },
    "raw page contents for the OLD tuple's line pointer: lp_flags=1 (LP_NORMAL, still physically present), t_xmax is set (not '0'), and t_ctid points FORWARD to the new tuple - this is the on-disk HOT-update chain link",
  );
  log.info({ ...newItem }, "raw page contents for the NEW tuple's line pointer: t_xmax='0', t_ctid points to itself (it is the current version)");

  const oldTupleIsDead = oldItem !== undefined && oldItem.t_xmax !== "0";
  const chainLinksToNewTuple = oldItem?.t_ctid === afterUpdate.ctid;
  log.info(
    { oldTupleIsDead, chainLinksToNewTuple },
    oldTupleIsDead && chainLinksToNewTuple
      ? "confirmed: the old tuple is still on disk, marked dead, and physically points at the new tuple that replaced it"
      : "UNEXPECTED: could not confirm the old tuple's dead/chained state from the raw page",
  );

  await session.close();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "xmin-xmax-ctid scenario failed");
  process.exit(1);
});
