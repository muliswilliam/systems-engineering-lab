import { generateAccounts } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { accounts, transfers } from "../db/schema.js";

const log = createLogger("lab05:seed");

type Size = "small" | "medium" | "large";

const SIZE_PRESETS: Record<Size, number> = {
  small: 10,
  medium: 100,
  large: 1_000,
};

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

/**
 * Idempotent: clears both tables (transfers first, since it references
 * accounts) and reinserts a fresh, deterministic set of accounts every run -
 * running this twice with the same --seed produces the same logical account
 * balances (SPEC.md 8.1). `transfers` starts empty; it is populated only by
 * running the naive/transactional scenario scripts or the test suite.
 */
async function main() {
  const { seed, size } = parseArgs();
  const accountCount = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size, accountCount }, "clearing existing rows");
  await db.delete(transfers);
  await db.delete(accounts);

  const generatedAccounts = generateAccounts(accountCount, seed);
  const inserted = await db
    .insert(accounts)
    .values(
      generatedAccounts.map((a) => ({
        publicId: a.publicId,
        ownerName: a.ownerName,
        balanceCents: a.balanceCents,
        currency: a.currency,
      })),
    )
    .returning({ id: accounts.id, balanceCents: accounts.balanceCents });

  const totalBalanceCents = inserted.reduce((sum, row) => sum + row.balanceCents, 0);

  log.info(
    { seed, size, accountCount: inserted.length, totalBalanceCents },
    "seed complete",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
