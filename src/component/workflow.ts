import { vResultValidator } from "@convex-dev/workpool";
import { assert } from "convex-helpers";
import {
  paginationOptsValidator,
  type FunctionHandle,
  type PaginationResult,
} from "convex/server";
import { type Infer, v } from "convex/values";
import { mutation, type MutationCtx, query } from "./_generated/server.js";
import { type Logger, logLevel } from "./logging.js";
import { getWorkflow } from "./model.js";
import { getWorkpool } from "./pool.js";
import schema, {
  journalDocument,
  vOnComplete,
  workflowDocument,
  type JournalEntry,
} from "./schema.js";
import { getDefaultLogger } from "./utils.js";
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
import { api, internal } from "./_generated/api.js";
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
  schedulerOptions?: SchedulerOptions,
) {
  const console = await getDefaultLogger(ctx);
  await updateMaxParallelism(ctx, console, args.maxParallelism);
  const workflowId = await ctx.db.insert("workflows", {
    name: args.workflowName,
    workflowHandle: args.workflowHandle,
    args: args.workflowArgs,
    generationNumber: 0,
    onComplete: args.onComplete,
  });
  console.debug(
    `Created workflow ${workflowId}:`,
    args.workflowArgs,
    args.workflowHandle,
  );
  if (args.startAsync) {
    const workpool = await getWorkpool(ctx, args);
    await workpool.enqueueMutation(
      ctx,
      args.workflowHandle as FunctionHandle<"mutation">,
      { workflowId, generationNumber: 0 },
      {
        name: args.workflowName,
        onComplete: internal.pool.handlerOnComplete,
        context: { workflowId, generationNumber: 0 },
        ...schedulerOptions,
      },
    );
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
  const console = await getDefaultLogger(ctx);
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
            await workpool.cancel(ctx, step.workId);
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

async function updateMaxParallelism(
  ctx: MutationCtx,
  console: Logger,
  maxParallelism: number | undefined,
) {
  const config = await ctx.db.query("config").first();
  if (config) {
    if (maxParallelism && maxParallelism !== config.maxParallelism) {
      console.warn("Updating max parallelism to", maxParallelism);
      await ctx.db.patch(config._id, { maxParallelism });
    }
  } else {
    await ctx.db.insert("config", { maxParallelism });
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
