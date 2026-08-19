/**
 * Runs `count` copies of `task` concurrently and returns every settled result.
 * Concurrency labs use this instead of sequential loops so races can actually
 * occur, per SPEC.md section 11 ("assert invariants, not timing").
 */
export async function runConcurrently<T>(
  count: number,
  task: (index: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(Array.from({ length: count }, (_, index) => task(index)));
}

export function countFulfilled<T>(results: PromiseSettledResult<T>[]): number {
  return results.filter((result) => result.status === "fulfilled").length;
}
