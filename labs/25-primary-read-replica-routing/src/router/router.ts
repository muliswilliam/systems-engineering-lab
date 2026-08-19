import type { Pool, PoolClient } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.js";
import type { NodeChoice, OperationKind } from "./types.js";

type Db = NodePgDatabase<typeof schema>;

export interface RouterDeps {
  primaryDb: Db;
  replicaDb: Db;
  primaryPool: Pool;
  replicaPool: Pool;
  classify: (kind: OperationKind) => NodeChoice;
}

export interface Router {
  /** Always routes per classify("write") - correct routers always send this to primary. */
  write<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** An ordinary read that does not need to observe a just-made write. */
  read<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** A read that MUST observe the effect of a write from the same logical operation. */
  readAfterWrite<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` inside a single real Postgres transaction (BEGIN/COMMIT) on
   * whichever node classify("transaction") picks. `fn` receives a raw
   * `pg` `PoolClient`, not a Drizzle db handle - row locks
   * (`SELECT ... FOR UPDATE`) are exactly the kind of PostgreSQL-specific
   * behavior CLAUDE.md asks labs to express as raw SQL rather than hide
   * behind an ORM abstraction.
   */
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

/**
 * One execution engine, parameterized only by `classify`. This is the point
 * of the lab: the naive router and the corrected router are not two
 * different pieces of machinery - they are the SAME machinery driven by two
 * different (and, for three of the four operation kinds, differently
 * wrong-or-right) classification tables. See src/router/classify.ts.
 */
export function createRouter({ primaryDb, replicaDb, primaryPool, replicaPool, classify }: RouterDeps): Router {
  function pickDb(kind: OperationKind): Db {
    return classify(kind) === "primary" ? primaryDb : replicaDb;
  }

  function pickPool(kind: OperationKind): Pool {
    return classify(kind) === "primary" ? primaryPool : replicaPool;
  }

  return {
    write(fn) {
      return fn(pickDb("write"));
    },
    read(fn) {
      return fn(pickDb("read"));
    },
    readAfterWrite(fn) {
      return fn(pickDb("read-after-write"));
    },
    async transaction(fn) {
      const pool = pickPool("transaction");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {
          // Best-effort - if ROLLBACK itself fails the connection is
          // already broken (e.g. the replica rejected a write mid-
          // transaction and aborted it), and the original error below is
          // what matters to the caller.
        });
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
