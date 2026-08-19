/**
 * The simulated "network" between an independent sender and receiver.
 *
 * A real network/broker can fail in two DISTINCT places that matter for very
 * different reasons:
 *
 *   1. the outbound message itself never arrives ("message_lost") - the
 *      receiver never does anything, because it never heard about the
 *      message in the first place.
 *   2. the message arrives and the receiver genuinely processes it, but the
 *      acknowledgment on the way back to the sender is lost ("ack_lost") -
 *      the receiver DID do the work; the sender just never finds out.
 *
 * From the sender's point of view these two failures are indistinguishable
 * (no ack arrived either way), which is exactly why at-least-once retrying
 * can cause real duplicate processing: it cannot tell "you never got my
 * message" apart from "you got it, I just didn't hear back."
 *
 * The outcome for each attempt is a plain, deterministic, seed-controlled
 * script - not randomness - so every run of a scenario produces the exact
 * same delivery_log rows and the exact same receiver-side counts. That is
 * what makes this lab's captured numbers reproducible.
 */
export type NetworkOutcome = "message_lost" | "ack_lost" | "success";

export interface NetworkScript {
  /** outcome for attempt N (1-indexed). Attempts beyond the array's length
   * repeat the last configured outcome. */
  outcomes: NetworkOutcome[];
}

export function outcomeForAttempt(script: NetworkScript, attemptNumber: number): NetworkOutcome {
  if (script.outcomes.length === 0) {
    throw new Error("NetworkScript.outcomes must contain at least one outcome");
  }
  const index = Math.min(attemptNumber - 1, script.outcomes.length - 1);
  return script.outcomes[index]!;
}
