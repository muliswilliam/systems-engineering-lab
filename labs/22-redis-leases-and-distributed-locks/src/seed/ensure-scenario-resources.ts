import { inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { resourceState } from "../db/schema.js";
import { SCENARIO_RESOURCES } from "./scenario-resources.js";

/**
 * Idempotently makes sure the fixed scenario resource_state rows exist,
 * without requiring a full `pnpm seed` run first. Used by integration tests
 * so `pnpm test` works against a freshly migrated (but not necessarily
 * seeded) database - same pattern as Lab 13's ensureScenarioCompanies.
 */
export async function ensureScenarioResources(): Promise<void> {
  await db
    .insert(resourceState)
    .values(SCENARIO_RESOURCES.map((name) => ({ name, fencingToken: 0, lastWriter: null })))
    .onConflictDoNothing({ target: resourceState.name });

  const rows = await db
    .select({ id: resourceState.id, name: resourceState.name })
    .from(resourceState)
    .where(inArray(resourceState.name, [...SCENARIO_RESOURCES]));

  if (rows.length !== SCENARIO_RESOURCES.length) {
    throw new Error("failed to ensure all scenario resource_state rows exist");
  }
}
