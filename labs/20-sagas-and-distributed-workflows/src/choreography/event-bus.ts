import type { Pool } from "pg";
import { insertSagaLog } from "../domain/saga-log.js";
import type { Direction } from "../domain/types.js";

export interface DomainEvent<T = Record<string, unknown>> {
  name: string;
  orderId: number;
  payload: T;
}

type Handler<T = Record<string, unknown>> = (event: DomainEvent<T>) => Promise<void>;

interface Subscription {
  consumerName: string;
  direction: Direction;
  handler: Handler;
}

/**
 * A deliberately minimal in-process event dispatcher - not a real message
 * queue/broker, per CLAUDE.md's infrastructure-minimalism guidance and the
 * brief's explicit scoping ("this does not need to be a real message
 * queue"). It exists only to let each step react to the event immediately
 * before it, with no central coordinator deciding what happens next - that
 * absence of a coordinator is the entire point of "choreography."
 *
 * Every `publish` and every `consume` (one per subscriber) writes its own
 * `saga_log` row. This is intentionally more log traffic than the
 * orchestrated saga produces for the identical business outcome - see
 * README "Observe" for the real counted numbers - because in choreography,
 * publishing an event and a handler reacting to it are two separate,
 * independently-observable things. There is no single place that logs "step
 * N happened" the way `runOrderSaga` does.
 */
export class EventBus {
  private readonly subscriptions = new Map<string, Subscription[]>();

  constructor(private readonly pool: Pool) {}

  on<T>(eventName: string, consumerName: string, direction: Direction, handler: Handler<T>): void {
    const list = this.subscriptions.get(eventName) ?? [];
    list.push({ consumerName, direction, handler: handler as Handler });
    this.subscriptions.set(eventName, list);
  }

  /**
   * Logs the publish, then awaits every subscriber's handler in turn
   * (logging its "consumed" row first). Because each handler `await`s its
   * own downstream `publish` calls before returning, awaiting this call
   * awaits the ENTIRE rest of the cascade - there is no separate queue or
   * poll loop needed for this in-process, single-consumer-per-event model.
   */
  async publish<T>(event: DomainEvent<T>, publishedBy: string, direction: Direction): Promise<void> {
    await insertSagaLog(this.pool, {
      orderId: event.orderId,
      mechanism: "choreography",
      stepName: event.name,
      direction,
      outcome: "published",
      detail: { publishedBy, payload: event.payload },
    });

    const subscribers = this.subscriptions.get(event.name) ?? [];
    for (const subscription of subscribers) {
      await insertSagaLog(this.pool, {
        orderId: event.orderId,
        mechanism: "choreography",
        stepName: event.name,
        direction: subscription.direction,
        outcome: "consumed",
        detail: { consumedBy: subscription.consumerName },
      });
      await subscription.handler(event as DomainEvent<Record<string, unknown>>);
    }
  }
}
