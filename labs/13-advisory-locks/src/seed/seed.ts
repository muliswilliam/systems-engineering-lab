import { generateCompanies, generateEmployees } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { companies, employees, payrollRuns } from "../db/schema.js";
import { SCENARIO_COMPANIES } from "./scenario-companies.js";

const log = createLogger("lab13:seed");

type Size = "small" | "medium" | "large";

const SIZE_PRESETS: Record<Size, { companies: number; employeesPerCompany: number }> = {
  small: { companies: 4, employeesPerCompany: 6 },
  medium: { companies: 30, employeesPerCompany: 12 },
  large: { companies: 200, employeesPerCompany: 20 },
};

function parseArgs(): { seed: number; size: Size } {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith("--seed="));
  const sizeArg = args.find((a) => a.startsWith("--size="));
  const seed = seedArg ? Number(seedArg.split("=")[1]) : 42;
  const size = (sizeArg ? sizeArg.split("=")[1] : "small") as Size;

  if (!(size in SIZE_PRESETS)) {
    throw new Error(`Unknown --size "${size}". Use small, medium, or large.`);
  }

  return { seed, size };
}

const BATCH_SIZE = 500;

async function main() {
  const { seed, size } = parseArgs();
  const preset = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size }, "clearing existing rows");
  await db.delete(payrollRuns);
  await db.delete(employees);
  await db.delete(companies);

  // Fixed, named scenario companies first - see scenario-companies.ts for
  // why these are looked up by name everywhere else, never by id.
  const insertedScenarioCompanies = await db
    .insert(companies)
    .values(SCENARIO_COMPANIES.map((c) => ({ name: c.name, country: c.country, currency: c.currency })))
    .returning({ id: companies.id, name: companies.name });

  await db.insert(payrollRuns).values(
    insertedScenarioCompanies.map((c) => ({ companyId: c.id, status: "pending", totalCents: 0 })),
  );

  log.info(
    { scenarioCompanies: insertedScenarioCompanies.map((c) => ({ id: c.id, name: c.name })) },
    "seeded fixed scenario companies (looked up by name from scenario scripts/tests)",
  );

  // Realistic "browsing" companies + employees via the shared payroll
  // generator, exactly like Lab 01, so PGweb isn't just two rows.
  const generatedCompanies = generateCompanies(preset.companies, seed);
  const insertedCompanies = await db
    .insert(companies)
    .values(
      generatedCompanies.map((c) => ({
        publicId: c.publicId,
        name: c.name,
        country: c.country,
        currency: c.currency,
      })),
    )
    .returning({ id: companies.id });

  await db.insert(payrollRuns).values(
    insertedCompanies.map((c) => ({ companyId: c.id, status: "pending", totalCents: 0 })),
  );

  const generatedEmployees = generateEmployees(generatedCompanies, preset.employeesPerCompany, seed);
  const employeeRows = generatedEmployees.map((e) => ({
    publicId: e.publicId,
    companyId: insertedCompanies[e.companyIndex]!.id,
    fullName: e.fullName,
    email: e.email,
    role: e.role,
    annualSalaryCents: e.annualSalaryCents,
    currency: e.currency,
  }));

  for (let i = 0; i < employeeRows.length; i += BATCH_SIZE) {
    await db.insert(employees).values(employeeRows.slice(i, i + BATCH_SIZE));
  }

  log.info(
    {
      scenarioCompanies: insertedScenarioCompanies.length,
      browsingCompanies: insertedCompanies.length,
      employees: employeeRows.length,
    },
    "seed complete",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
