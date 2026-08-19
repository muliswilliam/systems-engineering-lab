/**
 * Pulled out of seed.ts (which unconditionally runs `main()` as a script) so
 * importing these constants from a scenario script does not also trigger a
 * full reseed as an import side effect - same pattern Lab 10 established for
 * its own `SCENARIO_ACCOUNTS`.
 *
 * These two named accounts are what `scenario:deadlock`, `scenario:ordered`,
 * and `scenario:retry` each target, looked up by `owner_name`. Every
 * scenario resets both accounts' balances to this baseline before running,
 * so they - and the tests that call them - are safe to run repeatedly
 * without re-seeding.
 */
export const SCENARIO_ACCOUNTS = [
  { ownerName: "Scenario Account - Deadlock A", balanceCents: 1_000_000 },
  { ownerName: "Scenario Account - Deadlock B", balanceCents: 1_000_000 },
] as const;

export const TRIAL_PAIR_BASELINE_BALANCE_CENTS = 1_000_000;
