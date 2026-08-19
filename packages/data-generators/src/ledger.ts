import { Faker, en } from "@faker-js/faker";

export interface GeneratedAccount {
  publicId: string;
  ownerName: string;
  balanceCents: number;
  currency: string;
}

const DEFAULT_CURRENCY = "USD";

/**
 * Opening balances are bounded to a realistic personal-banking range ($100 -
 * $50,000) rather than an arbitrary integer range, per SPEC.md 8.3 ("do not
 * generate meaningless random records"). Kept small enough that many
 * transfer attempts against Lab 05's default seed can run without tripping
 * the `accounts.balance_cents >= 0` CHECK constraint by accident, while still
 * being provably a real balance.
 */
const MIN_OPENING_BALANCE_CENTS = 10_000;
const MAX_OPENING_BALANCE_CENTS = 5_000_000;

/**
 * Banking/ledger domain generator - deliberately minimal (SPEC.md 8.2's
 * "Banking/Ledger" entities are accounts, transfers, ledger entries; this
 * function only covers `accounts`, the one piece genuinely reusable across
 * every future ledger-domain lab per CLAUDE.md's Data Generation section).
 * `transfers`/`ledger_entries` rows are scenario data specific to what each
 * lab is teaching (Lab 05: naive vs transactional transfer attempts) and are
 * built inline in that lab rather than added here, to avoid speculative
 * shared machinery ahead of a second consumer actually needing it.
 *
 * All accounts share one `currency` by default (real transfers only make
 * sense between accounts in the same currency, and cross-currency transfers
 * are an FX concept this curriculum does not cover) - callers that want a
 * multi-currency dataset can still request one explicitly for read-only
 * scenarios.
 */
export function generateAccounts(
  count: number,
  seed: number,
  currency: string = DEFAULT_CURRENCY,
): GeneratedAccount[] {
  const faker = new Faker({ locale: en });
  // +3 offset keeps this generator's RNG sequence independent of
  // generateCompanies/generateEmployees (seed) and generateCustomers/
  // generateProducts/generateOrders(Batched) (seed, seed+1) if a future lab
  // ever composes ledger accounts alongside another domain under one seed.
  faker.seed(seed + 3);

  return Array.from({ length: count }, () => ({
    publicId: faker.string.uuid(),
    ownerName: faker.person.fullName(),
    balanceCents: faker.number.int({ min: MIN_OPENING_BALANCE_CENTS, max: MAX_OPENING_BALANCE_CENTS }),
    currency,
  }));
}
