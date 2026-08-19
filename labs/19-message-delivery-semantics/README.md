# Lab 19 - Message Delivery Semantics

## Why this exists

Labs 16-18 built a transactional outbox, a `SKIP LOCKED` publisher, and an
idempotent inbox consumer - three pieces of a real messaging pipeline. This
lab steps back from any one piece and asks the question those labs were all
implicitly answering piece by piece: what does "exactly once" actually mean,
and is it a real thing a broker can give you? The honest answer is no - not
in the pure transport sense. What is real, and achievable, is **effectively
once**: at-least-once delivery (which can and does genuinely duplicate
messages) composed with an idempotent receiver (which makes the duplicate
delivery harmless). This lab builds all three delivery semantics - at-most-
once, at-least-once, and effectively-once - side by side, against the same
simulated network, so the difference between them is a real, queryable fact
in a database table, not a slide with three bullet points.

## Learning objectives

After this lab you should be able to:

- explain precisely what at-most-once, at-least-once, and effectively-once
  each guarantee, and - just as importantly - what each one does NOT
  guarantee;
- distinguish the two distinct places a message delivery can fail - the
  outbound message itself being lost, versus the acknowledgment on the way
  back being lost - and explain why a sender cannot tell them apart;
- explain why ACKNOWLEDGMENT loss, not message loss, is the real mechanism
  that produces duplicates in at-least-once systems in production;
- point to the exact place in this lab's own code where an idempotent
  receiver, given the identical transport-level duplicate delivery a naive
  receiver sees, produces a business-visible effect exactly once instead of
  twice - a captured run, not a claim;
- state, without hedging, that "effectively once" is at-least-once delivery
  PLUS an idempotent receiver, composed across two boundaries - never a
  single mechanism, and never something a broker setting alone can provide.

## Architecture

```text
notifications (id, public_id, recipient, body, scenario, status,
               receiver_processed_count)
      ▲
      │ message_id
      ├──────────── delivery_log (one row per delivery ATTEMPT:
      │              attempt_number, outcome, delivered_at)
      │
      └──────────── processed_message_ids (message_id UNIQUE - the inbox/
                     idempotency table; only effectively-once.ts writes here)
```

```text
sender (src/delivery/sender.ts)
   │  sendOnce() / sendWithRetry()
   ▼
simulated network (src/delivery/network.ts)
   │  deterministic, seed-controlled outcome per attempt:
   │  "message_lost" | "ack_lost" | "success"
   ▼
receiver (src/delivery/receiver.ts)
   │  naiveProcessMessage()        <- at-most-once.ts, at-least-once.ts
   │  idempotentProcessMessage()   <- effectively-once.ts
   ▼
notifications.receiver_processed_count  (the business-visible effect)
```

Domain: a fresh, self-contained "notification platform" domain (recipient +
body + delivery status) - not one of SPEC.md 8.2's five named domains and not
imported from Labs 16-18, per the independent-labs principle, even though
those labs are this one's closest conceptual predecessors. See
`src/db/schema.ts` for the full rationale.

There is no real broker here (RabbitMQ, Kafka, SQS): per CLAUDE.md's
infrastructure-minimalism guidance, a real broker is only worth adding "for
messaging labs where a real broker materially improves the exercise." This
lab's subject is the SEMANTICS of retry/ack/duplicate handling, which is
fully reproducible against a deterministic in-process function - see
`src/delivery/network.ts`.

`src/delivery/sender.ts`'s `sendWithRetry` is used, byte-for-byte identical,
by BOTH `at-least-once.ts` and `effectively-once.ts`. The only thing that
differs between those two scenarios is which receiver function is passed in
(`naiveProcessMessage` vs `idempotentProcessMessage`) - this is the concrete
expression of "effectively-once is composed, not a separate mechanism."

## Setup

```bash
pnpm install
cp labs/19-message-delivery-semantics/.env.example labs/19-message-delivery-semantics/.env
cd labs/19-message-delivery-semantics
docker compose up -d
pnpm db:generate   # only needed if you change src/db/schema.ts - migrations are already checked in
pnpm db:migrate
pnpm seed --seed=42 --size=small
```

Open PGweb at http://localhost:8419 (auto-connects via
`PGWEB_DATABASE_URL`). After `pnpm seed`, `notifications` has 5 rows (one per
scenario case) and `delivery_log` has rows recording exactly how many
attempts each one took.

## Scenario

A notification service needs to send a message to a recipient. Between the
sender and the receiver sits an unreliable network: it can drop the outbound
message, drop the acknowledgment on the way back, or deliver cleanly. The
sender's only decision is how many times to try and what to do about
duplicates. Three different policies for that decision are this lab's three
scenarios.

