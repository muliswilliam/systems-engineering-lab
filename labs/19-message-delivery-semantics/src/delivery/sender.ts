import type { NetworkOutcome, NetworkScript } from "./network.js";
import { outcomeForAttempt } from "./network.js";

/**
 * What actually gets written to `delivery_log` for one attempt. Distinct
 * from `NetworkOutcome` on purpose: `NetworkOutcome` is the simulated
 * network's internal decision, `DeliveryOutcome` is the transport-level fact
 * this lab persists and later queries/asserts against.
 */
export type DeliveryOutcome = "sent_lost" | "delivered_ack_lost" | "delivered_acked";

export interface DeliveryAttempt {
  attemptNumber: number;
  outcome: DeliveryOutcome;
}

function toDeliveryOutcome(networkOutcome: NetworkOutcome): DeliveryOutcome {
  switch (networkOutcome) {
    case "message_lost":
      return "sent_lost";
    case "ack_lost":
      return "delivered_ack_lost";
    case "success":
      return "delivered_acked";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SendOnceOptions {
  networkOutcome: NetworkOutcome;
  /** Invoked only if the message actually reaches the receiver. */
  deliverToReceiver: () => Promise<void>;
}

/**
 * AT-MOST-ONCE delivery: send exactly one time, no retry, regardless of the
 * outcome. If `networkOutcome` is `"message_lost"`, `deliverToReceiver` is
 * never called and there is no second attempt to compensate - the message is
 * simply gone. This is the entire mechanism at-most-once.ts demonstrates.
 */
export async function sendOnce(opts: SendOnceOptions): Promise<DeliveryAttempt> {
  if (opts.networkOutcome === "message_lost") {
    return { attemptNumber: 1, outcome: "sent_lost" };
  }
  await opts.deliverToReceiver();
  return { attemptNumber: 1, outcome: toDeliveryOutcome(opts.networkOutcome) };
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: (attemptNumber: number) => number;
}

export interface SendWithRetryOptions {
  script: NetworkScript;
  /** Invoked once per attempt that actually reaches the receiver (i.e. every
   * attempt except a `"message_lost"` one). Receives the attempt number so
   * callers can log it. */
  deliverToReceiver: (attemptNumber: number) => Promise<void>;
  retry: RetryPolicy;
  /** Called synchronously after each attempt is decided, before the next
   * attempt (if any) - the caller uses this to persist the delivery_log row.
   * This keeps the retry mechanism itself free of any database concerns. */
  onAttempt: (attempt: DeliveryAttempt) => Promise<void>;
}

export interface SendWithRetryResult {
  attempts: DeliveryAttempt[];
  acked: boolean;
}

/**
 * AT-LEAST-ONCE delivery: retry, with backoff, until an acknowledgment is
 * received or `retry.maxAttempts` is exhausted. This is the ONE retry
 * mechanism shared, byte-for-byte, by both at-least-once.ts and
 * effectively-once.ts - per this lab's design, "effectively once" is not a
 * different (stronger) delivery mechanism, it is this exact same mechanism
 * plus an idempotent `deliverToReceiver`. Weakening or duplicating this
 * function anywhere would undermine the point of the lab.
 *
 * Whenever the network's outcome is `"ack_lost"`, `deliverToReceiver` still
 * runs - the receiver genuinely does the work - but the loop does not stop,
 * because from the sender's side an `"ack_lost"` attempt is indistinguishable
 * from a `"message_lost"` one: no acknowledgment arrived either way. That
 * indistinguishability is *why* retries can cause duplicate processing.
 */
export async function sendWithRetry(opts: SendWithRetryOptions): Promise<SendWithRetryResult> {
  const attempts: DeliveryAttempt[] = [];

  for (let attemptNumber = 1; attemptNumber <= opts.retry.maxAttempts; attemptNumber += 1) {
    const networkOutcome = outcomeForAttempt(opts.script, attemptNumber);

    let attempt: DeliveryAttempt;
    if (networkOutcome === "message_lost") {
      attempt = { attemptNumber, outcome: "sent_lost" };
    } else {
      await opts.deliverToReceiver(attemptNumber);
      attempt = { attemptNumber, outcome: toDeliveryOutcome(networkOutcome) };
    }

    attempts.push(attempt);
    await opts.onAttempt(attempt);

    if (attempt.outcome === "delivered_acked") {
      return { attempts, acked: true };
    }

    if (attemptNumber < opts.retry.maxAttempts) {
      await sleep(opts.retry.backoffMs(attemptNumber));
    }
  }

  return { attempts, acked: false };
}
