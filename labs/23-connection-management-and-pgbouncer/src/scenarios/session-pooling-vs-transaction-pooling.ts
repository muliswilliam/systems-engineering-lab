import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createLogger } from "@labs/logging";
import {
  sessionPoolingConnectionString,
  transactionPoolingConnectionString,
} from "../db/connections.js";

const log = createLogger("lab23:scenario:session-vs-transaction");

/**
 * The concrete session-state incompatibility CLAUDE.md's PgBouncer section
 * requires this lab teach: a client sets up some session-scoped Postgres
 * state, then later - in a separate round-trip - relies on that state still
 * being there.
 *
 * Two negative results found while building this scenario, both worth
 * knowing on their own:
 *
 * 1. `SET application_name = ...` is a BAD marker for this experiment.
 *    PgBouncer specifically tracks a handful of startup-style parameters
 *    (application_name among them) and silently replays them onto whichever
 *    real backend serves a client next, in every pool mode - so it looks
 *    "preserved" under transaction pooling even when the underlying backend
 *    actually changed. That hides the incompatibility rather than
 *    demonstrating it.
 *
 * 2. Using a FIXED name for a custom GUC / temp table / prepared statement
 *    across every trial produces false positives under transaction pooling.
 *    Because PgBouncer does not run a reset query between transactions in
 *    transaction-pool mode (by default that only happens for pool_mode=
 *    session), a backend can still be carrying a DIFFERENT earlier trial's
 *    identically-named leftover state. A later trial that happens to land
 *    on that same "dirty" backend would then find its own fixed-name marker
 *    already present - not because ITS state survived, but because someone
 *    else's did. Every trial below therefore uses a fresh, trial-unique
 *    identifier and checks for an EXACT match, not mere existence.
 *
 * With session pooling, the client keeps one real backend for its entire
 * client session, so all three kinds of state below always survive a later
 * round-trip. With transaction pooling, PgBouncer is free to hand the
 * client a different backend for its next statement once its previous
 * (implicit) transaction has committed - and once that happens, all three
 * fail with real, distinct Postgres errors (not silently wrong values):
 * `unrecognized configuration parameter`, `relation "..." does not exist`,
 * and `prepared statement "..." does not exist`. A burst of unrelated
 * "noise" clients between the setup and the check makes that backend
 * reassignment actually happen, instead of relying on luck.
 */

interface CheckResult {
  ok: boolean;
  error?: string;
}

interface Trial {
  poolMode: "session" | "transaction";
  backendPidBefore: number;
  backendPidAfter: number;
  sameBackend: boolean;
  customGuc: CheckResult;
  tempTable: CheckResult;
  preparedStatement: CheckResult;
  allPreserved: boolean;
}

async function runNoiseBurst(connectionString: string, count: number): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, async () => {
      const client = new Client({ connectionString });
      await client.connect();
      // Enough work that PgBouncer has to actually juggle its small backend
      // pool across this burst, instead of trivially reusing one backend.
      await client.query("select pg_sleep(0.05)");
      await client.end();
    }),
  );
}

async function tryCheck(run: () => Promise<void>): Promise<CheckResult> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function runTrial(
  poolMode: "session" | "transaction",
  connectionString: string,
  noiseClients: number,
): Promise<Trial> {
  // A fresh, trial-unique suffix (safe as a bare SQL identifier/literal
  // fragment: hex only, no quotes to escape) so this trial can never be
  // fooled by a different trial's leftover state on a reused backend.
  const marker = randomUUID().replace(/-/g, "");
  const tempTableName = `lab23_probe_${marker}`;
  const preparedStatementName = `lab23_stmt_${marker}`;
  const gucValue = `lab23-marker-${marker}`;

  const client = new Client({ connectionString });
  await client.connect();

  const backendPidBefore = (await client.query<{ pid: number }>("select pg_backend_pid() as pid"))
    .rows[0]!.pid;

  // Set up three kinds of session-scoped Postgres state, all in this first
  // round-trip, all under names/values unique to this trial.
  await client.query(`SET myapp.session_marker = '${gucValue}'`);
  await client.query(`CREATE TEMP TABLE ${tempTableName} (id int)`);
  await client.query(`INSERT INTO ${tempTableName} VALUES (1)`);
  await client.query(`PREPARE ${preparedStatementName} AS SELECT 1`);

  // A separate later round-trip, with real backend churn from other clients
  // happening in between - exactly the interleaving a busy application
  // would produce under real traffic.
  await runNoiseBurst(connectionString, noiseClients);

  const customGuc = await tryCheck(async () => {
    const { rows } = await client.query<Record<string, string>>("SHOW myapp.session_marker");
    const value = rows[0]?.["myapp.session_marker"];
    if (value !== gucValue) {
      throw new Error(`expected "${gucValue}", got "${String(value)}"`);
    }
  });
  const tempTable = await tryCheck(async () => {
    await client.query(`SELECT * FROM ${tempTableName}`);
  });
  const preparedStatement = await tryCheck(async () => {
    await client.query(`EXECUTE ${preparedStatementName}`);
  });

  const backendPidAfter = (await client.query<{ pid: number }>("select pg_backend_pid() as pid"))
    .rows[0]!.pid;

  await client.end();

  return {
    poolMode,
    backendPidBefore,
    backendPidAfter,
    sameBackend: backendPidBefore === backendPidAfter,
    customGuc,
    tempTable,
    preparedStatement,
    allPreserved: customGuc.ok && tempTable.ok && preparedStatement.ok,
  };
}

export interface SessionVsTransactionSummary {
  sessionTrials: Trial[];
  transactionTrials: Trial[];
  sessionPreservedCount: number;
  transactionPreservedCount: number;
}

export async function runSessionVsTransactionScenario(
  trialsPerMode = Number(process.env.SCENARIO_TRIALS ?? 5),
  noiseClients = Number(process.env.SCENARIO_NOISE_CLIENTS ?? 15),
): Promise<SessionVsTransactionSummary> {
  const sessionTrials: Trial[] = [];
  for (let i = 0; i < trialsPerMode; i += 1) {
    const trial = await runTrial("session", sessionPoolingConnectionString(), noiseClients);
    log.info({ trial: i, ...trial }, "session-pooling trial");
    sessionTrials.push(trial);
  }

  const transactionTrials: Trial[] = [];
  for (let i = 0; i < trialsPerMode; i += 1) {
    const trial = await runTrial("transaction", transactionPoolingConnectionString(), noiseClients);
    log.info({ trial: i, ...trial }, "transaction-pooling trial");
    transactionTrials.push(trial);
  }

  const summary: SessionVsTransactionSummary = {
    sessionTrials,
    transactionTrials,
    sessionPreservedCount: sessionTrials.filter((t) => t.allPreserved).length,
    transactionPreservedCount: transactionTrials.filter((t) => t.allPreserved).length,
  };

  log.info(
    {
      sessionPreservedCount: summary.sessionPreservedCount,
      sessionTotal: sessionTrials.length,
      transactionPreservedCount: summary.transactionPreservedCount,
      transactionTotal: transactionTrials.length,
    },
    "session-pooling-vs-transaction-pooling summary",
  );

  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSessionVsTransactionScenario()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      log.error({ err: error }, "scenario failed");
      process.exit(1);
    });
}
