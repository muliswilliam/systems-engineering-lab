import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { counters } from "../db/schema.js";

const log = createLogger("lab06:seed");

type Size = "small" | "medium" | "large";

const SIZE_PRESETS: Record<Size, number> = {
  small: 5,
  medium: 20,
  large: 100,
};

// Named, meaningful labels for the first few counters (the ones the
// scenario scripts actually read/write by name); anything beyond that for
// --size=medium/large is generic filler so the table has more than a
// handful of rows without pretending each one models something real. This
// lab's point is tuple versioning on a single row, not a realistic domain -
// see README "Scenario" for why counters (not payroll/commerce) were chosen.
const NAMED_LABELS = ["page-views", "signups", "orders-processed", "api-errors", "cache-hits"];

function parseArgs(): { seed: number; size: Size } {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith("--seed="));
  const sizeArg = args.find((a) => a.startsWith("--size="));
  const seed = seedArg ? Number(seedArg.split("=")[1]) : 42;
  const size = (sizeArg ? sizeArg.split("=")[1] : "small") as Size;

  if (!(size in SIZE_PRESETS)) {
    throw new Error(`Unknown --size "${size}". Use small, medium, or large.`);
  }

  return { seed, size };
}

/** Deterministic PRNG (mulberry32) so `--seed=N` always produces the same
 * initial counter values without pulling in a faker dependency this lab
 * doesn't otherwise need. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildLabels(count: number): string[] {
  const labels = NAMED_LABELS.slice(0, count);
  for (let i = labels.length; i < count; i += 1) {
    labels.push(`counter-${i + 1}`);
  }
  return labels;
}

async function main() {
  const { seed, size } = parseArgs();
  const count = SIZE_PRESETS[size];
  const rand = mulberry32(seed);

  await waitForDatabase(pool);

  log.info({ seed, size, count }, "clearing existing rows");
  await db.delete(counters);

  const rows = buildLabels(count).map((label) => ({
    label,
    value: Math.floor(rand() * 1000),
  }));

  await db.insert(counters).values(rows);

  log.info({ counters: rows.length, seed, size }, "seed complete");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
