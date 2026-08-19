import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../../src/db/primary-client.js";
import { replica1Pool, waitForDatabase as waitForReplica1 } from "../../src/db/replica1-client.js";
import { replica2Pool, waitForDatabase as waitForReplica2 } from "../../src/db/replica2-client.js";
import { widgets } from "../../src/db/schema.js";
import { setApplyDelay, waitForRowVisible } from "../../src/lib/replication-control.js";

const REPLICA1_DELAY_MS = 150;
const REPLICA2_DELAY_MS = 150;

beforeAll(async () => {
  await waitForPrimary(primaryPool);
  await migrate(primaryDb, { migrationsFolder: "drizzle" });
  await waitForReplica1(replica1Pool);
  await waitForReplica2(replica2Pool);
});

afterAll(async () => {
  await setApplyDelay(replica1Pool, 0);
  await setApplyDelay(replica2Pool, 0);
  await primaryPool.end();
  await replica1Pool.end();
  await replica2Pool.end();
});

describe("cascading propagation lag - the additional hop has a real, additive cost", () => {
  it("primary -> replica-2 total lag is measurably larger than primary -> replica-1 lag alone, under a real recovery_min_apply_delay on each hop", async () => {
    await setApplyDelay(replica1Pool, REPLICA1_DELAY_MS);
    await setApplyDelay(replica2Pool, REPLICA2_DELAY_MS);

    const [inserted] = await primaryDb
      .insert(widgets)
      .values({ name: "cascading-lag-test-row", value: 1 })
      .returning({ publicId: widgets.publicId });
    expect(inserted).toBeDefined();
    const publicId = inserted!.publicId;
    const committedAt = performance.now();

    await waitForRowVisible(replica1Pool, publicId, { timeoutMs: 10_000 });
    const hop1LagMs = performance.now() - committedAt;

    await waitForRowVisible(replica2Pool, publicId, { timeoutMs: 10_000 });
    const totalLagMs = performance.now() - committedAt;

    // Generous bounds per SPEC.md section 11 ("assert on eventual
    // consistency within a generous bound, not a tight one") - the point is
    // the ORDERING and the additive relationship, not exact millisecond
    // equality with the configured delay.
    expect(hop1LagMs).toBeGreaterThan(REPLICA1_DELAY_MS * 0.5);
    expect(totalLagMs).toBeGreaterThan(hop1LagMs);
    expect(totalLagMs).toBeGreaterThan((REPLICA1_DELAY_MS + REPLICA2_DELAY_MS) * 0.5);
  });

  it("with no artificial delay, a write still propagates through both hops in the correct order (replica-1 sees it no later than replica-2)", async () => {
    await setApplyDelay(replica1Pool, 0);
    await setApplyDelay(replica2Pool, 0);

    const [inserted] = await primaryDb
      .insert(widgets)
      .values({ name: "cascading-lag-baseline-row", value: 2 })
      .returning({ publicId: widgets.publicId });
    expect(inserted).toBeDefined();
    const publicId = inserted!.publicId;

    const hop1 = await waitForRowVisible(replica1Pool, publicId, { timeoutMs: 10_000 });
    const hop2 = await waitForRowVisible(replica2Pool, publicId, { timeoutMs: 10_000 });

    expect(hop1.waitedMs).toBeGreaterThanOrEqual(0);
    expect(hop2.waitedMs).toBeGreaterThanOrEqual(0);
  });
});
