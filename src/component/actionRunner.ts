import {
  type RetryBehavior,
  type RunResult,
  type WorkpoolOptions,
  vResultValidator,
} from "@convex-dev/workpool";
import { assert } from "convex-helpers";
import { type FunctionHandle } from "convex/server";
import { v, type Value } from "convex/values";
import { formatErrorWithStack } from "../shared.js";
import { checkForOversizedResult } from "./oversizedValues.js";
import { DEFAULT_RETRY_BEHAVIOR, workpoolOptions } from "./pool.js";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server.js";
import { journalDocument, type JournalEntry } from "../validators.js";
import { getWorkflow } from "./model.js";
import { getDefaultLogger } from "./utils.js";
import type {
  WorkflowMutationArgs,
  WorkflowMutationResult,
} from "../client/workflowMutation.js";
import type { WorkflowId } from "../types.js";

const ACTION_RUNNER_MAX_RESERVE_MS = 5_000;

export const run = internalAction({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    maxDurationMs: v.number(),
    workpoolOptions: v.optional(workpoolOptions),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const deadline = startedAt + args.maxDurationMs;
    const reserveMs = Math.min(
      ACTION_RUNNER_MAX_RESERVE_MS,
      Math.max(1, args.maxDurationMs * 0.1),
    );
    const loaded = await ctx.runQuery(api.journal.load, {
      workflowId: args.workflowId,
    });
    if (
      !loaded.ok ||
      loaded.workflow.generationNumber !== args.generationNumber ||
      loaded.workflow.runResult ||
      loaded.journalEntries.some((entry) => entry.step.inProgress)
    ) {
      return null;
    }

    const actionState = {
      workflow: loaded.workflow,
      journalEntries: loaded.journalEntries,
      logLevel: loaded.logLevel,
    };
    const workflowHandle = loaded.workflow.workflowHandle as FunctionHandle<
      "mutation",
      WorkflowMutationArgs,
      WorkflowMutationResult
    >;
    const effectiveWorkpoolOptions =
      args.workpoolOptions ?? loaded.workflow.workpoolOptions;

    while (true) {
      if (Date.now() + reserveMs >= deadline) {
        await ctx.runMutation(internal.pool.enqueue, {
          workflowId: args.workflowId,
          generationNumber: args.generationNumber,
          workpoolOptions: effectiveWorkpoolOptions,
        });
        return null;
      }

      const result = await ctx.runMutation(workflowHandle, {
        workflowId: args.workflowId as unknown as WorkflowId,
        generationNumber: args.generationNumber,
        actionState,
      });
      assert(typeof result !== "string" && "kind" in result);
      if (result.kind !== "steps") {
        return null;
      }

      const direct: JournalEntry[] = [];
      const dispatch: JournalEntry[] = [];
      for (const entry of result.entries) {
        const scheduled = entry.schedulerOptions
          ? ("runAt" in entry.schedulerOptions &&
              entry.schedulerOptions.runAt !== undefined) ||
            ("runAfter" in entry.schedulerOptions &&
              entry.schedulerOptions.runAfter !== undefined)
          : false;
        const simpleFunction = entry.step.kind === "function";
        const hasTime = Date.now() + reserveMs < deadline;
        const actionFits =
          entry.step.kind !== "function" ||
          entry.step.functionType !== "action" ||
          Date.now() + (entry.timeRequired ?? 0) + reserveMs < deadline;
        if (simpleFunction && !scheduled && hasTime && actionFits) {
          direct.push(entry);
        } else {
          dispatch.push(entry);
        }
      }

      const [directResults, dispatchedResults] = await Promise.all([
        Promise.all(
          direct.map((entry) =>
            executeDirectStep(
              ctx,
              entry as Doc<"steps">,
              args.generationNumber,
              effectiveWorkpoolOptions,
            ),
          ),
        ),
        dispatch.length === 0
          ? Promise.resolve([])
          : ctx.runMutation(internal.journal.dispatchSteps, {
              workflowId: args.workflowId,
              generationNumber: args.generationNumber,
              steps: dispatch.map((entry) => ({
                stepId: entry._id as Id<"steps">,
              })),
              workpoolOptions: effectiveWorkpoolOptions,
            }),
      ]);
      const byId = new Map(
        [...directResults, ...dispatchedResults].map((entry) => [
          entry._id,
          entry,
        ]),
      );
      const completedBatch = result.entries.map((entry) => {
        const updated = byId.get(entry._id as Id<"steps">);
        assert(updated, `Missing action result for step ${entry._id}`);
        return updated;
      });
      actionState.journalEntries.push(...completedBatch);
      if (completedBatch.some((entry) => entry.step.inProgress)) {
        return null;
      }
    }
  },
});

