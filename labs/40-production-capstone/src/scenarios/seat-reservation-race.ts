import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { reserveSeat, resetSeatToAvailable } from "../seats/reserve-seat.js";

const log = createLogger("lab40:scenario:seat-race");

/**
 * The concurrency-control mechanism this capstone's checkout flow rests on
 * (Lab 11/12's conditional write), demonstrated on its own before composing
 * it with everything else: 100 concurrent customers try to reserve the SAME
 * seat. Exactly one may win - this is the invariant the whole checkout
 * pipeline downstream depends on being true.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const ATTEMPTS = 100;
  const pool = createPool({ connectionString: process.env.DATABASE_URL, max: ATTEMPTS + 10 });
  await waitForDatabase(pool);

  const { rows } = await pool.query<{ id: number }>("SELECT id FROM seats ORDER BY id LIMIT 1");
  const seatId = rows[0]?.id;
  if (!seatId) throw new Error("No seats found - run `pnpm seed` first");
  await resetSeatToAvailable(pool, seatId);

  log.info({ seatId, attempts: ATTEMPTS }, "starting concurrent reservation attempts");

  const results = await runConcurrently(ATTEMPTS, (index) =>
    reserveSeat(pool, { seatId, customerId: `customer-${index}@example.com` }),
  );

  const reserved = results.filter(
    (r) => r.status === "fulfilled" && r.value.outcome === "reserved",
  ).length;
  const rejected = countFulfilled(results) - reserved;

  log.info(
    { seatId, attempts: ATTEMPTS, reserved, rejected },
    reserved === 1
      ? "INVARIANT HELD: exactly one of the concurrent attempts reserved the seat"
      : `unexpected: ${reserved} attempts reserved the seat (expected exactly 1)`,
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "seat reservation race scenario failed");
    process.exit(1);
  });
}
