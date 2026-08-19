# Lab 41 - System Design Drills

## Why this exists

Labs 01-40 each isolated one mechanism - a conditional write, an advisory
lock, `SKIP LOCKED`, an idempotency key, an outbox, a circuit breaker, a
replica topology - and proved, with a real running Postgres (and
occasionally Redis), exactly what that mechanism guarantees, what it does
not guarantee, and what it costs. That is deliberate practice at the
mechanism level.

System design interviews, and real system design work, do not hand you a
mechanism. They hand you a business problem ("never oversell a seat",
"never double-charge a customer") and expect you to (a) recognize which
invariant is actually at stake, (b) pick the smallest correct mechanism
for it from everything you know, and (c) explain, precisely, what that
choice does and does not protect against. That translation step - problem
to invariant to mechanism - is a distinct skill from implementing any one
mechanism, and it is the one skill this curriculum has not directly
practiced yet.

This lab is that practice. It is a synthesis lab, not a new application:
it poses eight realistic system-design prompts (the exact eight from
`SPEC.md`'s own Lab 41 brief) and, for each one, walks the same
eight-step process SPEC.md specifies - design, invariants, consistency
requirements, storage choice, concurrency mechanism, failure modes, scale
estimate, observability - while citing the specific lab, the specific
mechanism, and the specific real captured number that justifies each
choice. Nothing in a drill's model answer is restated from memory or
textbook theory; every claim traces back to a number or an error code this
repository's own labs actually produced.

## Learning objectives

After this lab you should be able to:

- given a one-paragraph system-design prompt, name the specific data
  invariant at stake before naming any technology;
- choose between a Postgres-native mechanism (constraint, transaction,
  conditional write, row lock, advisory lock, `SKIP LOCKED`) and an
  external coordination mechanism (Redis lock/lease, message broker,
  cache), and justify the choice by what guarantee the invariant actually
  needs, not by familiarity or fashion;
- recognize the recurring "common wrong answer" shape in system design
  interviews - reaching for a distributed lock, a cache, or a synchronous
  call where a datastore-native guarantee is simpler, cheaper, and more
  correct - and explain precisely why it is wrong using a mechanism this
  repository actually measured;
- compose multiple mechanisms from different labs into one coherent design
  (the same way Lab 40's capstone composed five mechanisms into one
  pipeline) and explain the order they must be applied in;
- state, for any mechanism you propose, what it guarantees, what it does
  not guarantee, what happens on crash, what happens on retry, and what
  changes under high contention or across regions - the same discipline
  CLAUDE.md's "Documentation Quality" section requires of every lab in
  this repository, now applied to a design you produced yourself.

## Architecture

There is no application, no schema, no `docker-compose.yml`, and no
`.env.example` in this lab. Per CLAUDE.md's own allowance ("if a lab
determines no Postgres/Redis/other datastore is genuinely needed, it is
acceptable to have a minimal or no `docker-compose.yml`" - the same
allowance Lab 37 used), this lab needs neither: it produces no new
database behavior to observe, only reasoning about behavior every earlier
lab already produced. `pnpm lab:start 41` / `pnpm lab:stop 41` /
`pnpm lab:reset 41` (the root Docker-Compose-driven helpers) do not apply
here for the same reason `pnpm lab:start 37` does not apply to Lab 37;
`pnpm lab:test 41` from the repo root works normally, since that action
just runs `pnpm test` in this directory.

```text
labs/41-system-design-drills/
├── README.md              <- this file: how to use the lab
├── drills/
│   ├── 01-ticketmaster-booking.md
│   ├── 02-payroll-processing.md
│   ├── 03-payment-api.md
│   ├── 04-distributed-job-scheduler.md
│   ├── 05-notification-platform.md
│   ├── 06-webhook-delivery-service.md
│   ├── 07-inventory-reservation.md
│   └── 08-multi-region-saas-backend.md
├── src/
│   └── check-citations.ts <- walks drills/, verifies every "Lab NN"
│                              citation points at a lab that really exists
│                              under labs/, and verifies structural/
│                              breadth requirements (see "Exercise" below)
└── tests/
    └── citations.test.ts  <- runs the same checks as an assertion suite
```

The one piece of runnable code in this lab is deliberately small and
deliberately not a "quiz runner" or a grading engine: system-design
answers do not have a single machine-checkable correct answer, and
building a scoring engine for open-ended design reasoning would be exactly
the kind of unnecessary machinery CLAUDE.md's engineering-cost guidance
warns against. What IS machine-checkable, and worth checking automatically
so this lab does not silently drift out of sync with the other 40 as they
change, is: does every citation in every drill point at a lab that
actually exists, and does the set of drills as a whole actually cover a
broad cross-section of the curriculum's phases rather than concentrating
on one corner of it. `pnpm check` and `pnpm test` both run that check.

## Setup

```bash
pnpm install
```

