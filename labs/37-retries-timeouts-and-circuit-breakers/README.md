# Lab 37 - Retries, Timeouts, and Circuit Breakers

## Why this exists

Every backend service eventually calls another service that is sometimes
slow, sometimes down, and sometimes flat-out broken. Three distinct
mechanisms exist to make that call survivable, and getting any one of them
wrong makes things worse, not better:

- **No timeout** means one slow downstream call can tie up a caller
  indefinitely - not "a while", literally as long as the downstream (or the
  OS/library default, which is often unbounded) takes to respond.
- **Naive retries** - retrying immediately, with no backoff, the moment a
  call fails - turn a struggling downstream into a dead one, by multiplying
  the exact request volume that is already overwhelming it.
- **Retries without idempotency** can silently double an effect that already
  happened: the downstream did the work and even committed it durably, but
  the caller never found out, because the RESPONSE - not the work - is what
  got lost or delayed.
- **No circuit breaker** means a caller keeps re-attempting (even with
  perfect backoff) a downstream that is clearly, structurally down, wasting
  every attempt's own timeout budget instead of recognizing "stop calling
  this for a while" the moment that becomes obvious.

This lab builds a real, seeded, deterministic-but-realistic unreliable
downstream and demonstrates all four problems - and their fixes - with real
measured numbers, not descriptions of what would happen.

## Learning objectives

After this lab you should be able to:

- explain, with real captured numbers, why a missing timeout ties up a
  caller for a downstream's full delay, and implement a timeout that bounds
  the caller's worst-case wait instead;
- explain precisely why naive, no-backoff, retry-everything logic amplifies
  load during an outage - and calculate the exact amplification factor for
  a given caller count and retry count;
- implement exponential backoff with full jitter, and explain what "jitter"
  is actually for (spreading out synchronized retries, not just adding
  randomness for its own sake);
- state precisely what "transient" means for retry purposes, and implement
  a retry policy that never retries a non-transient failure no matter how
  many attempts remain;
