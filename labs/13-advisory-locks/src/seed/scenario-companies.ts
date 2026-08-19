/**
 * Two fixed, named companies that every scenario script and integration test
 * targets by name (not by numeric id, which would be fragile once
 * faker-generated "browsing" companies share the table and once the
 * identity sequence keeps advancing across repeated `pnpm seed` runs). Each
 * scenario resets its own company's `payroll_runs` row before running, the
 * same idempotency guarantee Lab 07's SCENARIO_ACCOUNTS pattern established.
 *
 * SPEC.md's Lab 13 section frames the demonstration as "worker A processes
 * company 5; worker B cannot process company 5; worker C can process company
 * 6" - those numbers are illustrative company identifiers, not a requirement
 * that the seeded numeric id literally be 5 or 6. "Alpha" plays the role of
 * SPEC's company 5 (the one Worker A locks) and "Beta" plays the role of
 * company 6 (the different lock key Worker C uses) - see the README's
 * "Setup" and "Real validation run" sections for the actual numeric ids
 * captured from a real seed.
 */
export const SCENARIO_COMPANIES = [
  { name: "Scenario Company - Alpha (locked by Worker A)", country: "United States", currency: "USD" },
  { name: "Scenario Company - Beta (different lock key)", country: "United States", currency: "USD" },
] as const;
