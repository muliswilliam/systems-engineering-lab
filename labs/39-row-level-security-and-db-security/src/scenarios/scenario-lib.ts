import { poolFor } from "../db/roles.js";

export interface ScenarioTenant {
  id: number;
  name: string;
  slug: string;
}

/**
 * Looks up the two fixed, named scenario tenants seed.ts always creates
 * first ("acme"/"globex") - looked up by slug rather than assuming a
 * hardcoded id, so this survives a reseed regardless of --seed/--size (same
 * pattern as Lab 07's SCENARIO_ACCOUNTS / Lab 13's named scenario
 * companies). Uses the admin/superuser connection for this lookup only
 * because it is a read that must succeed regardless of RLS state while a
 * scenario is toggling it - the scenario tenants themselves are still
 * ordinary rows, not special in any schema sense.
 */
export async function loadScenarioTenants(): Promise<{ tenantA: ScenarioTenant; tenantB: ScenarioTenant }> {
  const admin = poolFor("admin");
  const { rows } = await admin.query<ScenarioTenant>(
    "SELECT id, name, slug FROM tenants WHERE slug IN ('acme', 'globex')",
  );
  const tenantA = rows.find((r) => r.slug === "acme");
  const tenantB = rows.find((r) => r.slug === "globex");
  if (!tenantA || !tenantB) {
    throw new Error(
      "Scenario tenants 'acme'/'globex' not found - run `pnpm db:migrate && pnpm seed` first",
    );
  }
  return { tenantA, tenantB };
}

/** `rows[0]` with a real error instead of `undefined` under `noUncheckedIndexedAccess`. */
export function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Expected at least one row, got none");
  }
  return row;
}

/** Formats a Postgres error's SQLSTATE/message for readable scenario output. */
export function describePgError(error: unknown): { code: string | undefined; message: string } {
  if (error && typeof error === "object" && "code" in error) {
    return {
      code: (error as { code?: string }).code,
      message: (error as { message?: string }).message ?? String(error),
    };
  }
  return { code: undefined, message: String(error) };
}
