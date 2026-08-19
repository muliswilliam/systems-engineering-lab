import type { Pool } from "pg";

/**
 * This lab's data is generated with `placed_at` values relative to "now"
 * (see `@labs/data-generators`'s `generateOrdersBatched`, `faker.date.past({
 * years: 1 })`), so hardcoding a calendar date would silently stop matching
 * anything a year after this lab was written. These helpers pick a real
 * window FROM the actual seeded data instead, the same "pick real IDs, not
 * hardcoded ones" discipline Lab 04's `sample-ids.ts` uses.
 */

export interface DateRangeWindow {
  start: Date;
  end: Date;
}

/**
 * A ~7-day window roughly in the middle of the seeded placed_at range -
 * used by Pattern 2's join+range query. 7 days (not 30) is a deliberate
 * choice, found empirically during this lab's own development: at this
 * dataset's scale, a 30-day window matches too many orders (~9,000) for the
 * cost-based planner to prefer a Nested Loop against `order_lines` even
 * with `idx_order_lines_order_id` present - a Hash Join with one full scan
 * of `order_lines` genuinely IS cheaper at that cardinality, and the join
 * strategy doesn't change at all (only the `orders`-side scan does). A
 * narrower, more realistic "one week of order activity" window yields
 * ~2,000 matching orders, small enough that the planner genuinely switches
 * `order_lines` from a Seq Scan to a per-order Nested Loop + Index Scan
 * using `idx_order_lines_order_id` - see README "Break it" / "Fix it" for
 * the real numbers this produces, INCLUDING the honest nuance that total
 * buffer touches can go UP under the indexed plan while wall-clock time
 * still goes DOWN (sequential vs. random I/O are not equally expensive per
 * buffer).
 */
export async function pickMiddleWeekWindow(pool: Pool): Promise<DateRangeWindow> {
  const result = await pool.query<{ min_placed_at: Date; max_placed_at: Date }>(
    "SELECT min(placed_at) AS min_placed_at, max(placed_at) AS max_placed_at FROM orders",
  );
  const row = result.rows[0];
  if (!row?.min_placed_at || !row?.max_placed_at) {
    throw new Error("no orders found - run `pnpm seed` first");
  }
  const totalMs = row.max_placed_at.getTime() - row.min_placed_at.getTime();
  const start = new Date(row.min_placed_at.getTime() + totalMs / 2);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start, end };
}

export interface MonthBucket {
  /**
   * Canonical text, e.g. "2026-05-01T00:00:00" - NO timezone suffix.
   * Deliberately returned as TEXT, not a JS `Date`: node-pg parses a
   * Postgres `timestamp without time zone` value (which is exactly what
   * `date_trunc('month', placed_at AT TIME ZONE 'UTC')` produces) using the
   * HOST's local timezone, not UTC - on a host whose local timezone isn't
   * UTC, round-tripping that value through a `Date` object and back would
   * silently shift it by the host's UTC offset (a real bug this lab's own
   * development hit: a UTC+3 host turned "2026-05-01 00:00:00" into a `Date`
   * for "2026-04-30T21:00:00Z"). Binding this string directly as a query
   * parameter against a `timestamp` (no zone) target lets Postgres parse it
   * literally, with no timezone involved at all - safe on any host.
   */
  monthStartText: string;
  /** Same text convention as monthStartText, one calendar month later. */
  monthEndText: string;
  orderCount: number;
}

/**
 * The single calendar month (by
 * date_trunc('month', placed_at AT TIME ZONE 'UTC') - the same expression
 * `idx_orders_month_expr` indexes) with the most orders - used by Pattern
 * 3's naive/fixed queries so the demo always has a comfortable number of
 * matching rows. All date math happens in SQL; only pre-formatted text
 * leaves the database (see MonthBucket's doc comment for why).
 */
export async function pickBusiestMonth(pool: Pool): Promise<MonthBucket> {
  const result = await pool.query<{ month_start_text: string; month_end_text: string; order_count: string }>(
    `SELECT
       to_char(month_start, 'YYYY-MM-DD"T"HH24:MI:SS') AS month_start_text,
       to_char(month_start + interval '1 month', 'YYYY-MM-DD"T"HH24:MI:SS') AS month_end_text,
       order_count
     FROM (
       SELECT date_trunc('month', placed_at AT TIME ZONE 'UTC') AS month_start, count(*) AS order_count
       FROM orders
       GROUP BY 1
     ) buckets
     ORDER BY order_count DESC
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("no orders found - run `pnpm seed` first");
  }
  return { monthStartText: row.month_start_text, monthEndText: row.month_end_text, orderCount: Number(row.order_count) };
}

/**
 * Appends an explicit UTC designator so a MonthBucket's text can ALSO be
 * bound safely against a `timestamptz` target (e.g. the raw `placed_at`
 * column in Pattern 3 Fix B's rewritten range query) - the explicit 'Z'
 * means Postgres interprets it as an absolute UTC instant regardless of the
 * session's `timezone` setting, instead of (wrongly) treating it as
 * session-local wall-clock time.
 */
export function asUtcInstant(monthBucketText: string): string {
  return `${monthBucketText}Z`;
}
