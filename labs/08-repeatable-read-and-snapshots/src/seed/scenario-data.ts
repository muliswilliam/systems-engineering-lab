/**
 * Pulled out of seed.ts (which unconditionally runs `main()` as a script) so
 * that importing these constants from a scenario script does not also
 * trigger a full reseed as an import side effect.
 *
 * `SCENARIO_ACCOUNTS` mirrors Lab 07's pattern: fixed "Scenario Account -
 * ..." rows looked up by name (not id, which would be fragile once
 * faker-generated "browsing" accounts share the table). Each scenario resets
 * its own account's balance to this baseline before running, so scenarios -
 * and the tests that call them - are safe to run repeatedly without
 * re-seeding.
 *
 * `SCENARIO_STAFF` backs the write-skew scenario: a pair of on-call staff
 * rows, both on call at baseline. The write-skew scenario resets both rows
 * to `true` before running, for the same idempotency reason.
 */
export const SCENARIO_ACCOUNTS = [
  { name: "Scenario Account - Repeatable Read Snapshot", balanceCents: 2_000_000 },
  { name: "Scenario Account - Concurrent Write Conflict", balanceCents: 500_000 },
] as const;

export const SCENARIO_STAFF = [
  { name: "Scenario Staff - Dr. Alvarez", isOnCall: true },
  { name: "Scenario Staff - Dr. Boyko", isOnCall: true },
] as const;