That is the entire setup. No `.env`, no `docker compose up`, no
`db:migrate`, no `seed`. If you have not done so recently, skim the
READMEs of the labs a given drill cites before attempting that drill -
this lab assumes you have done Labs 01-40, or at minimum read their
READMEs and ROADMAP.md entries, and it does not re-explain a mechanism
Lab 12 or Lab 22 already explained in full.

## Scenario

Eight prompts, drawn directly from `SPEC.md`'s own Lab 41 brief, spanning
booking, payroll, payments, scheduling, notifications, webhooks,
inventory, and a large multi-region SaaS backend:

| # | Drill | Primary invariant | Labs most directly cited |
|---|-------|-------------------|---------------------------|
| 01 | Ticketmaster-style booking | never oversell a seat | 11, 12, 15, 21, 22, 25, 26, 36, 40 |
| 02 | Payroll processing | exactly-once payroll run per company/period | 02, 09, 13, 14, 15, 29, 30, 31 |
| 03 | Payment API | never double-charge a customer | 09, 15, 16, 17, 18, 19, 37 |
| 04 | Distributed job scheduler | each due job fires exactly the intended number of times | 13, 14, 15, 37 |
| 05 | Notification platform | attempt delivery, never spam, survive a slow provider | 16, 17, 18, 36, 37, 40 |
| 06 | Webhook delivery service | at-least-once delivery without a retry storm | 14, 17, 18, 19, 36, 37, 38 |
| 07 | Inventory reservation | never reserve more units than exist | 02, 10, 11, 12, 20, 21, 32 |
| 08 | Large multi-region SaaS backend | tenant isolation + bounded staleness at global scale | 23, 24, 25, 26, 27, 28, 29, 33, 34, 35, 38, 39 |

Every drill also names at least one **common wrong answer** - a design
that sounds reasonable, that plenty of engineers would propose, and that
this repository has real, measured evidence against.

## Prediction

Before opening a drill's model answer: read only its prompt, then write
down your own answers to SPEC.md's eight questions (design, invariants,
consistency requirements, storage, concurrency mechanism, failure modes,
scale, observability) from memory. Do this before looking at the "Model
answer" section. The value of this lab is in the gap between what you
predict and what the model answer justifies with a real number - not in
reading the model answer directly.

## Exercise

1. Pick a drill in `drills/`.
2. Read the prompt and do your own prediction (see above).
3. Read the model answer. For every mechanism it names, go confirm (by
   opening that lab's README or the matching ROADMAP.md entry) that the
   number or error code cited is real and matches - do not take this
   lab's word for it uncritically; that habit of verification is itself
   part of what the curriculum is trying to teach.
4. Read the "Common wrong answer" section and check whether it was your
   first instinct. If it was, figure out precisely which real, measured
   evidence from this repository rules it out - not just "that's not best
   practice."
5. Answer the drill's own interview questions out loud, as if in an actual
   interview, citing a lab and a number each time you invoke a guarantee.
6. Run `pnpm test` once you have gone through several drills, to confirm
   this lab's own citations are internally consistent.

## Observe

- Which of your own first-instinct answers matched a "common wrong
  answer" section, and why that answer is tempting (usually: it is
  simpler to reason about sequentially, or it is the tool you reach for by
  habit, not because the invariant needs it).
- How often the correct mechanism is "a Postgres constraint or transaction
  already does this" versus "you need a new piece of infrastructure" -
  and notice this ratio; CLAUDE.md's Core Principle 3 ("prefer
  datastore-native guarantees") is not a rule this lab imposes from
  outside, it is a pattern that falls out of the drills' own evidence.
- Which drills reuse the *same* underlying mechanism for a different
  business problem (conditional writes show up in the booking, payroll,
  and inventory drills; `SKIP LOCKED` shows up in the scheduler,
  notification, and webhook drills) - recognizing that reuse quickly is
  most of what makes an experienced systems engineer fast in an actual
  interview.

## Break it

The "break it" step in this lab is: attempt a drill's prediction honestly,
in writing, before reading the model answer, and let yourself get it
wrong. Every drill's "Common wrong answer" section documents a design
that a reasonable, experienced engineer proposes often - if your own first
instinct never matches any of them, that is worth noticing too (it may
mean you are already pattern-matching the eight-step process correctly,
or it may mean you are being shown a mechanism you already know well and
should try a drill you find less familiar).

## Fix it

