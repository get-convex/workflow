import { v } from "convex/values";
import { vResultValidator } from "@convex-dev/workpool";
import { mutation, query } from "./_generated/server.js";
import {
  journalDocument,
  type JournalEntry,
  journalEntrySize,
  step,
  workflowDocument,
} from "./schema.js";
import { getWorkflow } from "./model.js";
import { logLevel } from "./logging.js";
import { vRetryBehavior, type WorkId } from "@convex-dev/workpool";
import {
  getWorkpool,
  type OnCompleteContext,
  workpoolOptions,
} from "./pool.js";
import { internal } from "./_generated/api.js";
import { createFunctionHandle, type FunctionHandle } from "convex/server";
import { getDefaultLogger } from "./utils.js";
import { assert } from "convex-helpers";
import { MAX_JOURNAL_SIZE } from "../shared.js";
import { awaitEvent } from "./event.js";
import { createHandler } from "./workflow.js";

export const load = query({
  args: {
    workflowId: v.id("workflows"),
    shortCircuit: v.optional(v.boolean()),
  },
  returns: v.object({
    workflow: workflowDocument,
    journalEntries: v.array(journalDocument),
    ok: v.boolean(),
    logLevel,
    blocked: v.optional(v.boolean()),
  }),
  handler: async (ctx, { workflowId, shortCircuit }) => {
    const workflow = await ctx.db.get(workflowId);
    assert(workflow, `Workflow not found: ${workflowId}`);
    const { logLevel } = await getDefaultLogger(ctx);
    const journalEntries: JournalEntry[] = [];
    let journalSize = 0;
    if (shortCircuit) {
      const inProgress = await ctx.db
        .query("steps")
        .withIndex("inProgress", (q) =>
          q.eq("step.inProgress", true).eq("workflowId", workflowId),
        )
        .first();
      if (inProgress) {
        return {
          journalEntries: [inProgress],
          blocked: true,
          workflow,
          logLevel,
          ok: true,
        };
      }
    }
    const t0 = Date.now();
    for await (const entry of ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflowId))) {
      journalEntries.push(entry);
      journalSize += journalEntrySize(entry);
      if (journalSize > MAX_JOURNAL_SIZE) {
        return { journalEntries, workflow, logLevel, ok: false };
      }
    }
    if (journalEntries.length > 10) {
      const elapsed = Date.now() - t0;
      globalThis.console.info(
        `[PERF] journal.load read ${journalEntries.length} entries in ${elapsed}ms (${journalSize} bytes)`,
      );
    }
    return { journalEntries, workflow, logLevel, ok: true };
  },
});

export const startSteps = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    steps: v.array(
      v.object({
        step,
        retry: v.optional(v.union(v.boolean(), vRetryBehavior)),
        schedulerOptions: v.optional(
          v.union(
            v.object({ runAt: v.optional(v.number()) }),
            v.object({ runAfter: v.optional(v.number()) }),
          ),
        ),
      }),
    ),
    workpoolOptions: v.optional(workpoolOptions),
  },
  returns: v.array(journalDocument),
  handler: async (ctx, args): Promise<JournalEntry[]> => {
    if (!args.steps.every((step) => step.step.inProgress)) {
      throw new Error(`Assertion failed: not in progress`);
    }
    const { generationNumber } = args;
    const workflow = await getWorkflow(ctx, args.workflowId, generationNumber);
    const console = await getDefaultLogger(ctx);

    if (workflow.runResult !== undefined) {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const maxEntry = await ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflow._id))
      .order("desc")
      .first();
    const stepNumberBase = maxEntry ? maxEntry.stepNumber + 1 : 0;
    const workpool = await getWorkpool(ctx, args.workpoolOptions);
    const onComplete = internal.pool.onComplete;

    const entries = await Promise.all(
      args.steps.map(async (stepArgs, index) => {
        const { retry, schedulerOptions } = stepArgs;
        const stepNumber = stepNumberBase + index;
        const stepId = await ctx.db.insert("steps", {
          workflowId: workflow._id,
          stepNumber,
          step: stepArgs.step,
        });
        let entry = await ctx.db.get(stepId);
        assert(entry, "Step not found");
        const step = entry.step;
        const { name } = step;
        if (step.kind === "event") {
          // Note: This modifies entry in place as well.
          entry = await awaitEvent(ctx, entry, {
            name,
            eventId: step.args.eventId,
          });
          if (step.runResult) {
            console.event("eventConsumed", {
              workflowId: entry.workflowId,
              workflowName: workflow.name,
              status: step.runResult.kind,
              eventName: step.name,
              stepNumber: stepNumber,
              durationMs: step.completedAt! - step.startedAt,
            });
          }
        } else if (step.kind === "batchGroup") {
          throw new Error(
            `batchGroup steps should use startBatchGroupStep, not startSteps`,
          );
        } else if (step.kind === "workflow") {
          const workflowId = await createHandler(ctx, {
            workflowName: step.name,
            workflowHandle: step.handle,
            workflowArgs: step.args,
            maxParallelism: args.workpoolOptions?.maxParallelism,
            onComplete: {
              fnHandle: await createFunctionHandle(
                internal.pool.nestedWorkflowOnComplete,
              ),
              context: {
                stepId,
                generationNumber,
                workpoolOptions: args.workpoolOptions,
              } satisfies OnCompleteContext,
            },
            startAsync: true,
          });
          step.workflowId = workflowId;
        } else {
          const context: OnCompleteContext = {
            generationNumber,
            stepId,
            workpoolOptions: args.workpoolOptions,
          };
          let workId: WorkId;
          switch (step.functionType) {
            case "query": {
              workId = await workpool.enqueueQuery(
                ctx,
                step.handle as FunctionHandle<"query">,
                step.args,
                { context, onComplete, name, ...schedulerOptions },
              );
              break;
            }
            case "mutation": {
              workId = await workpool.enqueueMutation(
                ctx,
                step.handle as FunctionHandle<"mutation">,
                step.args,
                { context, onComplete, name, ...schedulerOptions },
              );
              break;
            }
            case "action": {
              workId = await workpool.enqueueAction(
                ctx,
                step.handle as FunctionHandle<"action">,
                step.args,
                { context, onComplete, name, retry, ...schedulerOptions },
              );
              break;
            }
          }
          step.workId = workId;
        }
        await ctx.db.replace(entry._id, entry);

        console.event("started", {
          workflowId: workflow._id,
          workflowName: workflow.name,
          stepName: name,
          stepNumber,
        });
        return entry;
      }),
    );
    return entries;
  },
});

