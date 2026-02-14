import {
  vResultValidator,
  vRetryBehavior,
  vWorkIdValidator,
  Workpool,
  type RunResult,
  type WorkId,
  type WorkpoolOptions,
} from "@convex-dev/workpool";
import { assert } from "convex-helpers";
import { validate } from "convex-helpers/validators";
import {
  type FunctionHandle,
  type FunctionReference,
  type RegisteredAction,
} from "convex/server";
import { type Infer, v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { logLevel } from "./logging.js";
import { getWorkflow } from "./model.js";
import { getDefaultLogger } from "./utils.js";
import { completeHandler } from "./workflow.js";
import type { Doc } from "./_generated/dataModel.js";
import { vWorkflowId, type WorkflowId } from "../types.js";

export const workpoolOptions = v.object({
  logLevel: v.optional(logLevel),
  maxParallelism: v.optional(v.number()),
  defaultRetryBehavior: v.optional(vRetryBehavior),
  retryActionsByDefault: v.optional(v.boolean()),
});
// type check
const _: WorkpoolOptions = {} as Infer<typeof workpoolOptions>;

export const DEFAULT_MAX_PARALLELISM = 25;
export const DEFAULT_RETRY_BEHAVIOR = {
  maxAttempts: 5,
  initialBackoffMs: 500,
  base: 2,
};

export async function getWorkpool(
  ctx: MutationCtx,
  opts: WorkpoolOptions | undefined,
) {
  // nit: can fetch config only if necessary
  const config = await ctx.db.query("config").first();
  const logLevel = opts?.logLevel ?? config?.logLevel;
  const maxParallelism =
    opts?.maxParallelism ?? config?.maxParallelism ?? DEFAULT_MAX_PARALLELISM;
  return new Workpool(components.workpool, {
    logLevel,
    maxParallelism,
    defaultRetryBehavior: opts?.defaultRetryBehavior ?? DEFAULT_RETRY_BEHAVIOR,
    retryActionsByDefault: opts?.retryActionsByDefault ?? false,
  });
}

const onCompleteContext = v.object({
  generationNumber: v.number(),
  stepId: v.id("steps"),
  workpoolOptions: v.optional(workpoolOptions),
});

export type OnCompleteContext = Infer<typeof onCompleteContext>;

// For a single step
export const onComplete = internalMutation({
  args: {
    workId: vWorkIdValidator,
    result: vResultValidator,
    context: v.any(), // Ensure we can catch invalid context to fail workflow.
  },
  returns: v.null(),
  handler: onCompleteHandler,
});

// For a nested workflow
export const nestedWorkflowOnComplete = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.any(),
  },
  returns: v.null(),
  handler: onCompleteHandler,
});

