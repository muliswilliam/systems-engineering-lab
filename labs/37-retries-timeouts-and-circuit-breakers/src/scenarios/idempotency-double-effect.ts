import { randomUUID } from "node:crypto";
import { createLogger } from "@labs/logging";
import { UnreliableDownstream } from "../downstream/unreliable-downstream.js";
import { TimeoutError, withTimeout } from "../lib/timeout.js";

/**
 * IDEMPOTENCY: a downstream `charge()` call whose LEDGER WRITE commits
 * immediately but whose RESPONSE is slow (400-900ms). The caller uses a
 * short 150ms timeout (a reasonable choice on its own - see scenario:timeout).
 * The charge genuinely SUCCEEDED server-side, but the caller's timeout fires
 * first, so from the caller's point of view this looks exactly like a
 * failure. A naive retry (no reused idempotency key) therefore calls
 * `charge()` again - a REAL double charge, not a hypothetical one.
 *
 * How this differs from Lab 15 (`idempotency-and-deduplication`):
 * Lab 15's trigger is a lost HTTP RESPONSE between the server and an external
 * client (a proxy timeout, a dropped connection) - the server-side code never
 * had any timeout of its own; the loss happens somewhere in the network the
 * server doesn't control. THIS lab's trigger is the CALLER'S OWN timeout
 * racing a slow-but-successful downstream - the ambiguity is created by a
 * resilience mechanism the caller deliberately added (scenario:timeout),
 * not by an external failure. Both land in the exact same place - "the
 * caller cannot tell success from failure, so its retry must be safe either
 * way" - which is why the FIX is the same mechanism Lab 15 already
 * implements against Postgres (a stable idempotency key + a downstream that
 * recognizes a repeat and returns the cached result instead of re-applying
 * the effect), only here as an in-process `Map` instead of a `UNIQUE`
 * constraint - see this lab's README "Fix it" for why that substitution is
 * fine pedagogically but not for production.
 */
const log = createLogger("lab37:scenario:idempotency");

const CLIENT_TIMEOUT_MS = 150; // shorter than the downstream's ~400-900ms response time
const AMOUNT_CENTS = 1000;

async function naiveDoubleCharge(): Promise<void> {
  const downstream = new UnreliableDownstream({ seed: 42, health: "healthy" });

  log.info({ amountCents: AMOUNT_CENTS, clientTimeoutMs: CLIENT_TIMEOUT_MS }, "first attempt: charge the card");
  let firstChargeId: string | undefined;
  try {
    const result = await withTimeout(() => downstream.charge(AMOUNT_CENTS), CLIENT_TIMEOUT_MS);
    firstChargeId = result.chargeId; // would only happen if the response beat the timeout
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;
    log.info("client timed out waiting for a response - but the charge may have already succeeded server-side");
  }

  log.info("naive retry: no idempotency key was generated or reused, so this looks like a brand-new request");
  const retryResult = await withTimeout(() => downstream.charge(AMOUNT_CENTS), 2_000);

  console.log("\n--- idempotency: NAIVE retry (no reused key) ---");
  console.log(`first attempt's chargeId (if seen by caller): ${firstChargeId ?? "(caller never saw it - timed out)"}`);
  console.log(`retry's chargeId:                             ${retryResult.chargeId}`);
  console.log(`downstream ledger total:                      ${downstream.ledgerTotal} cents`);
  console.log(`charges applied downstream:                    ${downstream.chargesApplied}`);
  console.log(
    downstream.ledgerTotal === AMOUNT_CENTS * 2
      ? "DOUBLE CHARGE: the first attempt's charge genuinely succeeded server-side, then the naive retry " +
          "charged the card again - the customer was billed twice for one logical request."
      : "(unexpected - see README)",
  );

  log.info(
    { ledgerTotal: downstream.ledgerTotal, chargesApplied: downstream.chargesApplied },
    "naive double-charge scenario complete",
  );
}

async function fixedWithIdempotencyKey(): Promise<void> {
  const downstream = new UnreliableDownstream({ seed: 43, health: "healthy" });
  // Generated ONCE, before the first attempt, and reused across every retry -
  // the exact discipline Lab 15's naive-vs-fixed clients also hinge on.
  const idempotencyKey = randomUUID();

  log.info({ amountCents: AMOUNT_CENTS, idempotencyKey, clientTimeoutMs: CLIENT_TIMEOUT_MS }, "first attempt");
  try {
    await withTimeout(() => downstream.charge(AMOUNT_CENTS, idempotencyKey), CLIENT_TIMEOUT_MS);
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;
    log.info("client timed out - but this time the retry will reuse the SAME idempotency key");
  }

  const retryResult = await withTimeout(
    () => downstream.charge(AMOUNT_CENTS, idempotencyKey),
    2_000,
  );

  console.log("\n--- idempotency: FIXED retry (idempotency key reused) ---");
  console.log(`retry's chargeId:              ${retryResult.chargeId}`);
  console.log(`downstream ledger total:       ${downstream.ledgerTotal} cents`);
  console.log(`charges applied downstream:    ${downstream.chargesApplied}`);
  console.log(
    downstream.ledgerTotal === AMOUNT_CENTS && downstream.chargesApplied === 1
      ? "NO DOUBLE CHARGE: the downstream recognized the reused idempotency key and returned the ORIGINAL " +
          "charge instead of applying the effect a second time."
      : "(unexpected - see README)",
  );

  log.info(
    { ledgerTotal: downstream.ledgerTotal, chargesApplied: downstream.chargesApplied },
    "fixed idempotent-retry scenario complete",
  );
}

async function main(): Promise<void> {
  await naiveDoubleCharge();
  await fixedWithIdempotencyKey();
  process.exit(0);
}

main().catch((err: unknown) => {
  log.error({ err }, "idempotency scenario failed unexpectedly");
  process.exitCode = 1;
});
