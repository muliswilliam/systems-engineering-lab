import { Faker, en } from "@faker-js/faker";

export interface GeneratedEvent {
  publicId: string;
  name: string;
  venueName: string;
  eventAt: Date;
}

export interface GeneratedSeat {
  publicId: string;
  eventIndex: number;
  section: string;
  row: string;
  seatNumber: number;
}

/**
 * Ticketing domain generator (SPEC.md 8.2's "Ticketing" domain). SPEC.md
 * lists a much larger aspirational entity set for the domain across the
 * *whole* curriculum (venues, sections, ticket inventory, orders, payments).
 * Lab 12 - the only consumer of this file so far - only needs `events` and a
 * flat `seats` table (each seat carries its own `section`/`row`/
 * `seat_number` text/int columns instead of a separate normalized
 * venue/section model) to teach reservation race conditions; see that lab's
 * README "Architecture" section for the scoping rationale. Extend this file
 * if/when a later lab needs venues, orders, or payments as real generators.
 */
const SECTIONS = ["A", "B", "C"] as const;
const SEATS_PER_ROW = 10;

/** Fixed reference instant so `eventAt` is fully deterministic for a given
 * seed, independent of what day the generator happens to run on. */
const EVENT_WINDOW_START = new Date("2026-01-01T00:00:00Z");
const EVENT_WINDOW_DAYS = 120;

/**
 * Deterministic event generator - same `seed` always produces the same
 * logical dataset (SPEC.md 8.1).
 */
export function generateEvents(count: number, seed: number): GeneratedEvent[] {
  const faker = new Faker({ locale: en });
  // +5 offset keeps this generator's RNG sequence independent of the other
  // domains' generators (payroll uses seed/seed+1, commerce uses
  // seed/seed+1/seed+2, ledger uses seed+3) should a future lab ever compose
  // ticketing data alongside another domain under one seed.
  faker.seed(seed + 5);

  return Array.from({ length: count }, () => {
    const artist = faker.person.fullName();
    const offsetDays = faker.number.int({ min: 1, max: EVENT_WINDOW_DAYS });
    const eventAt = new Date(EVENT_WINDOW_START.getTime() + offsetDays * 24 * 60 * 60 * 1000);

    return {
      publicId: faker.string.uuid(),
      name: `${artist} Live`,
      venueName: `${faker.location.city()} Arena`,
      eventAt,
    };
  });
}

/**
 * Seats are generated per event, filling sections A/B/C row-by-row (10 seats
 * per row) so `section`/`row`/`seat_number` are always a coherent, unique
 * physical layout rather than independently-random values - the same
 * "relationships must make sense" principle SPEC.md 8.3 applies to every
 * other domain (ticket seats belong to a real section of a real event).
 */
export function generateSeats(events: GeneratedEvent[], seatsPerEvent: number, seed: number): GeneratedSeat[] {
  const faker = new Faker({ locale: en });
  faker.seed(seed + 6);

  const seats: GeneratedSeat[] = [];

  events.forEach((_event, eventIndex) => {
    let placed = 0;
    let rowNumber = 1;

    while (placed < seatsPerEvent) {
      for (const section of SECTIONS) {
        for (let seatNumber = 1; seatNumber <= SEATS_PER_ROW; seatNumber += 1) {
          if (placed >= seatsPerEvent) {
            return;
          }
          seats.push({
            publicId: faker.string.uuid(),
            eventIndex,
            section,
            row: String(rowNumber),
            seatNumber,
          });
          placed += 1;
        }
      }
      rowNumber += 1;
    }
  });

  return seats;
}
