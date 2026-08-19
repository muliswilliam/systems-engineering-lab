import type { Pool } from "pg";
import { SCENARIO_ACCOUNTS } from "../seed/scenario-accounts.js";

export interface AccountPair {
  index: number;
  accountAId: number;
  accountBId: number;
}

/**
 * Returns every trial-pair account id (everything seeded EXCEPT the two
 * named scenario accounts), ordered by id. Because `seed.ts` inserts the two
 * scenario accounts first and then every trial-pair account in a single
 * batched, order-preserving `unnest` insert against a table it just
 * `TRUNCATE ... RESTART IDENTITY`d, consecutive ids in this list are exactly
 * the two accounts of one pair - no naming convention needed to recover the
 * pairing.
 */
export async function getTrialPairs(pool: Pool): Promise<AccountPair[]> {
  const scenarioNames = SCENARIO_ACCOUNTS.map((a) => a.ownerName);
  const { rows } = await pool.query<{ id: number }>(
    "SELECT id FROM accounts WHERE owner_name <> ALL($1::text[]) ORDER BY id",
    [scenarioNames],
  );
  const ids = rows.map((r) => r.id);
  const pairs: AccountPair[] = [];
  for (let i = 0; i + 1 < ids.length; i += 2) {
    pairs.push({ index: pairs.length, accountAId: ids[i]!, accountBId: ids[i + 1]! });
  }
  return pairs;
}
