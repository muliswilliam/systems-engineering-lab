import "dotenv/config";
import { createLogger } from "@labs/logging";
import { openSession, sleep } from "../db/session.js";

const log = createLogger("lab06:scenario:readers-dont-block-writers");

const LABEL = "page-views";
const READER_HOLD_MS = 3000;

/**
 * A common wrong intuition from engineers used to databases (or ORMs) that
 * take read locks by default: "an open transaction that has read a row
 * must be blocking anyone who wants to write it." Under MVCC, a plain
 * SELECT never takes a row lock at all - it reads a snapshot of already-
 * committed tuple versions. So a concurrent writer is free to UPDATE and
 * COMMIT while the reader's transaction is still sitting open.
 *
 * This script proves it by timing, not by assertion: session A opens a
 * transaction and holds it open (via an explicit reader-side delay
 * simulating a slow/idle transaction) while session B measures how long its
 * UPDATE + COMMIT actually takes. Then, for contrast, it repeats the same
 * shape with `SELECT ... FOR UPDATE` (a locking read) to show that a real
 * row lock *does* block the writer for the full hold duration - the
 * difference is the lock, not the fact that a transaction is "reading."
 */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set - copy .env.example to .env first");

  // --- Phase 1: plain SELECT, open transaction, concurrent writer ---
  {
    const reader = await openSession(databaseUrl);
    const writer = await openSession(databaseUrl);
    log.info({ pidReader: reader.pid, pidWriter: writer.pid, phase: 1 }, "plain SELECT vs concurrent UPDATE");

    await reader.begin();
    await reader.query("SELECT value FROM counters WHERE label = $1", [LABEL]);
    log.info({ phase: 1, holdMs: READER_HOLD_MS }, "reader opened a transaction, read the row, and is holding it open (no FOR UPDATE)");

    const writeStart = Date.now();
    await writer.query("UPDATE counters SET value = value + 1 WHERE label = $1", [LABEL]);
    const writeElapsedMs = Date.now() - writeStart;
    log.info({ phase: 1, writeElapsedMs }, "writer's UPDATE returned (writer did not COMMIT yet, no reason to wait for it)");

    const notBlocked = writeElapsedMs < READER_HOLD_MS / 2;
    log.info(
      { phase: 1, notBlocked, writeElapsedMs, readerHoldMs: READER_HOLD_MS },
      notBlocked
        ? "confirmed: the writer was NOT blocked by the reader's open transaction"
        : "UNEXPECTED: the writer took long enough that it may have been blocked",
    );

    await sleep(READER_HOLD_MS);
    await reader.rollback();
    await writer.query("COMMIT");
    await reader.close();
    await writer.close();
  }

  // --- Phase 2 (contrast): SELECT ... FOR UPDATE, open transaction, concurrent writer ---
  {
    const reader = await openSession(databaseUrl);
    const writer = await openSession(databaseUrl);
    log.info({ pidReader: reader.pid, pidWriter: writer.pid, phase: 2 }, "SELECT ... FOR UPDATE vs concurrent UPDATE (contrast)");

    await reader.begin();
    await reader.query("SELECT value FROM counters WHERE label = $1 FOR UPDATE", [LABEL]);
    log.info({ phase: 2, holdMs: READER_HOLD_MS }, "reader took a row lock with FOR UPDATE and is holding it open");

    const writeStart = Date.now();
    const writerDone = writer.query("UPDATE counters SET value = value + 1 WHERE label = $1", [LABEL]).then(() => {
      writer.query("COMMIT").catch(() => undefined);
      return Date.now() - writeStart;
    });

    await sleep(READER_HOLD_MS);
    await reader.commit();

    const writeElapsedMs = await writerDone;
    const wasBlocked = writeElapsedMs >= READER_HOLD_MS * 0.8;
    log.info(
      { phase: 2, wasBlocked, writeElapsedMs, readerHoldMs: READER_HOLD_MS },
      wasBlocked
        ? "confirmed: FOR UPDATE's row lock DID block the writer until the reader committed - this is a real lock, not MVCC visibility"
        : "UNEXPECTED: the writer completed before the reader released its lock",
    );

    await reader.close();
    await writer.close();
  }
}

main().catch((error: unknown) => {
  log.error({ err: error }, "readers-dont-block-writers scenario failed");
  process.exit(1);
});
