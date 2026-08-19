import { Faker, en } from "@faker-js/faker";

export interface GeneratedOutboxEvent {
  publicId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * Background-processing / messaging domain generator for Lab 17's outbox
 * publishing lab. Lab 17 does not model the write side that would normally
 * produce these rows (an `orders` table plus `BEGIN / INSERT order / INSERT
 * outbox_event / COMMIT` is Lab 16's job) - it seeds `outbox_events` directly,
 * as if some other, already-correct process had already written them, so
 * this lab's entire focus stays on the PUBLISHING side (claim + broker call).
 *
 * Event types and payload shapes are a small, coherent slice of realistic
 * order-lifecycle events (SPEC.md 8.3: "avoid meaningless random records"),
 * not a generic reusable "orders" generator - this file is scoped to what
 * Lab 17 needs, per CLAUDE.md's guidance not to build speculative shared
 * machinery ahead of a second consumer needing it.
 */
const EVENT_TYPES = [
  "OrderCreated",
  "PaymentCaptured",
  "OrderShipped",
  "InventoryAdjusted",
  "RefundIssued",
] as const;

export type OutboxEventType = (typeof EVENT_TYPES)[number];

function buildPayload(faker: Faker, eventType: OutboxEventType): Record<string, unknown> {
  switch (eventType) {
    case "OrderCreated":
      return {
        orderId: faker.string.uuid(),
        customerEmail: faker.internet.email(),
        totalCents: faker.number.int({ min: 500, max: 50_000 }),
      };
    case "PaymentCaptured":
      return {
        orderId: faker.string.uuid(),
        amountCents: faker.number.int({ min: 500, max: 50_000 }),
        provider: faker.helpers.arrayElement(["stripe", "adyen"]),
      };
    case "OrderShipped":
      return {
        orderId: faker.string.uuid(),
        carrier: faker.helpers.arrayElement(["ups", "fedex", "usps"]),
        trackingNumber: faker.string.alphanumeric(12).toUpperCase(),
      };
    case "InventoryAdjusted":
      return {
        sku: faker.string.alphanumeric(8).toUpperCase(),
        delta: faker.number.int({ min: -20, max: 20 }),
      };
    case "RefundIssued":
      return {
        orderId: faker.string.uuid(),
        amountCents: faker.number.int({ min: 100, max: 20_000 }),
        reason: faker.helpers.arrayElement(["customer_request", "damaged", "duplicate_charge"]),
      };
  }
}

/**
 * Generates a deterministic, seeded batch of outbox events, all starting
 * logically `pending` (the caller decides how to insert `status` - this
 * generator only produces `eventType`/`payload`, per SPEC.md 8.1's
 * determinism requirement: the same seed always produces the same logical
 * dataset).
 */
export function generateOutboxEvents(count: number, seed: number): GeneratedOutboxEvent[] {
  const faker = new Faker({ locale: en });
  // +7 offset keeps this generator's RNG sequence independent of the other
  // domains' generators (payroll: seed/seed+1, commerce: seed/seed+1/seed+2,
  // ledger: seed+3, jobs: seed+4, ticketing: seed+5/seed+6) should a future
  // lab ever compose outbox events alongside another domain under one seed.
  faker.seed(seed + 7);

  return Array.from({ length: count }, () => {
    const eventType = faker.helpers.arrayElement(EVENT_TYPES);
    return {
      publicId: faker.string.uuid(),
      eventType,
      payload: buildPayload(faker, eventType),
    };
  });
}
