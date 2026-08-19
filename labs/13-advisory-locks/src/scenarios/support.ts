import { Client } from "pg";

/**
 * These scenarios deliberately do NOT use Drizzle or the shared `pg.Pool`
 * from src/db/client.ts. Per CLAUDE.md's "ORM plus SQL" and "Advisory Locks"
 * rules, advisory-lock experiments need multiple genuinely independent,
 * explicitly-controlled connections/sessions ("workers") so that session
 * lifetime and transaction boundaries are visible and reproducible - a query
 * builder or a shared pool does not model "this exact backend process holds
 * this exact session-level lock until it disconnects" well. Two or three raw
 * `pg.Client` connections make every step explicit, the same pattern Lab 07
 * established for isolation-level experiments, extended here to three
 * simulated workers where the scenario calls for it.
 */

export async function connectClient(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

export interface ScenarioCompany {
  id: number;
  publicId: string;
}

export async function findCompanyByName(connectionString: string, name: string): Promise<ScenarioCompany> {
  const client = await connectClient(connectionString);
  try {
    const { rows } = await client.query<{ id: string; public_id: string }>(
      "SELECT id, public_id FROM companies WHERE name = $1",
      [name],
    );
    if (!rows[0]) {
      throw new Error(`company "${name}" not found - run \`pnpm seed\` first`);
    }
    return { id: Number(rows[0].id), publicId: rows[0].public_id };
  } finally {
    await client.end();
  }
}

export async function resetPayrollRun(connectionString: string, companyId: number): Promise<void> {
  const client = await connectClient(connectionString);
  try {
    await client.query(
      `UPDATE payroll_runs
       SET status = 'pending', total_cents = 0, processed_by_worker = NULL, updated_at = now()
       WHERE company_id = $1`,
      [companyId],
    );
  } finally {
    await client.end();
  }
}

export interface PayrollRunState {
  status: string;
  totalCents: number;
  processedByWorker: string | null;
}

export async function readPayrollRun(connectionString: string, companyId: number): Promise<PayrollRunState> {
  const client = await connectClient(connectionString);
  try {
    const { rows } = await client.query<{
      status: string;
      total_cents: number;
      processed_by_worker: string | null;
    }>("SELECT status, total_cents, processed_by_worker FROM payroll_runs WHERE company_id = $1", [companyId]);
    if (!rows[0]) {
      throw new Error(`payroll_runs row for company ${companyId} not found - run \`pnpm seed\` first`);
    }
    return {
      status: rows[0].status,
      totalCents: rows[0].total_cents,
      processedByWorker: rows[0].processed_by_worker,
    };
  } finally {
    await client.end();
  }
}

// --- Advisory lock primitives -----------------------------------------
//
// Raw SQL, deliberately not hidden behind an abstraction that would obscure
// exactly which Postgres function is being called - CLAUDE.md's "Advisory
// Locks" section requires demonstrating the blocking vs try variants and the
// session vs transaction variants explicitly.

/** Session-level, blocking. Waits until the lock is free, held until unlock or disconnect. */
export async function advisoryLock(client: Client, key: number): Promise<void> {
  await client.query("SELECT pg_advisory_lock($1)", [key]);
}

/** Session-level, non-blocking. Returns immediately with true/false. */
export async function tryAdvisoryLock(client: Client, key: number): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [key]);
  return rows[0]!.locked;
}

/** Explicit release of a session-level lock. Returns false if the caller did not hold it. */
export async function advisoryUnlock(client: Client, key: number): Promise<boolean> {
  const { rows } = await client.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock($1) AS unlocked", [key]);
  return rows[0]!.unlocked;
}

/** Transaction-level, blocking. Released automatically at COMMIT or ROLLBACK - no unlock call exists. */
export async function advisoryXactLock(client: Client, key: number): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [key]);
}

/** Transaction-level, non-blocking. Returns immediately with true/false. */
export async function tryAdvisoryXactLock(client: Client, key: number): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1) AS locked",
    [key],
  );
  return rows[0]!.locked;
}

/** Two-int32 overload of the non-blocking session-level try-lock. */
export async function tryAdvisoryLockTwoKeys(client: Client, key1: number, key2: number): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1, $2) AS locked",
    [key1, key2],
  );
  return rows[0]!.locked;
}

export async function advisoryUnlockTwoKeys(client: Client, key1: number, key2: number): Promise<boolean> {
  const { rows } = await client.query<{ unlocked: boolean }>(
    "SELECT pg_advisory_unlock($1, $2) AS unlocked",
    [key1, key2],
  );
  return rows[0]!.unlocked;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
