import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { activityEvents } from "../db/schema.js";
import { generateActivityEventsBatched } from "./generator.js";

const log = createLogger("lab34:seed");

type Size = "small" | "medium" | "large";

/**
 * Row-count presets (SPEC.md 8.1: `pnpm seed --size=small|medium|large`).
 *
 * - small:  20,000 rows.  Fast (~seconds). Used by default and by tests -
 *   enough rows for the naive-vs-keyset difference to already be visible,
 *   without a multi-minute seed on every `pnpm test` run.
 * - medium: 150,000 rows. A middle step, still fast enough for interactive use.
 * - large:  600,000 rows. The size this lab's README numbers were captured
 *   against - "hundreds of thousands of rows" per the lab brief. NOT the
 *   default a learner runs by accident; see README "Setup" for expected
 *   wall-clock time.
 */
const SIZE_PRESETS: Record<Size, number> = {
  small: 20_000,
  medium: 150_000,
  large: 600_000,
};

const INSERT_BATCH_SIZE = 5_000;
const PROGRESS_EVERY_BATCHES = 10;

function parseArgs(): { seed: number; rows: number; label: string } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => args.find((a) => a.startsWith(`${flag}=`))?.split("=")[1];

  const seed = Number(get("--seed") ?? "42");

  const rowsArg = get("--rows");
  if (rowsArg) {
    const rows = Number(rowsArg);
    if (!Number.isFinite(rows) || rows <= 0) {
      throw new Error(`Invalid --rows value "${rowsArg}"`);
    }
    return { seed, rows, label: `--rows=${rows}` };
  }

  const sizeArg = (get("--size") ?? "small") as Size;
  if (!(sizeArg in SIZE_PRESETS)) {
    throw new Error(`Unknown --size "${sizeArg}". Use small, medium, or large.`);
  }
  return { seed, rows: SIZE_PRESETS[sizeArg], label: `--size=${sizeArg}` };
}

async function main() {
  const { seed, rows, label } = parseArgs();
  const startedAt = Date.now();

  await waitForDatabase(pool);

  log.info({ seed, rows, label }, "clearing existing rows");
  // TRUNCATE ... RESTART IDENTITY, not DELETE: this lab's whole point is
  // depth-dependent behavior, and a stale, ever-growing identity sequence
  // across repeated re-seeds would make row counts and id values drift
  // from run to run even under the same --seed. A clean, deterministic
  // reseed always starts ids back at 1 (SPEC.md 8.1: same seed -> same
  // logical dataset every time).
  await pool.query("TRUNCATE TABLE activity_events RESTART IDENTITY");

  log.info({ rows }, "generating and inserting activity_events (streamed in batches)");

  let inserted = 0;
  let batchIndex = 0;

  for (const batch of generateActivityEventsBatched({ count: rows, seed, batchSize: INSERT_BATCH_SIZE })) {
    await db.insert(activityEvents).values(
      batch.map((e) => ({
        actorName: e.actorName,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        createdAt: e.createdAt,
      })),
    );

    inserted += batch.length;
    batchIndex += 1;

    if (batchIndex % PROGRESS_EVERY_BATCHES === 0) {
      log.info({ batchIndex, inserted, elapsedMs: Date.now() - startedAt }, "seed progress");
    }
  }

  const elapsedMs = Date.now() - startedAt;
  log.info(
    {
      seed,
      inserted,
      elapsedMs,
      rowsPerSecond: Math.round(inserted / (elapsedMs / 1000)),
    },
    "seed complete",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
