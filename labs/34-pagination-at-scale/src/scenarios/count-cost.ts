import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { explainKeysetPage, getTotalRowCount } from "./pagination-lib.js";

const log = createLogger("lab34:scenario:count-cost");

/**
 * A COUNT(*) over a large table is itself expensive - PostgreSQL has no
 * index-only way to answer "how many rows match this filter" the way it can
 * answer "give me the next 20 rows"; it must visit every matching row's
 * visibility information. This matters directly to this lab's subject: a
 * classic OFFSET-based paginator often ALSO renders "Page 3 of 14,382" or
 * "1,234,567 results", which requires exactly this expensive COUNT(*) - one
 * more real cost that keyset/infinite-scroll UIs (which never need a total
 * page count) simply avoid.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const totalRows = await getTotalRowCount(pool);
  log.info({ totalRows }, "--- COUNT(*) COST: the price of rendering a 'Page X of Y' / 'N results' UI ---");

  const { rows: unfilteredExplain } = await pool.query<{
    "QUERY PLAN": [{ "Execution Time": number }];
  }>("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT count(*) FROM activity_events");
  const unfilteredMs = unfilteredExplain[0]!["QUERY PLAN"][0]["Execution Time"];

  const { rows: filteredExplain } = await pool.query<{
    "QUERY PLAN": [{ "Execution Time": number }];
  }>("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT count(*) FROM activity_events WHERE action = 'commented_on'");
  const filteredMs = filteredExplain[0]!["QUERY PLAN"][0]["Execution Time"];

  const keysetPage = await explainKeysetPage(pool, null, 20);

  log.warn(
    {
      totalRows,
      unfilteredCountMs: Number(unfilteredMs.toFixed(3)),
      filteredCountMs: Number(filteredMs.toFixed(3)),
      keysetFirstPageMs: Number(keysetPage.executionTimeMs.toFixed(3)),
      countToKeysetRatio: Number((unfilteredMs / Math.max(keysetPage.executionTimeMs, 0.001)).toFixed(1)),
    },
    "an unfiltered and a filtered COUNT(*) both require a full scan of the matching rows - there is no index shortcut for 'how many', only for 'give me the next N' - compare both against a single keyset page fetch below to see the real cost difference. An infinite-scroll / 'load more' UI that never renders a total page count never needs to pay this cost at all.",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "count cost scenario failed");
    process.exit(1);
  });
}
