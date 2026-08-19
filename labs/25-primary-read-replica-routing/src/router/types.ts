/**
 * Every database operation this lab's router handles falls into exactly one
 * of these four kinds. The whole lesson is that the correct node for each
 * kind is a FACT about Postgres/replication, not a matter of taste:
 *
 * - "write"            - any INSERT/UPDATE/DELETE. Only the primary accepts
 *                         writes at all (a replica returns SQLSTATE 25006).
 * - "read"              - an ordinary read that does not need to see the
 *                          effect of a write this same request just made
 *                          (e.g. browsing a product catalog). Safe to route
 *                          to the replica to offload the primary.
 * - "read-after-write"  - a read that MUST see the effect of a write the
 *                          same logical operation just performed (e.g.
 *                          "show the user the price they just changed").
 *                          The replica may not have replayed that write yet.
 * - "transaction"       - a read and a write (or multiple statements) that
 *                          must be atomic and mutually consistent. Postgres
 *                          transactions are a single-connection concept -
 *                          there is no such thing as one transaction that
 *                          spans two different server processes.
 */
export type OperationKind = "write" | "read" | "read-after-write" | "transaction";

export type NodeChoice = "primary" | "replica";
