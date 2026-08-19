# Playground

Scratch space for your own experiments in this lab. Nothing here is imported
by the lab's source, seed, or tests - it's a safe place to try variations
without touching the graded/checked-in code.

Ideas to try:

- Open PGweb (http://localhost:8420) after running
  `pnpm scenario:failure-and-compensation` and filter `saga_log` by
  `order_id` for the order it just printed - read the rows top to bottom in
  `occurred_at` order and confirm you can narrate the whole story
  (`createOrder` succeeded, `reserveInventory` succeeded, `capturePayment`
  succeeded, `createShipment` failed, then `refundPayment`,
  `releaseInventory`, `cancelOrder` all succeeded) from that one table alone.
- Do the same for a choreographed order (run
  `pnpm scenario:choreography-comparison` first) - filter `saga_log` by
  `order_id` and `mechanism = 'choreography'` and try to reconstruct the
  same story. Notice you now have to track `detail->>'publishedBy'` and
  `detail->>'consumedBy'` across many more rows, and that no single row says
  "the saga failed here and here's everything that got undone" the way the
  orchestrated version's linear sequence does.
- Change `src/scenarios/failure-and-compensation.ts`'s `failAtStep` to
  `"capturePayment"` or `"reserveInventory"` instead of `"createShipment"`
  and confirm the compensation chain correctly shortens (no `refundPayment`
  call at all if payment was never captured).
- Try adding a `failAtStep: "createOrder"` scenario and inspect what
  `saga_log` looks like for it - notice `order_id` is `NULL` for that one
  row, since the order itself was rolled back and never existed. Think about
  what a monitoring query for "saga failures" would need to account for.
- Modify `src/domain/run-step.ts`'s `simulateFailure` check to happen AFTER
  the business write instead of before it (i.e. do the INSERT/UPDATE, then
  throw). Confirm the `ROLLBACK` still discards that step's own attempted
  write - the failure-injection point changes what got attempted, not
  whether an individual step's own transaction stays atomic.
- Try commenting out one of the three compensation calls in
  `src/orchestration/orchestrator.ts`'s `createShipment`-failure branch (e.g.
  skip `releaseInventory`) and rerun the failure scenario - watch the
  inventory-restored assertion in `tests/integration/orchestration.test.ts`
  fail, and see the real resource leak this lab's "Break it" section
  describes (a payment refunded, but stock never returned to the shelf).
- Add a fourth "service" to the choreography chain (e.g. a notification
  handler that reacts to `ShipmentCreated`/`OrderCancelled` and just logs
  something) and see how much `saga_log` traffic ONE more hop adds, compared
  to how little it would add to the orchestrator (one more explicit function
  call in one place).
