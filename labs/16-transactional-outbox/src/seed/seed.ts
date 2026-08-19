import { Faker, en } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { orders, outboxEvents } from "../db/schema.js";

const log = createLogger("lab16:seed");

type Size = "small" | "medium" | "large";

const SIZE_PRESETS: Record<Size, number> = {
  small: 5,
  medium: 25,
  large: 100,
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
 * This lab's own generator, kept local rather than added to
 * `@labs/data-generators`: `orders` here is a deliberately minimal,
 * scenario-specific table (see schema.ts), not SPEC.md 8.2's reusable
 * "Commerce" domain entity, so a shared generator would be speculative
 * machinery ahead of any second consumer needing it (CLAUDE.md's Dependency
 * guidance).
 *
 * Idempotent: clears both tables (outbox_events first, since it references
 * orders) and reinserts a fresh, deterministic set of baseline orders every
 * run. Every baseline order also gets exactly one already-published outbox
 * event, modeling orders that were created and successfully published
 * *before* this lab session started - a clean starting point distinct from
 * the rows the scenario scripts and tests create themselves (which use their
 * own unique customer-name markers so they never collide with seed data).
 */
async function main() {
  const { seed, size } = parseArgs();
  const orderCount = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size, orderCount }, "clearing existing rows");
  await db.delete(outboxEvents);
  await db.delete(orders);

  const faker = new Faker({ locale: en });
  faker.seed(seed);

  const generatedOrders = Array.from({ length: orderCount }, () => ({
    customerName: faker.person.fullName(),
    amountCents: faker.number.int({ min: 500, max: 250_000 }),
  }));

  const insertedOrders = await db.insert(orders).values(generatedOrders).returning({
    id: orders.id,
    amountCents: orders.amountCents,
  });

  await db.insert(outboxEvents).values(
    insertedOrders.map((order) => ({
      aggregateType: "order" as const,
      aggregateId: order.id,
      eventType: "OrderCreated" as const,
      payload: { orderId: order.id, amountCents: order.amountCents },
      publishedAt: new Date(),
    })),
  );

  log.info(
    { seed, size, orderCount: insertedOrders.length },
    "seed complete - baseline orders each have one already-published outbox event",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
