import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check, jsonb } from "drizzle-orm/pg-core";

/**
 * Order-lifecycle saga domain, fresh and self-contained for this lab (no
 * import from any other lab's schema, per CLAUDE.md's independent-labs
 * principle). Each table below stands in for a bounded context that, in a
 * real distributed system, would be a separate service with its own
 * database - here they are plain tables in one Postgres instance, per
 * CLAUDE.md's infrastructure-minimalism guidance ("this is a
 * single-Postgres-database lab, not a real multi-service distributed
 * system").
 *
 * Forward flow:  createOrder -> reserveInventory -> capturePayment -> createShipment
 * On failure, compensations run in REVERSE order of whichever forward steps
 * already succeeded: refundPayment -> releaseInventory -> cancelOrder.
 * `createShipment` is the last forward step and never itself needs undoing -
 * if it fails, there is nothing downstream of it to compensate for.
 */

/**
 * `status`:
 *   - `pending`   the saga has started but not yet reached a terminal state.
 *   - `completed` all four forward steps succeeded; the order shipped.
 *   - `cancelled` a later step failed and compensation ran; this order will
 *                 never ship. (A distinct `failed` status was deliberately
 *                 NOT added - see README "Architecture": once compensation
 *                 finishes, the order's business meaning is "this order was
 *                 cancelled," not "this order is broken.")
 */
export const orders = pgTable(
  "orders",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    customerName: text("customer_name").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("orders_amount_cents_positive", sql`${table.amountCents} > 0`),
    check("orders_status_valid", sql`${table.status} in ('pending', 'completed', 'cancelled')`),
  ],
);

/**
 * A small, fixed catalog (see src/seed/seed.ts) - deliberately not a
 * dynamic/faker-generated product list, per the brief's "seed a small fixed
 * inventory catalog."
 */
export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sku: text("sku").notNull().unique(),
    name: text("name").notNull(),
    availableQuantity: integer("available_quantity").notNull(),
  },
  (table) => [check("inventory_items_available_quantity_non_negative", sql`${table.availableQuantity} >= 0`)],
);

/**
 * `status`:
 *   - `reserved` inventory was decremented and is held against this order.
 *   - `released` the compensating `releaseInventory` step returned the
 *                 quantity to `inventory_items.available_quantity`.
 */
export const inventoryReservations = pgTable(
  "inventory_reservations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: bigint("order_id", { mode: "number" })
      .notNull()
      .references(() => orders.id),
    itemId: bigint("item_id", { mode: "number" })
      .notNull()
      .references(() => inventoryItems.id),
    quantity: integer("quantity").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("inventory_reservations_quantity_positive", sql`${table.quantity} > 0`),
    check("inventory_reservations_status_valid", sql`${table.status} in ('reserved', 'released')`),
  ],
);

/**
 * `status`:
 *   - `captured` payment was taken.
 *   - `refunded` the compensating `refundPayment` step reversed it.
 */
export const payments = pgTable(
  "payments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: bigint("order_id", { mode: "number" })
      .notNull()
      .references(() => orders.id),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("payments_amount_cents_positive", sql`${table.amountCents} > 0`),
    check("payments_status_valid", sql`${table.status} in ('captured', 'refunded')`),
  ],
);

/**
 * `createShipment` is the last forward step and is never compensated -
 * either it fails (no row is ever inserted) or it succeeds (the order has
 * shipped and there is nothing left to undo). `status` therefore only ever
 * takes one value, kept as a column (rather than hard-coded) so a later
 * lab/extension could add carrier-cancellation semantics without a schema
 * change.
 */
export const shipments = pgTable(
  "shipments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: bigint("order_id", { mode: "number" })
      .notNull()
      .references(() => orders.id),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("shipments_status_valid", sql`${table.status} in ('created')`)],
);

/**
 * The primary observability artifact this lab is built around (see
 * README "Observe"). Every attempted step - orchestrated or
 * choreographed, forward or compensating, successful or failed - writes
 * exactly one row here per action:
 *
 *   - `mechanism`  which implementation produced this row: 'orchestration'
 *                  (a central coordinator calling each step directly) or
 *                  'choreography' (a step reacting to an event, with no
 *                  coordinator). Not part of the brief's literal column
 *                  list, added because it is what makes the two
 *                  mechanisms' logs directly comparable with a single
 *                  `WHERE mechanism = ...` (see README "Architecture" for
 *                  why this is a deliberate, documented deviation).
 *   - `step_name`  for orchestration: the business step name
 *                  (`createOrder`, `reserveInventory`, ..., `cancelOrder`,
 *                  ...). For choreography: the event name being
 *                  published/consumed (`OrderCreated`, `PaymentFailed`,
 *                  ...) OR the business step name for the row logging the
 *                  step's own outcome - see README for the full shape.
 *   - `direction`  'forward' (part of the happy-path chain) or
 *                  'compensate' (part of undoing a partially-completed
 *                  saga).
 *   - `outcome`    'success' / 'failure' for a business step's own
 *                  outcome; 'published' / 'consumed' for a choreography
 *                  event hop. Kept as one text column (not two booleans)
 *                  so a single `GROUP BY outcome` shows the full mix.
 *   - `detail`     free-form jsonb - reservation/payment ids, quantities,
 *                  failure reasons, and (choreography only) which service
 *                  published or consumed the event.
 */
export const sagaLog = pgTable(
  "saga_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: bigint("order_id", { mode: "number" }).references(() => orders.id),
    mechanism: text("mechanism").notNull(),
    stepName: text("step_name").notNull(),
    direction: text("direction").notNull(),
    outcome: text("outcome").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    detail: jsonb("detail").notNull().default({}),
  },
  (table) => [
    check("saga_log_mechanism_valid", sql`${table.mechanism} in ('orchestration', 'choreography')`),
    check("saga_log_direction_valid", sql`${table.direction} in ('forward', 'compensate')`),
    check(
      "saga_log_outcome_valid",
      sql`${table.outcome} in ('success', 'failure', 'published', 'consumed')`,
    ),
  ],
);
