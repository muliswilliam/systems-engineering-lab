/**
 * Pulled out of seed.ts (which unconditionally runs `main()` as a script) so
 * that importing these constants from a scenario script does not also
 * trigger a full reseed as an import side effect.
 *
 * These four rows are what every scenario script and integration test
 * targets, looked up by `title` (not by id, which would be fragile once
 * faker-generated "browsing" documents share the table). Each scenario
 * resets its own document's body/version/status to this baseline before
 * running, so scenarios - and the tests that call them - are safe to run
 * repeatedly without re-seeding, the same idempotency guarantee Lab 07's
 * seed established for this pattern.
 */
export const SCENARIO_DOCUMENTS = [
  {
    title: "Scenario Document - Lost Update",
    body: "This shared draft describes the Q3 rollout plan. Section 1: overview. Section 2: timeline.",
    status: "draft",
  },
  {
    title: "Scenario Document - Optimistic Concurrency",
    body: "This shared draft describes the Q3 rollout plan. Section 1: overview. Section 2: timeline.",
    status: "draft",
  },
  {
    title: "Scenario Document - Conditional Write (Publish Race)",
    body: "This document is ready to publish once review is complete.",
    status: "draft",
  },
  {
    title: "Scenario Document - Lock Comparison",
    body: "This shared draft describes the Q3 rollout plan. Section 1: overview. Section 2: timeline.",
    status: "draft",
  },
] as const;
