/**
 * A real, in-process stand-in for "a slow downstream dependency with
 * genuinely limited capacity" - e.g. a fixed-size outbound HTTP connection
 * pool to a payment gateway, or a search backend that can only usefully
 * serve a handful of concurrent queries. This is deliberately NOT a
 * Postgres connection pool - Lab 23 (connection-management-and-pgbouncer)
 * already covers Postgres-connection-specific exhaustion in depth, and this
 * lab's brief is to frame overload at the APPLICATION layer instead (an
 * unbounded number of concurrent in-flight calls into a resource with real,
 * finite capacity), so callers should not expect this to reproduce or
 * re-derive Lab 23's own findings.
 *
 * `BoundedResource` has exactly `capacity` slots. `acquire()` returns a
 * slot immediately if one is free; otherwise the caller waits in a real
 * FIFO queue until a slot frees up OR `timeoutMs` elapses, whichever comes
 * first - a genuine, not simulated, acquire-timeout error, the same failure
 * shape a real HTTP client raises when a connection pool is exhausted.
 */
export class BoundedResource {
  private availableSlots: number;
  private readonly waitQueue: Array<{
    grant: () => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(private readonly capacity: number) {
    this.availableSlots = capacity;
  }

  get inFlightCount(): number {
    return this.capacity - this.availableSlots;
  }

  get waitingCount(): number {
    return this.waitQueue.length;
  }

  async acquire(timeoutMs: number): Promise<() => void> {
    if (this.availableSlots > 0) {
      this.availableSlots -= 1;
      return () => this.release();
    }

    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimeout(entry.timer);
          resolve(() => this.release());
        },
        timer: setTimeout(() => {
          const index = this.waitQueue.indexOf(entry);
          if (index >= 0) {
            this.waitQueue.splice(index, 1);
          }
          reject(
            new Error(
              `downstream acquire timed out after ${timeoutMs}ms - the resource pool (capacity ${this.capacity}) has been exhausted for the entire wait`,
            ),
          );
        }, timeoutMs),
      };
      this.waitQueue.push(entry);
    });
  }

  private release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      // Hand the freed slot directly to the next waiter rather than
      // incrementing availableSlots first - avoids a window where a brand
      // new caller could race a long-waiting one for the same freed slot.
      next.grant();
      return;
    }
    this.availableSlots += 1;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simulates one call to the slow downstream dependency: acquire a real slot
 * from the bounded resource (or fail with a real timeout), hold it for
 * `workMs` (the downstream's own latency), then release it.
 */
export async function callSlowDownstream(
  resource: BoundedResource,
  workMs: number,
  acquireTimeoutMs: number,
): Promise<void> {
  const release = await resource.acquire(acquireTimeoutMs);
  try {
    await sleep(workMs);
  } finally {
    release();
  }
}
