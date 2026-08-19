import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { claimNextEvent, markPublished } from "../../src/outbox/claim.js";
import { runConcurrently } from "@labs/test-utils";

let insertedIds: number[] = [];

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterEach(async () => {
  if (insertedIds.length > 0) {
    await pool.query("DELETE FROM outbox_events WHERE id = ANY($1)", [insertedIds]);
    insertedIds = [];
  }
});

afterAll(async () => {
  await pool.end();
});

async function insertPendingEvents(count: number, label: string): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    // node-postgres returns `bigint` (OID 20) columns as strings by default,
    // to avoid silent precision loss past 2^53 - explicit Number() here
    // matches claimNextEvent's own conversion (src/outbox/claim.ts), so
    // these ids compare correctly against ClaimedEvent.id below.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO outbox_events (event_type, payload) VALUES ('TestEvent', $1) RETURNING id`,
      [JSON.stringify({ orderPublicId: randomUUID(), correlationId: `${label}-${i}`, customerEmail: "x@example.com", amountCents: 100 })],
    );
    ids.push(Number(rows[0]!.id));
  }
  return ids;
}

describe("outbox claiming via SELECT ... FOR UPDATE SKIP LOCKED (Lab 14/17's mechanism, reused fresh)", () => {
  it("10 concurrent workers draining 30 pending events claim exactly 30 unique rows with zero double-claims", async () => {
    const ids = await insertPendingEvents(30, "skiplocked");
    insertedIds = ids;

    const claimedIds: number[] = [];
    await runConcurrently(10, async (workerIndex) => {
      const workerId = `worker-${workerIndex}`;
      // Each worker drains until it sees no more claimable rows.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const event = await claimNextEvent(pool, workerId);
        if (!event) return;
        claimedIds.push(event.id);
        await markPublished(pool, event.id, workerId);
      }
    });

    expect(claimedIds).toHaveLength(30);
    expect(new Set(claimedIds).size).toBe(30);
    expect(new Set(claimedIds)).toEqual(new Set(ids));

    const { rows } = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*) FROM outbox_events WHERE id = ANY($1) GROUP BY status`,
      [ids],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("published");
  });

  it("a lease-expired claim is reclaimable by a different worker", async () => {
    const ids = await insertPendingEvents(1, "lease");
    insertedIds = ids;
    const id = ids[0]!;

    const claimedByA = await claimNextEvent(pool, "worker-A", 100); // 100ms lease
    expect(claimedByA?.id).toBe(id);

    // Worker A "crashes" - never finalizes. Wait past the lease.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const claimedByB = await claimNextEvent(pool, "worker-B", 5_000);
    expect(claimedByB?.id).toBe(id);

    const { rows } = await pool.query<{ attempts: number; locked_by: string }>(
      "SELECT attempts, locked_by FROM outbox_events WHERE id = $1",
      [id],
    );
    expect(rows[0]?.attempts).toBe(2);
    expect(rows[0]?.locked_by).toBe("worker-B");
  });
});
