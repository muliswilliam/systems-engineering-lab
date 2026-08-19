import { Pool, type PoolConfig } from "pg";

/**
 * Thin wrapper so every lab creates its pg Pool the same way and logs slow
 * queries consistently. Labs remain free to use Drizzle on top of this pool
 * or to run raw SQL directly against it - both share the same connection.
 */
export function createPool(config: PoolConfig): Pool {
  return new Pool(config);
}

export async function waitForDatabase(pool: Pool, attempts = 30, delayMs = 500): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(`Database not reachable after ${attempts} attempts: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
