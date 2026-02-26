# Formal Model: Workflow Replay Safety

## Goal
Prove that **every workflow eventually reaches a terminal state** (completed or failed),
assuming executors are eventually restarted and the Convex backend is available.

## System State

```
Workflow W:
  steps: Set<Step>
  runResult: Success | Failed | null       (terminal when non-null)
  generationNumber: nat

Step S ∈ W.steps:
  inProgress: bool
  runResult: Success | Failed | null

TaskQueue:
  entries: Map<StepId, Task>               (deleted atomically with result recording)

Executor E (per shard):
  pendingResults: List<PendingResult>       (in-memory, lost on crash)
  replayRescueQueue: List<ReplayCandidate>  (in-memory, lost on crash)
  inFlightStepIds: Set<StepId>              (in-memory, lost on crash)
```

## Key Invariants

**INV1 (Task Conservation):** A step is either:
  (a) `inProgress=false` with a `runResult`, OR
  (b) `inProgress=true` AND has a task in the TaskQueue, OR
  (c) `inProgress=true` AND has a result in some executor's `pendingResults`

**INV2 (Replay Liveness):** If all steps of workflow W have `inProgress=false` and
  `W.runResult=null`, then at least one of:
  (a) An inline replay is about to commit (inside recordResultBatch), OR
  (b) A replayBatchIfReady candidate exists in some executor's flush pipeline, OR
  (c) A candidate exists in some executor's rescueQueue, OR
  (d) The workflow will be re-replayed when the executor restarts and drains the shard

**INV3 (Idempotent Replay):** Calling the workflow mutation when all steps are complete
  is idempotent — it reads the journal, skips completed steps, and returns the final result.

## Transitions

### T1: Workflow Created
- Steps enqueued: step.inProgress=true, task inserted in TaskQueue
- INV1(b) satisfied

### T2: Executor Claims Task (claimTasks query)
- Read-only query, does NOT delete from TaskQueue
- Task still in queue — another executor or retry can re-claim
- INV1(b) still holds

### T3: Executor Processes Task
- Runs the action/query/mutation
- Pushes result to pendingResults (in-memory)
- Step transitions from INV1(b) to INV1(c)
- Task still in queue (not yet deleted)

### T4: Flush — recordResultBatch (with replayInline=true)
**Atomic mutation:**
1. For each item: mark step.inProgress=false, set runResult, delete task from queue
2. Build candidates map (workflows with runResult=null)
3. For each candidate:
   - Check inProgress index for workflow
   - If no in-progress steps → replay inline (run workflow mutation)
   - If in-progress steps exist → add to `unreplayed` return list
4. Return unreplayed candidates

**After mutation returns to client:**
5. If unreplayed.length > 0 → call replayBatchIfReady → rescue queue on failure

### T5: replayBatchIfReady
**Atomic mutation per candidate:**
1. Check workflow.runResult, generationNumber
2. Check inProgress index → if none, replay
3. OCC protects against concurrent recordResultBatch

## Race Condition Analysis

### Case A: Steps 2a and 2b complete in the SAME batch (same shard)
Within one recordResultBatch mutation:
1. Mark 2a.inProgress=false
2. Mark 2b.inProgress=false
3. Check inProgress for W → both done → replay fires ✓

### Case B: Steps 2a and 2b complete in DIFFERENT batches (different shards)

**Sub-case B1: Batch A commits before Batch B executes**
- Batch A: marks 2a done, checks inProgress → 2b still running → returns W as unreplayed
- Batch B: marks 2b done, checks inProgress → 2a already done → replay fires ✓
- Client A calls replayBatchIfReady for W → W already has runResult → no-op ✓