Reread the model answer's "Why this mechanism, not another" reasoning for
whichever step you got wrong, then re-derive it yourself from the cited
lab's actual evidence (its README or its ROADMAP.md entry) rather than
from this lab's summary of it. If you still disagree with the model
answer after doing that, that is a legitimate outcome for an open-ended
design question - write down specifically which real number or guarantee
you think changes the answer, and why (e.g. "this model answer assumes
single-digit-millisecond intra-region latency; at cross-country latency
the LSN-gated wait itself becomes the bottleneck, which changes the
tradeoff in Drill 08's Strategy B").

## Why the fix works

Each drill's model answer explains this inline, per mechanism, rather than
once for the whole lab - a single global "why it works" would either be
too vague to be useful (violating CLAUDE.md's Documentation Quality
standard) or would just restate all eight drills' worth of reasoning
redundantly.

## Tradeoffs

The one tradeoff specific to this lab itself, not to any one drill: a
synthesis lab can either (a) invent new scenarios, in which case its
"real evidence" claim is weaker, since nothing in this repository actually
measured them, or (b) restrict itself to the eight scenarios SPEC.md
names and ground every claim in a real number from Labs 01-40, at the
cost of not exploring problems outside that set (there is no distributed
consensus/Raft drill here, for instance, because no lab in this curriculum
built one - see `docs/architecture-principles.md` and `SPEC.md` section 23
for what this curriculum does and does not claim to cover). This lab
takes option (b) deliberately, per the parent brief's instruction to
ground every drill in mechanisms this repository's own labs actually
demonstrated rather than generic system-design-interview trivia.

## Production notes

Applied at the level of the whole discipline, not one mechanism:

1. **What guarantee does "having done this lab" give you?** The ability to
   name the right *class* of mechanism for a described invariant quickly,
   and to justify it with a specific, checkable fact instead of a vague
   appeal to "best practices."
2. **What does it not give you?** Hands-on experience with mechanisms this
   curriculum does not cover (e.g. Raft/Paxos-based consensus, CRDTs,
   vector-clock conflict resolution, geo-partitioned multi-writer
   databases) - the drills are honest about citing only what Labs 01-40
   actually built.
3. **What breaks under an actual interview's time pressure?** Reasoning
   from first principles for all eight steps on a totally novel prompt is
   slow; the payoff of this lab is pattern-matching prompts to invariants
   fast enough to spend your remaining time on the parts of the prompt
   that are actually novel.
4. **How does contention affect the underlying advice?** Every "prefer a
   conditional write / advisory lock / `SKIP LOCKED`" recommendation in
   these drills was measured under real concurrent load in its source
   lab (see each drill's citations) - the recommendation is not
   theoretical.
5. **What changes at a larger scale than any one lab tested?** Several
   drills (01, 08 especially) explicitly discuss the point where a single
   Postgres primary's write throughput, not the concurrency mechanism
   itself, becomes the bottleneck, and what changes (regional primaries,
   partitioning, connection pooling) once it does.
6. **What would you monitor?** Each drill's own "Observability" section
   names concrete signals, not "add monitoring" - queue depth, outbox
   lag, circuit breaker state, replication lag via `pg_wal_lsn_diff`
   rather than `replay_lag`, per Lab 26's own documented gotcha.
7. **When should you avoid this whole approach?** When the interviewer or
   the real problem needs genuinely novel infrastructure this curriculum
   does not cover - at that point, reason from the same eight-step
   process, but be honest that you are extrapolating rather than citing
   evidence.

## Interview questions

These are meta-level, about the process itself; each drill file has its
own scenario-specific interview questions.

- When should the answer to "how do you prevent this race condition" be
  "you don't need a lock at all," and which lab first taught you that
  reflex?
- Give an example, from any drill, where the "obvious" fix (a distributed
  lock) is actually solving the wrong problem entirely (a duplicate
  *request*, not a race for a resource) - what is the right primitive for
  that different problem?
- A design combines three mechanisms from three different labs (say,
  outbox + `SKIP LOCKED` + circuit breaker, as in the notification
  platform drill). In what order must they be composed, and what breaks
  if you get the order wrong?
- Pick any drill's "common wrong answer." Under what unusual constraint
  (not the one stated in the prompt) would that wrong answer actually
  become the right one?
- Why does almost every drill in this lab end up naming Postgres as the
  source of truth even in a "large multi-region SaaS backend," and what
  specific evidence from Lab 39, not opinion, backs that choice for
  tenant isolation specifically?

## Further experiments

- Write a ninth drill for a scenario not in SPEC.md's list (e.g. a
  leaderboard/ranking service, a URL shortener, a chat/presence system)
  using the same eight-step structure and the same
  cite-a-real-lab-and-number discipline, then add it to `drills/` and to
  `src/check-citations.ts`'s expectations.
- For Drill 08 (multi-region SaaS), work out the actual cross-region RTT
  your candidate regions would see and recompute whether Lab 26's
  LSN-gated read-after-write strategy (measured at ~403ms wait under a
  ~400ms lag, on a local loopback network) is still the right choice, or
  whether the wait itself becomes an unacceptable tax on every
  read-after-write request at real geographic latency.
- Take Lab 40's capstone architecture document and see how many of this
  lab's eight drills its own design decisions already answer - the
  capstone is itself a partially-worked drill for scenario 01.
- Argue the opposite side of one drill's "common wrong answer" as
  strongly as you can, using only real evidence from this repository, not
  hypotheticals - if you cannot, that is itself informative about how
  one-sided the tradeoff actually is.