/**
 * Like startSteps but does NOT enqueue to the workpool. Instead returns the
 * journal entries plus an onComplete function handle string. The client uses
 * this to enqueue batch tasks with the correct onComplete callback.
 */
export const startBatchSteps = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    steps: v.array(
      v.object({
        step,
        retry: v.optional(v.union(v.boolean(), vRetryBehavior)),
        schedulerOptions: v.optional(
          v.union(
            v.object({ runAt: v.optional(v.number()) }),
            v.object({ runAfter: v.optional(v.number()) }),
          ),
        ),
      }),
    ),
    workpoolOptions: v.optional(workpoolOptions),
  },
  returns: v.object({
    entries: v.array(journalDocument),
    onCompleteHandle: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    entries: JournalEntry[];
    onCompleteHandle: string;
  }> => {
    if (!args.steps.every((step) => step.step.inProgress)) {
      throw new Error(`Assertion failed: not in progress`);
    }
    const { generationNumber } = args;
    const workflow = await getWorkflow(ctx, args.workflowId, generationNumber);
    const console = await getDefaultLogger(ctx);

    if (workflow.runResult !== undefined) {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const maxEntry = await ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflow._id))
      .order("desc")
      .first();
    const stepNumberBase = maxEntry ? maxEntry.stepNumber + 1 : 0;
    const onCompleteHandle = await createFunctionHandle(
      internal.pool.onCompleteBatchStep,
    );

    // Schedule a polling completion checker that will re-enqueue the
    // workflow once all batch steps have finished. This avoids OCC
    // contention from per-item counter updates.
    await ctx.scheduler.runAfter(
      0,
      internal.pool._checkBatchCompletion,
      {
        workflowId: workflow._id,
        generationNumber,
        workpoolOptions: args.workpoolOptions,
      },
    );

    const t0 = Date.now();
    const entries = await Promise.all(
      args.steps.map(async (stepArgs, index) => {
        const stepNumber = stepNumberBase + index;
        const stepId = await ctx.db.insert("steps", {
          workflowId: workflow._id,
          stepNumber,
          step: stepArgs.step,
        });
        const entry = await ctx.db.get(stepId);
        assert(entry, "Step not found");

        console.event("started", {
          workflowId: workflow._id,
          workflowName: workflow.name,
          stepName: entry.step.name,
          stepNumber,
        });
        return entry;
      }),
    );
    const elapsed = Date.now() - t0;
    console.info(
      `[PERF] startBatchSteps created ${entries.length} step docs in ${elapsed}ms`,
    );
    return { entries, onCompleteHandle };
  },
});

/**
 * Creates a single "batchGroup" step doc for N batch items.
 * Returns the entry plus an onComplete handle for individual item completions.
 */
export const startBatchGroupStep = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    count: v.number(),
    workpoolOptions: v.optional(workpoolOptions),
  },
  returns: v.object({
    entry: journalDocument,
    onCompleteHandle: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    entry: JournalEntry;
    onCompleteHandle: string;
  }> => {
    const { generationNumber } = args;
    const workflow = await getWorkflow(ctx, args.workflowId, generationNumber);
    const console = await getDefaultLogger(ctx);

    if (workflow.runResult !== undefined) {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const maxEntry = await ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflow._id))
      .order("desc")
      .first();
    const stepNumberBase = maxEntry ? maxEntry.stepNumber + 1 : 0;

    const stepId = await ctx.db.insert("steps", {
      workflowId: workflow._id,
      stepNumber: stepNumberBase,
      step: {
        kind: "batchGroup" as const,
        count: args.count,
        name: "batchGroup",
        inProgress: true,
        argsSize: 0,
        args: {},
        runResult: undefined,
        startedAt: Date.now(),
        completedAt: undefined,
      },
    });
    const entry = await ctx.db.get(stepId);
    assert(entry, "Step not found");

    const onCompleteHandle = await createFunctionHandle(
      internal.pool.onCompleteBatchGroupItem,
    );

    // Schedule polling completion checker.
    await ctx.scheduler.runAfter(0, internal.pool._checkBatchCompletion, {
      workflowId: workflow._id,
      generationNumber,
      workpoolOptions: args.workpoolOptions,
    });

    console.event("started", {
      workflowId: workflow._id,
      workflowName: workflow.name,
      stepName: "batchGroup",
      stepNumber: stepNumberBase,
    });

    return { entry, onCompleteHandle };
  },
});

/**
 * Load all batch results for a batchGroup step, sorted by index.
 */
export const loadBatchResults = query({
  args: {
    batchStepId: v.id("steps"),
  },
  returns: v.array(
    v.object({
      index: v.number(),
      result: vResultValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("batchResults")
      .withIndex("batchStep", (q) => q.eq("batchStepId", args.batchStepId))
      .collect();
    return results.map((r) => ({ index: r.index, result: r.result }));
  },
});
