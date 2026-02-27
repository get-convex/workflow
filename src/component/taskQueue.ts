import { v } from "convex/values";
import { vResultValidator } from "@convex-dev/workpool";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { createLogger, DEFAULT_LOG_LEVEL } from "./logging.js";
import type { FunctionHandle } from "convex/server";

const WATCHDOG_INTERVAL_MS = 30_000; // check every 30s
const WATCHDOG_STALE_MS = 60_000;    // task in queue >60s = shard is dead

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
    // Ascending order: earlier workflows first → workflows created first
    // finish before later ones start, improving time-to-first-completion.
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
      await ctx.db.patch(existing._id, { epoch, executorHandle, numShards, watchdogScheduled: true });
    } else {
      epoch = 1;
      await ctx.db.insert("executorEpoch", { epoch, executorHandle, numShards, watchdogScheduled: true });
    }
    for (let i = 0; i < numShards; i++) {
      await ctx.scheduler.runAfter(
        0,
        executorHandle as FunctionHandle<"action">,
        { shard: i, epoch },
      );
    }
    await ctx.scheduler.runAfter(WATCHDOG_INTERVAL_MS, internal.taskQueue.watchdog);
    return epoch;
  },
});

// Bump the executor epoch without starting new executors.
// Running executors will see the stale epoch, drain in-flight tasks, and exit.
export const bumpEpoch = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("executorEpoch")
      .first();
    let epoch: number;
    if (existing) {
      epoch = existing.epoch + 1;
      await ctx.db.patch(existing._id, { epoch, watchdogScheduled: false });
    } else {
      epoch = 1;
      await ctx.db.insert("executorEpoch", { epoch });
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

// Self-rescheduling watchdog that detects dead executor shards and reschedules them.
// If a shard has tasks older than WATCHDOG_STALE_MS, the executor is likely dead.
// Processes shards in batches to stay under Convex read limits (32k docs).
export const watchdog = internalMutation({
  args: { shardOffset: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { shardOffset }) => {
    const console = createLogger(DEFAULT_LOG_LEVEL);
    const config = await ctx.db.query("executorEpoch").first();
    if (!config?.executorHandle || !config?.numShards || !config.watchdogScheduled) {
      if (config && config.watchdogScheduled) {
        await ctx.db.patch(config._id, { watchdogScheduled: false });
      }
      return null;
    }
    const { epoch, executorHandle, numShards } = config;
    const now = Date.now();
    let rescheduled = 0;

    // Process shards in batches of 25 to stay well under read limits.
    const SHARDS_PER_TICK = 25;
    const start = shardOffset ?? 0;
    const end = Math.min(start + SHARDS_PER_TICK, numShards);

    for (let shard = start; shard < end; shard++) {
      const oldest = await ctx.db
        .query("taskQueue")
        .withIndex("by_shard", (q) => q.eq("shard", shard))
        .first();
      if (oldest && now - oldest._creationTime > WATCHDOG_STALE_MS) {
        await ctx.scheduler.runAfter(0, executorHandle as FunctionHandle<"action">, { shard, epoch });
        rescheduled++;
        continue; // skip replayQueue check — already rescheduling this shard
      }

      const oldestReplay = await ctx.db
        .query("replayQueue")
        .withIndex("by_shard", (q) => q.eq("shard", shard))
        .first();
      if (oldestReplay && now - oldestReplay._creationTime > WATCHDOG_STALE_MS) {
        await ctx.scheduler.runAfter(0, executorHandle as FunctionHandle<"action">, { shard, epoch });
        rescheduled++;
      }
    }

    if (rescheduled > 0) {
      console.warn(`watchdog: rescheduled ${rescheduled} dead shard(s) (shards ${start}-${end - 1})`);
    }

    if (end < numShards) {
      // More shards to check — continue immediately with next batch.
      await ctx.scheduler.runAfter(0, internal.taskQueue.watchdog, { shardOffset: end });
    } else {
      // Full cycle done — wait before starting next sweep.
      await ctx.scheduler.runAfter(WATCHDOG_INTERVAL_MS, internal.taskQueue.watchdog, { shardOffset: 0 });
    }
    return null;
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
    shard: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { items, shard }) => {
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

    // 1. Insert durable replay queue entry for each candidate (write-only,
    //    no reads — cannot OCC with processReplayBatch).
    const replayEntryIds = new Map<string, Id<"replayQueue">>();
    for (const candidate of candidates.values()) {
      const entryId = await ctx.db.insert("replayQueue", {
        shard,
        workflowId: candidate.workflowId,
        generationNumber: candidate.generationNumber,
        workflowHandle: candidate.workflowHandle,
      });
      replayEntryIds.set(candidate.workflowId, entryId);
    }

    // 2. Best-effort inline replay — fast path that eliminates a poll-cycle
    //    round-trip. On success, delete the replay entry (same mutation, no
    //    OCC risk). If this fails, the entry persists for processReplayBatch.
    for (const candidate of candidates.values()) {
      const { workflowId, generationNumber, workflowHandle } = candidate;
      const workflow = await ctx.db.get(workflowId);
      if (!workflow || workflow.runResult || workflow.generationNumber !== generationNumber) {
        // Workflow already done — delete the replay entry.
        const entryId = replayEntryIds.get(workflowId);
        if (entryId) await ctx.db.delete(entryId);
        continue;
      }
      const inProgress = await ctx.db
        .query("steps")
        .withIndex("inProgress", (q) =>
          q.eq("step.inProgress", true).eq("workflowId", workflowId),
        )
        .first();
      if (inProgress) continue; // Other steps running — keep replay entry.
      try {
        await ctx.runMutation(
          workflowHandle as FunctionHandle<"mutation">,
          { workflowId, generationNumber },
        );
        // Replay succeeded — delete the replay entry.
        const entryId = replayEntryIds.get(workflowId);
        if (entryId) await ctx.db.delete(entryId);
      } catch (e) {
        const error = e instanceof Error ? e.message : `Unknown error: ${String(e)}`;
        console.error(`Error running workflow ${workflowId}: ${error}`);
        await ctx.db.patch(workflowId, {
          runResult: { kind: "failed", error },
        });
        // Workflow marked failed — delete the replay entry.
        const entryId = replayEntryIds.get(workflowId);
        if (entryId) await ctx.db.delete(entryId);
      }
    }
    return null;
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

const replayEntry = v.object({
  _id: v.id("replayQueue"),
  shard: v.number(),
  workflowId: v.id("workflows"),
  generationNumber: v.number(),
  workflowHandle: v.string(),
});

// Claim pending replays for a shard. Same pattern as claimTasks.
export const claimReplays = query({
  args: { shard: v.number(), limit: v.number() },
  returns: v.array(replayEntry),
  handler: async (ctx, { shard, limit }) => {
    const entries = await ctx.db
      .query("replayQueue")
      .withIndex("by_shard", (q) => q.eq("shard", shard))
      .take(limit);
    return entries.map((e) => ({
      _id: e._id,
      shard: e.shard,
      workflowId: e.workflowId,
      generationNumber: e.generationNumber,
      workflowHandle: e.workflowHandle,
    }));
  },
});

// Process replay queue entries. Deletes each entry by ID (no index scan)
// so it cannot OCC with recordResultBatch's write-only inserts.
// Re-inserts if steps are still in-progress.
export const processReplayBatch = mutation({
  args: { entries: v.array(replayEntry) },
  returns: v.null(),
  handler: async (ctx, { entries }) => {
    const console = createLogger(DEFAULT_LOG_LEVEL);
    // Deduplicate by workflowId — keep only the first entry per workflow.
    const seen = new Set<string>();
    for (const entry of entries) {
      // Delete this entry by ID (point read, no index scan).
      const doc = await ctx.db.get(entry._id);
      if (doc) await ctx.db.delete(entry._id);

      // Skip duplicates — only process first entry per workflow.
      if (seen.has(entry.workflowId)) continue;
      seen.add(entry.workflowId);

      // Check if replay still needed.
      const workflow = await ctx.db.get(entry.workflowId);
      if (!workflow || workflow.runResult || workflow.generationNumber !== entry.generationNumber) {
        continue;
      }

      const inProgress = await ctx.db
        .query("steps")
        .withIndex("inProgress", (q) =>
          q.eq("step.inProgress", true).eq("workflowId", entry.workflowId),
        )
        .first();
      if (inProgress) {
        // Steps still running — re-insert to try again later.
        await ctx.db.insert("replayQueue", {
          shard: entry.shard,
          workflowId: entry.workflowId,
          generationNumber: entry.generationNumber,
          workflowHandle: entry.workflowHandle,
        });
        continue;
      }

      // Replay.
      try {
        await ctx.runMutation(
          entry.workflowHandle as FunctionHandle<"mutation">,
          { workflowId: entry.workflowId, generationNumber: entry.generationNumber },
        );
      } catch (e) {
        const error = e instanceof Error ? e.message : `Unknown error: ${String(e)}`;
        console.error(`Error running workflow ${entry.workflowId}: ${error}`);
        await ctx.db.patch(entry.workflowId, {
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

export const clearReplayQueue = mutation({
  args: { shard: v.number(), limit: v.number() },
  returns: v.number(),
  handler: async (ctx, { shard, limit }) => {
    const entries = await ctx.db
      .query("replayQueue")
      .withIndex("by_shard", (q) => q.eq("shard", shard))
      .take(limit);
    for (const entry of entries) {
      await ctx.db.delete(entry._id);
    }
    return entries.length;
  },
});

export const clearTaskQueue = mutation({
  args: { shard: v.number(), limit: v.number() },
  returns: v.number(),
  handler: async (ctx, { shard, limit }) => {
    const entries = await ctx.db
      .query("taskQueue")
      .withIndex("by_shard", (q) => q.eq("shard", shard))
      .take(limit);
    for (const entry of entries) {
      await ctx.db.delete(entry._id);
    }
    return entries.length;
  },
});

// Fail all pending tasks in a shard: marks steps as failed, deletes task entries,
// and triggers replay for affected workflows.
export const failPendingTasks = mutation({
  args: { shard: v.number(), limit: v.number() },
  returns: v.object({ failed: v.number() }),
  handler: async (ctx, { shard, limit }) => {
    const console = createLogger(DEFAULT_LOG_LEVEL);
    const tasks = await ctx.db
      .query("taskQueue")
      .withIndex("by_shard", (q) => q.eq("shard", shard))
      .take(limit);

    const replayCandidates = new Map<
      string,
      { workflowId: Id<"workflows">; workflowHandle: string; generationNumber: number }
    >();

    for (const task of tasks) {
      // Mark step as failed.
      const step = await ctx.db.get(task.stepId);
      if (step && step.step.inProgress) {
        step.step.inProgress = false;
        step.step.completedAt = Date.now();
        step.step.runResult = { kind: "failed", error: "Force-failed by failPendingTasks" };
        await ctx.db.replace(step._id, step);
      }

      // Delete task queue entry.
      await ctx.db.delete(task._id);

      // Collect replay candidate.
      const workflow = await ctx.db.get(task.workflowId);
      if (workflow && !workflow.runResult) {
        replayCandidates.set(task.workflowId, {
          workflowId: task.workflowId,
          workflowHandle: workflow.workflowHandle,
          generationNumber: workflow.generationNumber,
        });
      }
    }

    // Insert durable replay entries for affected workflows.
    for (const candidate of replayCandidates.values()) {
      await ctx.db.insert("replayQueue", {
        shard,
        workflowId: candidate.workflowId,
        generationNumber: candidate.generationNumber,
        workflowHandle: candidate.workflowHandle,
      });
    }

    console.info(`failPendingTasks shard=${shard}: failed ${tasks.length} tasks, ${replayCandidates.size} workflows need replay`);
    return { failed: tasks.length };
  },
});

export const diagnoseStuck = query({
  args: {
    name: v.string(),
    createdAfter: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, { name, createdAfter, limit }) => {
    const stuck: Array<{
      id: string;
      createdAt: number;
      generationNumber: number;
      steps: Array<{
        id: string;
        inProgress: boolean;
        hasRunResult: boolean;
        startedAt: number;
        completedAt?: number;
      }>;
      tasksInQueue: number;
    }> = [];

    for await (const wf of ctx.db
      .query("workflows")
      .withIndex("name", (q) => q.eq("name", name))
      .order("desc")) {
      if (wf._creationTime < createdAfter) break;
      if (wf.runResult) continue;
      if (stuck.length >= limit) break;

      const steps = await ctx.db
        .query("steps")
        .withIndex("workflow", (q) => q.eq("workflowId", wf._id))
        .collect();

      let tasksInQueue = 0;
      for (const s of steps) {
        const task = await ctx.db
          .query("taskQueue")
          .withIndex("by_stepId", (q) => q.eq("stepId", s._id))
          .first();
        if (task) tasksInQueue++;
      }

      stuck.push({
        id: wf._id,
        createdAt: wf._creationTime,
        generationNumber: wf.generationNumber,
        steps: steps.map((s) => ({
          id: s._id,
          inProgress: s.step.inProgress,
          hasRunResult: !!s.step.runResult,
          startedAt: s.step.startedAt,
          completedAt: s.step.completedAt,
        })),
        tasksInQueue,
      });
    }
    return { count: stuck.length, stuck };
  },
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
