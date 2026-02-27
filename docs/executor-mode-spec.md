# Executor Mode: Clean-Room Implementation Spec

This document is a complete specification for implementing executor mode on top
of the workflow `main` branch. It contains every detail needed to produce a
correct, performant implementation from scratch.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Schema Changes](#schema-changes)
4. [Component-Side Changes](#component-side-changes)
5. [Client-Side Changes](#client-side-changes)
6. [The Executor Action (The Heart)](#the-executor-action)
7. [Shard Assignment](#shard-assignment)
8. [Handoff Protocol](#handoff-protocol)
9. [Cancel Support](#cancel-support)
10. [Critical Invariants](#critical-invariants)
11. [Pitfalls We Discovered](#pitfalls-we-discovered)
12. [Constants and Their Rationale](#constants-and-their-rationale)
13. [Benchmark Visualizer](#benchmark-visualizer)
14. [Testing Checklist](#testing-checklist)

---

## Overview

**Problem**: The standard workflow uses a workpool that dispatches each step as
a separate Convex action. At scale (10k+ workflows), the 512 concurrent action
limit becomes a hard bottleneck — steps queue behind each other indefinitely.

**Solution**: Replace per-step action invocations with a **sharded task queue**
and **long-lived executor actions**. Each executor is a single Convex action
that claims tasks from one shard of the task queue and runs the step handlers
in-process (no separate action invocation). Non-overlapping shard ranges
eliminate cross-executor OCC contention.

**Result**: 20k 4-step workflows complete in ~296 seconds with 0 failures.

## Architecture

```
User mutation
  └─ workflow.start()
       └─ workflow.create mutation (component)
            └─ workflow replay (inline or via coordinator)
                 └─ journal.startSteps mutation
                      └─ inserts task into taskQueue (shard = hash(workflowId))
                           │
     ┌───────────────────────────────────────────────┐
     │                                               │
executor(shard=0)        executor(shard=1)     ...  executor(shard=N-1)
     │                        │                          │
claimTasks(shard=0)     claimTasks(shard=1)          claimTasks(shard=N-1)
     │                        │                          │
run handler inline      run handler inline           run handler inline
     │                        │                          │
push to pendingResults  push to pendingResults       push to pendingResults
     │                        │                          │
flush loop:             flush loop:                  flush loop:
  recordResultBatch       recordResultBatch            recordResultBatch
  → replayIfReady         → replayIfReady              → replayIfReady
    → new tasks             → new tasks                  → new tasks
      appear in               appear in                    appear in
      taskQueue               taskQueue                    taskQueue
```

**Key insight**: Each executor only queries `taskQueue.withIndex("by_shard",
q => q.eq("shard", N))`. Non-overlapping index ranges = no OCC conflicts
between executors. The only shared state is the `executorEpoch` table (read-only
from executors) and the `steps`/`workflows` tables (different workflows touch
different documents).

## Schema Changes

Add three new tables to `src/component/schema.ts`:

### `taskQueue` table

```typescript
taskQueue: defineTable({
  shard: v.number(),
  functionType: v.union(
    v.literal("query"),
    v.literal("mutation"),
    v.literal("action"),
  ),
  handle: v.string(),        // FunctionHandle or batch action name
  args: v.any(),
  stepId: v.id("steps"),
  workflowId: v.id("workflows"),
  generationNumber: v.number(),
  retry: v.optional(v.object({
    maxAttempts: v.number(),
    initialBackoffMs: v.number(),
    base: v.number(),
  })),
})
  .index("by_shard", ["shard"])
  .index("by_stepId", ["stepId"])
```

**Critical**: Tasks are NOT deleted when claimed. They are deleted atomically
with result recording in `recordResultBatch`. This ensures crash recovery —
if an executor dies mid-processing, tasks remain in the queue.

### `executorEpoch` table

```typescript
executorEpoch: defineTable({
  epoch: v.number(),
})
```

Singleton table. Incremented by `startExecutors`. Executors compare their
epoch arg to the current value — if mismatched, they drain and exit. This
allows clean restarts.

### `executorHandoff` table

```typescript
executorHandoff: defineTable({
  shard: v.number(),
  ready: v.boolean(),   // new executor sets true when entering main loop
  yielded: v.boolean(), // old executor sets true when stopping claims
}).index("by_shard", ["shard"])
```

Ephemeral coordination documents for zero-gap executor handoff during
self-rescheduling. Deleted after handoff completes.

### `workflows` table change

Add field to the existing workflow object:

```typescript
executorShards: v.optional(v.number()),
```

When set on a workflow document, `journal.startSteps` routes steps through the
task queue instead of the workpool.

## Component-Side Changes

### File: `src/component/taskQueue.ts` (NEW)

This is a new file containing all task queue mutations and queries.

#### `claimTasks` — query

```typescript
export const claimTasks = query({
  args: { shard: v.number(), limit: v.number() },
  returns: v.array(taskResult),
  handler: async (ctx, { shard, limit }) => {
    const tasks = await ctx.db
      .query("taskQueue")
      .withIndex("by_shard", (q) => q.eq("shard", shard))
      .take(limit);
    return tasks.map((task) => ({
      functionType: task.functionType,
      handle: task.handle,
      args: task.args,
      stepId: task.stepId,
      workflowId: task.workflowId,
      generationNumber: task.generationNumber,
      retry: task.retry,
    }));
  },
});
```

**Critical**: This is a QUERY, not a mutation. It reads but does not delete.
The executor tracks which stepIds are in-flight locally to avoid re-processing.

#### `recordResultBatch` — mutation

Records step results and deletes tasks atomically. Returns a list of
workflows that may need replay (their last in-progress step just completed).

```typescript
export const recordResultBatch = mutation({
  args: {
    items: v.array(v.object({
      stepId: v.id("steps"),
      result: vResultValidator,
      generationNumber: v.number(),
    })),
  },
  returns: v.array(replayCandidate),
  handler: async (ctx, { items }) => {
    const candidates = new Map<string, ReplayCandidate>();

    for (const { stepId, result, generationNumber } of items) {
      // Helper: always delete the task, even on early return
      const deleteTask = async () => {
        const taskEntry = await ctx.db
          .query("taskQueue")
          .withIndex("by_stepId", (q) => q.eq("stepId", stepId))
          .unique();
        if (taskEntry) await ctx.db.delete(taskEntry._id);
      };

      // Validate: journal entry exists
      const journalEntry = await ctx.db.get(stepId);
      if (!journalEntry) { await deleteTask(); continue; }

      // Validate: workflow exists
      const workflow = await ctx.db.get(journalEntry.workflowId);
      if (!workflow) { await deleteTask(); continue; }

      // Validate: generation number matches (not stale)
      if (workflow.generationNumber !== generationNumber) {
        await deleteTask(); continue;
      }

      // Validate: step is still in progress
      if (!journalEntry.step.inProgress) {
        await deleteTask(); continue;
      }

      // Record the result
      journalEntry.step.inProgress = false;
      journalEntry.step.completedAt = Date.now();
      switch (result.kind) {
        case "success":
          journalEntry.step.runResult = {
            kind: "success",
            returnValue: result.returnValue,
          };
          break;
        case "failed":
          journalEntry.step.runResult = {
            kind: "failed",
            error: result.error,
          };
          break;
        case "canceled":
          journalEntry.step.runResult = { kind: "canceled" };
          break;
      }
      await ctx.db.replace(journalEntry._id, journalEntry);

      // Delete the task (atomic with result recording)
      await deleteTask();

      // Track as replay candidate if workflow isn't already finished
      if (workflow.runResult === undefined) {
        candidates.set(journalEntry.workflowId, {
          workflowId: journalEntry.workflowId,
          workflowHandle: workflow.workflowHandle,
          generationNumber: workflow.generationNumber,
        });
      }
    }

    return [...candidates.values()];
  },
});
```

**Critical design**: The mutation returns replay candidates rather than
executing replays inline. This keeps the mutation's OCC surface small
(only touches taskQueue + steps documents). Replay is triggered by the
executor as a separate `replayIfReady` mutation call.

**Why not schedule replays with `ctx.scheduler.runAfter(0, ...)`?**
We tried this. It was significantly WORSE. The scheduler queue is shared
with all other mutations. Under high load, scheduled replays wait in queue
behind other work, adding seconds of latency to every step transition.
The executor calling `replayIfReady` directly is faster because it
bypasses the scheduler queue entirely.

#### `replayIfReady` — mutation

Per-workflow replay check. Small mutation = minimal OCC surface.

```typescript
export const replayIfReady = mutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    workflowHandle: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { workflowId, generationNumber, workflowHandle }) => {
    const workflow = await ctx.db.get(workflowId);
    if (!workflow || workflow.runResult ||
        workflow.generationNumber !== generationNumber) {
      return null;
    }
    // Check if any steps are still in progress
    const inProgress = await ctx.db
      .query("steps")
      .withIndex("inProgress", (q) =>
        q.eq("step.inProgress", true).eq("workflowId", workflowId),
      )
      .first();
    if (inProgress) return null;

    // All steps done — replay the workflow to advance to next steps
    try {
      await ctx.runMutation(
        workflowHandle as FunctionHandle<"mutation">,
        { workflowId, generationNumber },
      );
    } catch (e) {
      const error = e instanceof Error
        ? e.message
        : `Unknown error: ${String(e)}`;
      await ctx.db.patch(workflowId, {
        runResult: { kind: "failed", error },
      });
    }
    return null;
  },
});
```

**Why separate from `recordResultBatch`?** If replay fails (e.g., OCC on the
workflow document), it doesn't roll back the result recording. Each
`replayIfReady` call only touches one workflow's documents, so failures are
isolated.

#### `startExecutors` — mutation

```typescript
export const startExecutors = mutation({
  args: {
    executorHandle: v.string(),   // FunctionHandle for the executor action
    numShards: v.number(),
  },
  returns: v.number(),            // new epoch
  handler: async (ctx, { executorHandle, numShards }) => {
    // Increment epoch — old executors with stale epochs will terminate
    const existing = await ctx.db.query("executorEpoch").first();
    let epoch: number;
    if (existing) {
      epoch = existing.epoch + 1;
      await ctx.db.patch(existing._id, { epoch });
    } else {
      epoch = 1;
      await ctx.db.insert("executorEpoch", { epoch });
    }
    // Schedule one executor action per shard
    for (let i = 0; i < numShards; i++) {
      await ctx.scheduler.runAfter(
        0,
        executorHandle as FunctionHandle<"action">,
        { shard: i, epoch },
      );
    }
    return epoch;
  },
});
```

#### `getExecutorEpoch` — query

```typescript
export const getExecutorEpoch = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const existing = await ctx.db.query("executorEpoch").first();
    return existing?.epoch ?? 0;
  },
});
```

#### `handoff` / `getHandoff` — mutation/query for handoff protocol

See [Handoff Protocol](#handoff-protocol) section.

#### `diagnose` — query (optional, for debugging)

Returns per-shard task counts and executor epoch. Useful for diagnosing stuck
states.

### File: `src/component/journal.ts` — MODIFY `startSteps`

Add routing logic: when `workflow.executorShards` is set, insert tasks into the
task queue instead of enqueuing through the workpool.

#### Shard assignment function

Add this above `startSteps`:

```typescript
function shardForWorkflow(workflowId: string, numShards: number): number {
  let hash = 0;
  for (let i = 0; i < workflowId.length; i++) {
    hash = (hash * 31 + workflowId.charCodeAt(i)) | 0;
  }
  return ((hash % numShards) + numShards) % numShards;
}
```

**Critical**: All steps of the same workflow go to the SAME shard. This is
intentional — it means a single executor can process all steps of a workflow
sequentially without cross-shard coordination. The hash ensures even
distribution across shards.

#### Default retry for queries/mutations

```typescript
const DEFAULT_QM_RETRY = {
  maxAttempts: 4,
  initialBackoffMs: 125,
  base: 2,
};
```

Queries and mutations can transiently fail (OCC), so they get automatic retry.
Actions do NOT get default retry — the user's handler should handle its own
retries (e.g., LLM SDK retry logic).

#### Routing logic in `startSteps` handler

Inside the `Promise.all(args.steps.map(...))` loop, for each step, the existing
code has a `switch (step.functionType)` block. Add executor routing BEFORE the
existing workpool logic:

For **query** and **mutation** function types:
```typescript
case "query": {
  if (workflow.executorShards) {
    const shard = shardForWorkflow(workflow._id, workflow.executorShards);
    await ctx.db.insert("taskQueue", {
      shard,
      functionType: "query",
      handle: step.handle,
      args: step.args,
      stepId,
      workflowId: workflow._id,
      generationNumber,
      retry: DEFAULT_QM_RETRY,
    });
    workId = `executor:${stepId}`;
  } else {
    // existing workpool.enqueueQuery logic
  }
  break;
}
```

Same pattern for `"mutation"`.

For **action** type:
```typescript
case "action": {
  if (stepArgs.batchActionName && workflow.executorShards) {
    // Route through sharded task queue
    const shard = shardForWorkflow(workflow._id, workflow.executorShards);
    await ctx.db.insert("taskQueue", {
      shard,
      functionType: "action",
      handle: stepArgs.batchActionName,  // NOT step.handle — use the batch name
      args: step.args,
      stepId,
      workflowId: workflow._id,
      generationNumber,
      // No retry for actions — handler manages its own retries
    });
    workId = `executor:${stepId}`;
  } else if (stepArgs.batchActionName && workflow.batchBridgeHandle) {
    // existing batch bridge logic
  } else {
    // existing workpool.enqueueAction logic
  }
  break;
}
```

**Critical**: For actions, the `handle` field is set to `stepArgs.batchActionName`
(e.g., `"executorSimulateLLM"`), NOT `step.handle` (which is a FunctionHandle).
The executor looks up handlers by this name string.

The `workId` is set to `executor:${stepId}` — this prefix is used by the cancel
handler to distinguish executor-managed steps from workpool-managed steps.

### File: `src/component/workflow.ts` — MODIFY

1. Add `executorShards: v.optional(v.number())` to `createArgs`.
2. Pass `executorShards: args.executorShards` when inserting the workflow document.
3. In the cancel handler, add executor-step detection (see [Cancel Support](#cancel-support)).

## Client-Side Changes

### File: `src/client/index.ts` — MODIFY `WorkflowManager`

#### New private fields

```typescript
private executorShards?: number;
private executorActionHandlers = new Map<
  string,
  (ctx: GenericActionCtx<GenericDataModel>, args: any) => Promise<any>
>();
private executorRef: FunctionReference<"action", "internal"> | null = null;
```

#### Constructor

Accept `executorShards` in options:

```typescript
constructor(
  public component: WorkflowComponent,
  public options?: {
    workpoolOptions?: WorkpoolOptions;
    batch?: BatchWorkpool;
    executorShards?: number;
  },
) {
  this.batch = options?.batch;
  this.executorShards = options?.executorShards;
}
```

#### `action()` method — MODIFY

When `executorShards` is set, store the handler in-memory and register the
name for batch action detection:

```typescript
action(name, opts) {
  if (this.executorShards) {
    this.executorActionHandlers.set(name, opts.handler);
    this.batchActionNames.add(name);
    // Return a no-op placeholder action — never invoked directly
    return internalActionGeneric({
      handler: async () => {
        throw new Error(`${name} runs inside executors, not directly`);
      },
    });
  }
  // ... existing batch logic
}
```

**Why a placeholder?** The function reference must exist so `safeFunctionName()`
can extract the name for the `batchActionName` detection in `step.ts`. But
the action is never actually invoked — the executor calls the handler directly
from its in-memory map.

#### `executor()` method — NEW

Returns a registered action that is the long-lived executor. See
[The Executor Action](#the-executor-action) for the full implementation.

```typescript
executor(): RegisteredAction<"internal", { shard: number; epoch?: number }, null>
```

#### `setExecutorRef()` method — NEW

```typescript
setExecutorRef(ref: FunctionReference<"action", "internal">) {
  this.executorRef = ref;
}
```

#### `startExecutors()` method — NEW

```typescript
async startExecutors(ctx: RunMutationCtx) {
  if (!this.executorShards || !this.executorRef) {
    throw new Error("startExecutors requires executorShards and setExecutorRef");
  }
  const executorHandle = await createFunctionHandle(this.executorRef);
  await ctx.runMutation(this.component.taskQueue.startExecutors, {
    executorHandle,
    numShards: this.executorShards,
  });
}
```

#### `define()` method — MODIFY

Pass `batchActionNames` through to `workflowMutation`:

```typescript
define(workflow) {
  return workflowMutation(
    this.component,
    workflow,
    this.options?.workpoolOptions,
    this.batchActionNames.size > 0 ? this.batchActionNames : undefined,
  );
}
```

#### `start()` method — MODIFY

Pass `executorShards` when creating the workflow:

```typescript
const workflowId = await ctx.runMutation(this.component.workflow.create, {
  // ... existing fields ...
  executorShards: this.executorShards,
});
```

## The Executor Action

This is the most complex piece. It runs as a long-lived Convex action
(up to ~8-9 minutes) that processes tasks from a single shard.

### High-Level Structure

```
executor(shard, epoch):
  1. Compute staggered jitter for reschedule time
  2. Start non-blocking handoff cleanup (background promise)
  3. Start background flush loop (every 500ms)
  4. Enter main loop:
     a. Check reschedule time → if exceeded, start handoff & exit
     b. Check epoch → if stale, drain remaining tasks & exit
     c. If under MAX_CONCURRENCY, claim tasks from shard
     d. Filter out already-in-flight stepIds
     e. Feed new tasks to bounded-concurrency pool
     f. Sleep (short if active, longer if idle)
  5. Finally: stop flush loop, await background cleanup
```

### Result Batching (The Flush System)

Results don't go to the database one at a time. They accumulate in a
`pendingResults` array and are flushed in batches.

```typescript
const pendingResults: PendingResult[] = [];
const inFlightStepIds = new Set<string>();
let flushing = false;
```

#### `flush()` function

```
while pendingResults has items:
  1. Take up to FLUSH_BATCH_SIZE (50) items
  2. Call recordResultBatch mutation
     - On error: put items back at front of pendingResults, return
  3. Remove flushed stepIds from inFlightStepIds
  4. For each replay candidate returned:
     - Call replayIfReady in parallel (Promise.all)
     - Collect failures
     - Retry failures sequentially with backoff (3 attempts, 200/400/600ms)
```

**Critical: inFlightStepIds.delete happens AFTER successful flush, not
after task processing.** If you delete the stepId from tracking before
the result is recorded, a re-claim could process the same task again
and produce a duplicate result.

#### Flush loop (background)

```typescript
let flushLoopRunning = true;
const flushLoop = (async () => {
  while (flushLoopRunning) {
    await sleep(FLUSH_INTERVAL_MS);
    if (pendingResults.length > 0) await flush();
  }
})();
```

### Bounded-Concurrency Task Pool

Tasks run with bounded concurrency (MAX_CONCURRENCY = 200). This is NOT
`Promise.all` — it's a manual pool that feeds the next task when one completes.

```typescript
let activeCount = 0;
let resolveIdle: (() => void) | null = null;
const taskBuffer: Task[] = [];

const feedTask = (task) => {
  if (activeCount < MAX_CONCURRENCY) {
    activeCount++;
    runTask(task);
  } else {
    taskBuffer.push(task);
  }
};

const runTask = (task) => {
  processTask(task)
    .catch(() => {})
    .finally(() => {
      const next = taskBuffer.shift();
      if (next) {
        runTask(next);         // immediately start next task
      } else {
        activeCount--;
        if (activeCount === 0 && resolveIdle) {
          resolveIdle();       // signal idle
        }
      }
    });
};
```

### `processTask()` — Running a Single Task

```typescript
const processTask = async (task: Task): Promise<void> => {
  const maxAttempts = task.retry?.maxAttempts ?? 1;
  const initialBackoffMs = task.retry?.initialBackoffMs ?? 125;
  const base = task.retry?.base ?? 2;

  let result: RunResult | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      let returnValue: any;
      switch (task.functionType) {
        case "query":
          returnValue = await ctx.runQuery(task.handle as any, task.args);
          break;
        case "mutation":
          returnValue = await ctx.runMutation(task.handle as any, task.args);
          break;
        case "action": {
          const handler = handlers.get(task.handle);
          if (!handler) {
            result = { kind: "failed", error: `Unknown action: ${task.handle}` };
            break;
          }
          returnValue = await handler(ctx, task.args);
          break;
        }
      }
      if (result?.kind === "failed") break; // unknown action — no retry
      result = { kind: "success", returnValue: returnValue ?? null };
      break;
    } catch (e) {
      const error = e instanceof Error ? e.message : `Unknown error: ${String(e)}`;
      result = { kind: "failed", error };
      if (attempt < maxAttempts - 1) {
        const backoff = initialBackoffMs * Math.pow(base, attempt);
        await sleep(backoff);
      }
    }
  }
  pendingResults.push({
    stepId: task.stepId,
    result: result!,
    generationNumber: task.generationNumber,
  });
};
```

**Note on action dispatch**: For actions, `task.handle` is the batch action
NAME (e.g., `"executorSimulateLLM"`), looked up in the `handlers` Map. For
queries/mutations, `task.handle` is a FunctionHandle string, called via
`ctx.runQuery`/`ctx.runMutation`.

### `waitUntilIdle()` — Draining Before Exit

Called before the executor exits (reschedule, epoch mismatch, etc.):

```typescript
const waitUntilIdle = async () => {
  await new Promise<void>((resolve) => {
    if (activeCount === 0) resolve();
    else resolveIdle = resolve;
  });
  // Drain all pending results with retries
  let retries = 0;
  while (pendingResults.length > 0) {
    await flush();
    if (pendingResults.length > 0) {
      retries++;
      if (retries >= MAX_FLUSH_RETRIES) {
        // Give up — tasks stay in queue, next executor will re-process
        pendingResults.length = 0;
        break;
      }
      await sleep(200);
    }
  }
};
```

### Main Loop

```typescript
try {
  while (true) {
    // 1. Check reschedule time
    if (Date.now() - startTime > RESCHEDULE_MS + jitterMs) {
      // Start handoff protocol (see Handoff Protocol section)
      // ...
      await waitUntilIdle();
      return null;
    }

    // 2. Check epoch — stale executor drains and exits
    if (!(await checkEpoch())) {
      // Drain any remaining tasks in the shard
      const drainTasks = await claimTasks(shard, CLAIM_LIMIT);
      const newTasks = drainTasks.filter(t => !inFlightStepIds.has(t.stepId));
      if (newTasks.length > 0) {
        for (const task of newTasks) {
          inFlightStepIds.add(task.stepId);
          feedTask(task);
        }
        continue; // re-check — may have more tasks
      }
      await waitUntilIdle();
      return null;
    }

    // 3. Claim new tasks if under capacity
    if (activeCount + taskBuffer.length < MAX_CONCURRENCY) {
      const tasks = await claimTasks(shard, CLAIM_LIMIT);
      const newTasks = tasks.filter(t => !inFlightStepIds.has(t.stepId));
      if (newTasks.length > 0) {
        for (const task of newTasks) {
          inFlightStepIds.add(task.stepId);
          feedTask(task);
        }
        continue; // immediately claim more
      }
    }

    // 4. Sleep
    const sleepMs = activeCount > 0 ? POLL_BACKOFF_ACTIVE_MS : POLL_BACKOFF_MS;
    await sleep(sleepMs);
  }
} finally {
  flushLoopRunning = false;
  await flushLoop;
  await handoffCleanup;  // ensure background handoff cleanup finishes
}
```

**Critical: The `inFlightStepIds` filter.** Since `claimTasks` is read-only
(doesn't delete tasks), the same task appears in every poll until its result
is flushed and the task is deleted. The `inFlightStepIds` set prevents
re-processing. A stepId is added when claimed and removed after the flush
succeeds (not after processing completes).

## Shard Assignment

```typescript
function shardForWorkflow(workflowId: string, numShards: number): number {
  let hash = 0;
  for (let i = 0; i < workflowId.length; i++) {
    hash = (hash * 31 + workflowId.charCodeAt(i)) | 0;
  }
  return ((hash % numShards) + numShards) % numShards;
}
```

All steps of a workflow go to the same shard. This means:
- A single executor handles all steps of a given workflow.
- After completing step N, the executor's next claim cycle picks up step N+1
  (if the replay inserted it into the same shard).
- This minimizes cross-shard dependencies.

The hash function is deterministic and produces good distribution. The
`((hash % n) + n) % n` pattern handles negative hash values from integer
overflow.

## Handoff Protocol

When an executor approaches the 10-minute action timeout, it self-reschedules
a replacement and performs a graceful handoff. The goal is **zero gap** —
the new executor starts claiming immediately while the old one winds down.

### Staggered Jitter

Reschedule times are staggered by shard index to prevent all shards from
handing off simultaneously:

```typescript
const JITTER_WINDOW_MS = 60_000;
const shardSlotMs = Math.floor((shard / numShards) * JITTER_WINDOW_MS);
const perturbMs = Math.floor(
  Math.random() * Math.floor(JITTER_WINDOW_MS / numShards),
);
const jitterMs = shardSlotMs + perturbMs;
```

With 100 shards: shard 0 reschedules at RESCHEDULE_MS + 0-0.6s, shard 1
at RESCHEDULE_MS + 0.6-1.2s, ..., shard 99 at RESCHEDULE_MS + 59.4-60s.
At most 1 shard hands off at a time.

### Old executor (outgoing) protocol

1. Create handoff doc: `handoff(shard, "init")` — inserts `{ shard, ready: false, yielded: false }`
2. Schedule successor: `ctx.scheduler.runAfter(0, executorRef, { shard, epoch })`
3. Keep claiming and processing tasks (streaming handoff — no gap)
4. Poll for `state.ready === true` (successor is warmed up)
5. Set `yielded: true`: `handoff(shard, "yielded")` — stops claiming
6. `waitUntilIdle()` — drain all in-flight work
7. Exit

### New executor (incoming) protocol

Non-blocking — the main loop starts immediately:

1. Check for existing handoff doc on startup
2. If doc exists and predecessor hasn't yielded:
   - Signal ready: `handoff(shard, "ready")` (in background promise)
   - Poll for predecessor to yield (in background promise)
   - Clear handoff doc: `handoff(shard, "clear")` (in background promise)
3. Main loop starts IMMEDIATELY — brief overlap of two executors on the
   same shard is safe because:
   - `claimTasks` is read-only
   - `recordResultBatch` checks `generationNumber` + `inProgress`
   - Duplicate processing produces the same result (idempotent)

The background handoff cleanup runs in a fire-and-forget promise, awaited
only in the `finally` block.

## Cancel Support

In `src/component/workflow.ts`, the cancel handler must detect executor-managed
steps by their `workId` prefix:

```typescript
if (typeof step.workId === "string" &&
    step.workId.startsWith("executor:")) {
  // Clean up the task queue entry
  const stepId = step.workId.slice("executor:".length);
  const taskEntry = await ctx.db
    .query("taskQueue")
    .withIndex("by_stepId", (q) =>
      q.eq("stepId", ctx.db.normalizeId("steps", stepId)!),
    )
    .unique();
  if (taskEntry) {
    await ctx.db.delete(taskEntry._id);
  }
} else {
  // Existing workpool cancel logic
  await workpool.cancel(ctx, step.workId);
}
```

Also bump `workflow.generationNumber += 1` on cancel — this invalidates any
in-flight executor results (the generationNumber check in `recordResultBatch`
will discard them).

## Critical Invariants

1. **Tasks are deleted ONLY in `recordResultBatch`**, never in `claimTasks`.
   This ensures crash recovery — a dead executor leaves tasks for its
   replacement.

2. **`inFlightStepIds` prevents duplicate processing.** Added on claim,
   removed after successful flush (not after task completion). If removed
   too early, a re-claim could process the task again before the result
   is recorded.

3. **`generationNumber` is checked in `recordResultBatch` AND
   `replayIfReady`.** If a workflow is canceled (bumping generationNumber),
   stale results from in-flight executors are silently discarded.

4. **Replay is triggered by the executor, not scheduled.** The executor
   calls `replayIfReady` directly via `ctx.runMutation`. This avoids
   scheduler queue latency which we measured to add seconds under load.

5. **All steps of a workflow go to the same shard.** This ensures the
   executor that just completed step N will see step N+1 on its next
   claim cycle (after replay inserts the new task).

6. **Flush errors don't kill the executor.** On `recordResultBatch` failure,
   items are pushed back to `pendingResults` for retry on the next flush
   cycle. The executor continues processing other tasks.

7. **`waitUntilIdle()` drains completely before exit.** The executor never
   exits with unrecorded results. If flush retries are exhausted
   (MAX_FLUSH_RETRIES), the remaining items are dropped — their tasks
   remain in the queue for the next executor to re-process.

## Pitfalls We Discovered

### 1. DO NOT schedule replays with `runAfter(0)`

We tried having `recordResultBatch` call `ctx.scheduler.runAfter(0,
api.taskQueue.replayIfReady, ...)` instead of returning candidates.
This was **significantly worse** — each step transition gained seconds
of scheduler queue latency. The executor calling `replayIfReady`
directly is faster.

### 2. DO NOT delete `inFlightStepIds` after processTask completes

If you remove the stepId from tracking when the task handler finishes
(but before the result is flushed), the next `claimTasks` poll will
see the task again (it hasn't been deleted yet) and re-process it.
Only remove after successful flush.

### 3. DO NOT combine recordResult + claimTasks in one mutation

Early prototypes tried `recordResultAndClaim` — recording results and
claiming new tasks in a single mutation. This caused massive OCC because
50 concurrent mutations per shard all queried the same index range.
Separating claim (read-only query) from record (mutation) eliminates this.

### 4. DO NOT use random shard assignment per step

All steps of a workflow must go to the same shard. If step 1 goes to
shard 3 and step 2 goes to shard 7, the executor on shard 3 replays the
workflow (which inserts step 2 into shard 7), but shard 7's executor
might not poll for another 500ms. Using consistent shard assignment means
the same executor sees the new task immediately.

### 5. "Too many concurrent commits" is expected under load

At 100 shards, each firing `recordResultBatch` + parallel `replayIfReady`
every 500ms, you get 200-600 concurrent mutations. Some will fail with
"too many concurrent commits". This is handled by retry logic and does
not affect correctness. Do not try to eliminate these errors — reducing
mutation pressure would reduce throughput.

### 6. Batch creation starvation is a benchmark artifact

When creating 20k workflows while simultaneously executing them, later
batch creation mutations get starved by step execution mutations. This
shows up as growing gaps between batches in the viz. This is NOT a problem
in production where workflows arrive over time.

## Constants and Their Rationale

| Constant | Value | Rationale |
|----------|-------|-----------|
| `CLAIM_LIMIT` | 800 | High enough to claim all tasks in a shard at once. `claimTasks` is a query (no OCC risk), so reading more is cheap. |
| `MAX_CONCURRENCY` | 200 | Balances throughput vs memory. 200 concurrent promises × 100 shards = 20k concurrent handlers system-wide. Enough for network-bound work (LLM calls). |
| `FLUSH_BATCH_SIZE` | 50 | Each batch touches ~200 DB operations (50 steps + 50 tasks + workflow lookups). Keeps each mutation under Convex limits while batching efficiently. |
| `FLUSH_INTERVAL_MS` | 500 | Step transition latency = FLUSH_INTERVAL + poll time. 500ms is a good balance between latency and mutation pressure. |
| `POLL_BACKOFF_MS` | 500 | When idle, poll every 500ms. Not too aggressive (wastes query budget) or too slow (delays new work). |
| `POLL_BACKOFF_ACTIVE_MS` | 150 | When tasks are running, poll frequently. New tasks from replays appear quickly. |
| `RESCHEDULE_MS` | 8 min | Convex actions timeout at 10 min. 8 min leaves 2 min for handoff protocol + drain. |
| `MAX_FLUSH_RETRIES` | 5 | If flush fails 5 times during drain, give up. Tasks stay in queue for next executor. |
| `HANDOFF_POLL_MS` | 500 | Handoff state checks during transition. |
| `HANDOFF_SUCCESSOR_TIMEOUT_MS` | 30s | Max time old executor waits for new one to signal ready. |
| `HANDOFF_PREDECESSOR_TIMEOUT_MS` | 30s | Max time new executor waits for old one to yield. |
| `JITTER_WINDOW_MS` | 60s | Spread reschedule times across 60s. With N shards, each shard gets a 60/N second slot. |
| `DEFAULT_QM_RETRY` | 4 attempts, 125ms, base 2 | For queries/mutations routed through executor. Handles transient OCC. Actions get no default retry. |

## Benchmark Visualizer

The visualizer is critical for understanding executor behavior. It renders a
waterfall/staircase chart of all workflows, showing how steps overlap in time.

### How it works

The viz is served as a static HTML page from an HTTP route (`/benchmark-viz`).
It uses the Convex HTTP API directly (not the JS client) to poll two queries:

1. **`benchmarkStatusPage`** (every 2s) — Paginated counts of total/completed/failed/running
2. **`benchmarkTimeline`** (every 3s) — Paginated workflow data with step timing

The `?after=<startedAt>` URL parameter filters to workflows created after that
timestamp.

### Timeline query (`timelinePage`)

This component-level query powers the viz. It must be exposed via a public
query wrapper in the app's benchmark module.

```typescript
// In src/component/workflow.ts
export const timelinePage = query({
  args: {
    name: v.string(),
    createdAfter: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { name, createdAfter, paginationOpts }) => {
    const result = await paginator(ctx.db, schema)
      .query("workflows")
      .withIndex("name", (q) => q.eq("name", name))
      .order("desc")
      .paginate(paginationOpts);

    const filtered = createdAfter
      ? result.page.filter((wf) => wf._creationTime >= createdAfter)
      : result.page;

    const hitOld = createdAfter
      ? result.page.some((wf) => wf._creationTime < createdAfter)
      : false;

    const page = await Promise.all(
      filtered.map(async (wf) => {
        const stepDocs = await ctx.db
          .query("steps")
          .withIndex("workflow", (q) => q.eq("workflowId", wf._id))
          .collect();
        return {
          id: wf._id,
          createdAt: wf._creationTime,
          runResult: wf.runResult?.kind,
          steps: stepDocs.map((s) => {
            // Extract executionStartedAt from step result if present.
            // Actions should return { executorStartedAt: Date.now(), ... }
            // at the start of their handler so the viz can distinguish
            // queue wait time (dim) from execution time (bright).
            const rv = s.step.runResult?.kind === "success"
              ? s.step.runResult.returnValue
              : undefined;
            const executionStartedAt = typeof rv?.executorStartedAt === "number"
              ? rv.executorStartedAt
              : undefined;
            return {
              stepNumber: s.stepNumber,
              name: s.step.name,
              startedAt: s.step.startedAt,
              completedAt: s.step.completedAt,
              executionStartedAt,
            };
          }),
        };
      }),
    );

    return { ...result, isDone: result.isDone || hitOld, page };
  },
});
```

**Key detail**: The `executionStartedAt` field is extracted from the step's
return value, not from a separate field. Action handlers should return
`{ executorStartedAt: Date.now(), ... }` at the very start of their handler
(before doing any work). The viz uses this to split each step bar into:
- **Dim portion** (queued): `startedAt` → `executionStartedAt` (time in queue)
- **Bright portion** (executing): `executionStartedAt` → `completedAt` (actual work)

### Canvas rendering

The viz renders at **1 pixel per workflow row** on a canvas, then CSS-scales
the canvas to fill the viewport. This allows rendering 20,000+ rows without
DOM overhead.

```
Canvas dimensions: width = viewport width, height = workflow count
CSS dimensions: width = viewport width, height = viewport height - header
Result: each row is scaled to (viewport height / workflow count) CSS pixels
```

Each step is drawn as a horizontal bar at the workflow's row:
```
x0 = (step.startedAt - benchmarkStart) / timeSpanMs * canvasWidth
x1 = (step.completedAt - benchmarkStart) / timeSpanMs * canvasWidth
```

Step colors by stepNumber:
- 0 (extract): blue `rgba(68,136,255,0.7)`
- 1 (analyze-a): green `rgba(80,220,120,0.45)`
- 2 (analyze-b): orange `rgba(255,180,40,0.45)`
- 3 (summarize): red `rgba(255,68,68,0.7)`

### Reading the waterfall

**Healthy system (simulated 8-12s steps, 20k workflows):**
```
┌──────────────────────────────────────────────────┐
│ ██████████████████████                           │ batch 1 (0-1000)
│  ███████████████████████                         │ batch 2 (1000-2000)
│    ████████████████████████                      │ batch 3 (2000-3000)
│      ██████████████████████████                  │ ...tight staircase
│        ████████████████████████████              │
│          ██████████████████████████████          │
│             ████████████████████████████████     │ batch N
└──────────────────────────────────────────────────┘
0s                                              ~5m
```

Each "step" of the staircase is a batch of 1000 workflows. The slope represents
throughput — steeper = faster.

**Signs of problems:**
- **Wide gaps between staircase steps**: Batch creation starvation (mutations
  for step execution crowding out batch creation mutations)
- **Wide individual step bars**: Steps taking longer than expected (rate
  limiting, slow external services, high queue wait)
- **Dim (queued) portion of bars is large**: Tasks sitting in queue too long
  (not enough executors, or executors too slow to claim)
- **Flat horizontal sections with no activity**: Executor handoff gap
  (should be eliminated by the non-blocking handoff protocol)
- **Bright portions getting wider towards the bottom**: Increasing latency
  for later workflows (rate limiting exhaustion, system pressure)

### HTTP route setup

In `example/convex/http.ts`:

```typescript
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();
http.route({
  path: "/benchmark-viz",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(BENCHMARK_VIZ_HTML, {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      },
    });
  }),
});
export default http;
```

The full HTML source is included inline as a template literal (see
`example/convex/http.ts` in the implementation).

### Required public query wrappers

The viz calls queries via HTTP, so they must be public (not internal):

```typescript
// In example/convex/benchmark.ts
export const benchmarkTimeline = query({
  args: {
    name: v.string(),
    createdAfter: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { name, createdAfter, paginationOpts }) => {
    return await ctx.runQuery(
      components.workflow.workflow.timelinePage,
      { name, createdAfter, paginationOpts },
    );
  },
});

export const benchmarkStatusPage = query({
  args: {
    name: v.string(),
    createdAfter: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { name, createdAfter, paginationOpts }) => {
    return await ctx.runQuery(
      components.workflow.workflow.countByNamePage,
      { name, createdAfter, paginationOpts },
    );
  },
});
```

## Testing Checklist

### Basic functionality
- [ ] Single workflow (1 step) completes via executor
- [ ] Multi-step workflow (sequential steps) completes
- [ ] Parallel steps (Promise.all in workflow handler) complete
- [ ] Workflow with mixed step types (query + mutation + action) completes
- [ ] Workflow failure propagates correctly
- [ ] Workflow cancel deletes task queue entries

### Scale
- [ ] 100 workflows, 0 failures
- [ ] 1,000 workflows, 0 failures
- [ ] 10,000 workflows, 0 failures
- [ ] 20,000 workflows, 0 failures (simulated ~8-12s steps)

### Executor lifecycle
- [ ] Executor self-reschedules at RESCHEDULE_MS
- [ ] Handoff produces zero-gap continuity (no stuck tasks)
- [ ] `startExecutors` terminates old executors (epoch check)
- [ ] Executor drains cleanly on epoch mismatch

### Edge cases
- [ ] Executor dies mid-processing → tasks reclaimable by next executor
- [ ] `recordResultBatch` with stale generationNumber → result discarded
- [ ] Same task claimed by overlapping executors → only one result recorded
- [ ] Empty shard → executor polls and stays alive
- [ ] Flush failure → results buffered and retried
- [ ] Cancel during in-flight step → step result discarded via generationNumber bump

### Benchmark viz
- [ ] Tight staircase pattern for first 10k workflows
- [ ] All workflows complete (0 running, 0 failed for simulated mode)
- [ ] Span under 300s for 20k workflows with 8-12s simulated steps