**Sub-case B2: Batches overlap, OCC detects conflict**
- Batch A reads inProgress index (sees 2b's entry)
- Batch B writes 2b (modifies inProgress index)
- OCC conflict → one is retried → eventually reduces to B1 ✓

**Sub-case B3: Batches overlap, OCC retries exhausted (≤4 retries)**
- One batch fails permanently → mutation rolled back
- Step result NOT recorded, task NOT deleted from queue
- Client catches error, pushes batch back to pendingResults
- Next flush tick retries → eventually reduces to B1 or B2 ✓

**Sub-case B4: B3 + executor dies before retry**
- pendingResults lost (in-memory)
- BUT: task still in queue (mutation rolled back)
- New executor claims task, re-processes, re-flushes → reduces to B1/B2 ✓

### Case C: replayInline skips (inProgress found), client calls replayBatchIfReady

**Sub-case C1: replayBatchIfReady succeeds**
- Checks inProgress → if all done, replays ✓

**Sub-case C2: replayBatchIfReady fails (OCC)**
- Retry once, then rescue queue
- Rescue queue drained on every flush tick and on shutdown
- Eventually succeeds ✓

**Sub-case C3: replayBatchIfReady in rescue queue + executor dies**
- Rescue queue lost (in-memory)
- All step results ARE recorded (recordResultBatch committed)
- Tasks ARE deleted from queue
- **No task in queue to trigger re-processing**
- **No pending result to trigger re-flush**
- ⚠️ POTENTIAL DEADLOCK — workflow stuck with all steps done, no replay

## Identified Gap: Case C3

When:
1. recordResultBatch succeeds (steps done, tasks deleted)
2. replayInline skips (other steps in concurrent batch still "in progress" per snapshot)
3. Candidate returned to client
4. replayBatchIfReady fails → rescue queue
5. Executor dies → rescue queue lost

**Result:** Workflow W has all steps complete but runResult=null. No mechanism to recover.

### Can B4 + C3 co-occur?
- Shard X: recordResultBatch for step 2a succeeds → 2a done, task deleted
  - inProgress check: 2b in progress → unreplayed candidate → replayBatchIfReady
- Shard Y: recordResultBatch for step 2b succeeds → 2b done, task deleted
  - inProgress check: 2a NOT in progress (shard X committed) → replay fires ✓

So C3 only triggers if BOTH shards return unreplayed candidates AND their
replayBatchIfReady calls BOTH fail. Let's trace:
- Shard X calls replayBatchIfReady → checks inProgress → all done → replays ✓

Actually, by the time shard X calls replayBatchIfReady, both batches have
committed. So inProgress is empty → replay fires.

C3 requires replayBatchIfReady to FAIL even though all steps are done.
This could happen due to OCC with another concurrent mutation touching the
same workflow. After rescue queue retries, it should eventually succeed.

**The only true deadlock is: all retries fail + executor dies.**

## Mitigation Options for C3

### Option 1: Periodic sweep (belt-and-suspenders)
A scheduled job runs every N minutes, scans for workflows where:
- runResult = null
- No steps with inProgress = true
- createdAt > threshold (avoid racing with fresh workflows)
And replays them. Cost: one query per sweep, rare replays.

### Option 2: Executor startup sweep
When a new executor starts, before entering the main loop, query for "orphaned"
workflows (all steps done, no runResult, no tasks in queue) and replay them.

### Option 3: Guaranteed drain
Ensure executors NEVER die with rescue queue items. Use ctx.scheduler.runAfter
as a last resort in the finally block to schedule individual replay mutations
for any remaining rescue queue items.

## Recommendation

**Option 3 is the strongest guarantee.** In the executor's finally block, before
exit, schedule individual replayIfReady mutations for any remaining rescue queue
items. This ensures that even if the executor action times out, the replays are
durably scheduled in the Convex scheduler.

```typescript
// In executor finally block, after draining rescue queue:
if (replayRescueQueue.length > 0) {
  // Last resort: schedule durable replay for any remaining candidates
  for (const candidate of replayRescueQueue) {
    await ctx.scheduler.runAfter(0, component.taskQueue.replayIfReady, candidate);
  }
}
```

This transforms the in-memory rescue queue into durable scheduled jobs as a
final safety net. The scheduled replayIfReady calls are idempotent.

## Also: protect pendingResults on shutdown

The same pattern should be applied to unflushed pendingResults. If the executor
is about to die with results that haven't been recorded:

```typescript
// In executor finally block, after waitUntilIdle:
if (pendingResults.length > 0) {
  // Results that couldn't be flushed — tasks are still in queue,
  // so they'll be re-processed by the next executor. No action needed.
  // (Task conservation: INV1(b) still holds since mutation never committed.)
}
```

For pendingResults, no action is needed because the tasks are still in the queue
(recordResultBatch never committed for them). The next executor will re-claim
and re-process them.

## Conclusion

With Option 3 (scheduler.runAfter for rescue queue in finally block), the system
provides the following guarantee:

**Every workflow eventually reaches a terminal state**, given:
- Convex backend is available
- Executors are eventually restarted (or the scheduled replays run)
- The workflow mutation itself doesn't have an infinite loop

The only remaining failure mode is Convex platform unavailability, which is
outside the system's control.
