/**
 * Pulled out of seed.ts (which unconditionally runs `main()` as a script)
 * so that importing these constants from a scenario script does not also
 * trigger a full reseed as an import side effect.
 *
 * These three rows are what every scenario script and integration test
 * targets, looked up by name (not by id, which would be fragile once
 * faker-generated "browsing" accounts share the table). Each scenario resets
 * its own account's balance to this baseline before running, so scenarios -
 * and the tests that call them - are safe to run repeatedly without
 * re-seeding, the same idempotency guarantee Lab 01's seed established.
 */
export const SCENARIO_ACCOUNTS = [
  { name: "Scenario Account - Dirty Read", balanceCents: 1_000_000 },
  { name: "Scenario Account - Non-Repeatable Read", balanceCents: 2_000_000 },
  { name: "Scenario Account - Isolation Equivalence", balanceCents: 3_000_000 },
] as const;
