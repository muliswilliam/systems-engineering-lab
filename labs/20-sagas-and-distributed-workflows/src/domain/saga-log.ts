import type { Pool, PoolClient } from "pg";
import type { Direction, Mechanism } from "./types.js";

export interface SagaLogInput {
  orderId: number | null;
  mechanism: Mechanism;
  stepName: string;
  direction: Direction;
  outcome: "success" | "failure" | "published" | "consumed";
  detail?: Record<string, unknown>;
}

/**
 * Writes one `saga_log` row. Accepts either a `PoolClient` (so the log entry
 * commits atomically with the business write it describes, inside the same
 * transaction) or a bare `Pool` (for a failure log written as its own,
 * separate statement *after* a `ROLLBACK` has already discarded the
 * transaction that attempted the step - the same "audit row outside the
 * failed transaction" pattern Lab 05 uses, because a row inserted inside a
 * transaction that then rolls back would itself disappear).
 */
export async function insertSagaLog(queryable: Pool | PoolClient, input: SagaLogInput): Promise<void> {
  await queryable.query(
    `INSERT INTO saga_log (order_id, mechanism, step_name, direction, outcome, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.orderId,
      input.mechanism,
      input.stepName,
      input.direction,
      input.outcome,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}
