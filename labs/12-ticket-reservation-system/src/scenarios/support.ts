export type ReservationOutcome = "reserved" | "unavailable";

export interface ReservationResult {
  outcome: ReservationOutcome;
  seatId: number;
  buyer: string;
  reservationToken?: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function reservedUntilFromNow(holdMinutes: number): Date {
  return new Date(Date.now() + holdMinutes * 60_000);
}
