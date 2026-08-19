import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { counters } from "../../src/db/schema.js";
import { openSession, sleep, type Session } from "../../src/db/session.js";

/**
 * A concurrent writer is not blocked by another session's open,
 * non-locking read transaction - asserted here by racing the writer's
 * UPDATE+COMMIT against a timeout that is well shorter than the reader's
 * hold duration. If the writer were blocked, this test would time out
 * (or at least take close to READER_HOLD_MS); it doesn't.
 *
 * For contrast, the second test shows `SELECT ... FOR UPDATE` (a real row
 * lock, not a plain MVCC read) DOES block a concurrent writer for the full
 * hold duration - the blocking comes from the lock, not from "reading."
 */
const label = "test-readers-dont-block-writers";
const READER_HOLD_MS = 1500;

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

afterAll(async () => {
  await reader.close();
  await writer.close();
  await db.delete(counters).where(eq(counters.label, label));
  await pool.end();
});

describe("readers do not block writers", () => {
  it("a plain SELECT inside an open transaction does not block a concurrent UPDATE", async () => {
    await reader.begin();
    await reader.query("SELECT value FROM counters WHERE label = $1", [label]);

    const start = Date.now();
    await writer.query("UPDATE counters SET value = value + 1 WHERE label = $1", [label]);
    const elapsedMs = Date.now() - start;

    // A blocked writer would take roughly READER_HOLD_MS; an unblocked one
    // completes essentially immediately.
    expect(elapsedMs).toBeLessThan(READER_HOLD_MS / 2);

    await writer.query("COMMIT");
    await reader.rollback();
  });

  it("SELECT ... FOR UPDATE DOES block a concurrent UPDATE until the lock is released", async () => {
    await reader.begin();
    await reader.query("SELECT value FROM counters WHERE label = $1 FOR UPDATE", [label]);

    let writerResolved = false;
    const writerPromise = writer
      .query("UPDATE counters SET value = value + 1 WHERE label = $1", [label])
      .then(() => {
        writerResolved = true;
      });

    await sleep(READER_HOLD_MS);
    // Still blocked: the writer's promise has not resolved while the
    // reader's row lock is held.
    expect(writerResolved).toBe(false);

    await reader.commit();
    await writerPromise;
    expect(writerResolved).toBe(true);

    await writer.query("COMMIT");
  });
});