## Prediction

Before running anything, predict:

1. Under at-most-once (send once, never retry), if the network drops the
   message, what happens? Does anything in the system ever notice and try
   again?
2. Under at-least-once with a bounded retry, if the network drops the
   *acknowledgment* (not the message) on attempt 1, does the receiver process
   the message once or twice? Why can the sender not tell this case apart
   from a genuinely lost message?
3. If a receiver keeps a table of message ids it has already processed and
   checks it before applying any business effect, does that stop the sender
   from retrying and the transport from delivering the message twice? What
   exactly does it stop instead?
4. Is there a delivery mechanism in this lab (or in a typical production
   message broker) that delivers a message exactly one time, at the
   transport level, with no possibility of loss or duplication? If not, what
   is actually achievable?

## Exercise

1. Run the setup commands above.
2. Run each scenario script in order and read the log output:
   ```bash
   pnpm scenario:at-most-once
   pnpm scenario:at-least-once
   pnpm scenario:effectively-once
   ```
3. Run `pnpm dev` and look at `byScenario` - compare
   `totalDeliveryAttempts` (transport-level) against
   `totalReceiverProcessedCount` (business-level) for each scenario.
4. Run `pnpm test` and read through
   `tests/integration/{at-most-once,at-least-once,effectively-once}.test.ts` -
   these assert the exact counts below as real, automated checks, not prose.

## Observe