async function executeDirectStep(
  ctx: ActionCtx,
  entry: Doc<"steps">,
  generationNumber: number,
  options: WorkpoolOptions | undefined,
): Promise<Doc<"steps">> {
  assert(entry.step.kind === "function", "Expected a function step");
  const { functionType, handle, args } = entry.step;
  if (functionType === "mutation") {
    return await ctx.runMutation(internal.actionRunner.runMutationStep, {
      stepId: entry._id,
      generationNumber,
    });
  }

  let runResult: RunResult;
  try {
    const returnValue =
      functionType === "query"
        ? await ctx.runQuery(
            handle as FunctionHandle<"query">,
            args as Record<string, Value>,
          )
        : await ctx.runAction(
            handle as FunctionHandle<"action">,
            args as Record<string, Value>,
          );
    runResult = { kind: "success", returnValue: returnValue ?? null };
  } catch (error) {
    runResult = { kind: "failed", error: formatErrorWithStack(error) };
  }

  if (functionType === "action" && runResult.kind === "failed") {
    const retry = retryBehavior(entry.retry, options);
    if (retry && retry.maxAttempts > 1) {
      const nextBackoffMs = retry.initialBackoffMs * retry.base;
      const [scheduled] = await ctx.runMutation(
        internal.journal.dispatchSteps,
        {
          workflowId: entry.workflowId,
          generationNumber,
          steps: [
            {
              stepId: entry._id,
              retry: {
                ...retry,
                maxAttempts: retry.maxAttempts - 1,
                initialBackoffMs: nextBackoffMs,
              },
              schedulerOptions: { runAfter: nextBackoffMs },
            },
          ],
          workpoolOptions: options,
        },
      );
      return scheduled;
    }
  }

  return await ctx.runMutation(internal.actionRunner.completeStep, {
    stepId: entry._id,
    generationNumber,
    runResult,
  });
}

function retryBehavior(
  retry: Doc<"steps">["retry"],
  options: WorkpoolOptions | undefined,
): RetryBehavior | undefined {
  if (typeof retry === "object") {
    return retry;
  }
  if (
    retry === true ||
    (retry === undefined && options?.retryActionsByDefault)
  ) {
    return options?.defaultRetryBehavior ?? DEFAULT_RETRY_BEHAVIOR;
  }
  return undefined;
}

export const completeStep = internalMutation({
  args: {
    stepId: v.id("steps"),
    generationNumber: v.number(),
    runResult: vResultValidator,
  },
  returns: journalDocument,
  handler: async (ctx, args) => {
    return await completeStepHandler(
      ctx,
      args.stepId,
      args.generationNumber,
      args.runResult,
    );
  },
});

export const runMutationStep = internalMutation({
  args: {
    stepId: v.id("steps"),
    generationNumber: v.number(),
  },
  returns: journalDocument,
  handler: async (ctx, args) => {
    const entry = await ctx.db.get("steps", args.stepId);
    assert(entry, `Step not found: ${args.stepId}`);
    await getWorkflow(ctx, entry.workflowId, args.generationNumber);
    assert(entry.step.inProgress, `Step already completed: ${args.stepId}`);
    assert(entry.step.kind === "function", "Expected a function step");
    assert(entry.step.functionType === "mutation", "Expected a mutation step");
    let runResult: RunResult;
    try {
      const returnValue = await ctx.runMutation(
        entry.step.handle as FunctionHandle<"mutation">,
        entry.step.args,
      );
      runResult = { kind: "success", returnValue: returnValue ?? null };
    } catch (error) {
      runResult = { kind: "failed", error: formatErrorWithStack(error) };
    }
    return await completeStepHandler(
      ctx,
      entry._id,
      args.generationNumber,
      runResult,
    );
  },
});

async function completeStepHandler(
  ctx: MutationCtx,
  stepId: Doc<"steps">["_id"],
  generationNumber: number,
  result: RunResult,
): Promise<Doc<"steps">> {
  const entry = await ctx.db.get("steps", stepId);
  assert(entry, `Step not found: ${stepId}`);
  const workflow = await getWorkflow(ctx, entry.workflowId, generationNumber);
  assert(entry.step.inProgress, `Step already completed: ${stepId}`);
  entry.step.inProgress = false;
  entry.step.completedAt = Date.now();
  entry.step.runResult = checkForOversizedResult(result);
  await ctx.db.replace("steps", entry._id, entry);
  const console = await getDefaultLogger(ctx);
  console.event("stepCompleted", {
    workflowId: workflow._id,
    workflowName: workflow.name,
    status: entry.step.runResult.kind,
    stepName: entry.step.name,
    stepNumber: entry.stepNumber,
    durationMs: entry.step.completedAt - entry.step.startedAt,
  });
  return entry;
}
