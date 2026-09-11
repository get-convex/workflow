import {
  type RunResult,
  type WorkpoolOptions,
  vResultValidator,
} from "@convex-dev/workpool";
import { assert } from "convex-helpers";
import { type FunctionHandle } from "convex/server";
import { v, type Value } from "convex/values";
import { formatErrorWithStack } from "../shared.js";
import { checkForOversizedResult } from "./oversizedValues.js";
import { retryBehavior, workpoolOptions } from "./pool.js";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server.js";
import { journalDocument, type JournalEntry } from "../validators.js";
import { getDefaultLogger } from "./utils.js";
import type {
  WorkflowMutationArgs,
  WorkflowMutationResult,
} from "../client/workflowMutation.js";
import type { WorkflowId } from "../types.js";

const ACTION_RUNNER_MAX_RESERVE_MS = 5_000;

/**
 * The long-lived driver for `executionMode: "action"` workflows.
 *
 * Every mutation this action calls treats staleness (canceled/completed
 * workflow, superseded generation, restarted workflow) as a return value,
 * never an error: the runner exits cleanly and the current driver — whichever
 * one the workflow document points at — carries on. An unexpected throw here
 * is an infrastructure failure and lands in `pool.handlerOnComplete`, which
 * owns recovery and tail-enqueues a replacement driver.
 */
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
    if (!loaded.ok) {
      // An oversized journal is a deterministic workflow failure, not a
      // reason for this driver to silently exit and strand the workflow.
      await ctx.runMutation(api.workflow.complete, {
        workflowId: args.workflowId,
        generationNumber: args.generationNumber,
        runResult: {
          kind: "failed",
          error: `Failed to load journal for ${args.workflowId}: it exceeds the maximum journal size`,
        },
      });
      return null;
    }
    if (
      loaded.workflow.generationNumber !== args.generationNumber ||
      loaded.workflow.runResult ||
      loaded.journalEntries.some((entry) => entry.step.inProgress)
    ) {
      return null;
    }

    // The generation this runner is currently driving. Starts at the
    // generation we were enqueued for and advances (via a compare-and-swap
    // on the workflow document) after each settled batch, so every mutation
    // below carries the generation it acts on behalf of.
    let generationNumber = args.generationNumber;
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
        // Budget exhausted: hand off to a fresh driver. `pool.enqueue`
        // replaces `driverWorkId`, so from that commit on this action is a
        // bystander whose completion is ignored.
        await ctx.runMutation(internal.pool.enqueue, {
          workflowId: args.workflowId,
          generationNumber,
          workpoolOptions: effectiveWorkpoolOptions,
        });
        return null;
      }

      const result = await ctx.runMutation(workflowHandle, {
        workflowId: args.workflowId as unknown as WorkflowId,
        generationNumber,
        actionState,
      });
      assert(typeof result !== "string" && "kind" in result);
      if (result.kind !== "steps") {
        return null;
      }

      const direct: JournalEntry[] = [];
      const dispatch: JournalEntry[] = [];
      // Entries the handler already resolved in its own transaction (inline
      // queries/mutations, events consumed on arrival). They are only here so
      // we can append them to the cached journal — starting them again would
      // re-run the function and then fail on the completion fence.
      const settled: JournalEntry[] = [];
      for (const entry of result.entries) {
        if (!entry.step.inProgress) {
          settled.push(entry);
          continue;
        }
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
              generationNumber,
              effectiveWorkpoolOptions,
            ),
          ),
        ),
        dispatch.length === 0
          ? Promise.resolve([] as JournalEntry[] | "stale")
          : ctx
              .runMutation(internal.journal.dispatchSteps, {
                workflowId: args.workflowId,
                generationNumber,
                steps: dispatch.map((entry) => ({
                  stepId: entry._id as Id<"steps">,
                })),
                workpoolOptions: effectiveWorkpoolOptions,
              })
              .then((dispatched) =>
                dispatched.kind === "ok" ? dispatched.entries : "stale",
              ),
      ]);
      if (
        dispatchedResults === "stale" ||
        directResults.some((entry) => entry === "stale")
      ) {
        // The workflow was canceled or restarted out from under us; the
        // fences already rejected our writes, so just stop driving.
        return null;
      }
      const byId = new Map(
        [
          ...settled,
          ...(directResults as Doc<"steps">[]),
          ...dispatchedResults,
        ].map((entry) => [entry._id as Id<"steps">, entry as Doc<"steps">]),
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
      // The whole batch settled without leaving this action: one continuation
      // wave is done. Advance the generation before evaluating the handler
      // again; losing this compare-and-swap means another driver owns the
      // workflow now (cancel, restart), so exit.
      const advanced = await ctx.runMutation(
        internal.journal.advanceGeneration,
        { workflowId: args.workflowId, generationNumber },
      );
      if (advanced.kind === "stale") {
        return null;
      }
      generationNumber = advanced.generationNumber;
      // Keep the cached snapshot consistent: the next poll validates the
      // cached workflow's generation against the one we pass.
      actionState.workflow.generationNumber = generationNumber;
    }
  },
});

