import { vResultValidator } from "@convex-dev/workpool";
import { assert } from "convex-helpers";
import {
  paginationOptsValidator,
  type FunctionHandle,
  type PaginationResult,
} from "convex/server";
import { type Infer, v } from "convex/values";
import { mutation, type MutationCtx, query } from "./_generated/server.js";
import { createLogger, DEFAULT_LOG_LEVEL, logLevel } from "./logging.js";
import { getWorkflow } from "./model.js";
import { getWorkpool } from "./pool.js";
import schema, {
  journalDocument,
  vOnComplete,
  workflowDocument,
  type JournalEntry,
} from "./schema.js";
import { getDefaultLogger } from "./utils.js";
import { ensureCoordinatorRunning } from "./coordinator.js";
import {
  type WorkflowId,
  type OnCompleteArgs,
  type WorkflowStep,
  type EventId,
  vPaginationResult,
  vWorkflowStep,
  type SchedulerOptions,
  type PublicWorkflow,
  vPublicWorkflow,
} from "../types.js";
import { api } from "./_generated/api.js";
import { formatErrorWithStack } from "../shared.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { paginator } from "convex-helpers/server/pagination";

const createArgs = v.object({
  workflowName: v.string(),
  workflowHandle: v.string(),
  workflowArgs: v.any(),
  maxParallelism: v.optional(v.number()),
  onComplete: v.optional(vOnComplete),
  startAsync: v.optional(v.boolean()),
  batchBridgeHandle: v.optional(v.string()),
  executorShards: v.optional(v.number()),
  // TODO: ttl
});
export const create = mutation({
  args: createArgs,
  returns: v.id("workflows"),
  handler: createHandler,
});

export async function createHandler(
  ctx: MutationCtx,
  args: Infer<typeof createArgs>,
  _schedulerOptions?: SchedulerOptions,
) {
  const console = createLogger(DEFAULT_LOG_LEVEL);
  const workflowId = await ctx.db.insert("workflows", {
    name: args.workflowName,
    workflowHandle: args.workflowHandle,
    args: args.workflowArgs,
    generationNumber: 0,
    onComplete: args.onComplete,
    readyToRun: args.startAsync ? true : undefined,
    batchBridgeHandle: args.batchBridgeHandle,
    executorShards: args.executorShards,
  });
  console.debug(
    `Created workflow ${workflowId}:`,
    args.workflowArgs,
    args.workflowHandle,
  );
  if (args.startAsync) {
    await ensureCoordinatorRunning(ctx);
  } else {
    // If we can't start it, may as well not create it, eh? Fail fast...
    await ctx.runMutation(args.workflowHandle as FunctionHandle<"mutation">, {
      workflowId,
      generationNumber: 0,
    });
  }
  return workflowId;
}

export const getStatus = query({
  args: {
    workflowId: v.id("workflows"),
  },
  returns: v.object({
    workflow: workflowDocument,
    inProgress: v.array(journalDocument),
    logLevel: logLevel,
  }),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get(args.workflowId);
    assert(workflow, `Workflow not found: ${args.workflowId}`);
    const console = await getDefaultLogger(ctx);

    const inProgress = await ctx.db
      .query("steps")
      .withIndex("inProgress", (q) =>
        q.eq("step.inProgress", true).eq("workflowId", args.workflowId),
      )
      .collect();
    console.debug(`${args.workflowId} blocked by`, inProgress);
    return { workflow, inProgress, logLevel: console.logLevel };
  },
});

function publicWorkflowId(workflowId: Id<"workflows">): WorkflowId {
  return workflowId as any;
}

function publicWorkflow(workflow: Doc<"workflows">): PublicWorkflow {
  return {
    workflowId: publicWorkflowId(workflow._id),
    name: workflow.name,
    args: workflow.args,
    context: workflow.onComplete?.context,
    runResult: workflow.runResult,
  } satisfies PublicWorkflow;
}

function publicStep(step: JournalEntry): WorkflowStep {
  return {
    workflowId: publicWorkflowId(step.workflowId),
    name: step.step.name,
    stepId: step._id,
    stepNumber: step.stepNumber,

    args: step.step.args,
    runResult: step.step.runResult,

    startedAt: step.step.startedAt,
    completedAt: step.step.completedAt,

    ...(step.step.kind === "event"
      ? {
          kind: "event",
          eventId: step.step.eventId as unknown as EventId,
        }
      : step.step.kind === "workflow"
        ? {
            kind: "workflow",
            nestedWorkflowId: publicWorkflowId(step.step.workflowId!),
          }
        : {
            kind: "function",
            workId: step.step.workId!,
          }),
  } satisfies WorkflowStep;
}

export const list = query({
  args: {
    order: v.union(v.literal("asc"), v.literal("desc")),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginationResult(vPublicWorkflow),
  handler: async (ctx, args) => {
    const result = await paginator(ctx.db, schema)
      .query("workflows")
      .order(args.order)
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map(publicWorkflow),
    } as PaginationResult<Infer<typeof vPublicWorkflow>>;
  },
});

