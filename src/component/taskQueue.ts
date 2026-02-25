import { v } from "convex/values";
import { vResultValidator } from "@convex-dev/workpool";
import { mutation, query } from "./_generated/server.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { createLogger, DEFAULT_LOG_LEVEL } from "./logging.js";
import type { FunctionHandle } from "convex/server";

const taskResult = v.object({
  functionType: v.union(v.literal("query"), v.literal("mutation"), v.literal("action")),
  handle: v.string(),
  args: v.any(),
  stepId: v.id("steps"),
  workflowId: v.id("workflows"),
  generationNumber: v.number(),
  retry: v.optional(v.object({
    maxAttempts: v.number(),
    initialBackoffMs: v.number(),
    base: v.number(),
  })),
});

export const claimTasks = query({
  args: {
    shard: v.number(),
    limit: v.number(),
  },
  returns: v.array(taskResult),
  handler: async (ctx, { shard, limit }) => {
    // Read tasks without deleting — deletion happens in recordResultBatch
    // to ensure atomicity with step result recording.
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

export const recordResult = mutation({
  args: {
    stepId: v.id("steps"),
    result: vResultValidator,
    generationNumber: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { stepId, result, generationNumber }) => {
    const console = createLogger(DEFAULT_LOG_LEVEL);

    // Helper: always delete the task from the queue, even on early return.
    // Stale/orphaned tasks must not block the shard permanently.
    const deleteTask = async () => {
      const taskEntry = await ctx.db
        .query("taskQueue")
        .withIndex("by_stepId", (q) => q.eq("stepId", stepId))
        .unique();
      if (taskEntry) {
        await ctx.db.delete(taskEntry._id);
      }
    };

    // 1. Record the step result (same logic as pool.ts:onCompleteHandler)
    const journalEntry = await ctx.db.get(stepId);
    if (!journalEntry) {
      console.error(`Journal entry not found: ${stepId}`);
      await deleteTask();
      return null;
    }
    const workflowId = journalEntry.workflowId;
    const workflow = await ctx.db.get(workflowId);
    if (!workflow) {
      console.error(`Workflow not found: ${workflowId}`);
      await deleteTask();
      return null;
    }
    if (workflow.generationNumber !== generationNumber) {
      console.error(
        `Workflow: ${workflowId} already has generation number ${workflow.generationNumber} when completing ${stepId}`,
      );
      await deleteTask();
      return null;
    }
    if (!journalEntry.step.inProgress) {
      console.error(
        `Step finished but journal entry not in progress: ${stepId}`,
      );
      await deleteTask();
      return null;
    }

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
        journalEntry.step.runResult = {
          kind: "canceled",
        };
        break;
    }
    await ctx.db.replace(journalEntry._id, journalEntry);

    console.event("stepCompleted", {
      workflowId,
      workflowName: workflow.name,
      status: result.kind,
      stepName: journalEntry.step.name,
      stepNumber: journalEntry.stepNumber,
      durationMs: journalEntry.step.completedAt - journalEntry.step.startedAt,
    });

    // 2. Delete the task from the queue (atomically with result recording)
    await deleteTask();

    if (workflow.runResult !== undefined) {
      return null;
    }

    // 3. Check if this was the last in-progress step → replay workflow inline
    const otherInProgress = await ctx.db
      .query("steps")
      .withIndex("inProgress", (q) =>
        q.eq("step.inProgress", true).eq("workflowId", workflowId),
      )
      .first();
    if (!otherInProgress) {
      try {
        await ctx.runMutation(
          workflow.workflowHandle as FunctionHandle<"mutation">,
          {
            workflowId: workflow._id,
            generationNumber: workflow.generationNumber,
          },
        );
      } catch (e) {
        const error =
          e instanceof Error ? e.message : `Unknown error: ${String(e)}`;
        console.error(`Error running workflow ${workflowId}: ${error}`);
        await ctx.db.patch(workflowId, {
          runResult: { kind: "failed", error },
        });
      }
    }

    return null;
  },
});

export const startExecutors = mutation({
  args: {
    executorHandle: v.string(),
    numShards: v.number(),
  },
  returns: v.number(), // returns the new epoch
  handler: async (ctx, { executorHandle, numShards }) => {
    // Increment executor epoch — old executors with stale epochs will terminate.
    const existing = await ctx.db
      .query("executorEpoch")
      .first();
    let epoch: number;
    if (existing) {
      epoch = existing.epoch + 1;
      await ctx.db.patch(existing._id, { epoch });
    } else {
      epoch = 1;
      await ctx.db.insert("executorEpoch", { epoch });
    }
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

export const getExecutorEpoch = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("executorEpoch")
      .first();
    return existing?.epoch ?? 0;
  },
});

const replayCandidate = v.object({
  workflowId: v.id("workflows"),
  generationNumber: v.number(),
  workflowHandle: v.string(),
});

export const recordResultBatch = mutation({
  args: {
    items: v.array(
      v.object({
        stepId: v.id("steps"),
        result: vResultValidator,
        generationNumber: v.number(),
        executorFinishedAt: v.optional(v.number()),
        flushCalledAt: v.optional(v.number()),
      }),
    ),
    replayInline: v.optional(v.boolean()),
  },
  returns: v.array(replayCandidate),
  handler: async (ctx, { items, replayInline }) => {
    const console = createLogger(DEFAULT_LOG_LEVEL);
    const candidates = new Map<
      string,
      { workflowId: Id<"workflows">; workflowHandle: string; generationNumber: number }
    >();

    for (const { stepId, result, generationNumber, executorFinishedAt, flushCalledAt } of items) {
      const deleteTask = async () => {
        const taskEntry = await ctx.db
          .query("taskQueue")
          .withIndex("by_stepId", (q) => q.eq("stepId", stepId))
          .unique();
        if (taskEntry) {
          await ctx.db.delete(taskEntry._id);
        }
      };

      const journalEntry = await ctx.db.get(stepId);
      if (!journalEntry) {
        await deleteTask();
        continue;
      }
      const workflowId = journalEntry.workflowId;
      const workflow = await ctx.db.get(workflowId);
      if (!workflow) {
        await deleteTask();
        continue;
      }
      if (workflow.generationNumber !== generationNumber) {
        await deleteTask();
        continue;
      }
      if (!journalEntry.step.inProgress) {
        await deleteTask();
        continue;
      }

      journalEntry.step.inProgress = false;
      journalEntry.step.completedAt = Date.now();
      if (executorFinishedAt) {
        journalEntry.step.executorFinishedAt = executorFinishedAt;
      }
      if (flushCalledAt) {
        journalEntry.step.flushCalledAt = flushCalledAt;
      }
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
          journalEntry.step.runResult = {
            kind: "canceled",
          };
          break;
      }
      await ctx.db.replace(journalEntry._id, journalEntry);

      console.event("stepCompleted", {
        workflowId,
        workflowName: workflow.name,
        status: result.kind,
        stepName: journalEntry.step.name,
        stepNumber: journalEntry.stepNumber,
        durationMs: journalEntry.step.completedAt - journalEntry.step.startedAt,
      });

      await deleteTask();

      if (workflow.runResult === undefined) {
        candidates.set(workflowId, {
          workflowId,
          workflowHandle: workflow.workflowHandle,
          generationNumber: workflow.generationNumber,
        });
      }
    }

    // Durable safety net: schedule a delayed replayIfReady for each
    // candidate. This is committed atomically with the result recording,
    // so it survives executor crashes and hard timeouts. In the normal
    // case inline replay handles it first and the scheduled call is a
    // cheap no-op (checks runResult, returns early).
    if (replayInline) {
      for (const candidate of candidates.values()) {
        await ctx.scheduler.runAfter(
          10_000,
          api.taskQueue.replayIfReady,
          candidate,
        );
      }
    }

    // When replayInline is set, attempt replay within this same mutation.
    // This eliminates OCC conflicts for the common case. Candidates where
    // other steps are still in-progress are returned to the client so it
    // can retry via replayBatchIfReady — this prevents the race where two
    // concurrent batches each complete the "last" step but both skip replay
    // because neither sees the other's commit (snapshot isolation).
    if (replayInline) {
      const unreplayed: Array<{ workflowId: Id<"workflows">; workflowHandle: string; generationNumber: number }> = [];
      for (const candidate of candidates.values()) {
        const { workflowId, generationNumber, workflowHandle } = candidate;
        const workflow = await ctx.db.get(workflowId);
        if (!workflow || workflow.runResult || workflow.generationNumber !== generationNumber) {
          continue;
        }
        const inProgress = await ctx.db
          .query("steps")
          .withIndex("inProgress", (q) =>
            q.eq("step.inProgress", true).eq("workflowId", workflowId),
          )
          .first();
        if (inProgress) {
          // Other steps still running in a concurrent batch — return to
          // client for retry so the workflow isn't permanently stranded.
          unreplayed.push(candidate);
          continue;
        }
        try {
          await ctx.runMutation(
            workflowHandle as FunctionHandle<"mutation">,
            { workflowId, generationNumber },
          );
        } catch (e) {
          const error = e instanceof Error ? e.message : `Unknown error: ${String(e)}`;
          console.error(`Error running workflow ${workflowId}: ${error}`);
          await ctx.db.patch(workflowId, {
            runResult: { kind: "failed", error },
          });
        }
      }
      return unreplayed;
    }

    // Return candidates — executor handles replay in a concurrent pipeline.
    // No inProgress index reads here = minimal OCC surface.
    return [...candidates.values()];
  },
});

// Per-workflow replay check. Called from executor after recordResultBatch.
// Small mutation = minimal OCC conflict surface.
export const replayIfReady = mutation({
  args: replayCandidate,
  returns: v.null(),
  handler: async (ctx, { workflowId, generationNumber, workflowHandle }) => {
    const console = createLogger(DEFAULT_LOG_LEVEL);
    const workflow = await ctx.db.get(workflowId);
    if (!workflow || workflow.runResult || workflow.generationNumber !== generationNumber) {
      return null;
    }
    const inProgress = await ctx.db
      .query("steps")
      .withIndex("inProgress", (q) =>
        q.eq("step.inProgress", true).eq("workflowId", workflowId),
      )
      .first();
    if (inProgress) {
      return null;
    }
    try {
      await ctx.runMutation(
        workflowHandle as FunctionHandle<"mutation">,
        { workflowId, generationNumber },
      );
    } catch (e) {
      const error = e instanceof Error ? e.message : `Unknown error: ${String(e)}`;
      console.error(`Error running workflow ${workflowId}: ${error}`);
      await ctx.db.patch(workflowId, {
        runResult: { kind: "failed", error },
      });
    }
    return null;
  },
});

// Batched replay: process multiple candidates in a single mutation call.
// Reduces mutation count from N to 1, avoiding "too many concurrent commits".
export const replayBatchIfReady = mutation({
  args: { candidates: v.array(replayCandidate) },
  returns: v.null(),
  handler: async (ctx, { candidates }) => {
    const console = createLogger(DEFAULT_LOG_LEVEL);
    for (const { workflowId, generationNumber, workflowHandle } of candidates) {
      const workflow = await ctx.db.get(workflowId);
      if (!workflow || workflow.runResult || workflow.generationNumber !== generationNumber) {
        continue;
      }
      const inProgress = await ctx.db
        .query("steps")
        .withIndex("inProgress", (q) =>
          q.eq("step.inProgress", true).eq("workflowId", workflowId),
        )
        .first();
      if (inProgress) {
        continue;
      }
      try {
        await ctx.runMutation(
          workflowHandle as FunctionHandle<"mutation">,
          { workflowId, generationNumber },
        );
      } catch (e) {
        const error = e instanceof Error ? e.message : `Unknown error: ${String(e)}`;
        console.error(`Error running workflow ${workflowId}: ${error}`);
        await ctx.db.patch(workflowId, {
          runResult: { kind: "failed", error },
        });
      }
    }
    return null;
  },
});

export const diagnose = query({
  args: {
    numShards: v.optional(v.number()),
  },
  returns: v.object({
    taskQueueCounts: v.array(v.object({ shard: v.number(), count: v.number() })),
    totalTasks: v.number(),
    executorEpoch: v.number(),
  }),
  handler: async (ctx, { numShards }) => {
    const shards = numShards ?? 40;
    // Use indexed per-shard queries instead of table scan.
    const taskQueueCounts: Array<{ shard: number; count: number }> = [];
    let totalTasks = 0;
    for (let s = 0; s < shards; s++) {
      let count = 0;
      for await (const _task of ctx.db
        .query("taskQueue")
        .withIndex("by_shard", (q) => q.eq("shard", s))) {
        count++;
      }
      if (count > 0) {
        taskQueueCounts.push({ shard: s, count });
        totalTasks += count;
      }
    }

    const existing = await ctx.db.query("executorEpoch").first();
    const executorEpoch = existing?.epoch ?? 0;

    return { taskQueueCounts, totalTasks, executorEpoch };
  },
});

export const handoff = mutation({
  args: {
    shard: v.number(),
    action: v.union(
      v.literal("init"),
      v.literal("ready"),
      v.literal("yielded"),
      v.literal("clear"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { shard, action }) => {
    const existing = await ctx.db
      .query("executorHandoff")
      .withIndex("by_shard", (q) => q.eq("shard", shard))
      .unique();

    switch (action) {
      case "init": {
        // Old executor creates the handoff doc (delete stale first).
        if (existing) {
          await ctx.db.delete(existing._id);
        }
        await ctx.db.insert("executorHandoff", {
          shard,
          ready: false,
          yielded: false,
        });
        break;
      }
      case "ready": {
        // New executor signals it's warmed up.
        if (existing) {
          await ctx.db.patch(existing._id, { ready: true });
        }
        break;
      }
      case "yielded": {
        // Old executor confirms it has stopped claiming.
        if (existing) {
          await ctx.db.patch(existing._id, { yielded: true });
        }
        break;
      }
      case "clear": {
        // New executor cleans up after handoff completes.
        if (existing) {
          await ctx.db.delete(existing._id);
        }
        break;
      }
    }
    return null;
  },
});

export const getHandoff = query({
  args: {
    shard: v.number(),
  },
  returns: v.union(
    v.object({ ready: v.boolean(), yielded: v.boolean() }),
    v.null(),
  ),
  handler: async (ctx, { shard }) => {
    const existing = await ctx.db
      .query("executorHandoff")
      .withIndex("by_shard", (q) => q.eq("shard", shard))
      .unique();
    if (!existing) return null;
    return { ready: existing.ready, yielded: existing.yielded };
  },
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
