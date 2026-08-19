import type { NodeChoice, OperationKind } from "./types.js";

/**
 * The BUG, distilled to one function: a naive router that only ever thinks
 * about "is this a write or a read." Every kind of read - ordinary,
 * read-after-write, and even the read inside what should be a transaction -
 * is treated identically and sent to the replica. This is exactly how these
 * bugs happen in practice: a developer writes `if (isWrite) primary else
 * replica` and never separately considers "but what if this read needs to
 * see a write I JUST made?"
 *
 * The "transaction" row is deliberately wrong here too, not because a naive
 * developer set out to route transactions to the replica on purpose, but
 * because a router this naive has no separate transaction concept at all -
 * anything that starts with a read falls through the same `replica` branch.
 * See src/scenarios/transaction-must-run-on-primary.ts for the real,
 * Postgres-verified consequence of that (SQLSTATE 25006 the moment the
 * transaction's SELECT ... FOR UPDATE runs against the replica).
 */
export function classifyNaive(kind: OperationKind): NodeChoice {
  switch (kind) {
    case "write":
      return "primary";
    case "read":
    case "read-after-write":
    case "transaction":
      return "replica";
  }
}

/**
 * The FIX: classify every operation kind explicitly instead of collapsing
 * "read" into one bucket. Only genuinely ordinary reads go to the replica -
 * everything that needs to see the state of a write in the same logical
 * operation, or that IS a write, goes to the primary.
 */
export function classifyCorrected(kind: OperationKind): NodeChoice {
  switch (kind) {
    case "write":
    case "read-after-write":
    case "transaction":
      return "primary";
    case "read":
      return "replica";
  }
}