export const listByName = query({
  args: {
    name: v.string(),
    order: v.union(v.literal("asc"), v.literal("desc")),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginationResult(vPublicWorkflow),
  handler: async (ctx, args) => {
    const result = await paginator(ctx.db, schema)
      .query("workflows")
      .withIndex("name", (q) => q.eq("name", args.name))
      .order(args.order)
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map(publicWorkflow),
    } as PaginationResult<Infer<typeof vPublicWorkflow>>;
  },
});

// Paginated count — each call reads one page within the 16MB read limit.
// Returns partial counts + a cursor. Call in a loop from an action to
// count across arbitrarily many workflows.
export const countByNamePage = query({
  args: {
    name: v.string(),
    createdAfter: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    completed: v.number(),
    failed: v.number(),
    running: v.number(),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { name, createdAfter, paginationOpts }) => {
    const result = await paginator(ctx.db, schema)
      .query("workflows")
      .withIndex("name", (q) => q.eq("name", name))
      .order("desc")
      .paginate(paginationOpts);

    let completed = 0;
    let failed = 0;
    let running = 0;
    const hitOld = createdAfter
      ? result.page.some((wf) => wf._creationTime < createdAfter)
      : false;
    for (const wf of result.page) {
      if (createdAfter && wf._creationTime < createdAfter) break;
      if (!wf.runResult) running++;
      else if (wf.runResult.kind === "success") completed++;
      else failed++;
    }
    return {
      completed,
      failed,
      running,
      continueCursor: result.continueCursor,
      isDone: result.isDone || hitOld,
    };
  },
});

// Legacy single-call count — works for small result sets (<~15k workflows).
export const countByName = query({
  args: {
    name: v.string(),
    createdAfter: v.optional(v.number()),
  },
  returns: v.object({
    total: v.number(),
    completed: v.number(),
    failed: v.number(),
    running: v.number(),
  }),
  handler: async (ctx, { name, createdAfter }) => {
    let completed = 0;
    let failed = 0;
    let running = 0;
    for await (const wf of ctx.db
      .query("workflows")
      .withIndex("name", (q) => q.eq("name", name))
      .order("desc")) {
      if (createdAfter && wf._creationTime < createdAfter) break;
      if (!wf.runResult) running++;
      else if (wf.runResult.kind === "success") completed++;
      else failed++;
    }
    return { total: completed + failed + running, completed, failed, running };
  },
});

export const creationTimeBuckets = query({
  args: {
    name: v.string(),
    createdAfter: v.number(),
    bucketMs: v.number(),
  },
  returns: v.array(v.object({ offsetSec: v.number(), count: v.number() })),
  handler: async (ctx, { name, createdAfter, bucketMs }) => {
    const buckets = new Map<number, number>();
    for await (const wf of ctx.db
      .query("workflows")
      .withIndex("name", (q) => q.eq("name", name))
      .order("desc")) {
      if (wf._creationTime < createdAfter) break;
      const bucket = Math.floor((wf._creationTime - createdAfter) / bucketMs) * (bucketMs / 1000);
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    }
    return [...buckets.entries()]
      .map(([offsetSec, count]) => ({ offsetSec, count }))
      .sort((a, b) => a.offsetSec - b.offsetSec);
  },
});

