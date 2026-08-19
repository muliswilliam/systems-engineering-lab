import { Faker, en } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { tenants, supportTickets } from "../db/schema.js";

const log = createLogger("lab39:seed");

type Size = "small" | "medium" | "large";

/**
 * Tenant/ticket-per-tenant presets. "medium" (the default) gives
 * scenario:performance a real, non-trivial table to measure against
 * (tens of thousands of rows) without seeding taking more than a few
 * seconds.
 */
const SIZE_PRESETS: Record<Size, { tenants: number; ticketsPerTenant: number }> = {
  small: { tenants: 5, ticketsPerTenant: 50 },
  medium: { tenants: 40, ticketsPerTenant: 2_500 },
  large: { tenants: 100, ticketsPerTenant: 5_000 },
};

function parseArgs(): { seed: number; size: Size } {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith("--seed="));
  const sizeArg = args.find((a) => a.startsWith("--size="));
  const seed = seedArg ? Number(seedArg.split("=")[1]) : 42;
  const size = (sizeArg ? sizeArg.split("=")[1] : "medium") as Size;

  if (!(size in SIZE_PRESETS)) {
    throw new Error(`Unknown --size "${size}". Use small, medium, or large.`);
  }

  return { seed, size };
}

const TICKET_STATUSES = ["open", "pending", "resolved", "closed"] as const;
const BATCH_SIZE = 1_000;

/**
 * This lab's own generator, kept local rather than promoted to
 * `@labs/data-generators`: `tenants`/`support_tickets` are scenario-specific
 * to this lab's multi-tenancy domain (see schema.ts's own doc comment), not
 * one of SPEC.md 8.2's five reusable named domains.
 *
 * Runs as the connection in db/client.ts, i.e. the MIGRATOR role - the
 * table owner, which bypasses Row-Level Security by default (see README
 * "Break it" for why that is exactly the real, common default this lab
 * demonstrates rather than works around). A seed/migration script writing
 * across every tenant at once is the ONE legitimate place that bypass is
 * actually useful; the running application server (the `app` role) never
 * gets this bypass.
 *
 * Idempotent: clears both tables (support_tickets first, FK to tenants) and
 * reinserts a fresh, deterministic set every run (SPEC.md 8.1). Two fixed,
 * named scenario tenants ("Scenario Tenant - Acme (A)" / "Scenario Tenant -
 * Globex (B)") are always seeded first and always get index 0/1, so
 * scenario scripts and tests can look them up by slug rather than relying
 * on a hardcoded id surviving a reseed - the same pattern Lab 07's
 * SCENARIO_ACCOUNTS and Lab 13's named scenario companies established.
 */
async function main() {
  const { seed, size } = parseArgs();
  const { tenants: tenantCount, ticketsPerTenant } = SIZE_PRESETS[size];
  const faker = new Faker({ locale: [en] });
  faker.seed(seed);

  await waitForDatabase(pool);

  log.info({ seed, size, tenantCount, ticketsPerTenant }, "clearing existing rows");
  await db.delete(supportTickets);
  await db.delete(tenants);

  const tenantNames = [
    { name: "Scenario Tenant - Acme (A)", slug: "acme" },
    { name: "Scenario Tenant - Globex (B)", slug: "globex" },
    ...Array.from({ length: Math.max(tenantCount - 2, 0) }, () => {
      const company = faker.company.name();
      return { name: company, slug: faker.helpers.slugify(company).toLowerCase() };
    }),
  ].slice(0, tenantCount);

  // Slugs must be unique - faker company names can collide, so disambiguate
  // deterministically by appending the row index rather than retrying with
  // fresh randomness (which would break determinism for a given --seed).
  const seenSlugs = new Set<string>();
  const uniqueTenantRows = tenantNames.map((t, index) => {
    let slug = t.slug || `tenant-${index}`;
    if (seenSlugs.has(slug)) {
      slug = `${slug}-${index}`;
    }
    seenSlugs.add(slug);
    return { name: t.name, slug };
  });

  const insertedTenants = await db.insert(tenants).values(uniqueTenantRows).returning({
    id: tenants.id,
    slug: tenants.slug,
  });

  log.info({ tenants: insertedTenants.length }, "tenants inserted");

  let totalTickets = 0;
  for (const tenant of insertedTenants) {
    const ticketRows = Array.from({ length: ticketsPerTenant }, () => ({
      tenantId: tenant.id,
      subject: faker.lorem.sentence({ min: 3, max: 8 }),
      body: faker.lorem.paragraph(),
      status: faker.helpers.arrayElement(TICKET_STATUSES),
    }));

    for (let i = 0; i < ticketRows.length; i += BATCH_SIZE) {
      await db.insert(supportTickets).values(ticketRows.slice(i, i + BATCH_SIZE));
    }
    totalTickets += ticketRows.length;
  }

  log.info({ tenants: insertedTenants.length, totalTickets }, "seed complete");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
