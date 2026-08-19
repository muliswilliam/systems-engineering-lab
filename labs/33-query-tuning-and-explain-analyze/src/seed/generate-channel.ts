import type { Faker } from "@faker-js/faker";

/**
 * Channel is generated LOCALLY (not part of the shared
 * `@labs/data-generators` commerce generators - no other lab needs it) and
 * deliberately CORRELATED with order status: a cancelled order in this
 * dataset is disproportionately likely to have been cancelled by phone (a
 * customer calling in to cancel), while every other status's channel is
 * close to uniform across web/mobile/phone/store. This manufactured
 * correlation is Pattern 1b's whole point - see
 * src/scenarios/pattern1-bad-estimates-naive.ts. Extracted to its own
 * module so both src/seed/seed.ts and tests/integration/seed-helper.ts use
 * the exact same generation logic.
 */
export const CHANNELS = ["web", "mobile", "phone", "store"] as const;
export type Channel = (typeof CHANNELS)[number];
export const CANCELLED_PHONE_BIAS = 0.85;

export function pickChannel(faker: Faker, status: string): Channel {
  if (status === "cancelled" && faker.number.float({ min: 0, max: 1 }) < CANCELLED_PHONE_BIAS) {
    return "phone";
  }
  return faker.helpers.arrayElement(CHANNELS);
}