- **PGweb** (http://localhost:8419): open `delivery_log` and filter by
  `message_id` for any row in `notifications` - count the attempts by eye and
  compare against `notifications.receiver_processed_count` for the same
  message.
- **`docker compose logs postgres`**: `log_statement=all` makes every
  `INSERT INTO delivery_log` and every `INSERT INTO processed_message_ids`
  visible in order - in the effectively-once case, watch the second
  `INSERT INTO processed_message_ids` execute and affect zero rows (the
  `ON CONFLICT DO NOTHING` firing).
- **Structured logs**: every scenario script logs
  `deliveryLogRows`/`receiverProcessedCount` as fields, so the gap between
  "how many times did the transport try" and "how many times did the
  business effect actually apply" is a number in the log line, not something
  you compute by hand.
- **`SELECT * FROM processed_message_ids;`**: only ever has rows written by
  `effectively-once.ts` - a direct, visible marker of which scenario is
  actually idempotent.

## Break it

Run:

```bash
pnpm scenario:at-least-once
```

Real captured output from this lab's own validation run:

```text
--- (a) message-loss then success: the 'normal path' people assume ---
1 lost attempt + 1 successful attempt = 2 delivery_log rows, receiver saw it exactly once
  messageId: 13   deliveryLogRows: 2   receiverProcessedCount: 1

--- (b) ack-loss: the real mechanism that produces duplicates ---
DUPLICATE: both attempts genuinely reached the receiver - the naive receiver applied the business effect twice
  messageId: 14   deliveryLogRows: 2   receiverProcessedCount: 2
```

Case (a) is the case people picture when they hear "at-least-once retries
until it works": one lost attempt, one successful attempt, the receiver only
ever saw the message once, because the failed attempt never reached it.

Case (b) is the real, and more important, mechanism: the message was
delivered and genuinely processed on attempt 1 - the receiver did real work -
but the acknowledgment travelling back to the sender was lost. The sender
has no way to distinguish "you never got my message" from "you got it, I
just didn't hear back," so it retries. The retry reaches the receiver again,
which has no memory of attempt 1, and processes the identical message a
second time. `receiver_processed_count = 2` is a real, queryable duplicate -
this is `effectively-once.ts`'s "naive baseline" that the fix addresses.

For contrast, `pnpm scenario:at-most-once` shows the opposite failure mode -
no duplicates, but no delivery guarantee either:

```text
--- 1. at-most-once, message dropped in transit ---
LOST FOREVER: no retry ever happens under at-most-once - the receiver never saw this message
  messageId: 11   deliveryLogRows: 1   receiverProcessedCount: 0

--- 2. at-most-once, message never dropped ---
delivered exactly once, cleanly - the happy path at-most-once is usually pitched as
  messageId: 12   deliveryLogRows: 1   receiverProcessedCount: 1
```

## Fix it

Run:

```bash
pnpm scenario:effectively-once
```

Real captured output, using the IDENTICAL ack-loss network script
(`["ack_lost", "success"]`) and the IDENTICAL `sendWithRetry` mechanism as
`at-least-once.ts`'s case (b) above:

```text
--- effectively-once: identical ack-loss interleaving as at-least-once.ts's case (b) ---
receiver invoked   messageId: 15   attemptNumber: 1   applied: true
receiver invoked   messageId: 15   attemptNumber: 2   applied: false
FIXED: transport still shows 2 delivery attempts, but the business-visible effect happened exactly once
  messageId: 15   deliveryLogRows: 2   receiverProcessedCount: 1
```

`deliveryLogRows: 2` - the duplicate delivery is NOT eliminated. The
transport genuinely retried and genuinely re-delivered the message, exactly
as it did in the naive case. What changed is `applied: false` on attempt 2:
the receiver's `INSERT INTO processed_message_ids (message_id) VALUES ($1)
ON CONFLICT (message_id) DO NOTHING` found the row from attempt 1 already
there, inserted nothing, and skipped incrementing
`receiver_processed_count`. `receiverProcessedCount: 1` where the naive
receiver, given the exact same interleaving, produced `2`.

`pnpm test` captures both the bug and the fix as real assertions, including a
direct side-by-side test that runs the naive and idempotent receivers against
the identical ack-loss script and asserts `2` vs `1`:

```text
✓ tests/integration/at-most-once.test.ts (2 tests) 33ms
✓ tests/integration/at-least-once.test.ts (2 tests) 79ms
✓ tests/integration/effectively-once.test.ts (2 tests) 104ms

Test Files  3 passed (3)
     Tests  6 passed (6)
```

## Why the fix works

`processed_message_ids.message_id` is `UNIQUE`. The receiver claims a message
id and applies its business effect inside the SAME transaction:

```sql
BEGIN;
INSERT INTO processed_message_ids (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING;
-- only if the insert above actually inserted a row:
UPDATE notifications SET receiver_processed_count = receiver_processed_count + 1 WHERE id = $1;
COMMIT;
```

Because the claim and the effect commit together, there is no window where a
crash between them could let a retry either skip an effect it should apply
or apply an effect it should skip. The second genuine delivery of the same
message finds its id already claimed, the `INSERT` affects zero rows, and the
`UPDATE` never runs. This is exactly the pattern Lab 18 (inbox pattern) would
build out in full - built fresh, minimally, here.

Critically, nothing about the SENDER changed between `at-least-once.ts` and
`effectively-once.ts` - both call the exact same `sendWithRetry` function
with the exact same network script. The fix lives entirely on the receiver
side. This is the core lesson: retries and duplicate delivery are a property
of the TRANSPORT, and idempotency is a property of the RECEIVER; you cannot
fix one by only changing the other, and "effectively once" is what you get
when both are correct together.

## Tradeoffs

- **At-most-once is not "worse," it is a different tradeoff.** For data
  where a lost notification is cheap to shrug off and a duplicate would be
  actively harmful (e.g. "your card has been charged" sent twice), never
  retrying can be the right choice. This lab's at-most-once scenario shows
  the cost of that choice concretely: a real, permanently lost message with
  zero delivery_log evidence that a retry was even considered.
- **At-least-once without idempotency is not a smaller version of
  effectively-once - it is a different, riskier system.** The naive receiver
  in `at-least-once.ts` is not "effectively-once with a bug"; it is a
  complete, working at-least-once system that will duplicate side effects
  under ordinary ack loss, in production, at whatever rate your network drops
  acks.
- **Idempotency has a cost.** `idempotentProcessMessage` does one extra
  `INSERT` and holds a transaction open slightly longer than
  `naiveProcessMessage`'s single `UPDATE`. At the scale of a notification
  service this is negligible; at very high throughput, `processed_message_ids`
  itself becomes a table that needs an eviction/retention policy (see
  Production notes).
- **Idempotency keys must be chosen carefully.** This lab uses the message's
  own internal id, because the sender created the message row itself and the
  id is stable across retries. A system where the SAME logical message can be
  re-submitted under a *different* id (e.g. a user double-clicking "send")
  needs an idempotency key chosen by the caller, not a server-generated id -
  see Lab 15.
- **Backoff is real but simplified here.** `sendWithRetry`'s `backoffMs`
  is linear (`attempt * 20ms`) and deliberately tiny so the test suite stays
  fast and deterministic; production retry policies typically use
  exponential backoff with jitter (see Lab 37).

## Production notes

1. **What guarantee does this technique provide?** At-most-once: no
   duplicates, ever, at the cost of no delivery guarantee. At-least-once:
   the message is eventually delivered at least one time, as long as the
   sender keeps retrying within its bound, at the cost of possible
   duplicates. Effectively-once: the same at-least-once delivery guarantee,
   composed with a receiver that guarantees its OWN business effect applies
   at most once per message id.
2. **What does it not guarantee?** None of the three guarantee ordering
   between different messages, and effectively-once does not make the
   transport exactly-once - `delivery_log` in this lab's own effectively-once
   scenario always shows the real duplicate delivery, unchanged.
3. **What breaks under process crash?** A sender crash between recording a
   delivery attempt and receiving the ack looks, to the sender on restart,
   identical to an ack that was merely delayed or lost - it must retry either
   way, which is exactly why the receiver, not the sender, has to own
   deduplication.
4. **What breaks under network partition?** A partition is indistinguishable
   from message loss or ack loss from the sender's point of view - this lab's
   `NetworkOutcome` type collapses all three failure causes into the same two
   observable effects on purpose, because that collapse is real, not a
   simplification of this lab.
5. **What changes at high contention?** `processed_message_ids` needs an
   index on `message_id` (it has one implicitly via its `UNIQUE` constraint)
   to keep the idempotency check cheap as the table grows; at high message
   volume this table also needs a retention/archival policy, since it grows
   without bound otherwise.
6. **What changes with multiple regions?** Not covered by this lab -
   cross-region message delivery adds its own latency and ordering
   complications on top of everything here (see the replication phase for
   the closest analogous problem, applied to data instead of messages).
7. **What metrics would you monitor?** Retry count distribution per message
   (a rising p99 retry count usually means ack loss or receiver slowness, not
   message loss), `processed_message_ids` growth rate, and the ratio of
   `delivery_log` rows to distinct `message_id`s (a ratio near 1.0 means
   duplicates are rare; a ratio well above 1.0 means acks are being lost
   routinely and should be investigated as a network/receiver latency
   problem, not just tolerated).
8. **What simpler alternative could be used?** For at-most-once's specific
   risk (silent message loss), a periodic reconciliation job that finds
   `notifications` rows stuck at `status = 'undelivered'` past some age and
   re-sends them is a much smaller change than adopting full retry logic -
   though at that point you have built at-least-once anyway, just badly.
9. **When should you avoid this technique?** Avoid at-least-once without an
   idempotent receiver whenever the business effect is not naturally
   idempotent (charging a card, sending an SMS, decrementing inventory) -
   this lab's `at-least-once.ts` is exactly what that mistake looks like,
   captured as a real, asserted duplicate.

## Interview questions

1. Why can a sender never distinguish "the message was lost" from "the
   message was delivered but the acknowledgment was lost"? What does that
   force the sender's retry logic to do?
2. Is at-least-once delivery ever *not* the right choice, given that it can
   always be paired with an idempotent receiver to become effectively-once?
3. In this lab, `delivery_log` shows 2 rows for both the naive and idempotent
   ack-loss scenarios, but `receiver_processed_count` differs (2 vs 1). What
   does that tell you about which layer - transport or receiver - "owns"
   the exactly-once guarantee most systems actually want?
4. Why does `idempotentProcessMessage` perform the `INSERT INTO
   processed_message_ids` and the business `UPDATE` inside the SAME
   transaction, rather than checking first and updating second as two
   separate statements?
5. If you were told a production system claims "exactly-once delivery" via
   its message broker configuration alone, what question would you ask to
   find out whether that claim is actually true?
6. How would you choose the idempotency key for a receiver processing
   messages from a source that might resend the same logical event under a
   brand-new message id?

## Further experiments

- Change `at-least-once.ts`'s ack-loss script to
  `["ack_lost", "ack_lost", "success"]` and confirm `delivery_log` grows to 3
  rows and the naive receiver's count grows to 3 - duplicates are not capped
  at 2, they scale with however many acks get lost before one gets through.
- Set `retry.maxAttempts` to `1` in a scratch copy of the ack-loss scenario
  and confirm the system degrades to exactly at-most-once's behavior - a
  concrete way to see at-most-once as "at-least-once with zero retries," not
  a separate mechanism.
- Add a fourth, deliberately broken "fix" attempt: have the SENDER (not the
  receiver) check `delivery_log` for a prior successful attempt before
  retrying, instead of making the receiver idempotent. Try to construct an
  interleaving where this still double-processes - it should be possible,
  because the check and the retry are not atomic with the receiver's actual
  processing. This is why idempotency belongs on the receiver.
- Increase `pnpm seed --size=large` (20 independent instances of each
  scenario) and confirm the invariant holds identically across all 20 -
  `receiver_processed_count` should be exactly 0, 1, 1, 2, 1 for
  at_most_once_lost / at_most_once_clean / at_least_once_message_loss /
  at_least_once_ack_loss / effectively_once_ack_loss respectively, every
  single time.
- Try making `processed_message_ids` NOT unique (drop the constraint in a
  scratch migration) and rerun `effectively-once.ts` - confirm the "fix"
  silently stops working and `receiver_processed_count` goes back to 2, since
  the whole guarantee depends on that single `UNIQUE` constraint.
