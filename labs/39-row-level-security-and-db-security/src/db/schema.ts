import { pgTable, bigint, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * A fresh, independent multi-tenant SaaS-style domain - not one of
 * SPEC.md 8.2's five named domains (payroll/ticketing/commerce/banking/
 * background-processing). A support-ticketing helpdesk is a realistic,
 * believable place for a "forgot the tenant filter" bug: an admin/debug
 * endpoint that lists tickets, a background digest job, a search
 * endpoint - all classic places a `WHERE tenant_id = ?` clause gets
 * dropped by accident. See README "Architecture" for the full reasoning.
 *
 * Multi-tenancy model: SHARED SCHEMA, SHARED TABLES, a `tenant_id` column
 * on every tenant-scoped row - the realistic model most real SaaS
 * products actually use (not schema-per-tenant or database-per-tenant),
 * per this lab's brief. Row-Level Security policies (added in migration
 * 0001, hand-written raw SQL - see that migration's own comment for why
 * this cannot be expressed as Drizzle `pgTable()` config) are what turn
 * that shared `tenant_id` column into a database-ENFORCED boundary
 * instead of a convention application code has to remember.
 */

export const tenants = pgTable("tenants", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supportTickets = pgTable(
  "support_tickets",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    tenantId: bigint("tenant_id", { mode: "number" })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Every tenant-scoped query in this lab (application code's own
    // WHERE clause, AND the RLS policy's implicit one) filters on
    // tenant_id, so this index is what keeps both the naive-but-correct
    // query and the RLS-enforced query from degrading to a sequential
    // scan as the table grows - see scenario:performance and README
    // "Tradeoffs" for the real measured effect of this index existing.
    tenantIdIdx: index("support_tickets_tenant_id_idx").on(table.tenantId),
  }),
);
