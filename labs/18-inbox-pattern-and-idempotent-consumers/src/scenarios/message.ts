import { randomUUID } from "node:crypto";

/**
 * The simulated incoming message. Per CLAUDE.md's infrastructure-minimalism
 * guidance and this lab's brief, there is no real broker here - "the
 * queue" is just a plain array/generator of these objects, handed directly
 * to a consumer function. Each message models a `CreditApplied` event: some
 * upstream system (conceptually Lab 17's outbox publishers) decided account
 * `accountId` should be credited `amountCents`, and gave the event a unique
 * `messageId`.
 *
 * At-least-once delivery means the SAME `messageId` can be handed to a
 * consumer more than once - sequentially (a publisher retries because it
 * never saw the ack) or concurrently (two publisher workers, or two
 * replicas of the same consumer, both pick up the same redelivered message
 * at the same time). Both delivery patterns are exercised in this lab's
 * scenarios and tests.
 */
export interface CreditAppliedMessage {
  messageId: string;
  accountId: number;
  amountCents: number;
}

export function makeCreditAppliedMessage(accountId: number, amountCents: number): CreditAppliedMessage {
  return { messageId: randomUUID(), accountId, amountCents };
}

/** Redelivers the exact same message `count` times - simulating an
 * at-least-once broker/outbox handing the identical event back to the
 * consumer more than once. */
export function redeliver(message: CreditAppliedMessage, count: number): CreditAppliedMessage[] {
  return Array.from({ length: count }, () => message);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
