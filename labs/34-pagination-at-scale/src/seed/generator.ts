import { Faker, en } from "@faker-js/faker";

export interface GeneratedActivityEvent {
  actorName: string;
  action: string;
  targetType: string;
  targetId: string;
  createdAt: Date;
}

const ACTOR_POOL_SIZE = 400;

/**
 * A coherent "dev-collaboration platform" activity feed (think a GitHub/
 * Jira-style audit log: "alice merged pull_request #4821"), weighted so the
 * common actions (create/update/comment) dominate and terminal actions
 * (delete/reject) are a realistic minority.
 */
const ACTIONS: { value: string; weight: number }[] = [
  { value: "created", weight: 22 },
  { value: "updated", weight: 20 },
  { value: "commented_on", weight: 18 },
  { value: "closed", weight: 10 },
  { value: "reopened", weight: 3 },
  { value: "merged", weight: 8 },
  { value: "approved", weight: 7 },
  { value: "rejected", weight: 3 },
  { value: "assigned", weight: 6 },
  { value: "labeled", weight: 2 },
  { value: "archived", weight: 1 },
];

const TARGET_TYPES: { value: string; weight: number }[] = [
  { value: "issue", weight: 35 },
  { value: "pull_request", weight: 30 },
  { value: "comment", weight: 15 },
  { value: "repository", weight: 5 },
  { value: "release", weight: 5 },
  { value: "deployment", weight: 10 },
];

/**
 * Mean inter-event arrival time, in whole seconds, used to advance the
 * synthetic feed clock one event at a time (see below). Kept small and
 * constant (not derived from a fixed calendar window) so the generator
 * needs no upfront knowledge of `count` - the feed's total time span simply
 * grows with the number of events, the way a real feed's history grows with
 * its actual event volume rather than a fixed retention window.
 */
const MEAN_INTERARRIVAL_SECONDS = 2;

/**
 * `createdAt` is deliberately generated at whole-SECOND granularity (see
 * schema.ts's doc comment) via a Poisson-ish random walk: each event's
 * timestamp is the previous event's timestamp plus an exponentially
 * distributed interarrival time, then truncated to the second. With a mean
 * interarrival of 2 seconds, roughly 1 - e^(-1/2) ~= 39% of consecutive
 * events land in the SAME second - frequent enough that `ORDER BY
 * created_at` alone visibly fails to produce a stable order at any
 * dataset size, which is exactly the property this lab needs `(created_at,
 * id)` for.
 */
function* walkTimestamps(faker: Faker, count: number, startAt: Date): Generator<Date> {
  let currentMs = startAt.getTime();
  for (let i = 0; i < count; i += 1) {
    if (i > 0) {
      // Exponential(mean) via inverse-CDF sampling from faker's seeded RNG,
      // so the whole walk stays deterministic under a fixed --seed.
      const u = faker.number.float({ min: 1e-9, max: 1, fractionDigits: 9 });
      const interarrivalSeconds = -Math.log(u) * MEAN_INTERARRIVAL_SECONDS;
      currentMs += Math.round(interarrivalSeconds * 1000);
    }
    yield new Date(Math.floor(currentMs / 1000) * 1000);
  }
}

export interface GenerateActivityEventsBatchedOptions {
  count: number;
  seed: number;
  /** Number of events per yielded batch. */
  batchSize?: number;
  /** Feed start time; defaults to `count * MEAN_INTERARRIVAL_SECONDS` seconds before now. */
  startAt?: Date;
}

/**
 * Streaming/batched generator (SPEC.md 8.4: "batch or stream inserts
 * instead of loading millions of records into memory"). Never materializes
 * more than `batchSize` events at once, so this is safe to call for
 * hundreds of thousands to millions of rows.
 *
 * Deterministic per SPEC.md 8.1: the same `seed` always produces the same
 * logical sequence of actors/actions/targets/timestamps, in the same order.
 */
export function* generateActivityEventsBatched(
  options: GenerateActivityEventsBatchedOptions,
): Generator<GeneratedActivityEvent[]> {
  const { count, seed, batchSize = 5_000 } = options;

  const faker = new Faker({ locale: en });
  faker.seed(seed);

  const actorNames = Array.from({ length: ACTOR_POOL_SIZE }, () => faker.internet.username());
  const actionPool = ACTIONS.flatMap((a) => Array<string>(a.weight).fill(a.value));
  const targetTypePool = TARGET_TYPES.flatMap((t) => Array<string>(t.weight).fill(t.value));

  const startAt = options.startAt ?? new Date(Date.now() - count * MEAN_INTERARRIVAL_SECONDS * 1000);
  const timestamps = walkTimestamps(faker, count, startAt);

  let batch: GeneratedActivityEvent[] = [];
  let targetIdCounter = 1;

  for (const createdAt of timestamps) {
    // targetId is drawn from a bounded, slowly-growing counter (not a fresh
    // random UUID per row) so the same handful of targets realistically
    // accumulate multiple activity events over time, the way a real popular
    // issue/PR gets many comments/updates rather than every event pointing
    // at a brand-new target.
    const targetId = String(1 + faker.number.int({ min: 0, max: targetIdCounter - 1 }));
    if (faker.number.int({ min: 0, max: 99 }) < 5) {
      targetIdCounter += 1;
    }

    batch.push({
      actorName: faker.helpers.arrayElement(actorNames),
      action: faker.helpers.arrayElement(actionPool),
      targetType: faker.helpers.arrayElement(targetTypePool),
      targetId,
      createdAt,
    });

    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield batch;
  }
}
