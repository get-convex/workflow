import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import {
  journalDocument,
  type JournalEntry,
  journalEntrySize,
  step,
  workflowDocument,
} from "./schema.js";
import { getWorkflow } from "./model.js";
import { createLogger, DEFAULT_LOG_LEVEL, logLevel } from "./logging.js";
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
    for await (const entry of ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflowId))) {
      journalEntries.push(entry);
      journalSize += journalEntrySize(entry);
      if (journalSize > MAX_JOURNAL_SIZE) {
        return { journalEntries, workflow, logLevel, ok: false };
      }
    }
    return { journalEntries, workflow, logLevel, ok: true };
  },
});

function shardForWorkflow(workflowId: string, numShards: number): number {
  let hash = 0;
  for (let i = 0; i < workflowId.length; i++) {
    hash = (hash * 31 + workflowId.charCodeAt(i)) | 0;
  }
  return ((hash % numShards) + numShards) % numShards;
}

const DEFAULT_QM_RETRY = {
  maxAttempts: 4,
  initialBackoffMs: 125,
  base: 2,
};

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
        batchActionName: v.optional(v.string()),
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
    const console = createLogger(DEFAULT_LOG_LEVEL);

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
        const { schedulerOptions } = stepArgs;
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
          let workId: string;
          // Retry config only applies to actions — queries and mutations
          // are deterministic and retried automatically by Convex on OCC.
          const actionRetryConfig =
            step.functionType === "action"
              ? (stepArgs.retry === false
                  ? undefined
                  : typeof stepArgs.retry === "object"
                    ? stepArgs.retry
                    : DEFAULT_QM_RETRY)
              : undefined;
          switch (step.functionType) {
            case "query": {
              if (workflow.executorShards) {
                const shard = shardForWorkflow(workflow._id as string, workflow.executorShards);
                await ctx.db.insert("taskQueue", {
                  shard,
                  workflowCreatedAt: workflow._creationTime,
                  functionType: "query",
                  handle: step.handle,
                  args: step.args,
                  stepId,
                  workflowId: workflow._id,
                  generationNumber,
                });
                workId = `executor:${stepId}`;
              } else {
                workId = (await workpool.enqueueQuery(
                  ctx,
                  step.handle as FunctionHandle<"query">,
                  step.args,
                  { context, onComplete, name, ...schedulerOptions },
                )) as unknown as string;
              }
              break;
            }
            case "mutation": {
              if (workflow.executorShards) {
                const shard = shardForWorkflow(workflow._id as string, workflow.executorShards);
                await ctx.db.insert("taskQueue", {
                  shard,
                  workflowCreatedAt: workflow._creationTime,
                  functionType: "mutation",
                  handle: step.handle,
                  args: step.args,
                  stepId,
                  workflowId: workflow._id,
                  generationNumber,
                });
                workId = `executor:${stepId}`;
              } else {
                workId = (await workpool.enqueueMutation(
                  ctx,
                  step.handle as FunctionHandle<"mutation">,
                  step.args,
                  { context, onComplete, name, ...schedulerOptions },
                )) as unknown as string;
              }
              break;
            }
            case "action": {
              if (stepArgs.batchActionName && workflow.executorShards) {
                // Route through sharded task queue for executor-driven execution.
                const shard = shardForWorkflow(workflow._id as string, workflow.executorShards);
                await ctx.db.insert("taskQueue", {
                  shard,
                  workflowCreatedAt: workflow._creationTime,
                  functionType: "action",
                  handle: stepArgs.batchActionName,
                  args: step.args,
                  stepId,
                  workflowId: workflow._id,
                  generationNumber,
                  retry: actionRetryConfig,
                });
                workId = `executor:${stepId}`;
              } else {
                workId = (await workpool.enqueueAction(
                  ctx,
                  step.handle as FunctionHandle<"action">,
                  step.args,
                  { context, onComplete, name, ...schedulerOptions },
                )) as unknown as string;
              }
              break;
            }
          }
          step.workId = workId as unknown as WorkId;
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
