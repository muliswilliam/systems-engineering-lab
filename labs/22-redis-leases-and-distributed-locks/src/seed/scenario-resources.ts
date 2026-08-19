/**
 * Fixed, named resource_state rows that every scenario script and
 * integration test targets by name - not by numeric id, which would be
 * fragile once faker-generated "browsing" resources share the table and
 * once the identity sequence keeps advancing across repeated `pnpm seed`
 * runs. Same pattern Lab 07's SCENARIO_ACCOUNTS and Lab 13's
 * SCENARIO_COMPANIES established. Each scenario resets its own resource's
 * row (and its Redis keys) before running - see resetScenarioState in
 * src/redis-lock/support.ts.
 */
export const LEASE_EXPIRY_RESOURCE_NAME = "Scenario Resource - Lease Expiry Bug";
export const FENCING_TOKEN_RESOURCE_NAME = "Scenario Resource - Fencing Token Fix";

export const SCENARIO_RESOURCES = [LEASE_EXPIRY_RESOURCE_NAME, FENCING_TOKEN_RESOURCE_NAME] as const;
