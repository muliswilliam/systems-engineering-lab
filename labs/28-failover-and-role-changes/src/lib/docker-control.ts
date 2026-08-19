import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Real, un-simulated container lifecycle control via `docker compose`,
 * scoped to whatever directory the calling script/test is run from (this
 * lab's package.json scripts and `vitest run` are always invoked with the
 * lab's own root as cwd, which is where docker-compose.yml lives - the same
 * assumption Compose itself makes for an unqualified `docker compose ...`
 * invocation).
 *
 * This is the mechanism CLAUDE.md's "show failure before the fix" principle
 * demands for THIS lab specifically: an unplanned primary failure is not
 * something that can be honestly demonstrated by mocking a function call -
 * it has to be a real container that a real client can no longer reach.
 */

const DOCKER_TIMEOUT_MS = 30_000;

async function runDockerCompose(args: string[]): Promise<void> {
  await execFileAsync("docker", ["compose", ...args], {
    cwd: process.cwd(),
    timeout: DOCKER_TIMEOUT_MS,
  });
}

/** Stops (does not remove) the named service's container. Blocks until Docker reports it stopped. */
export async function stopService(service: string): Promise<void> {
  await runDockerCompose(["stop", service]);
}

/** Restarts a previously-stopped service's container from its existing (persisted) data volume. */
export async function startService(service: string): Promise<void> {
  await runDockerCompose(["start", service]);
}

/** Full destructive reset: removes containers AND volumes, per CLAUDE.md's "docker compose down -v" convention. */
export async function resetTopology(): Promise<void> {
  await runDockerCompose(["down", "-v"]);
  await runDockerCompose(["up", "-d"]);
}
