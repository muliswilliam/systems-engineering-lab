/**
 * Simulated in-process message broker.
 *
 * Scoping decision (CLAUDE.md "Technology Defaults": "Only introduce
 * additional infrastructure when the lab actually needs it"): this lab's
 * entire lesson is about the CLAIM side of publishing (`SELECT ... FOR
 * UPDATE SKIP LOCKED`) and the fact that a safe claim does not make delivery
 * exactly-once. A real broker (Kafka/SQS/RabbitMQ/etc.) would add topics,
 * connection management, and ack semantics that are irrelevant to that
 * lesson and would make the duplicate-delivery demonstration harder to see,
 * not easier - a plain async function that records every call it received
 * is sufficient to prove `publishToBroker` was invoked twice for the same
 * event. If a later lab needs real broker semantics (Lab 19 - message
 * delivery semantics - is the natural place), it can introduce one then.
 */
export interface BrokerEvent {
  publicId: string;
  eventType: string;
  payload: unknown;
}

export type BrokerMode = "succeed" | "fail" | "slow";

export interface SimulatedBroker {
  publish(event: BrokerEvent): Promise<void>;
  /** How many times `publish` was called for this exact public_id - this is
   * the number the crashed-publisher scenario proves is 2, not 1. */
  callCountFor(publicId: string): number;
  /** Total publish calls across every event, regardless of outcome. */
  totalCalls(): number;
  /** Every event that the broker successfully "received" (mode !== "fail"),
   * in call order - duplicates included. */
  deliveries: BrokerEvent[];
}

export interface SimulatedBrokerOptions {
  mode?: BrokerMode;
  /** Delay used when `mode === "slow"`. */
  slowMs?: number;
}

export function createSimulatedBroker(options: SimulatedBrokerOptions = {}): SimulatedBroker {
  const callCounts = new Map<string, number>();
  const deliveries: BrokerEvent[] = [];
  let calls = 0;

  return {
    async publish(event) {
      calls += 1;
      callCounts.set(event.publicId, (callCounts.get(event.publicId) ?? 0) + 1);

      if (options.mode === "slow") {
        await new Promise((resolve) => setTimeout(resolve, options.slowMs ?? 200));
      }
      if (options.mode === "fail") {
        throw new Error(`simulated broker failure publishing ${event.publicId}`);
      }

      // The broker "genuinely received" the event - this line running is the
      // whole point of the crashed-publisher demonstration: it runs TWICE.
      deliveries.push(event);
    },
    callCountFor(publicId) {
      return callCounts.get(publicId) ?? 0;
    },
    totalCalls() {
      return calls;
    },
    deliveries,
  };
}
