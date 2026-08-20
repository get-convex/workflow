# Workflow Generation Semantics

Status: proposed

Audience: implementation owner for the action-driven workflow runner

## Purpose

`generationNumber` should identify a single continuation wave of a workflow. It
should provide the ordering and recovery fence for the workflow driver and for
every step claimed by that driver.

This replaces the current interpretation, where the number primarily changes on
manual restart and cancellation. The new interpretation is intended to make
driver recovery deterministic without introducing a second driver-attempt or
step-owner counter.

## Terms

- **Workflow generation**: One continuation wave. A driver replays the journal,
  starts a batch of new steps, and waits for that batch to settle before the
  workflow advances.
- **Driver**: A mutation-driven poll or an action-driven runner that evaluates
  the workflow handler.
- **Claimed step**: A step whose execution has been assigned to a generation.
- **Settled step**: A step with a terminal `runResult` (`success`, `failed`, or
  `canceled`).
- **Durable step**: A step handed to Workpool, a nested workflow, an event, or
  the scheduler and represented by durable component state such as `workId`.
- **Direct step**: A query, mutation, or action executed by the action driver.

## Data model

### Workflow

`workflows.generationNumber` is the current generation. It is monotonically
increasing for the lifetime of the workflow document.

The implementation may add a durable driver-enqueue marker (for example,
`driverWorkId` or `driverScheduledGeneration`) if it is required to prevent two
equivalent drivers from being enqueued. This marker is not a second generation
counter.

### Step

Each newly claimed step stores:

```ts
generationNumber?: number
```

The field must initially be optional for schema compatibility with existing
workflow documents. All newly claimed steps must set it.

The generation is written when execution is claimed, not merely when an
unclaimed journal entry is allocated. Therefore:

- no generation: created but not claimed;
- generation present and no durable execution identifier: directly owned by that
  generation;
- generation present and `workId`/nested workflow/event state present: handed to
  the corresponding durable subsystem.

If journal allocation and claiming remain one operation, every allocated action
must conservatively be treated as possibly started after that operation commits.
Splitting allocation from claim is preferable when preserving the distinction
matters.

## Invariants

1. `generationNumber` never decreases.
2. At most one generation is current for a workflow.
3. A step is claimed by at most one current generation at a time.
4. The workflow does not advance from generation `N` while any step claimed by
   `N` remains in progress.
5. Only the workflow driver advancement transaction changes the current
   generation during normal execution.
6. Generation advancement and successor-driver enqueueing are atomic.
7. A completion may modify a step only when:
   - the workflow is still running;
   - the completion generation equals the step generation; and
   - the step is still in progress under the same execution mode (direct or
     durable).
8. A late or duplicate completion is a no-op or a logged fence rejection. It
   never overwrites a terminal result.
9. A driver failure does not itself advance the generation.
10. Workflow cancellation is terminal-state fencing, not generation advancement.

## Normal state transitions

### Initial execution

The initial driver runs generation `0`. It may claim zero or more steps for
generation `0`.

### Blocking generation

When generation `N` starts steps:

1. Persist the step journal entries and their generation ownership.
2. Execute direct steps and/or hand durable steps to their subsystem.
3. If any generation `N` step remains in progress, the driver stops without
   advancing the generation.
4. Step completions settle their entries but do not independently skip a
   generation.

### Advancing a generation

The successor driver, or a central mutation acting as the driver tail, performs
an atomic compare-and-set transition:

1. Load the workflow and require `runResult === undefined`.
2. Require `workflow.generationNumber === N`.
3. Require no in-progress step claimed by generation `N`.
4. Patch the workflow to generation `N + 1`.
5. Record or enqueue exactly one successor driver for generation `N + 1`.

If any precondition fails, the transition does not enqueue a successor.

### Multiple direct batches in one action

The action runner may process several continuation waves before its time budget
expires. After each direct batch settles, it must advance the generation before
evaluating the workflow to create another batch.

## Driver completion and tail enqueueing

The action driver is enqueued with Workpool retries disabled. Its Workpool
`onComplete` mutation owns recovery and tail enqueueing.

For a successful driver result:

- if the workflow is terminal, stop;
- if it is blocked on durable or direct generation work, stop;
- if the current generation is settled and the workflow needs another poll,
  atomically advance and enqueue the successor.

For a failed driver result:

1. Recover steps claimed by the failed generation according to the rules below.
2. Do not advance while recovered work remains in progress.
3. Tail-enqueue another driver for the same generation when replay or recovery
   is required.
4. Once the generation settles, advance normally.

There is no workflow-level maximum number of driver attempts. Tail enqueueing
continues until the workflow is terminal or canceled. Consecutive driver
failures should use capped backoff and emit operational diagnostics.

The `onComplete` context contains at least the workflow ID and generation. A
stale `onComplete` for a non-current generation is ignored.

