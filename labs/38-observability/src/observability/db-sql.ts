import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Loads one of `packages/db-utils/sql/*.sql`'s REUSABLE PostgreSQL
 * inspection scripts (CLAUDE.md "PostgreSQL Inspection": "store broadly
 * reusable versions under a shared package") directly from the shared
 * package's own source directory - not duplicated into this lab. Resolved
 * via a plain relative path from this file's own location rather than
 * Node's package `exports` map, since a monorepo-relative path is simpler
 * and does not depend on how `@labs/db-utils` happens to be linked into
 * `node_modules` (pnpm symlinks make either approach work, but this is the
 * more direct one).
 */
export function loadSharedSql(fileName: string): string {
  const path = fileURLToPath(new URL(`../../../../packages/db-utils/sql/${fileName}`, import.meta.url));
  return readFileSync(path, "utf-8");
}
