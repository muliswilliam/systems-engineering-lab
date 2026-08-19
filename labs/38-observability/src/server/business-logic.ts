import type { Logger } from "pino";
import type { OrderRow } from "./order-queries.js";

export interface OrderView {
  publicId: string;
  amountCents: number;
  status: string;
  emailDomain: string;
}

/**
 * The "business logic" step of this lab's HTTP -> business logic ->
 * database -> response trace. Derives `emailDomain` from `customerEmail`
 * WITHOUT a null check - a real, realistic bug: `orders.customer_email` is
 * nullable for guest checkouts (see `src/db/schema.ts`), and this line was
 * written against "normal" test data that never happened to include one.
 * It throws a genuine `TypeError` for exactly those rows, which is this
 * lab's entire "error" traffic bucket - not a fake injected exception, an
 * actual missed edge case, exactly the kind structured logs + a
 * correlation ID exist to help diagnose after the fact.
 */
export function buildOrderView(order: OrderRow, log: Logger): OrderView {
  log.info({ step: "business_logic.start" }, "business logic start");
  const start = performance.now();

  const emailDomain = order.customerEmail!.split("@")[1]!.toLowerCase();

  const view: OrderView = {
    publicId: order.publicId,
    amountCents: order.amountCents,
    status: order.status,
    emailDomain,
  };

  const durationMs = performance.now() - start;
  log.info({ step: "business_logic.end", durationMs: Number(durationMs.toFixed(2)) }, "business logic end");
  return view;
}
