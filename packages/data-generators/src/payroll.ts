import { Faker, en } from "@faker-js/faker";

export interface GeneratedCompany {
  publicId: string;
  name: string;
  country: string;
  currency: string;
}

export interface GeneratedEmployee {
  publicId: string;
  companyIndex: number;
  fullName: string;
  email: string;
  role: "engineer" | "manager" | "designer" | "recruiter" | "sales";
  annualSalaryCents: number;
  currency: string;
}

const ROLE_SALARY_BAND_USD: Record<GeneratedEmployee["role"], [number, number]> = {
  engineer: [90_000, 190_000],
  manager: [110_000, 220_000],
  designer: [80_000, 160_000],
  recruiter: [70_000, 130_000],
  sales: [75_000, 150_000],
};

const COUNTRY_CURRENCY: Record<string, string> = {
  "United States": "USD",
  Canada: "CAD",
  Germany: "EUR",
  France: "EUR",
  "United Kingdom": "GBP",
};

/**
 * Deterministic company generator - same `seed` always produces the same
 * logical dataset (SPEC.md section 8.1), which matters for concurrency and
 * performance labs that need reproducible data.
 */
export function generateCompanies(count: number, seed: number): GeneratedCompany[] {
  const faker = new Faker({ locale: en });
  faker.seed(seed);

  const countries = Object.keys(COUNTRY_CURRENCY);

  return Array.from({ length: count }, () => {
    const country = faker.helpers.arrayElement(countries);
    return {
      publicId: faker.string.uuid(),
      name: faker.company.name(),
      country,
      currency: COUNTRY_CURRENCY[country] as string,
    };
  });
}

/**
 * Employees are generated per company so role/salary/currency stay coherent
 * with the company they belong to, instead of independent random rows.
 */
export function generateEmployees(
  companies: GeneratedCompany[],
  employeesPerCompany: number,
  seed: number,
): GeneratedEmployee[] {
  const faker = new Faker({ locale: en });
  faker.seed(seed + 1);

  const roles = Object.keys(ROLE_SALARY_BAND_USD) as GeneratedEmployee["role"][];
  const employees: GeneratedEmployee[] = [];

  companies.forEach((company, companyIndex) => {
    for (let i = 0; i < employeesPerCompany; i += 1) {
      const role = faker.helpers.arrayElement(roles);
      const [min, max] = ROLE_SALARY_BAND_USD[role];
      const firstName = faker.person.firstName();
      const lastName = faker.person.lastName();

      employees.push({
        publicId: faker.string.uuid(),
        companyIndex,
        fullName: `${firstName} ${lastName}`,
        email: faker.internet.email({ firstName, lastName }).toLowerCase(),
        role,
        annualSalaryCents: faker.number.int({ min, max }) * 100,
        currency: company.currency,
      });
    }
  });

  return employees;
}