export async function executeDirectStep(
  ctx: ActionCtx,
  entry: Doc<"steps">,
  generationNumber: number,
  options: WorkpoolOptions | undefined,
): Promise<Doc<"steps"> | "stale"> {
  assert(entry.step.kind === "function", "Expected a function step");
  const { functionType, handle, args } = entry.step;
  if (functionType === "mutation") {
    try {
      const result = await ctx.runMutation(
        internal.actionRunner.runMutationStep,
        {
          stepId: entry._id,
          generationNumber,
        },
      );
      return result.kind === "ok" ? (result.entry as Doc<"steps">) : "stale";
    } catch {
      // User-code errors are caught inside runMutationStep and committed as a
      // failed step. Reaching this catch means the wrapper transaction itself
      // never returned a committed result (for example, OCC retries were
      // exhausted). Hand ownership to Workpool instead of failing the whole
      // action driver. dispatchSteps re-checks the completion fence, so if the
      // mutation did commit but its response was lost, it returns the settled
      // entry without executing the mutation again.
      const dispatched = await ctx.runMutation(
        internal.journal.dispatchSteps,
        {
          workflowId: entry.workflowId,
          generationNumber,
          steps: [{ stepId: entry._id }],
          workpoolOptions: options,
        },
      );
      return dispatched.kind === "ok"
        ? (dispatched.entries[0] as Doc<"steps">)
        : "stale";
    }
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
      const dispatched = await ctx.runMutation(internal.journal.dispatchSteps, {
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
      });
      return dispatched.kind === "ok"
        ? (dispatched.entries[0] as Doc<"steps">)
        : "stale";
    }
  }

  const completed = await ctx.runMutation(internal.actionRunner.completeStep, {
    stepId: entry._id,
    generationNumber,
    runResult,
  });
  return completed.kind === "ok" ? (completed.entry as Doc<"steps">) : "stale";
}

const vCompleteStepResult = v.union(
  v.object({ kind: v.literal("stale"), reason: v.string() }),
  v.object({ kind: v.literal("ok"), entry: journalDocument }),
);

export const completeStep = internalMutation({
  args: {
    stepId: v.id("steps"),
    generationNumber: v.number(),
    runResult: vResultValidator,
  },
  returns: vCompleteStepResult,
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
  returns: vCompleteStepResult,
  handler: async (ctx, args) => {
    const stale = await checkStepFences(ctx, args.stepId, args.generationNumber);
    if (stale) {
      return stale;
    }
    const entry = await ctx.db.get("steps", args.stepId);
    assert(entry, `Step not found: ${args.stepId}`);
    assert(entry.step.kind === "function", "Expected a function step");
    assert(entry.step.functionType === "mutation", "Expected a mutation step");
    // The user mutation and the journal completion share this transaction:
    // either both commit or neither does, which is what makes deleting an
    // in-progress mutation entry during recovery safe.
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

type StaleResult = { kind: "stale"; reason: string };

/**
 * The step-completion fence (spec invariant 7): a completion may modify a
 * step only when the workflow is still running, the completion's generation
 * matches, and the step is still in progress under direct execution. A
 * rejected completion is a return value — the runner exits cleanly — never
 * an error that would fail the workflow.
 */
async function checkStepFences(
  ctx: MutationCtx,
  stepId: Id<"steps">,
  generationNumber: number,
): Promise<StaleResult | null> {
  const entry = await ctx.db.get("steps", stepId);
  if (!entry) {
    // Deleted by recovery or cleanup; the claim is gone.
    return { kind: "stale", reason: `Step not found: ${stepId}` };
  }
  const workflow = await ctx.db.get("workflows", entry.workflowId);
  if (!workflow || workflow.runResult !== undefined) {
    return {
      kind: "stale",
      reason: `Workflow not running: ${entry.workflowId}`,
    };
  }
  if (workflow.generationNumber !== generationNumber) {
    return {
      kind: "stale",
      reason: `Invalid generation number: ${generationNumber} for workflow ${entry.workflowId}`,
    };
  }
  if (!entry.step.inProgress) {
    return { kind: "stale", reason: `Step already completed: ${stepId}` };
  }
  if (
    (entry.step.kind === "function" || entry.step.kind === "sleep") &&
    entry.step.workId !== undefined
  ) {
    // Ownership moved to the workpool (e.g. recovery consumed our attempt);
    // a late direct completion must not overwrite the workpool-owned retry.
    return {
      kind: "stale",
      reason: `Step ${stepId} is owned by the workpool now`,
    };
  }
  return null;
}

async function completeStepHandler(
  ctx: MutationCtx,
  stepId: Doc<"steps">["_id"],
  generationNumber: number,
  result: RunResult,
): Promise<{ kind: "ok"; entry: Doc<"steps"> } | StaleResult> {
  const stale = await checkStepFences(ctx, stepId, generationNumber);
  if (stale) {
    const console = await getDefaultLogger(ctx);
    console.warn(`Rejecting step completion: ${stale.reason}`);
    return stale;
  }
  const entry = await ctx.db.get("steps", stepId);
  assert(entry, `Step not found: ${stepId}`);
  const workflow = await ctx.db.get("workflows", entry.workflowId);
  assert(workflow, `Workflow not found: ${entry.workflowId}`);
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
  return { kind: "ok", entry };
}
