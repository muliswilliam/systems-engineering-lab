import { Faker, en } from "@faker-js/faker";
import { PARTITIONED_YEAR, monthBounds } from "../db/partitions.js";

export interface GeneratedMetricEvent {
  deviceId: string;
  metric: string;
  value: number;
  recordedAt: Date;
}

const DEVICE_POOL_SIZE = 300;

/**
 * A coherent IoT device-telemetry domain: a fleet of sensors reporting
 * readings for five metrics, weighted so the high-frequency environmental
 * metrics (temperature/humidity) dominate over the rarer, event-ish ones
 * (vibration), the way a real fleet's report mix looks. Ranges are
 * per-metric so values stay physically plausible (SPEC.md 8.3: "generated
 * data should respect domain constraints").
 */
const METRICS: { value: string; weight: number; min: number; max: number; decimals: number }[] = [
  { value: "temperature_c", weight: 30, min: 15, max: 35, decimals: 1 },
  { value: "humidity_pct", weight: 20, min: 20, max: 90, decimals: 1 },
  { value: "pressure_hpa", weight: 15, min: 950, max: 1050, decimals: 1 },
  { value: "battery_pct", weight: 20, min: 0, max: 100, decimals: 0 },
  { value: "vibration_mm_s", weight: 15, min: 0, max: 5, decimals: 2 },
];

export interface GenerateMetricEventsBatchedOptions {
  /** Rows generated for EACH of the 12 months of `PARTITIONED_YEAR`. */
  rowsPerMonth: number;
  seed: number;
  batchSize?: number;
}

export interface MonthBatch {
  year: number;
  month: number;
  batch: GeneratedMetricEvent[];
}

/**
 * Streaming/batched generator (SPEC.md 8.4), yielded one calendar month at
 * a time so seed.ts can log per-month progress and so every row lands in
 * the month its `recordedAt` implies - useful for reasoning about exact
 * per-partition row counts. Deterministic per SPEC.md 8.1: the same `seed`
 * always produces the same logical dataset, in the same order, regardless
 * of how many rows per month are requested.
 */
export function* generateMetricEventsBatched(options: GenerateMetricEventsBatchedOptions): Generator<MonthBatch> {
  const { rowsPerMonth, seed, batchSize = 5_000 } = options;

  const faker = new Faker({ locale: en });
  faker.seed(seed);

  const deviceIds = Array.from({ length: DEVICE_POOL_SIZE }, (_, i) => `dev-${String(i + 1).padStart(4, "0")}`);
  const metricPool = METRICS.flatMap((m) => Array<typeof m>(m.weight).fill(m));

  for (let month = 1; month <= 12; month += 1) {
    const { from, to } = monthBounds(PARTITIONED_YEAR, month);
    const fromMs = from.getTime();
    const toMs = to.getTime();

    let batch: GeneratedMetricEvent[] = [];

    for (let i = 0; i < rowsPerMonth; i += 1) {
      const metricSpec = faker.helpers.arrayElement(metricPool);
      const recordedAtMs = faker.number.int({ min: fromMs, max: toMs - 1 });

      batch.push({
        deviceId: faker.helpers.arrayElement(deviceIds),
        metric: metricSpec.value,
        value: Number(
          faker.number
            .float({ min: metricSpec.min, max: metricSpec.max, fractionDigits: metricSpec.decimals })
            .toFixed(metricSpec.decimals),
        ),
        recordedAt: new Date(recordedAtMs),
      });

      if (batch.length >= batchSize) {
        yield { year: PARTITIONED_YEAR, month, batch };
        batch = [];
      }
    }

    if (batch.length > 0) {
      yield { year: PARTITIONED_YEAR, month, batch };
    }
  }
}