- reproduce a REAL idempotency double-effect bug (a downstream charge that
  succeeded, but whose response the caller's own timeout discarded) and fix
  it with a reused idempotency key - and explain how this failure mode
  differs from Lab 15's;
- implement a real closed/open/half-open circuit breaker state machine, and
  explain why its OPEN state must reject calls WITHOUT attempting the
  downstream at all, rather than merely failing fast after a quick attempt;
- explain why, when composing all three mechanisms, the circuit breaker must
  be OUTERMOST and retries must run INSIDE its "one logical attempt" - not
  the other way around.

## Architecture

```text
scenario script
  -> CircuitBreaker.execute(fn)          <- OUTERMOST: can reject before
       -> retryWithBackoff(attempt =>       attempting anything at all
            withTimeout(() =>
              downstream.call(...)        <- INNERMOST: the actual work,
            , timeoutMs)                     bounded per attempt
          , retryOpts)
       )
```

**Why no database, and no Docker Compose.** Retries, timeouts, and circuit
breakers are entirely CLIENT-SIDE, in-process concerns - they govern how a
caller behaves toward a downstream dependency, not how data is stored. This
lab's "downstream" is a real, seeded, in-process async class
(`UnreliableDownstream`), not a mock that returns canned values: it has real
configurable latency, real seeded probabilistic failure injection, and a
real internal ledger that a retry can genuinely double-write to. Per
CLAUDE.md's own allowance ("if you determine no Postgres/Redis/other
datastore is genuinely needed... it is acceptable to have a minimal or no
docker-compose.yml"), this lab has neither a `docker-compose.yml` nor a
`.env.example` - there is no database connection string or service to
configure. `pnpm lab:start 37` / `pnpm lab:stop 37` / `pnpm lab:reset 37`
(the root Docker-Compose-driven helpers) do not apply to this lab for the
same reason; use `pnpm test` / `pnpm dev` / the `pnpm scenario:*` commands
directly, or `pnpm lab:test 37` from the repo root (which just runs
`pnpm test` in this directory and works normally).

**The simulated downstream** (`src/downstream/unreliable-downstream.ts`) is
seeded (mulberry32 PRNG) so every scenario and test is reproducible. It has
four `health` modes:

- `healthy` - fast, reliable success.
- `degraded` - a realistic seeded mix of fast success / slow success /
  transient error / non-transient error.
- `down-fail-fast` - every call fails immediately (models a downstream that
  is down but at least says so right away - e.g. connection refused).
- `down-hang` - every call takes `hangMs` (default 5000ms, standing in for
  "unacceptably, unboundedly long") before eventually succeeding (models an
  overloaded, not crashed, downstream).

A separate `charge()` method models a payment-processor-style call whose
LEDGER WRITE commits immediately but whose RESPONSE is deliberately slow -
this is what makes the idempotency scenario a real, reproducible bug rather
than a thought experiment.

**Library modules** (`src/lib/`):

- `timeout.ts` - `withTimeout(fn, ms)`, a `Promise.race`-based bound on how
  long a caller waits. See "Production notes" for what it does NOT stop.
- `retry.ts` - `retryWithBackoff(fn, opts)`, exponential backoff with FULL
  jitter (`delay = random(0, min(maxDelayMs, baseDelayMs * 2^(attempt-1)))`,
  the same algorithm AWS's "Exponential Backoff And Jitter" architecture
  post popularized), gated by an `isRetryable` predicate.
- `circuit-breaker.ts` - `CircuitBreaker`, a real CLOSED/OPEN/HALF_OPEN state
  machine with an injectable clock (for deterministic tests) and an
  `onStateChange` hook (for observable, logged transitions).

No `@labs/data-generators`/Drizzle/`pg` dependency exists in this lab's
`package.json` - there is no relational domain to seed (per the task's own
framing, "a simulated downstream API call is fine as flavor text without
needing a full relational domain").

## Setup

```bash
pnpm install
cd labs/37-retries-timeouts-and-circuit-breakers
pnpm typecheck
pnpm test
```

That's it - no `docker compose up`, no migrations, no seed step.

## Scenario

A client repeatedly needs to call an unreliable downstream (framed here as a
generic "place order / check inventory / charge card" API). The invariants
this lab protects, in order:

1. A caller's worst-case wait for one call is BOUNDED, not open-ended.
2. Retrying a failing downstream does not amplify load faster than the
   downstream can handle - and never retries a failure that retrying cannot
   fix.
3. A retry of an operation that already succeeded server-side never repeats
   its effect.
4. A downstream that is clearly, structurally down stops being called
   altogether until there is a real signal it might have recovered.

## Prediction

Before running anything, predict:

1. If a downstream call can hang for 5 seconds and a caller adds NO timeout,
   how long is the caller blocked for one such call?
2. 50 concurrent callers each retry a failing call up to 5 times immediately,
   with no backoff. How many total calls reach the downstream?
3. A downstream's ledger write happens instantly, but its response takes
   400-900ms. A caller times out after 150ms and retries with no reused
   idempotency key. What happens to the ledger?
4. A circuit breaker's failure threshold is 5. After it trips OPEN, does the
   6th call still reach the downstream? How long does the 6th call take
   compared to the 5th?

## Exercise

```bash
pnpm scenario:naive-hang       # 1. no timeout - real observed hang
pnpm scenario:retry-storm      # 2. naive retry - real amplification
pnpm scenario:timeout          # 3. the timeout fix - real bounded latency
pnpm scenario:backoff          # 4. backoff+jitter, transient-only
pnpm scenario:idempotency      # 5. real double-effect bug + fix
pnpm scenario:circuit-breaker  # 6. real closed/open/half-open transitions
pnpm scenario:composed         # 7. all three, correctly layered
pnpm test                      # 8. every invariant above, as assertions
```

## Observe

- **Structured logs** (Pino, via `@labs/logging`): every scenario logs
  through `createLogger`, including every circuit-breaker state transition
  (`from`/`to`/`reason`) and every retry attempt's computed backoff delay -
  timing and state are fields in the log line, not something to infer.
- **`downstream.totalCallCount`**: every scenario prints this - it is the
  ground truth for "how many times did we actually hit the downstream",
  independent of how many logical `execute()`/retry-loop calls the client
  code made.
- **`downstream.ledgerTotal` / `downstream.chargesApplied`**: the
  idempotency scenario's ground truth for whether a side effect happened
  once or twice - not just "did the code run twice" but "did the EFFECT
  happen twice".

## Break it

### No timeout: a real, measured hang

```bash
pnpm scenario:naive-hang
```

Real captured output from this lab's own validation run:

```text
caller was blocked for: 5002ms
```

The downstream took 5000ms to respond; the caller, having added no timeout
at all, was blocked for the entire duration - `5002ms`, matching the
downstream's configured delay almost exactly (the 2ms difference is
scheduling/logging overhead). In production this number is not "5 seconds" -
it is whatever the OS TCP stack or HTTP client library defaults to, which is
frequently either unbounded or measured in minutes, not something the
application chose on purpose.

### Naive retry storm: real amplification

```bash
pnpm scenario:retry-storm
```

Real captured output:

```text
concurrent callers:        50
naive retries per caller:  5
expected downstream calls: 250
ACTUAL downstream calls:   250
amplification factor:      5.0x per logical request
wall clock:                124ms
```

The downstream was down the ENTIRE time (every one of the 250 calls failed).
The naive retry logic - no backoff, no restraint - amplified 50 logical
requests into exactly 250 real downstream calls, in only 124ms, meaning the
already-failing downstream was hit at roughly 2,000 calls/second by a client
that thought it was being "resilient." `tests/integration/retry-storm.test.ts`
asserts this exact count (`250`), not an approximation.

### Idempotency double-effect: a real double charge

```bash
pnpm scenario:idempotency
```

Real captured output:

```text
--- idempotency: NAIVE retry (no reused key) ---
first attempt's chargeId (if seen by caller): (caller never saw it - timed out)
retry's chargeId:                             ch_2
downstream ledger total:                      2000 cents
charges applied downstream:                    2
DOUBLE CHARGE: the first attempt's charge genuinely succeeded server-side,
then the naive retry charged the card again - the customer was billed twice
for one logical request.
```

The first `charge()` call committed its ledger write immediately (this is
what "the operation succeeded" means here), but its RESPONSE took
400-900ms - longer than the caller's 150ms timeout. The caller saw a
`TimeoutError` and, having no idempotency key to reuse, treated the retry as
a brand-new request. `downstream.ledgerTotal` (2000 cents, twice the
1000-cent charge) and `downstream.chargesApplied` (2) are the ground truth:
this is not "the code ran the function twice", it is "the customer was
billed twice."

**How this differs from Lab 15.** Lab 15 (`idempotency-and-deduplication`)
reproduces a lost HTTP RESPONSE between the server and an external client -
a proxy timeout, a dropped connection, something outside the server's own
control. This lab's trigger is different: the CALLER's OWN timeout (a
resilience mechanism it deliberately added, see `scenario:timeout`) races a
downstream that is slow but genuinely succeeding. The ambiguity here is
self-inflicted by adding a timeout, not caused by an external network
failure. Both land in exactly the same place - "the caller cannot tell
success from failure, so retrying must be made safe either way" - which is
why the fix is the identical mechanism.

## Fix it

### Timeouts: a real bounded worst case

```bash
pnpm scenario:timeout
```

Real captured output, same overloaded downstream, `withTimeout(fn, 200)`
added:

```text
configured timeout:        200ms
downstream's real delay:   5000ms per call (unchanged - it is still just as overloaded)
p50 caller-observed latency: 202.0ms
p99 caller-observed latency: 203.0ms
max caller-observed latency: 203.0ms
```

Every one of 20 calls against the identical 5000ms-hanging downstream now
returns in ~200ms - a real, measured **~25x reduction** in worst-case
latency (5000ms -> 203ms max), simply by bounding how long the CALLER
waits. `tests/unit/timeout.test.ts` asserts this bound directly (elapsed
time close to, never far past, the configured timeout).

### Retries with backoff, for transient failures only

```bash
pnpm scenario:backoff
```

Real captured output (a downstream that fails 3 times then recovers,
retried with `baseDelayMs=100`, `maxDelayMs=2000`):

```text
succeeded on attempt: 4
recorded backoff delays (ms): 7.3, 140.7, 361.1
```

The delay CEILING doubles each attempt (100 -> 200 -> 400), but the actual
delays drawn from `[0, ceiling)` - 7.3ms, 140.7ms, 361.1ms - are neither
identical multiples of each other nor deterministically half/double the
previous one. That is full jitter: it grows the same envelope naive
exponential backoff does, but spreads concurrent retriers out instead of
letting them all retry in lockstep (the same synchronized-thundering-herd
problem `scenario:retry-storm` demonstrates at zero backoff).

The same script also proves the OTHER half of "transient failures only":

```text
--- backoff-jitter: non-transient failure is NEVER retried ---
configured maxAttempts: 5
ACTUAL downstream calls made: 1
error: NonTransientDownstreamError - correctly not retried, even though 4
attempts remained, because isRetryable() returned false.
```

A validation-style rejection (`NonTransientDownstreamError`, standing in for
e.g. "invalid card number") is called exactly once, even with 4 attempts
still available - retrying it can never succeed, so `isRetryable()` refuses.
This is the precise line CLAUDE.md's Idempotency section and this lab's
brief both draw: TRANSIENT means "the caller genuinely doesn't know whether
it worked, and trying again is a reasonable recovery strategy" - it does not
mean "any failure at all", which is exactly what `scenario:retry-storm`'s
naive client gets wrong.

### Idempotency key: no double effect

```bash
pnpm scenario:idempotency
```

Real captured output, same setup, only difference: the client generates ONE
idempotency key up front and reuses it on retry:

```text
--- idempotency: FIXED retry (idempotency key reused) ---
retry's chargeId:              ch_1
downstream ledger total:       1000 cents
charges applied downstream:    1
NO DOUBLE CHARGE: the downstream recognized the reused idempotency key and
returned the ORIGINAL charge instead of applying the effect a second time.
```

`ledgerTotal` stayed at 1000 cents and `chargesApplied` stayed at 1 - the
retry's `chargeId` (`ch_1`) is the SAME charge the first attempt created,
not a new one. This is exactly Lab 15's mechanism
(`INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` +
fallback `SELECT`), reused conceptually rather than re-derived: a stable key
plus a check-or-return-existing operation that the downstream treats
atomically. Here it is a plain in-process `Map` inside
`UnreliableDownstream.charge()` instead of a Postgres `UNIQUE` constraint,
because this lab has no database - **that substitution is fine for teaching
the concept and NOT fine for production**: a `Map` is neither durable across
a process restart nor safe to share across multiple server instances, which
is exactly why Lab 15's real implementation lives in Postgres.

### Circuit breaker: real state transitions

```bash
pnpm scenario:circuit-breaker
```

Real captured output, `failureThreshold: 5`, `cooldownMs: 300`:

```text
--- circuit-breaker: tripping to OPEN ---
  call 1: 19ms - downstream error
  call 2: 20ms - downstream error
  call 3: 21ms - downstream error
  call 4: 21ms - downstream error
  call 5: 28ms - downstream error
  call 6: 0ms - fast-failed (breaker OPEN)
  call 7: 0ms - fast-failed (breaker OPEN)
  call 8: 0ms - fast-failed (breaker OPEN)
breaker state after 8 calls: OPEN
downstream.totalCallCount:   5 (threshold was 5)
```

Calls 1-5 genuinely reached the downstream (19-28ms each, its real
configured latency) and tripped the breaker on the 5th consecutive failure.
Calls 6, 7, and 8 were rejected in **0ms** - not "fast", literally
sub-millisecond, because the breaker never attempted the downstream at all.
`downstream.totalCallCount` stayed at exactly 5 even though 8 calls were
made - 3 of them never touched the downstream. This is the real, measured
contrast the brief asks for: 0ms fast-fail vs. `scenario:timeout`'s
203ms timeout-bound worst case - OPEN doesn't wait for a timeout to elapse,
it doesn't attempt the call in the first place.

```text
--- circuit-breaker: HALF_OPEN probe succeeds, closes ---
breaker state after successful probe: CLOSED
downstream calls made by the probe: 1 (exactly 1 expected)

--- circuit-breaker: HALF_OPEN probe fails, reopens ---
breaker state after re-failing: OPEN
breaker state after a FAILED probe: OPEN (expected OPEN again)
```

With structured logging of every transition:

```text
{"from":"CLOSED","to":"OPEN","reason":"failure threshold reached","consecutiveFailures":5}
{"from":"OPEN","to":"HALF_OPEN","reason":"cooldown elapsed"}
{"from":"HALF_OPEN","to":"CLOSED","reason":"probe succeeded"}
{"from":"CLOSED","to":"OPEN","reason":"failure threshold reached","consecutiveFailures":5}
{"from":"OPEN","to":"HALF_OPEN","reason":"cooldown elapsed"}
{"from":"HALF_OPEN","to":"OPEN","reason":"probe failed"}
```

After the 300ms cooldown elapsed and the (now-healthy) downstream was
probed, exactly ONE call reached the downstream and the breaker closed. A
second run against a downstream that was STILL down let the probe through
after cooldown, watched it fail, and reopened immediately -
`tests/unit/circuit-breaker.test.ts` asserts every one of these transitions
with a fake, fully deterministic clock (no real sleeping required for the
unit tests; the scenario script itself sleeps for real to show it working
end-to-end).

### Tie it together: correct layering

```bash
pnpm scenario:composed
```

Real captured output, `failureThreshold: 4`, `maxAttempts: 3` per retry
sequence, sustained outage:

```text
  execute() #1: breaker=CLOSED, downstream calls this attempt sequence: 3
  execute() #2: breaker=CLOSED, downstream calls this attempt sequence: 3
  execute() #3: breaker=CLOSED, downstream calls this attempt sequence: 3
  execute() #4: breaker=OPEN,   downstream calls this attempt sequence: 3
  execute() #5: breaker=OPEN,   downstream calls this attempt sequence: 0
  execute() #6: breaker=OPEN,   downstream calls this attempt sequence: 0

breaker opened after 4 FAILED execute() calls (each one containing up to 3
internal retries) - not after 4 individual downstream attempts. Total
downstream calls actually made: 12, vs. the 18 it would have been with NO
breaker at all.
```

This is the concrete evidence for why layering order matters:

1. **The breaker counts LOGICAL operations, not individual downstream
   attempts.** It tripped after 4 FAILED `execute()` calls - each one
   representing an entire exhausted retry-with-backoff sequence - not after
   4 raw downstream failures (which happened at call #2 within the very
   first `execute()`). If retries wrapped the breaker instead of the other
   way around, every individual retry attempt would separately consult (and
   could separately trip or re-trip) the breaker, corrupting exactly this
   count.
2. **Once OPEN, execute() #5 and #6 made ZERO downstream calls** - not "1
   quick attempt then give up", zero. Retries and timeouts never even ran.
   Total downstream calls for this run: 12, against 18 a caller with no
   breaker at all would have made for the same 6 logical requests
   (`6 x 3 = 18`) - a real, measured 33% reduction, growing without bound
   the longer an outage lasts.
3. **The timeout lives INSIDE each retry attempt**, not around the whole
   retry sequence - each individual attempt gets its own bounded worst case,
   so one global timeout can never cut off a LATER attempt that would have
   succeeded quickly.

Recovery: once the downstream healed and the cooldown elapsed, the breaker's
own HALF_OPEN probe (itself a full timeout+retry attempt) succeeded, closing
the breaker (`from: OPEN, to: HALF_OPEN, reason: cooldown elapsed` then
`from: HALF_OPEN, to: CLOSED, reason: probe succeeded`, both real captured
log lines from this run).

## Why the fix works

- **Timeout**: `Promise.race` between the real call and a timer bounds how
  long the CALLER waits, regardless of how long the downstream actually
  takes - the caller's own code, not the downstream's behavior, decides the
  worst case.
- **Backoff + jitter**: exponential growth reduces how often a struggling
  downstream is hit as failures continue; jitter (drawing a RANDOM delay
  from `[0, ceiling)` rather than using the ceiling itself) prevents many
  concurrent callers who failed at the same moment from all retrying at the
  same moment again, which is what naive fixed-delay backoff still allows.
- **Idempotency key**: moves the "did this already happen" question from
  "can the client tell" (it provably cannot, in this lab's own reproduced
  bug) to "does the downstream have a durable, keyed record of it" - the
  downstream, not the client, is the source of truth for whether the effect
  already ran, exactly as CLAUDE.md's "prefer datastore-native guarantees"
  principle argues (Lab 15's version enforces this with a real Postgres
  `UNIQUE` constraint; this lab's in-process `Map` is the same shape, minus
  the durability).
- **Circuit breaker**: converts "keep trying and hope" into an explicit,
  observable state machine. OPEN exists specifically so that "the downstream
  is down" becomes a FACT the caller acts on immediately, rather than
  something rediscovered on every single attempt via a fresh timeout.

## Tradeoffs

- **A timeout that is too short cuts off calls that would have succeeded.**
  `scenario:idempotency`'s own bug is a direct consequence of a
  reasonable-looking 150ms timeout racing a downstream whose real (successful)
  response takes 400-900ms - the timeout itself is not wrong, but it creates
  exactly the ambiguity idempotency exists to resolve.
- **Backoff improves availability for the SYSTEM, not necessarily latency
  for one caller** - a caller that eventually succeeds on attempt 4 waited
  through 3 real delays to get there (`scenario:backoff`'s own
  ~509ms total wait, `7.3 + 140.7 + 361.1`), which is worse for that one
  request than a naive immediate retry would have been, IF the naive retry
  hadn't also been contributing to a retry storm.
- **A circuit breaker adds a new source of "the request failed" that has
  nothing to do with what the caller sent** - a well-formed, perfectly valid
  request is rejected while OPEN purely because OTHER recent calls failed.
  This needs to be a distinguishable, actionable error to callers (and
  ideally, monitoring), not folded into "generic downstream error."
- **A single-process, in-memory circuit breaker only protects the process it
  runs in.** Across N application instances, each has its own breaker state
  - one instance's breaker being OPEN does nothing to stop the other N-1
  from continuing to hammer the same downstream. A shared, cross-process
  breaker state needs external coordination (e.g. Redis, see Lab 22),
  which is a real added dependency this lab deliberately does not add.
- **The idempotency key's Map has no expiry.** Same caveat Lab 15's README
  documents for its `UNIQUE` index: an unbounded key store grows forever; a
  real implementation needs a retention policy.

## Production notes

1. **What guarantee does this mechanism provide?** A timeout guarantees a
   caller's own wait is bounded. Backoff-with-jitter guarantees retries do
   not grow request volume in lockstep during an outage. An idempotency key
   guarantees a specific keyed operation's effect happens at most once no
   matter how many times it is retried. A circuit breaker guarantees a
   downstream that is failing past a threshold stops receiving new calls
   until a bounded cooldown and a single successful probe.
2. **What does it not guarantee?** A timeout does not stop the downstream's
   own work from continuing (this lab's simulated downstream keeps "running"
   in the background after the caller gives up - see `scenario:timeout`'s
   own caveat). Backoff does not guarantee any individual request succeeds
   quickly. An idempotency key only protects the operation it is attached
   to - it does nothing for a second, unrelated side effect performed in the
   same request. A circuit breaker's state is local to the process it runs
   in (see "Tradeoffs").
3. **What breaks under process crash?** A crash mid-retry just means the
   next process/request starts its own fresh retry sequence - none of this
   lab's mechanisms carry state across a crash except the DOWNSTREAM's own
   idempotency-key record, which is exactly why that record, not client-side
   state, is what makes the retry safe.
4. **What breaks under network partition?** A caller that cannot reach a
   downstream at all looks identical, from the caller's point of view, to a
   downstream that is up but slow - both manifest as a timeout. This is
   precisely why a timeout-triggered retry must be idempotency-safe: the
   caller genuinely cannot distinguish "never arrived" from "arrived,
   processed, response lost."
5. **What changes at high contention / large scale?** Retry storms scale
   with caller count, not downstream capacity - this lab's 50-caller storm
   produced 250 calls; a real service with thousands of concurrent callers
   during an outage can produce request volumes many multiples of normal
   peak traffic, which is the single most common way a partial outage
   becomes a total one. Circuit breakers cap this at the failure threshold
   REGARDLESS of caller count, which is why they matter more, not less, at
   scale.
6. **What metrics would be monitored?** Circuit breaker state (a time
   series of CLOSED/OPEN/HALF_OPEN, and time spent in each), retry attempt
   count and success-after-N-retries rate, timeout rate (calls that hit the
   ceiling vs. completed normally), and - specific to idempotency - the rate
   of "idempotency key already seen" responses (a direct signal for how
   often retries are actually happening in production).
7. **When should this approach be avoided?** A circuit breaker adds real
   complexity and a new failure mode of its own (a wrongly-tripped breaker
   rejecting healthy traffic) - for a downstream with very low call volume
   or where failures are rare and cheap, plain timeout + bounded retry may
   be enough. Backoff-with-jitter should not be applied to genuinely
   time-sensitive synchronous user-facing requests where a fast, clear
   failure is better UX than a slow, eventually-successful one.

## Interview questions

1. Why does `Promise.race`-based timeout not stop the downstream's own work,
   and what would it take to actually cancel it?
2. Walk through the exact math: 50 concurrent callers, 5 retries each, no
   backoff, downstream fully down. How many downstream calls happen? What
   changes if backoff is added but the downstream is still fully down the
   entire time?
3. What specifically distinguishes a "transient" failure from one that
   should never be retried? Give an example of each from this lab's
   `UnreliableDownstream`.
4. In this lab's idempotency scenario, the downstream's ledger write commits
   BEFORE its slow response is even sent. Why does that ordering, by itself,
   create the double-charge bug - and what would change if the write
   happened only after the response was confirmed received (hint: what new
   problem would that create instead)?
5. Why must a circuit breaker's OPEN state reject calls WITHOUT invoking the
   downstream at all, rather than just attempting a very short timeout and
   failing fast that way?
6. In the composed scenario, the breaker trips after exactly 4 FAILED
   `execute()` calls, not after 4 raw downstream failures. Why does that
   distinction matter, and what would go wrong if retries wrapped the
   breaker instead of running inside it?
7. A circuit breaker's state lives in one process's memory. What breaks
   about that assumption once a service runs as 20 replicas behind a load
   balancer, and what would you reach for to fix it?

## Further experiments

- Change `retry-storm.ts`'s `ATTEMPTS_PER_CALLER` from 5 to 10 and confirm
  the amplification scales linearly (`downstream.totalCallCount` should be
  exactly `50 * 10 = 500`).
- Add a circuit breaker to `retry-storm.ts`'s naive client and measure how
  much the real downstream call count drops for the identical 50-caller
  burst - compare against this lab's own composed-scenario contrast
  (12 vs. 18 calls).
- In `backoff-jitter.ts`, change `random: jitterRandom` to `Math.random` and
  rerun a few times - confirm the delay CEILINGS are identical across runs
  (100, 200, 400) but the ACTUAL delays differ every time, since only the
  jitter source changed.
- In `circuit-breaker.ts`, add a rolling failure-RATE threshold (e.g. "50%
  of the last 20 calls failed") instead of consecutive-failure counting, and
  think through what new test would be needed to prove it trips at the
  right moment - and why a rolling window is harder to reason about than a
  simple consecutive counter.
- Extend `UnreliableDownstream.charge()` with a configurable response delay
  DISTRIBUTION (not just a fixed range) and re-run `scenario:idempotency`
  with several different client timeout values to find the exact timeout
  value where the double-charge bug stops reproducing reliably - then
  explain why "just pick a longer timeout" is a fragile fix compared to the
  idempotency key.