## Recovery by step type

Recovery considers only in-progress steps claimed by the failed current
generation.

### Unclaimed entries

An entry without a generation was not claimed. Leave it available for the next
driver to claim.

### Query

Clear the failed direct claim and re-execute the query in the same generation.
Queries have no durable side effects.

### Mutation

Clear the failed direct claim and re-execute the mutation in the same
generation.

The direct mutation and journal completion must remain in one parent mutation.
Serializable transaction semantics ensure that either both committed or neither
committed.

### Action without retry

Settle the step as failed. The error should state that the driver failed while
the action was in progress and that its external outcome may be unknown.

Do not automatically invoke the action again.

### Action with retry

Treat the interrupted direct attempt as one failed action attempt. Consume one
configured attempt and hand the remaining retry policy to Workpool. If no
attempt remains, settle the step as failed.

When the driver actually fails or times out, that invocation cannot resume after
its directly called action and write the result to the journal. The recovery
problem is the action's potentially unknown external outcome, not a late
writeback from the dead driver invocation. Moving a retryable step to Workpool
must still durably record its new execution mode before enqueueing the retry.

### Durable work

If a step has been handed to Workpool, a nested workflow, an event, or a
scheduled sleep, leave it in progress. Its existing completion path remains
responsible for settling it.

## Cancellation

Cancellation performs one terminal transaction:

1. Set the workflow `runResult` to `canceled`.
2. Cancel pending durable work where supported.
3. Prevent any future driver tail enqueue.

Cancellation does not increment `generationNumber`. All direct and durable
completion handlers must check terminal workflow state before changing journal
entries. Work already running outside a transaction may finish externally, but
its late completion cannot alter the canceled workflow.

Convex guarantees that a scheduled function canceled before it starts will not
run. An action canceled after it starts may continue running, but functions it
subsequently schedules will not run. Workpool similarly does not stop
in-progress work. Therefore, workflow terminal state remains the authoritative
fence for any completion path that can still reach the database.

## Manual restart

Manual restart remains valid only for a terminal workflow.

Before restarting:

1. Require that prior in-progress entries are settled, or explicitly settle them
   as part of restart cleanup.
2. Delete the requested journal suffix.
3. Clear the workflow result.
4. Advance once through the same generation advancement mechanism.
5. Enqueue exactly one driver for the new generation.

Retained completed entries keep their historical generation values.

## Concurrency requirements

- Parallel final step completions may race to request continuation, but exactly
  one transaction may advance generation `N` and enqueue generation `N + 1`.
- A duplicate driver for generation `N` must observe either an active driver or
  generation `N + 1` and exit without starting steps.
- Generation checks are necessary but not sufficient for late action completions
  after ownership moves to Workpool; completion must also verify the current
  execution mode/identifier.
- Queries for outstanding work should use an index beginning with workflow ID,
  generation, and in-progress state, in the order required by the selected
  access pattern.

## Migration and compatibility

1. Add the step generation field as optional.
2. Treat legacy in-progress entries without a generation conservatively as
   durable if they have durable identifiers; otherwise require recovery or
   operator inspection before enabling action execution by default.
3. New entries always write generation ownership.
4. After legacy running workflows drain or are migrated, the validator may be
   tightened in a later release.
5. Public workflow and step result shapes should not expose the internal field
   unless it is intentionally added as diagnostics.

## Required tests

### Deterministic tests

- Generation advances only after every parallel step in the generation settles.
- Two simultaneous final completions enqueue one successor.
- A driver failure leaves the generation unchanged.
- Queries and mutations recover in the same generation.
- An interrupted non-retryable action becomes failed without re-execution.
- An interrupted retryable action consumes an attempt and transfers ownership to
  Workpool.
- A late direct action completion cannot overwrite a recovered or Workpool-owned
  step.
- Cancellation prevents journal mutation and successor enqueueing.
- Restart advances once and fences retained stale completions.
- Multiple direct batches handled by one action use increasing generations.

### Cloud conformance tests

- Cancellation behavior for scheduled child actions.
- Cancellation behavior for `ctx.runAction` children.
- Workpool `onComplete` behavior for failed and canceled running actions.
- Tail-enqueueing new Workpool work from `onComplete`.
- Exactly one successor under parallel completion load.

### Crash tests

If cloud conformance and deterministic failure injection cover the required
boundaries, process-level Docker crash tests may be omitted. Otherwise, add
controlled process termination after step claim, after each direct function
returns, and before journal completion.

## Acceptance criteria

- No workflow remains stuck solely because its driver failed.
- Database mutations commit at most once.
- Queries may repeat but produce one accepted journal result.
- Actions never repeat after an ambiguous interruption unless their retry policy
  explicitly permits another attempt.
- Every generation has a single atomic advancement to its successor.
- Terminal cancellation prevents all later workflow-state changes.
