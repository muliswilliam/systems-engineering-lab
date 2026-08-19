import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { counters } from "../../src/db/schema.js";
import { openSession, type Session } from "../../src/db/session.js";

/**
 * Postgres never exposes a dirty read, at any isolation level, including
 * the default READ COMMITTED - a transaction that reads a row twice never
 * sees another transaction's UPDATE until that transaction commits. This
 * asserts the guarantee directly, independent of timing. See
 * src/scenarios/snapshot-isolation.ts for the fuller narrated demo,
 * including what A sees on ITS next statement after B does commit.
 */
const label = "test-no-dirty-read";
let reader: Session;
let writer: Session;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.delete(counters).where(eq(counters.label, label));
  await db.insert(counters).values({ label, value: 0 });

  reader = await openSession(process.env.DATABASE_URL!);
  writer = await openSession(process.env.DATABASE_URL!);
});

afterEach(async () => {
  await reader.rollback().catch(() => undefined);
  await writer.rollback().catch(() => undefined);
});

afterAll(async () => {
  await reader.close();
  await writer.close();
  await db.delete(counters).where(eq(counters.label, label));
  await pool.end();
});

describe("no dirty reads", () => {
  it("a transaction's SELECT does not see another transaction's uncommitted UPDATE", async () => {
    await reader.begin();
    const [before] = await reader.query<{ value: number }>("SELECT value FROM counters WHERE label = $1", [label]);
    expect(before!.value).toBe(0);

    await writer.begin();
    await writer.query("UPDATE counters SET value = 999 WHERE label = $1", [label]);
    // writer intentionally NOT committed yet

    const [during] = await reader.query<{ value: number }>("SELECT value FROM counters WHERE label = $1", [label]);
    expect(during!.value).toBe(0); // still the pre-update value - no dirty read

    await writer.rollback();
    await reader.rollback();
  });

  it("a transaction's SELECT does not see another transaction's uncommitted INSERT", async () => {
    const otherLabel = "test-no-dirty-read-insert";
    await db.delete(counters).where(eq(counters.label, otherLabel));

    await writer.begin();
    await writer.query("INSERT INTO counters (label, value) VALUES ($1, 1)", [otherLabel]);
    // writer intentionally NOT committed yet

    await reader.begin();
    const rows = await reader.query("SELECT value FROM counters WHERE label = $1", [otherLabel]);
    expect(rows.length).toBe(0); // uncommitted row is invisible

    await writer.rollback();
    await reader.rollback();
  });
});
