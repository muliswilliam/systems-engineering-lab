import { fileURLToPath } from "node:url";
import { Faker, en } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";

const log = createLogger("lab38:seed");

const DEFAULT_ROWS = 400;
// ~5% guest-checkout rows (customer_email = null) - realistic and small
// enough that the "error" bucket of the traffic mix (10% of requests) still
// mostly lands on a genuine null row rather than needing every 10th id to be
// one, per CLAUDE.md's "realistic, not meaningless" data generation rule.
const GUEST_CHECKOUT_FRACTION = 0.05;
const STATUS_WEIGHTS: Array<{ status: string; weight: number }> = [
  { status: "completed", weight: 0.9 },
  { status: "refunded", weight: 0.05 },
  { status: "pending", weight: 0.05 },
];

function pickStatus(faker: Faker): string {
  const roll = faker.number.float({ min: 0, max: 1 });
  let cumulative = 0;
  for (const { status, weight } of STATUS_WEIGHTS) {
    cumulative += weight;
    if (roll <= cumulative) return status;
  }
  return STATUS_WEIGHTS[STATUS_WEIGHTS.length - 1]!.status;
}

/**
 * Deterministic, seeded, single-batch insert (400 rows does not need
 * chunking the way Lab 31's 150,000-row seed does). Idempotent per
 * CLAUDE.md 8.1: TRUNCATE + RESTART IDENTITY before every insert.
 */
export async function seedOrders(targetPool: typeof pool, totalRows: number, seedValue = 38): Promise<void> {
  const faker = new Faker({ locale: en });
  faker.seed(seedValue);

  await targetPool.query("TRUNCATE TABLE orders RESTART IDENTITY");

  const emails: Array<string | null> = [];
  const amounts: number[] = [];
  const statuses: string[] = [];

  for (let i = 0; i < totalRows; i += 1) {
    const isGuest = faker.number.float({ min: 0, max: 1 }) < GUEST_CHECKOUT_FRACTION;
    emails.push(isGuest ? null : faker.internet.email().toLowerCase());
    amounts.push(faker.number.int({ min: 500, max: 50_000 }));
    statuses.push(pickStatus(faker));
  }

  await targetPool.query(
    `INSERT INTO orders (customer_email, amount_cents, status)
     SELECT * FROM unnest($1::text[], $2::integer[], $3::text[])`,
    [emails, amounts, statuses],
  );
}

function parseArgs(): { seed: number; rows: number } {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith("--seed="));
  const rowsArg = args.find((a) => a.startsWith("--rows="));
  return {
    seed: seedArg ? Number(seedArg.split("=")[1]) : 38,
    rows: rowsArg ? Number(rowsArg.split("=")[1]) : DEFAULT_ROWS,
  };
}

async function main() {
  const { seed, rows } = parseArgs();
  await waitForDatabase(pool);

  const start = performance.now();
  await seedOrders(pool, rows, seed);
  const durationMs = performance.now() - start;

  const guestCount = await pool.query("SELECT count(*) FROM orders WHERE customer_email IS NULL");
  log.info(
    {
      seed,
      totalRows: rows,
      guestCheckoutRows: Number(guestCount.rows[0].count),
      durationMs: Number(durationMs.toFixed(0)),
    },
    "seed complete",
  );
  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "seed failed");
    process.exit(1);
  });
}
