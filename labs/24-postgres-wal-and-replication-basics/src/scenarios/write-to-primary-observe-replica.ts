import { performance } from "node:perf_hooks";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../db/replica-client.js";
import { widgets } from "../db/schema.js";

const log = createLogger("lab24:scenario:write-to-primary-observe-replica");

const WRITE_COUNT = 20;
const POLL_INTERVAL_MS = 5;
const POLL_TIMEOUT_MS = 5_000;

interface LagSample {
  attempt: number;
  publicId: string;
  lagMs: number;
  pollsUntilVisible: number;
}

/**
 * Insert one row on the PRIMARY, record the moment the INSERT resolves
 * (node-postgres resolves a query only after the primary has committed it,
 * so this is a real "just after commit" timestamp), then poll the REPLICA
 * with a tight loop until the same row (matched by its public_id, not a
 * guessed offset) becomes visible there. The difference between those two
 * timestamps is the real, observed replication lag for that write - not a
 * theoretical number.
 */
async function measureOneWrite(attempt: number): Promise<LagSample> {
  const [inserted] = await primaryDb
    .insert(widgets)
    .values({ name: `lag-probe-${attempt}`, value: attempt })
    .returning({ publicId: widgets.publicId });

  if (!inserted) {
    throw new Error("insert on primary returned no row");
  }

  const committedAt = performance.now();
  const publicId = inserted.publicId;

  let polls = 0;
  while (performance.now() - committedAt < POLL_TIMEOUT_MS) {
    polls += 1;
    const result = await replicaPool.query<{ public_id: string }>(
      "SELECT public_id FROM widgets WHERE public_id = $1",
      [publicId],
    );
    if (result.rowCount && result.rowCount > 0) {
      const visibleAt = performance.now();
      return {
        attempt,
        publicId,
        lagMs: visibleAt - committedAt,
        pollsUntilVisible: polls,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `row ${publicId} from primary did not appear on replica within ${POLL_TIMEOUT_MS}ms - replication is not working`,
  );
}

async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica(replicaPool);

  log.info({ writeCount: WRITE_COUNT }, "measuring real primary -> replica replication lag");

  const samples: LagSample[] = [];
  for (let attempt = 1; attempt <= WRITE_COUNT; attempt += 1) {
    const sample = await measureOneWrite(attempt);
    samples.push(sample);
    log.info(sample, "write replicated");
  }

  const lags = samples.map((s) => s.lagMs);
  const min = Math.min(...lags);
  const max = Math.max(...lags);
  const avg = lags.reduce((sum, v) => sum + v, 0) / lags.length;

  log.info(
    {
      samples: samples.length,
      minLagMs: Number(min.toFixed(2)),
      maxLagMs: Number(max.toFixed(2)),
      avgLagMs: Number(avg.toFixed(2)),
    },
    "replication lag distribution (real, observed, not hand-waved)",
  );

  await primaryPool.end();
  await replicaPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "write-to-primary-observe-replica failed");
  process.exit(1);
});
