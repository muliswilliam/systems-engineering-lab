/**
 * A real message broker (Kafka, RabbitMQ, SQS, ...) is deliberately out of
 * scope for this lab. Per CLAUDE.md's infrastructure-minimalism guidance, a
 * broker is only worth adding "for messaging labs where a real broker
 * materially improves the exercise" - Lab 17 (outbox workers with
 * `SKIP LOCKED`) is where a real publisher process and a real broker matter.
 * This lab's subject is the ATOMICITY of "did the business write and the
 * event-intent get recorded together" - the naive dual-write bug and the
 * outbox fix for it are both fully reproducible against an in-process stand-in
 * for "an unreliable network call to a broker," so that is what this module
 * is: `publishToBroker` simulates the call, with a configurable failure mode,
 * and nothing more.
 */

export interface BrokerEvent {
  eventType: string;
  aggregateType: string;
  aggregateId: number;
  payload: unknown;
}

export type BrokerFailureMode = "always" | "never";

export interface PublishToBrokerOptions {
  /** "always" simulates a broker/network call that fails every time (the
   * naive-dual-write-broker-fails scenario). "never" simulates a broker call
   * that always succeeds (every other scenario). Defaults to "never". */
  failureMode?: BrokerFailureMode;
  /** Simulated network latency in milliseconds - kept tiny by default so the
   * test suite stays fast, but nonzero so this reads as a real async call
   * rather than a synchronous no-op. */
  simulatedLatencyMs?: number;
}

export class BrokerPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerPublishError";
  }
}

/**
 * Stands in for "make a network call to a message broker." Real brokers fail
 * for all sorts of reasons the caller cannot control: the broker is down, the
 * network partitions, the request times out, the topic is over quota. None of
 * that is specific to any one broker product, so this function does not try
 * to imitate one - it just resolves or rejects, on a delay, exactly like a
 * real network call would look from the caller's point of view.
 */
export async function publishToBroker(
  event: BrokerEvent,
  options: PublishToBrokerOptions = {},
): Promise<void> {
  const { failureMode = "never", simulatedLatencyMs = 5 } = options;

  await new Promise((resolve) => setTimeout(resolve, simulatedLatencyMs));

  if (failureMode === "always") {
    throw new BrokerPublishError(
      `simulated broker publish failure for ${event.aggregateType}:${event.aggregateId} (${event.eventType})`,
    );
  }
}
