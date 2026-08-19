import { Client } from "pg";
import { sleep } from "./support.js";

/**
 * Waits (by polling, not by guessing a fixed delay) until a specific backend
 * PID's `pg_stat_activity.wait_event_type` reports `'Lock'` - i.e. until that
 * backend is genuinely, currently blocked waiting to acquire a lock. Used to
 * know PRECISELY when it is safe to capture a `pg_locks` snapshot that will
 * actually show the wait, instead of a fixed sleep that might fire too early
 * (nothing waiting yet) or too late (Postgres's deadlock detector has already
 * killed one side).
 */
export async function waitUntilWaitingOnLock(
  observer: Client,
  pid: number,
  timeoutMs = 2_000,
  pollMs = 5,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (rows[0]?.wait_event_type === "Lock") {
      return true;
    }
    await sleep(pollMs);
  }
  return false;
}

export interface BlockedQueryEdge {
  waitingPid: number;
  waitingQuery: string;
  blockedByPid: number;
  blockedByQuery: string;
}

/**
 * Adapted from `packages/db-utils/sql/show-blocked-queries.sql` (see that
 * file for the general "who is blocking whom" version this lab reuses,
 * unmodified in spirit), scoped here to a specific set of backend pids. This
 * one query IS the deadlock-cycle diagnostic: when run while a genuine 2-way
 * deadlock is forming, it returns TWO edges - pid A waiting on pid B, AND pid
 * B waiting on pid A - which together are the wait-for cycle itself. No
 * separate "cycle detection" query is needed for this lab's 2-transaction
 * case; the general blocked-queries query already surfaces the cycle the
 * moment both sides are waiting on each other, because each row IS one edge
 * of the graph and a 2-cycle is just two edges pointing at each other.
 */
export async function snapshotBlockedQueryEdges(observer: Client, pids: number[]): Promise<BlockedQueryEdge[]> {
  const { rows } = await observer.query<{
    waiting_pid: number;
    waiting_query: string;
    blocked_by_pid: number;
    blocked_by_query: string;
  }>(
    `SELECT
       blocked.pid AS waiting_pid,
       left(blocked_activity.query, 160) AS waiting_query,
       blocking.pid AS blocked_by_pid,
       left(blocking_activity.query, 160) AS blocked_by_query
     FROM pg_locks blocked
     JOIN pg_stat_activity blocked_activity ON blocked_activity.pid = blocked.pid
     JOIN pg_locks blocking
       ON blocking.locktype = blocked.locktype
       AND blocking.database IS NOT DISTINCT FROM blocked.database
       AND blocking.relation IS NOT DISTINCT FROM blocked.relation
       AND blocking.page IS NOT DISTINCT FROM blocked.page
       AND blocking.tuple IS NOT DISTINCT FROM blocked.tuple
       AND blocking.transactionid IS NOT DISTINCT FROM blocked.transactionid
       AND blocking.pid <> blocked.pid
       AND blocking.granted
     JOIN pg_stat_activity blocking_activity ON blocking_activity.pid = blocking.pid
     WHERE NOT blocked.granted
       AND blocked.pid = ANY($1::int[])
     ORDER BY blocked.pid`,
    [pids],
  );

  return rows.map((r) => ({
    waitingPid: r.waiting_pid,
    waitingQuery: r.waiting_query,
    blockedByPid: r.blocked_by_pid,
    blockedByQuery: r.blocked_by_query,
  }));
}

/** True iff the edge set forms a 2-cycle between exactly these two pids:
 * pidA waits on pidB AND pidB waits on pidA. */
export function isTwoCycleBetween(edges: BlockedQueryEdge[], pidA: number, pidB: number): boolean {
  const aWaitsOnB = edges.some((e) => e.waitingPid === pidA && e.blockedByPid === pidB);
  const bWaitsOnA = edges.some((e) => e.waitingPid === pidB && e.blockedByPid === pidA);
  return aWaitsOnB && bWaitsOnA;
}
