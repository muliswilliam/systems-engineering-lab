import { generateCompanies, generateEmployees } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { companies, employees } from "../db/schema.js";

const log = createLogger("lab02:seed");

type Size = "small" | "medium" | "large";

const SIZE_PRESETS: Record<Size, { companies: number; employeesPerCompany: number }> = {
  small: { companies: 5, employeesPerCompany: 8 },
  medium: { companies: 50, employeesPerCompany: 15 },
  large: { companies: 500, employeesPerCompany: 25 },
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
  await db.delete(employees);
  await db.delete(companies);

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

  const generatedEmployees = generateEmployees(generatedCompanies, preset.employeesPerCompany, seed);
  const employeeRows = generatedEmployees.map((e) => ({
    publicId: e.publicId,
    companyId: insertedCompanies[e.companyIndex]!.id,
    fullName: e.fullName,
    email: e.email,
    role: e.role,
    annualSalaryCents: e.annualSalaryCents,
    currency: e.currency,
    employmentStatus: e.employmentStatus,
  }));

  for (let i = 0; i < employeeRows.length; i += BATCH_SIZE) {
    await db.insert(employees).values(employeeRows.slice(i, i + BATCH_SIZE));
  }

  const terminatedCount = employeeRows.filter((e) => e.employmentStatus === "terminated").length;

  log.info(
    {
      companies: insertedCompanies.length,
      employees: employeeRows.length,
      terminated: terminatedCount,
      active: employeeRows.length - terminatedCount,
    },
    "seed complete",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ error }, "seed failed");
  process.exit(1);
});