export const timelinePage = query({
  args: {
    name: v.string(),
    createdAfter: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginationResult(
    v.object({
      id: v.string(),
      createdAt: v.number(),
      runResult: v.optional(v.union(v.literal("success"), v.literal("failed"), v.literal("canceled"))),
      steps: v.array(
        v.object({
          stepNumber: v.number(),
          name: v.string(),
          startedAt: v.number(),
          completedAt: v.optional(v.number()),
          executionStartedAt: v.optional(v.number()),
        }),
      ),
    }),
  ),
  handler: async (ctx, { name, createdAfter, paginationOpts }) => {
    // Paginate desc (newest first) so we can stop early at createdAfter
    const result = await paginator(ctx.db, schema)
      .query("workflows")
      .withIndex("name", (q) => q.eq("name", name))
      .order("desc")
      .paginate(paginationOpts);

    const filtered = createdAfter
      ? result.page.filter((wf) => wf._creationTime >= createdAfter)
      : result.page;

    // If any workflow on this page is older than createdAfter, we're done
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
          runResult: wf.runResult?.kind as "success" | "failed" | "canceled" | undefined,
          steps: stepDocs.map((s) => {
            // Extract executionStartedAt from the action's return value if present.
            // Actions can include `executorStartedAt` in their result to distinguish
            // queue wait time from actual execution time.
            const rv = s.step.runResult?.kind === "success"
              ? (s.step.runResult.returnValue as Record<string, unknown>)
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

    return {
      ...result,
      isDone: result.isDone || hitOld,
      page,
    } as any;
  },
});

export const listSteps = query({
  args: {
    workflowId: v.id("workflows"),
    order: v.union(v.literal("asc"), v.literal("desc")),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginationResult(vWorkflowStep),
  handler: async (ctx, args) => {
    const result = await paginator(ctx.db, schema)
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", args.workflowId))
      .order(args.order)
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map(publicStep),
    } as PaginationResult<Infer<typeof vWorkflowStep>>;
  },
});

export const cancel = mutation({
  args: {
    workflowId: v.id("workflows"),
  },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    const workflow = await ctx.db.get(workflowId);
    assert(workflow, `Workflow not found: ${workflowId}`);
    await completeHandler(ctx, {
      workflowId,
      generationNumber: workflow.generationNumber,
      runResult: { kind: "canceled" },
    });
  },
});

const completeArgs = v.object({
  workflowId: v.id("workflows"),
  generationNumber: v.number(),
  runResult: vResultValidator,
});

export const complete = mutation({
  args: completeArgs,
  returns: v.null(),
  handler: completeHandler,
});

// When the overall workflow completes (successfully or not).
export async function completeHandler(
  ctx: MutationCtx,
  args: Infer<typeof completeArgs>,
) {
  const workflow = await getWorkflow(
    ctx,
    args.workflowId,
    args.generationNumber,
  );
  const console = createLogger(DEFAULT_LOG_LEVEL);
  if (workflow.runResult) {
    throw new Error(`Workflow not running: ${workflow}`);
  }
  workflow.runResult = args.runResult;
  console.event("completed", {
    workflowId: workflow._id,
    name: workflow.name,
    status: workflow.runResult.kind,
    overallDurationMs: Date.now() - workflow._creationTime,
  });
  if (workflow.runResult.kind === "canceled") {
    // We bump it so no in-flight steps succeed / we don't race to complete.
    workflow.generationNumber += 1;
    // TODO: can we cancel these asynchronously if there's more than one?
    const inProgress = await ctx.db
      .query("steps")
      .withIndex("inProgress", (q) =>
        q.eq("step.inProgress", true).eq("workflowId", args.workflowId),
      )
      .collect();
    if (inProgress.length > 0) {
      const workpool = await getWorkpool(ctx, {});
      for (const { step } of inProgress) {
        if (!step.kind || step.kind === "function") {
          if (step.workId) {
            // Executor-managed steps use "executor:" prefix — skip workpool cancel.
            if (typeof step.workId === "string" && (step.workId as string).startsWith("executor:")) {
              // Clean up the task queue entry if it exists.
              const stepId = (step.workId as string).slice("executor:".length);
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
              await workpool.cancel(ctx, step.workId);
            }
          }
        } else if (step.kind === "workflow") {
          if (step.workflowId) {
            await ctx.runMutation(api.workflow.cancel, {
              workflowId: step.workflowId,
            });
          }
        }
      }
    }
    console.debug(`Canceled workflow:`, workflow);
  }
  // Write the workflow so the onComplete can observe the updated status.
  await ctx.db.replace(workflow._id, workflow);
  if (workflow.onComplete) {
    try {
      await ctx.runMutation(
        workflow.onComplete.fnHandle as FunctionHandle<
          "mutation",
          OnCompleteArgs
        >,
        {
          workflowId: workflow._id as unknown as WorkflowId,
          result: workflow.runResult,
          context: workflow.onComplete.context,
        },
      );
    } catch (error) {
      const message = formatErrorWithStack(error);
      console.error("Error calling onComplete", message);
      await ctx.db.insert("onCompleteFailures", {
        ...args,
        error: message,
      });
    }
  }
  // TODO: delete everything unless ttl is set
  console.debug(`Completed workflow ${workflow._id}:`, workflow);
}

export const cleanup = mutation({
  args: {
    workflowId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const workflowId = ctx.db.normalizeId("workflows", args.workflowId);
    if (!workflowId) {
      throw new Error(`Invalid workflow ID: ${args.workflowId}`);
    }
    const workflow = await ctx.db.get(workflowId);
    if (!workflow) {
      return false;
    }
    const logger = await getDefaultLogger(ctx);
    // TODO: allow cleaning up a workflow from inside it / in the onComplete hook
    if (!workflow.runResult) {
      logger.debug(
        `Can't clean up workflow ${workflowId} since it hasn't completed.`,
      );
      return false;
    }
    logger.debug(`Cleaning up workflow ${workflowId}`, workflow);
    await ctx.db.delete(workflowId);
    const journalEntries = await ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflowId))
      .collect();
    for (const journalEntry of journalEntries) {
      logger.debug("Deleting journal entry", journalEntry);
      await ctx.db.delete(journalEntry._id);
    }
    return true;
  },
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
