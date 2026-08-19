import type { Client } from "pg";
import { isPgError, sleep, DEADLOCK_DETECTED_SQLSTATE, type PgError } from "./support.js";

/** The minimal logging surface this module needs - avoids a direct `pino`
 * dependency in a lab package that otherwise only depends on `@labs/logging`. */
export interface LoggerLike {
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

export type LockOrderStrategy = "naive-lock-order" | "consistent-lock-order";

export interface LegPlan {
  workerLabel: "A" | "B";
  fromAccountId: number;
  toAccountId: number;
  amountCents: number;
  /** The row this leg locks FIRST, via `SELECT ... FOR UPDATE`. */
  firstLockId: number;
  /** The row this leg locks SECOND - the request that either blocks briefly
   * (consistent ordering) or forms a wait-for cycle (naive ordering). */
  secondLockId: number;
}

/**
 * THE CENTRAL DECISION. Same business operation - "transfer amountCents from
 * fromAccountId to toAccountId" - two different lock-acquisition policies:
 *
 * - `naive-lock-order`: lock the SOURCE account first, then the destination.
 *   This mirrors how a transfer function reads most naturally ("lock the
 *   account we're debiting, then the one we're crediting") - and is exactly
 *   why it is a realistic bug, not a contrived one. Two transfers in
 *   OPPOSITE directions between the same two accounts then lock in OPPOSITE
 *   orders, which is the entire cause of the deadlock.
 * - `consistent-lock-order`: lock whichever account has the LOWER id first,
 *   REGARDLESS of transfer direction. Every transaction touching these two
 *   accounts - no matter which way the money is moving - agrees on the same
 *   acquisition order, so a cycle can never form: at most one side ever
 *   waits, and it waits for a lock that will definitely be released, not one
 *   that is waiting right back on it.
 */
export function planLeg(
  strategy: LockOrderStrategy,
  workerLabel: "A" | "B",
  fromAccountId: number,
  toAccountId: number,
  amountCents: number,
): LegPlan {
  if (strategy === "naive-lock-order") {
    return { workerLabel, fromAccountId, toAccountId, amountCents, firstLockId: fromAccountId, secondLockId: toAccountId };
  }
  const firstLockId = Math.min(fromAccountId, toAccountId);
  const secondLockId = Math.max(fromAccountId, toAccountId);
  return { workerLabel, fromAccountId, toAccountId, amountCents, firstLockId, secondLockId };
}

export interface LegOutcome {
  workerLabel: "A" | "B";
  status: "committed" | "deadlock_aborted" | "failed";
  sqlstate?: string;
  message?: string;
  detail?: string;
  hint?: string;
  attempts: number;
}

export interface Rendezvous {
  arriveAndWaitForPeer: () => Promise<void>;
}

/**
 * Runs ONE attempt of a transfer leg: BEGIN, lock `firstLockId`, optionally
 * rendezvous with the peer leg (this is where both sides are made to arrive
 * at "I've taken my first lock" before either requests its second - the
 * explicit synchronization CLAUDE.md requires instead of a sleep), lock
 * `secondLockId`, apply both balance updates, COMMIT.
 *
 * On ANY error, issues a `ROLLBACK` before rethrowing - once Postgres aborts
 * a transaction (a real deadlock victim gets exactly this), the session
 * stays in "current transaction is aborted" state until an explicit
 * `ROLLBACK`, the same as any other mid-transaction error.
 */
export async function runLegAttempt(client: Client, plan: LegPlan, rendezvous?: Rendezvous): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [plan.firstLockId]);
    if (rendezvous) {
      await rendezvous.arriveAndWaitForPeer();
    }
    await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [plan.secondLockId]);
    await client.query("UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2", [
      plan.amountCents,
      plan.fromAccountId,
    ]);
    await client.query("UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2", [
      plan.amountCents,
      plan.toAccountId,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function toOutcome(workerLabel: "A" | "B", attempts: number, error: PgError): LegOutcome {
  return {
    workerLabel,
    status: error.code === DEADLOCK_DETECTED_SQLSTATE ? "deadlock_aborted" : "failed",
    sqlstate: error.code,
    message: error.message,
    detail: error.detail,
    hint: error.hint,
    attempts,
  };
}

/**
 * Runs a transfer leg exactly once (no retry) - used by the naive-deadlock
 * reproduction and by the consistent-ordering fix, both of which want to
 * observe the OUTCOME of a single real attempt, not a recovered one.
 * `rendezvous` is only meaningful on this single attempt.
 */
export async function runLegSingleAttempt(client: Client, plan: LegPlan, rendezvous?: Rendezvous): Promise<LegOutcome> {
  try {
    await runLegAttempt(client, plan, rendezvous);
    return { workerLabel: plan.workerLabel, status: "committed", attempts: 1 };
  } catch (error) {
    if (isPgError(error)) {
      return toOutcome(plan.workerLabel, 1, error);
    }
    throw error;
  }
}

/**
 * THE RECOVERY (not prevention) mitigation: if a leg's first attempt is
 * aborted with a real SQLSTATE 40P01, back off a short randomized interval
 * and retry as an ORDINARY transaction (no rendezvous - the peer leg that
 * "won" the original deadlock has already committed and moved on, so there
 * is nothing left to synchronize with on retry). Bounded by `maxAttempts`.
 *
 * Explicitly NOT the same mechanism as Lab 09's Serializable-retry loop:
 * Lab 09 retries because SERIALIZABLE's SSI detected a dangerous READ/WRITE
 * dependency that could violate a cross-row invariant under concurrent
 * access - a correctness concern that exists even with only ONE lock ever
 * taken per row. This lab's deadlock has nothing to do with isolation level
 * (it happens under the default READ COMMITTED) and everything to do with
 * TWO transactions each holding a lock the other one is blocked waiting for,
 * in a cycle - a pure lock-ORDERING problem. Retrying recovers from a
 * deadlock exactly the way it recovers from a transient network blip: it
 * does nothing to stop the cycle from forming again next time two
 * conflicting transfer directions race - only consistent lock ordering does
 * that. See this lab's README "Fix it" for the full comparison.
 */
export async function runLegWithRetry(
  client: Client,
  plan: LegPlan,
  options: { rendezvousForFirstAttempt?: Rendezvous; maxAttempts?: number; log?: LoggerLike } = {},
): Promise<LegOutcome> {
  const maxAttempts = options.maxAttempts ?? 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runLegAttempt(client, plan, attempt === 1 ? options.rendezvousForFirstAttempt : undefined);
      return { workerLabel: plan.workerLabel, status: "committed", attempts: attempt };
    } catch (error) {
      if (!isPgError(error)) {
        throw error;
      }
      const outcome = toOutcome(plan.workerLabel, attempt, error);
      const isRetryableDeadlock = error.code === DEADLOCK_DETECTED_SQLSTATE && attempt < maxAttempts;
      options.log?.warn(
        { workerLabel: plan.workerLabel, attempt, sqlstate: error.code, retrying: isRetryableDeadlock },
        isRetryableDeadlock ? "deadlock victim - backing off and retrying" : "leg failed, not retrying",
      );
      if (!isRetryableDeadlock) {
        return outcome;
      }
      await sleep(20 + Math.random() * 60);
    }
  }
  throw new Error("runLegWithRetry: exhausted attempts without returning - unreachable");
}
