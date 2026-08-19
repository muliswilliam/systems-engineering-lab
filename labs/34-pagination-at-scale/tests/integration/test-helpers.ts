import type { Pool } from "pg";
import { db } from "../../src/db/client.js";
import { activityEvents } from "../../src/db/schema.js";
import { generateActivityEventsBatched } from "../../src/seed/generator.js";

const BATCH_SIZE = 2_000;

/**
 * Truncates and reseeds `activity_events` with a known, deterministic row
 * count for a single test file. Each test file calls this in its own
 * `beforeAll` so it starts from a known state regardless of what a
 * previous file (run sequentially - see vitest.config.ts) left behind.
 */
export async function reseed(pool: Pool, rows: number, seed = 42): Promise<void> {
  await pool.query("TRUNCATE TABLE activity_events RESTART IDENTITY");
  for (const batch of generateActivityEventsBatched({ count: rows, seed, batchSize: BATCH_SIZE })) {
    await db.insert(activityEvents).values(
      batch.map((e) => ({
        actorName: e.actorName,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        createdAt: e.createdAt,
      })),
    );
  }
}