async function onCompleteHandler(
  ctx: MutationCtx,
  args: {
    workId?: WorkId;
    workflowId?: WorkflowId;
    result: RunResult;
    context: object;
  },
) {
  const console = await getDefaultLogger(ctx);
  const stepId =
    "stepId" in args.context && typeof args.context.stepId === "string"
      ? ctx.db.normalizeId("steps", args.context.stepId)
      : null;
  if (!stepId) {
    // Write to failures table and return
    // So someone can investigate if this ever happens
    console.error("Invalid onComplete context", args.context);
    await ctx.db.insert("onCompleteFailures", args);
    return;
  }
  const journalEntry = await ctx.db.get(stepId);
  assert(journalEntry, `Journal entry not found: ${stepId}`);
  const workflowId = journalEntry.workflowId;

  if (
    !validate(onCompleteContext, args.context, { allowUnknownFields: true })
  ) {
    const error =
      `Invalid onComplete context for ${args.workId ? `workId ${args.workId}` : `nested workflowId ${args.workflowId}`}` +
      JSON.stringify(args.context);
    await ctx.db.patch(workflowId, {
      runResult: {
        kind: "failed",
        error,
      },
    });
    return;
  }
  const { generationNumber } = args.context;
  const workflow = await getWorkflow(ctx, workflowId, null);
  if (workflow.generationNumber !== generationNumber) {
    console.error(
      `Workflow: ${workflowId} already has generation number ${workflow.generationNumber} when completing ${stepId}`,
    );
    return;
  }
  if (!journalEntry.step.inProgress) {
    console.error(
      `Step finished but journal entry not in progress: ${stepId} status: ${journalEntry.step.runResult?.kind ?? "pending"}`,
    );
    return;
  }
  journalEntry.step.inProgress = false;
  journalEntry.step.completedAt = Date.now();
  switch (args.result.kind) {
    case "success":
      journalEntry.step.runResult = {
        kind: "success",
        returnValue: args.result.returnValue,
      };
      break;
    case "failed":
      journalEntry.step.runResult = {
        kind: "failed",
        error: args.result.error,
      };
      break;
    case "canceled":
      journalEntry.step.runResult = {
        kind: "canceled",
      };
      break;
  }
  await ctx.db.replace(journalEntry._id, journalEntry);
  console.debug(`Completed execution of ${stepId}`, journalEntry);

  console.event("stepCompleted", {
    workflowId,
    workflowName: workflow.name,
    status: args.result.kind,
    stepName: journalEntry.step.name,
    stepNumber: journalEntry.stepNumber,
    durationMs: journalEntry.step.completedAt - journalEntry.step.startedAt,
  });
  if (workflow.runResult !== undefined) {
    if (workflow.runResult.kind !== "canceled") {
      console.error(
        `Workflow: ${workflowId} already ${workflow.runResult.kind} when completing ${stepId} with status ${args.result.kind}`,
      );
    }
    return;
  }
  // Only re-enqueue the workflow when no in-progress steps remain.
  // This avoids flooding the standard workpool with redundant re-runs
  // (e.g. 1000 batch completions each triggering a workflow re-enqueue).
  const remainingInProgress = await ctx.db
    .query("steps")
    .withIndex("inProgress", (q) =>
      q.eq("step.inProgress", true).eq("workflowId", workflowId),
    )
    .first();
  if (remainingInProgress) {
    console.debug(
      `Skipping workflow re-enqueue: ${workflowId} still has in-progress steps`,
    );
    return;
  }
  const workpool = await getWorkpool(ctx, args.context.workpoolOptions);
  await enqueueWorkflow(ctx, workflow, workpool);
}

export async function enqueueWorkflow(
  ctx: MutationCtx,
  workflow: Doc<"workflows">,
  workpool: Workpool,
) {
  const { _id: workflowId, generationNumber, name, workflowHandle } = workflow;
  await workpool.enqueueMutation(
    ctx,
    workflowHandle as FunctionHandle<"mutation">,
    { workflowId, generationNumber },
    {
      name,
      onComplete: internal.pool.handlerOnComplete,
      context: { workflowId, generationNumber },
    },
  );
}

// Lightweight onComplete for batch steps. Only patches the step doc with the
// result — no shared counter, no index check, no workflow re-enqueue.
// Re-enqueue is handled by _checkBatchCompletion (polling).
export const onCompleteBatchStep = internalMutation({
  args: {
    workId: vWorkIdValidator,
    result: vResultValidator,
    context: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { stepId } = args.context;
    const normalizedStepId = ctx.db.normalizeId("steps", stepId);
    if (!normalizedStepId) return;

    // Patch step result directly — read step to spread, then patch.
    const entry = await ctx.db.get(normalizedStepId);
    if (!entry) return;
    await ctx.db.patch(normalizedStepId, {
      step: {
        ...entry.step,
        inProgress: false,
        completedAt: Date.now(),
        runResult: args.result,
      },
    });
  },
});

// Lightweight onComplete for batchGroup items. Write-only: inserts a result doc
// into batchResults — no read-modify-write, no OCC contention.
export const onCompleteBatchGroupItem = internalMutation({
  args: {
    workId: vWorkIdValidator,
    result: vResultValidator,
    context: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { batchStepId, index } = args.context;
    const normalizedId = ctx.db.normalizeId("steps", batchStepId);
    if (!normalizedId) return;
    await ctx.db.insert("batchResults", {
      batchStepId: normalizedId,
      index,
      result: args.result,
    });
  },
});

