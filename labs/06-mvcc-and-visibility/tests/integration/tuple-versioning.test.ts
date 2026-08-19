import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { openSession, type Session } from "../../src/db/session.js";
import { counters } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

/**
 * Real MVCC facts about UPDATE, asserted structurally (never on timing):
 * Postgres does not mutate a tuple in place. An UPDATE marks the current
 * tuple dead (sets its xmax) and inserts a physically new tuple (new ctid,
 * new xmin). See src/scenarios/xmin-xmax-ctid.ts for the same facts run as
 * a narrated script with logged values.
 */
let session: Session;

function parseCtid(ctid: string): { page: number; lp: number } {
  const match = /^\((\d+),(\d+)\)$/.exec(ctid);
  if (!match) throw new Error(`unexpected ctid format: ${ctid}`);
  return { page: Number(match[1]), lp: Number(match[2]) };
}

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  session = await openSession(process.env.DATABASE_URL!);
  await session.query("CREATE EXTENSION IF NOT EXISTS pageinspect");
});

afterAll(async () => {
  await session.close();
  await pool.end();
});

describe("tuple versioning (xmin / xmax / ctid)", () => {
  const label = "test-tuple-versioning";

  afterAll(async () => {
    await db.delete(counters).where(eq(counters.label, label));
  });

  it("UPDATE produces a new tuple version: ctid and xmin both change", async () => {
    await session.query("DELETE FROM counters WHERE label = $1", [label]);

    const [inserted] = await session.query<{ xmin: string; ctid: string; value: number }>(
      "INSERT INTO counters (label, value) VALUES ($1, 1) RETURNING xmin::text AS xmin, ctid::text AS ctid, value",
      [label],
    );
    expect(inserted).toBeDefined();

    const [updated] = await session.query<{ xmin: string; ctid: string; xmax: string; value: number }>(
      "UPDATE counters SET value = value + 1 WHERE label = $1 RETURNING xmin::text AS xmin, xmax::text AS xmax, ctid::text AS ctid, value",
      [label],
    );
    expect(updated).toBeDefined();

    expect(updated!.ctid).not.toBe(inserted!.ctid);
    expect(updated!.xmin).not.toBe(inserted!.xmin);
    expect(updated!.value).toBe(2);
    // The live tuple has no deleter/updater yet.
    expect(updated!.xmax).toBe("0");
  });

  it("an ordinary SELECT filtered by the OLD ctid finds nothing once the UPDATE has committed (MVCC visibility, not a raw disk read)", async () => {
    await session.query("DELETE FROM counters WHERE label = $1", [label]);

    const [inserted] = await session.query<{ ctid: string }>(
      "INSERT INTO counters (label, value) VALUES ($1, 10) RETURNING ctid::text AS ctid",
      [label],
    );

    await session.query("UPDATE counters SET value = value + 1 WHERE label = $1", [label]);

    const rows = await session.query("SELECT value FROM counters WHERE ctid = $1::tid", [inserted!.ctid]);
    expect(rows.length).toBe(0);
  });

  it("the OLD tuple is still physically present on the raw page, marked dead, chained to the new tuple", async () => {
    await session.query("DELETE FROM counters WHERE label = $1", [label]);

    const [inserted] = await session.query<{ ctid: string }>(
      "INSERT INTO counters (label, value) VALUES ($1, 10) RETURNING ctid::text AS ctid",
      [label],
    );
    const [updated] = await session.query<{ ctid: string }>(
      "UPDATE counters SET value = value + 1 WHERE label = $1 RETURNING ctid::text AS ctid",
      [label],
    );

    const { page, lp: originalLp } = parseCtid(inserted!.ctid);
    const { lp: newLp } = parseCtid(updated!.ctid);

    const pageItems = await session.query<{ lp: number; t_xmax: string; t_ctid: string }>(
      `SELECT lp, t_xmax::text, t_ctid::text
       FROM heap_page_items(get_raw_page('counters', $1))
       WHERE lp = ANY($2)`,
      [page, [originalLp, newLp]],
    );

    const oldItem = pageItems.find((row) => row.lp === originalLp);
    expect(oldItem).toBeDefined();
    expect(oldItem!.t_xmax).not.toBe("0"); // marked dead by the UPDATE
    expect(oldItem!.t_ctid).toBe(updated!.ctid); // on-disk chain link to the new tuple
  });
});
