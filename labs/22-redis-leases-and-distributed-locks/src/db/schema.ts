import { pgTable, bigint, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A fresh, self-contained schema (independent of every other lab, per the
 * independent-labs principle) for a single shared mutable resource that
 * multiple "workers" (independent processes/connections) coordinate write
 * access to via a Redis lock before writing.
 *
 * `fencing_token` is the whole point of this lab's fix (src/redis-lock/
 * fencing-token.ts): a monotonically increasing number handed out by Redis
 * at lock-acquisition time, recorded here so a conditional `UPDATE ...
 * WHERE fencing_token < $1` (the exact conditional-write pattern Lab 11
 * teaches) can reject a write from a stale lock holder even when that
 * holder's own lock-expiry detection never fired. `last_writer` and
 * `updated_at` exist purely so the lease-expiry-bug and fencing-token
 * scenarios have something observable to disagree about.
 */
export const resourceState = pgTable("resource_state", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull().unique(),
  fencingToken: bigint("fencing_token", { mode: "number" }).notNull().default(0),
  lastWriter: text("last_writer"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
