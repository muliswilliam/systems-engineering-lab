import type { Pool } from "pg";

export interface TestSeat {
  id: number;
  publicId: string;
}

/**
 * Creates one fresh event with `count` AVAILABLE seats, isolated from
 * whatever `pnpm seed` put in the database (a distinct event row, so
 * `WHERE event_id = $1` scopes every query in a test file to only its own
 * rows) - the same "each test file manages and cleans up its own scratch
 * rows" convention Lab 17's `outbox-helpers.ts` documents.
 */
export async function createTestEventWithSeats(pool: Pool, count: number): Promise<{ eventId: number; seats: TestSeat[] }> {
  const eventResult = await pool.query<{ id: number }>(
    `INSERT INTO events (name, venue_name, event_at) VALUES ($1, 'Test Arena', now() + interval '30 days') RETURNING id`,
    [`Test Event ${Date.now()}-${Math.random()}`],
  );
  const eventId = eventResult.rows[0]!.id;

  const seats: TestSeat[] = [];
  for (let i = 0; i < count; i++) {
    const seatResult = await pool.query<{ id: number; public_id: string }>(
      `INSERT INTO seats (event_id, section, seat_number, price_cents) VALUES ($1, 'A', $2, 9900) RETURNING id, public_id`,
      [eventId, i + 1],
    );
    const row = seatResult.rows[0]!;
    seats.push({ id: row.id, publicId: row.public_id });
  }

  return { eventId, seats };
}

export async function cleanupTestEvent(pool: Pool, eventId: number): Promise<void> {
  await pool.query(
    `DELETE FROM notification_attempts WHERE order_public_id IN (
       SELECT public_id FROM orders WHERE seat_id IN (SELECT id FROM seats WHERE event_id = $1)
     )`,
    [eventId],
  );
  await pool.query(
    `DELETE FROM outbox_events WHERE payload->>'orderPublicId' IN (
       SELECT public_id::text FROM orders WHERE seat_id IN (SELECT id FROM seats WHERE event_id = $1)
     )`,
    [eventId],
  );
  await pool.query(`DELETE FROM orders WHERE seat_id IN (SELECT id FROM seats WHERE event_id = $1)`, [eventId]);
  await pool.query(`DELETE FROM seats WHERE event_id = $1`, [eventId]);
  await pool.query(`DELETE FROM events WHERE id = $1`, [eventId]);
}