// Polling completion checker for batch steps. Scheduled from startBatchSteps
// and startBatchGroupStep. For batchGroup steps, counts batchResults docs.
// For legacy batch steps, checks the inProgress index.
export const _checkBatchCompletion = internalMutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    workpoolOptions: v.optional(workpoolOptions),
    _pollCount: v.optional(v.number()),
    _firstPollAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pollCount = (args._pollCount ?? 0) + 1;
    const firstPollAt = args._firstPollAt ?? Date.now();

    // Find all in-progress steps for this workflow.
    const inProgressSteps = await ctx.db
      .query("steps")
      .withIndex("inProgress", (q) =>
        q.eq("step.inProgress", true).eq("workflowId", args.workflowId),
      )
      .collect();

    let anyRemaining = false;
    for (const step of inProgressSteps) {
      if (step.step.kind === "batchGroup") {
        // Count batchResults for this batchGroup step.
        // Use take(count) to stop reading early when not all results are in.
        const results = await ctx.db
          .query("batchResults")
          .withIndex("batchStep", (q) => q.eq("batchStepId", step._id))
          .take(step.step.count);
        if (results.length >= step.step.count) {
          // All items complete — mark the batchGroup step as done.
          await ctx.db.patch(step._id, {
            step: {
              ...step.step,
              inProgress: false,
              completedAt: Date.now(),
              runResult: { kind: "success", returnValue: null },
            },
          });
          // There may be other in-progress steps; continue checking.
        } else {
          anyRemaining = true;
        }
      } else {
        // Legacy batch step or other in-progress step — still waiting.
        anyRemaining = true;
      }
    }

    if (anyRemaining) {
      // Not done yet — poll again in 200ms.
      await ctx.scheduler.runAfter(
        200,
        internal.pool._checkBatchCompletion,
        {
          ...args,
          _pollCount: pollCount,
          _firstPollAt: firstPollAt,
        },
      );
      return;
    }
    // All batch steps done — re-enqueue the workflow.
    const elapsed = ((Date.now() - firstPollAt) / 1000).toFixed(1);
    const console = await getDefaultLogger(ctx);
    console.info(
      `[PERF] Batch completion detected after ${pollCount} polls (${elapsed}s)`,
    );
    const workflow = await getWorkflow(ctx, args.workflowId, null);
    if (workflow.runResult !== undefined) return;
    if (workflow.generationNumber !== args.generationNumber) return;
    const workpool = await getWorkpool(ctx, args.workpoolOptions);
    await enqueueWorkflow(ctx, workflow, workpool);
  },
});

export type OnComplete =
  typeof onComplete extends RegisteredAction<
    "public",
    infer Args,
    infer ReturnValue
  >
    ? FunctionReference<"action", "internal", Args, ReturnValue>
    : never;

const handlerOnCompleteContext = v.object({
  workflowId: v.id("workflows"),
  generationNumber: v.number(),
});

// For the workflow handler
export const handlerOnComplete = internalMutation({
  args: {
    workId: vWorkIdValidator,
    result: vResultValidator,
    context: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.result.kind === "success") {
      return;
    }
    const console = await getDefaultLogger(ctx);
    if (!validate(handlerOnCompleteContext, args.context)) {
      console.error("Invalid handlerOnComplete context", args.context);
      const workflowId = ctx.db.normalizeId(
        "workflows",
        args.context.workflowId,
      );
      await ctx.db.insert("onCompleteFailures", args);
      if (!workflowId) {
        console.error("Invalid workflow ID", args.context.workflowId);
        return;
      }
      await completeHandler(ctx, {
        workflowId: args.context.workflowId,
        generationNumber: args.context.generationNumber,
        runResult: {
          kind: "failed",
          error:
            "Invalid handlerOnComplete context: " +
            JSON.stringify(args.context),
        },
      }).catch((error) => {
        console.error("Error calling completeHandler", error);
      });
      return;
    }
    const { workflowId, generationNumber } = args.context;
    await completeHandler(ctx, {
      workflowId,
      generationNumber,
      runResult: args.result,
    });
  },
});
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
