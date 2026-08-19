import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the real `docker` CLI, used only by
 * `src/scenarios/upstream-failure.ts` (and its matching integration test) to
 * genuinely stop and restart the `lab27-replica-1` container - the same
 * command a human operator would run at a terminal
 * (`docker stop lab27-replica-1` / `docker start lab27-replica-1`). This is
 * NOT a simulated failure: the container process is actually sent SIGTERM
 * (then SIGKILL on timeout) and its port stops accepting connections, which
 * is exactly why replica-2's own connection to it drops for real.
 *
 * Kept lab-local rather than promoted to a shared package, per
 * ROADMAP.md's note on Lab 26's `replication-control.ts` - no second
 * consumer needs "stop/start a named container by name" yet, and the right
 * general shape of that isn't clear until Lab 28 (failover) needs it too.
 */

export async function stopContainer(containerName: string): Promise<void> {
  await execFileAsync("docker", ["stop", containerName]);
}

export async function startContainer(containerName: string): Promise<void> {
  await execFileAsync("docker", ["start", containerName]);
}

/**
 * Polls `docker inspect` for the container's health status. bitnami's image
 * defines a healthcheck (see docker-compose.yml) - this waits for Docker to
 * report it as "healthy" again after a restart, the same condition
 * `depends_on: condition: service_healthy` waits for on a fresh `up -d`.
 */
export async function waitForContainerHealthy(
  containerName: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        containerName,
      ]);
      if (stdout.trim() === "healthy") {
        return;
      }
    } catch {
      // Container may not exist yet / docker inspect can transiently fail
      // right after `docker start` - keep polling until the timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`container ${containerName} never became healthy within ${timeoutMs}ms`);
}
