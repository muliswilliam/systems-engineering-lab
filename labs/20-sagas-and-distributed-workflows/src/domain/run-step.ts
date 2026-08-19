import type { Pool, PoolClient } from "pg";
import { insertSagaLog } from "./saga-log.js";
import type { Direction, Mechanism, StepOutcome } from "./types.js";
import { SagaStepError } from "./types.js";

export interface RunStepParams<T> {
  orderId: number;
  mechanism: Mechanism;
  stepName: string;
  direction: Direction;
  /** When true, the step throws before doing any business write - modeling
   * "this step's own attempt was rejected" (e.g. the carrier API declined
   * the shipment), not a mid-step crash. See README "Architecture" for why
   * this lab injects failures this way. */
  simulateFailure?: boolean;
  simulatedFailureMessage?: string;
  detail?: Record<string, unknown>;
  work: (client: PoolClient) => Promise<T>;
}

/**
 * Shared plumbing behind every forward and compensating step in this lab:
 * one small transaction per step (never the whole saga in one transaction -
 * see README "Architecture"), a `saga_log` row written atomically with the
 * step's own business write on success, and a separate `saga_log` row
 * written *after* `ROLLBACK` on failure (a row inside the rolled-back
 * transaction would not survive it - the same reasoning as Lab 05's
 * `failed` audit insert).
 */
export async function runStep<T>(pool: Pool, params: RunStepParams<T>): Promise<StepOutcome<T>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (params.simulateFailure) {
      throw new SagaStepError(
        params.stepName as never,
        params.simulatedFailureMessage ?? `simulated failure at step "${params.stepName}"`,
      );
    }

    const result = await params.work(client);

    await insertSagaLog(client, {
      orderId: params.orderId,
      mechanism: params.mechanism,
      stepName: params.stepName,
      direction: params.direction,
      outcome: "success",
      detail: params.detail,
    });

    await client.query("COMMIT");
    return { failed: false, result };
  } catch (error) {
    await client.query("ROLLBACK");
    const reason = error instanceof Error ? error.message : String(error);

    await insertSagaLog(pool, {
      orderId: params.orderId,
      mechanism: params.mechanism,
      stepName: params.stepName,
      direction: params.direction,
      outcome: "failure",
      detail: { ...params.detail, reason },
    });

    return { failed: true, reason };
  } finally {
    client.release();
  }
}
