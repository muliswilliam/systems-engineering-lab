/**
 * Pulled out of seed.ts (which unconditionally runs `main()` as a script) so
 * importing these constants from a scenario script does not also trigger a
 * full reseed as an import side effect - same pattern as Lab 07's
 * scenario-accounts.ts.
 *
 * Two fixed teams, looked up by name (not id, which would be fragile once
 * faker-generated "browsing" rows share the table):
 *
 * - WRITE_SKEW_TEAM: exactly two staff, used by the write-skew, serializable-
 *   conflict, and serializable-retry scenarios, which all need precisely two
 *   overlapping "go off call" decisions to reproduce the classic anomaly.
 * - CONTENTION_TEAM: five staff, used by contention-and-throughput.ts, which
 *   needs enough concurrent actors for an abort-rate measurement to be
 *   meaningful.
 *
 * Every scenario resets its own team's `is_on_call` to `true` for every
 * member before running, so scenarios - and the tests that call them - are
 * safe to run repeatedly without re-seeding, the same idempotency guarantee
 * every other lab in this repository establishes.
 */
export const WRITE_SKEW_TEAM = "ER Night Shift - Write Skew";

export const WRITE_SKEW_STAFF = [
  { team: WRITE_SKEW_TEAM, name: "Dr. Alice Chen" },
  { team: WRITE_SKEW_TEAM, name: "Dr. Bob Nkemelu" },
] as const;

export const CONTENTION_TEAM = "ER Night Shift - Contention";

export const CONTENTION_STAFF = [
  { team: CONTENTION_TEAM, name: "Dr. Carla Reyes" },
  { team: CONTENTION_TEAM, name: "Dr. Dmitri Volkov" },
  { team: CONTENTION_TEAM, name: "Dr. Emeka Obi" },
  { team: CONTENTION_TEAM, name: "Dr. Farah Haddad" },
  { team: CONTENTION_TEAM, name: "Dr. Grace Lindqvist" },
] as const;

export const SCENARIO_STAFF = [...WRITE_SKEW_STAFF, ...CONTENTION_STAFF];
