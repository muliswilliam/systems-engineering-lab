import { Faker, en } from "@faker-js/faker";

export interface GeneratedCustomer {
  publicId: string;
  fullName: string;
  email: string;
  country: string;
}

export interface GeneratedProduct {
  publicId: string;
  sku: string;
  name: string;
  category: string;
  unitPriceCents: number;
}

export type OrderStatus = "pending" | "paid" | "shipped" | "cancelled";

export interface GeneratedOrderLine {
  productIndex: number;
  quantity: number;
  /** Snapshot of the product's price at order time - not a live reference. */
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface GeneratedOrder {
  customerIndex: number;
  status: OrderStatus;
  placedAt: Date;
  lines: GeneratedOrderLine[];
}

const CATEGORY_PRICE_BAND_CENTS: Record<string, [number, number]> = {
  electronics: [2_000, 120_000],
  home: [800, 25_000],
  apparel: [1_200, 15_000],
  books: [500, 6_000],
  sporting_goods: [1_000, 40_000],
  grocery: [200, 3_500],
};

const COUNTRIES = ["United States", "Canada", "Germany", "France", "United Kingdom"];

/**
 * Weighted so most orders land in a normal "paid"/"shipped" state, with a
 * realistic minority still pending or cancelled - useful for WHERE-clause
 * and subquery exercises later in this lab (e.g. "revenue excluding
 * cancelled orders").
 */
const STATUS_WEIGHTS: { value: OrderStatus; weight: number }[] = [
  { value: "paid", weight: 55 },
  { value: "shipped", weight: 25 },
  { value: "pending", weight: 12 },
  { value: "cancelled", weight: 8 },
];

/**
 * Deterministic customer generator - same `seed` always produces the same
 * logical dataset (SPEC.md section 8.1).
 */
export function generateCustomers(count: number, seed: number): GeneratedCustomer[] {
  const faker = new Faker({ locale: en });
  faker.seed(seed);

  return Array.from({ length: count }, () => {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    return {
      publicId: faker.string.uuid(),
      fullName: `${firstName} ${lastName}`,
      email: faker.internet.email({ firstName, lastName }).toLowerCase(),
      country: faker.helpers.arrayElement(COUNTRIES),
    };
  });
}

/**
 * Product price is drawn from a band keyed by category, not a flat random
 * range, so "average price per category" queries in this lab produce
 * meaningfully different numbers per category instead of noise.
 */
export function generateProducts(count: number, seed: number): GeneratedProduct[] {
  const faker = new Faker({ locale: en });
  faker.seed(seed + 1);

  const categories = Object.keys(CATEGORY_PRICE_BAND_CENTS);

  return Array.from({ length: count }, (_, index) => {
    const category = faker.helpers.arrayElement(categories);
    const [min, max] = CATEGORY_PRICE_BAND_CENTS[category] as [number, number];
    return {
      publicId: faker.string.uuid(),
      sku: `SKU-${String(index + 1).padStart(6, "0")}`,
      name: faker.commerce.productName(),
      category,
      unitPriceCents: faker.number.int({ min, max }),
    };
  });
}

/**
 * Orders are generated per customer, referencing real products at their
 * *current* generated price (snapshotted into the order line, the way a
 * real checkout would capture the price at purchase time rather than a live
 * foreign-key lookup).
 *
 * `maxOrdersPerCustomer` is a uniform-random upper bound, so roughly
 * `1 / (maxOrdersPerCustomer + 1)` of customers end up with zero orders -
 * this is intentional: it gives the joins/subqueries exercises in this lab
 * real "customers with no orders" and "products never ordered" rows to find,
 * instead of a dataset where every entity is trivially connected to every
 * other one.
 */
/**
 * Only the first 80% of the catalog (by generation order) is ever ordered
 * from - the remaining 20% is a deliberate long tail of never-purchased
 * products (new arrivals, discontinued items, dead stock), the way a real
 * catalog always has some SKUs with zero lifetime sales. This makes
 * "products that have never been ordered" a query with a real, non-empty
 * answer regardless of dataset size, instead of a coincidence of random draws.
 */
const ORDERABLE_CATALOG_FRACTION = 0.8;

export function generateOrders(
  customers: GeneratedCustomer[],
  products: GeneratedProduct[],
  maxOrdersPerCustomer: number,
  seed: number,
): GeneratedOrder[] {
  const faker = new Faker({ locale: en });
  faker.seed(seed + 2);

  const statusPool: OrderStatus[] = STATUS_WEIGHTS.flatMap((s) => Array<OrderStatus>(s.weight).fill(s.value));
  const orderableProductCount = Math.max(1, Math.floor(products.length * ORDERABLE_CATALOG_FRACTION));
  const productIndexes = products.map((_, index) => index).slice(0, orderableProductCount);

  const orders: GeneratedOrder[] = [];

  customers.forEach((_, customerIndex) => {
    const orderCount = faker.number.int({ min: 0, max: maxOrdersPerCustomer });

    for (let i = 0; i < orderCount; i += 1) {
      const placedAt = faker.date.past({ years: 1 });
      const status = faker.helpers.arrayElement(statusPool);
      const lineCount = faker.number.int({ min: 1, max: 5 });
      const chosenProductIndexes = faker.helpers.arrayElements(productIndexes, lineCount);

      const lines: GeneratedOrderLine[] = chosenProductIndexes.map((productIndex) => {
        const product = products[productIndex] as GeneratedProduct;
        const quantity = faker.number.int({ min: 1, max: 4 });
        const unitPriceCents = product.unitPriceCents;
        return {
          productIndex,
          quantity,
          unitPriceCents,
          lineTotalCents: quantity * unitPriceCents,
        };
      });

      orders.push({ customerIndex, status, placedAt, lines });
    }
  });

  return orders.sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
}
