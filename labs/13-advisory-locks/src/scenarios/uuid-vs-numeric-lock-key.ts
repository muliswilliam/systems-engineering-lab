import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_COMPANIES } from "../seed/scenario-companies.js";
import {
  advisoryUnlockTwoKeys,
  advisoryUnlock,
  connectClient,
  findCompanyByName,
  tryAdvisoryLock,
  tryAdvisoryLockTwoKeys,
} from "./support.js";

const log = createLogger("lab13:scenario:uuid-vs-numeric-lock-key");

const COMPANY_NAME = SCENARIO_COMPANIES[0].name;

export interface LockKeyStrategyResult {
  companyId: number;
  companyPublicId: string;
  numericKeyAcquired: boolean;
  hashedUuidBigintKeyValue: string;
  hashedUuidBigintKeyAcquired: boolean;
  splitUuidTwoIntKeyValues: [number, number];
  splitUuidTwoIntKeyAcquired: boolean;
}

/**
 * `pg_advisory_lock` and friends take either one `bigint` or two `int`s.
 * There are two common ways to turn an entity into that key:
 *
 * 1. Use the entity's internal numeric `id` directly - simple, and within
 *    this one table there is zero collision risk because `id` is a real
 *    primary key.
 * 2. Hash the entity's public UUID into a numeric key - useful when the
 *    lock key needs to be derived from an externally-facing identifier (or
 *    when multiple entity types share one advisory-lock "namespace" and you
 *    do not want to plumb every internal numeric id to every caller).
 *    Hashing necessarily maps a much larger space (128-bit UUIDs) down to a
 *    much smaller one (32 or 64 bits), which introduces a real but bounded
 *    collision probability - see the README's "Exercise" and "Tradeoffs"
 *    sections for the actual birthday-paradox numbers.
 *
 * This demonstrates both against the real running Postgres instance: a
 * direct numeric-id lock, a single-bigint key from `hashtext(...)::bigint`
 * (64-bit-ish namespace, using Postgres's built-in string hash), and a
 * two-int32 key built by splitting an MD5 hash of the UUID text in half
 * (the `pg_advisory_lock(int, int)` overload).
 */
export async function runLockKeyStrategies(connectionString: string): Promise<LockKeyStrategyResult> {
  const company = await findCompanyByName(connectionString, COMPANY_NAME);
  const client = await connectClient(connectionString);

  try {
    // Strategy 1: internal numeric id directly.
    const numericKeyAcquired = await tryAdvisoryLock(client, company.id);
    log.info(
      { companyId: company.id, acquired: numericKeyAcquired },
      "strategy 1: pg_try_advisory_lock(internal numeric id) - no collision risk within this table",
    );
    if (numericKeyAcquired) {
      await advisoryUnlock(client, company.id);
    }

    // Strategy 2: hashtext(public_id) widened to bigint - single-key overload.
    const { rows: hashRows } = await client.query<{ key: string }>(
      "SELECT hashtext($1)::bigint AS key",
      [company.publicId],
    );
    const hashedUuidBigintKeyValue = hashRows[0]!.key;
    const hashedUuidBigintKeyAcquired = await tryAdvisoryLock(client, Number(hashedUuidBigintKeyValue));
    log.info(
      { companyId: company.id, publicId: company.publicId, key: hashedUuidBigintKeyValue, acquired: hashedUuidBigintKeyAcquired },
      "strategy 2: pg_try_advisory_lock(hashtext(public_id)::bigint) - hashed UUID, single bigint key",
    );
    if (hashedUuidBigintKeyAcquired) {
      await advisoryUnlock(client, Number(hashedUuidBigintKeyValue));
    }

    // Strategy 3: MD5(public_id) split into two int4 halves - two-key overload.
    const { rows: splitRows } = await client.query<{ key1: number; key2: number }>(
      `SELECT
         ('x' || substr(md5($1), 1, 8))::bit(32)::int AS key1,
         ('x' || substr(md5($1), 9, 8))::bit(32)::int AS key2`,
      [company.publicId],
    );
    const key1 = splitRows[0]!.key1;
    const key2 = splitRows[0]!.key2;
    const splitUuidTwoIntKeyAcquired = await tryAdvisoryLockTwoKeys(client, key1, key2);
    log.info(
      { companyId: company.id, publicId: company.publicId, key1, key2, acquired: splitUuidTwoIntKeyAcquired },
      "strategy 3: pg_try_advisory_lock(int, int) from md5(public_id) split into two halves",
    );
    if (splitUuidTwoIntKeyAcquired) {
      await advisoryUnlockTwoKeys(client, key1, key2);
    }

    return {
      companyId: company.id,
      companyPublicId: company.publicId,
      numericKeyAcquired,
      hashedUuidBigintKeyValue,
      hashedUuidBigintKeyAcquired,
      splitUuidTwoIntKeyValues: [key1, key2],
      splitUuidTwoIntKeyAcquired,
    };
  } finally {
    await client.end();
  }
}

/**
 * Pure-math birthday-paradox approximation - not a database call. For `n`
 * companies whose lock keys are drawn (via hashing) from a `spaceBits`-bit
 * space, this is the approximate probability that at least two distinct
 * companies hash to the SAME advisory-lock key. See the README's
 * "Tradeoffs" section for what a collision actually costs (an unnecessary,
 * temporary block between two unrelated companies - an availability/perf
 * issue, not a correctness bug, since nothing about advisory-lock semantics
 * assumes the key space is collision-free).
 */
export function approxCollisionProbability(n: number, spaceBits: number): number {
  const space = 2 ** spaceBits;
  const exponent = -(n * (n - 1)) / (2 * space);
  return 1 - Math.exp(exponent);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const result = await runLockKeyStrategies(connectionString);
  log.warn({ ...result }, "uuid-vs-numeric-lock-key scenario complete");

  const sampleSizes = [1_000, 100_000, 10_000_000];
  for (const n of sampleSizes) {
    log.info(
      {
        companies: n,
        probabilityAt32Bits: approxCollisionProbability(n, 32),
        probabilityAt64Bits: approxCollisionProbability(n, 64),
      },
      "birthday-paradox collision probability estimate (pure math, not a DB call)",
    );
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "uuid-vs-numeric-lock-key scenario failed");
    process.exit(1);
  });
}
