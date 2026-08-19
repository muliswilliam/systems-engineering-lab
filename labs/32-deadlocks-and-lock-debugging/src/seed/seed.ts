import { fileURLToPath } from "node:url";
import { generateAccounts } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { SCENARIO_ACCOUNTS, TRIAL_PAIR_BASELINE_BALANCE_CENTS } from "./scenario-accounts.js";

const log = createLogger("lab32:seed");

/**
 * Default number of independent account PAIRS seeded for the "many
 * concurrent trials" scenario/test (`scenario:trials`,
 * `tests/integration/many-trials.test.ts`). 150 pairs (300 accounts) is
 * comfortably more than either the naive-strategy or consistent-order
 * test's own trial count needs, with room for both to use disjoint slices of
 * the pool (see `many-trials.ts`'s `offset`/`count` parameters) and for
 * `--trials=` on the interactive script to go higher without reseeding.
 */
const DEFAULT_TRIAL_PAIRS = 150;

function parseArgs(): { seed: number; pairs: number } {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith("--seed="));
  const pairsArg = args.find((a) => a.startsWith("--pairs="));
  const seed = seedArg ? Number(seedArg.split("=")[1]) : 42;
  const pairs = pairsArg ? Number(pairsArg.split("=")[1]) : DEFAULT_TRIAL_PAIRS;
  if (!Number.isFinite(pairs) || pairs <= 0) {
    throw new Error(`--pairs must be a positive integer, got "${pairsArg}"`);
  }
  return { seed, pairs };
}

/**
 * Idempotent (SPEC.md 8.1): `TRUNCATE ... RESTART IDENTITY` first, so
 * re-seeding always produces the exact same logical dataset for a given
 * `--seed=`/`--pairs=` - the two named scenario accounts always land at ids
 * 1 and 2, and every trial-pair account id after that is deterministic and
 * contiguous, which is what lets `getTrialPairAccountIds` below pair them up
 * purely by insertion order without needing a naming convention.
 */
async function main() {
  const { seed, pairs } = parseArgs();
  const totalTrialAccounts = pairs * 2;

  await waitForDatabase(pool);

  await pool.query("TRUNCATE TABLE accounts RESTART IDENTITY");

  for (const account of SCENARIO_ACCOUNTS) {
    await pool.query("INSERT INTO accounts (owner_name, balance_cents) VALUES ($1, $2)", [
      account.ownerName,
      account.balanceCents,
    ]);
  }

  const generated = generateAccounts(totalTrialAccounts, seed);
  const ownerNames = generated.map((a) => a.ownerName);
  const balances = new Array<number>(totalTrialAccounts).fill(TRIAL_PAIR_BASELINE_BALANCE_CENTS);

  await pool.query(
    `INSERT INTO accounts (owner_name, balance_cents) SELECT * FROM unnest($1::text[], $2::integer[])`,
    [ownerNames, balances],
  );

  const { rows: countRows } = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM accounts");

  log.info(
    { seed, pairs, totalAccounts: Number(countRows[0]?.count ?? 0) },
    "seed complete - 2 named scenario accounts (ids 1-2) plus deterministic trial-pair accounts, every balance at baseline",
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
