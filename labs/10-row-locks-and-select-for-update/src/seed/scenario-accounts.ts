/**
 * Pulled out of seed.ts (which unconditionally runs `main()` as a script) so
 * that importing these constants from a scenario script does not also
 * trigger a full reseed as an import side effect.
 *
 * Each named row is what one scenario script and its matching integration
 * test target, looked up by `owner_name` (not by id, which would be fragile
 * once faker-generated "browsing" accounts share the table). Every scenario
 * resets its own account's balance to this baseline before running, so
 * scenarios - and the tests that call them - are safe to run repeatedly
 * without re-seeding, the same idempotency guarantee Lab 01's seed
 * established.
 */
export const SCENARIO_ACCOUNTS = [
  { ownerName: "Scenario Account - Lost Update", balanceCents: 1_000_000 },
  { ownerName: "Scenario Account - Select For Update", balanceCents: 1_000_000 },
  { ownerName: "Scenario Account - Nowait Lock Timeout", balanceCents: 500_000 },
  { ownerName: "Scenario Account - Lock Modes", balanceCents: 500_000 },
] as const;
