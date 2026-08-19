import { describe, it, expect } from "vitest";
import { Client } from "pg";
import {
  directConnectionString,
  sessionPoolingConnectionString,
  transactionPoolingConnectionString,
} from "../../src/db/connections.js";

async function selectOne(connectionString: string): Promise<number | undefined> {
  const client = new Client({ connectionString });
  await client.connect();
  const { rows } = await client.query<{ ok: number }>("select 1 as ok");
  await client.end();
  return rows[0]?.ok;
}

describe("connectivity", () => {
  it("connects directly to Postgres", async () => {
    expect(await selectOne(directConnectionString())).toBe(1);
  });

  it("connects through the session-pooling PgBouncer instance", async () => {
    expect(await selectOne(sessionPoolingConnectionString())).toBe(1);
  });

  it("connects through the transaction-pooling PgBouncer instance", async () => {
    expect(await selectOne(transactionPoolingConnectionString())).toBe(1);
  });
});
