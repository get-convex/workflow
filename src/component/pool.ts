import {
  vResultValidator,
  vWorkIdValidator,
  Workpool,
  type RetryBehavior,
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
import { getDefaultLogger } from "./utils.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  vWorkflowId,
  type SchedulerOptions,
  type WorkflowId,
} from "../types.js";
import { checkForOversizedResult } from "./oversizedValues.js";
export { workpoolOptions } from "../workpoolOptions.js";
import { workpoolOptions } from "../workpoolOptions.js";

export const DEFAULT_MAX_PARALLELISM = 25;
export const DEFAULT_RETRY_BEHAVIOR = {
  maxAttempts: 5,
  initialBackoffMs: 500,
  base: 2,
};

// Capped backoff for tail-enqueueing a replacement driver after an
// infrastructure failure. There is no attempt cap: the workflow only fails
// for reasons its handler observed, never because its driver died.
const DRIVER_BACKOFF_INITIAL_MS = 250;
const DRIVER_BACKOFF_MAX_MS = 30_000;

/** The effective retry behavior for an action step, shared with the runner. */
export function retryBehavior(
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
  const journalEntry = await ctx.db.get("steps", stepId);
  if (!journalEntry) {
    console.error(
      `Journal entry not found: ${stepId}. This is likely because it was already cleaned up.`,
    );
    return;
  }
  const workflowId = journalEntry.workflowId;

  if (
    !validate(onCompleteContext, args.context, { allowUnknownFields: true })
  ) {
    const error =
      `Invalid onComplete context for ${args.workId ? `workId ${args.workId}` : `nested workflowId ${args.workflowId}`}` +
      JSON.stringify(args.context);
    await ctx.db.patch("workflows", workflowId, {
      runResult: {
        kind: "failed",
        error,
      },
    });
    return;
  }
  const { generationNumber } = args.context;
  const workflow = await ctx.db.get("workflows", workflowId);
  assert(workflow, `Workflow not found: ${workflowId}`);
  // Terminal-state fence: cancellation does not bump the generation, so a
  // completed/canceled workflow's journal must reject all late completions.
  if (workflow.runResult !== undefined) {
    if (workflow.runResult.kind !== "canceled") {
      console.error(
        `Workflow: ${workflowId} already ${workflow.runResult.kind} when completing ${stepId} with status ${args.result.kind}`,
      );
    }
    return;
  }
  if (workflow.generationNumber !== generationNumber) {
    console.error(
      `Workflow: ${workflowId} already has generation number ${workflow.generationNumber} when completing ${stepId}. Expected ${generationNumber}`,
    );
    return;
  }
  if (!journalEntry.step.inProgress) {
    console.error(
      `Step finished but journal entry not in progress: ${stepId} status: ${journalEntry.step.runResult?.kind ?? "pending"}`,
    );
    return;
  }
  await settleStep(ctx, console, workflow, journalEntry, args.result);

  const effectiveWorkpoolOptions =
    args.context.workpoolOptions ?? workflow.workpoolOptions;
  await advanceAndEnqueue(ctx, workflow, effectiveWorkpoolOptions);
}

/** Write a terminal result to a journal entry and emit the completion event. */
async function settleStep(
  ctx: MutationCtx,
  console: Awaited<ReturnType<typeof getDefaultLogger>>,
  workflow: Doc<"workflows">,
  journalEntry: Doc<"steps">,
  result: RunResult,
) {
  journalEntry.step.inProgress = false;
  journalEntry.step.completedAt = Date.now();
  journalEntry.step.runResult = checkForOversizedResult(result);
  await ctx.db.replace("steps", journalEntry._id, journalEntry);
  console.debug(`Completed execution of ${journalEntry._id}`, journalEntry);
  console.event("stepCompleted", {
    workflowId: journalEntry.workflowId,
    workflowName: workflow.name,
    status: journalEntry.step.runResult.kind,
    stepName: journalEntry.step.name,
    stepNumber: journalEntry.stepNumber,
    durationMs: journalEntry.step.completedAt - journalEntry.step.startedAt,
  });
}

/**
 * The single generation-advancement transition (spec: "Advancing a
 * generation"). Requires a running workflow with no in-progress steps;
 * atomically bumps the generation and enqueues exactly one successor driver.
 * Every completion path funnels through here, so parallel final completions
 * race on the workflow document and exactly one advancement commits.
 *
 * Returns false without enqueueing when a precondition fails, which is the
 * normal case for every completion except the generation's last.
 */
export async function advanceAndEnqueue(
  ctx: MutationCtx,
  workflow: Doc<"workflows">,
  options?: WorkpoolOptions,
): Promise<boolean> {
  if (workflow.runResult !== undefined) {
    return false;
  }
  const remaining = await ctx.db
    .query("steps")
    .withIndex("inProgress", (q) =>
      q.eq("step.inProgress", true).eq("workflowId", workflow._id),
    )
    .first();
  if (remaining) {
    return false;
  }
  workflow.generationNumber += 1;
  workflow.driverFailures = undefined;
  await ctx.db.patch("workflows", workflow._id, {
    generationNumber: workflow.generationNumber,
    driverFailures: undefined,
  });
  const workpool = await getWorkpool(ctx, options ?? workflow.workpoolOptions);
  await enqueueWorkflow(ctx, workflow, workpool, options);
  return true;
}

export async function enqueueWorkflow(
  ctx: MutationCtx,
  workflow: Doc<"workflows">,
  workpool: Workpool,
  options?: WorkpoolOptions,
  schedulerOptions?: SchedulerOptions,
) {
  options ??= workflow.workpoolOptions;
  const { _id: workflowId, generationNumber, name, workflowHandle } = workflow;
  const onComplete = internal.pool.handlerOnComplete;
  const context = { workflowId, generationNumber };
  let driverWorkId: WorkId;
  if (workflow.execution?.type === "action") {
    driverWorkId = await workpool.enqueueAction(
      ctx,
      internal.actionRunner.run,
      {
        workflowId,
        generationNumber,
        maxDurationMs: workflow.execution.maxDurationMs,
        workpoolOptions: options,
      },
      { name, onComplete, context, ...schedulerOptions },
    );
  } else {
    driverWorkId = await workpool.enqueueMutation(
      ctx,
      workflowHandle as FunctionHandle<"mutation">,
      { workflowId, generationNumber },
      { name, onComplete, context, ...schedulerOptions },
    );
  }
  // Mark this driver as the authoritative one: recovery in handlerOnComplete
  // only acts for the driver whose workId still matches, so a superseded
  // driver's late completion can never race a live one.
  workflow.driverWorkId = driverWorkId;
  await ctx.db.patch("workflows", workflowId, { driverWorkId });
}

export const enqueue = internalMutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    workpoolOptions: v.optional(workpoolOptions),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get("workflows", args.workflowId);
    if (
      !workflow ||
      workflow.generationNumber !== args.generationNumber ||
      workflow.runResult
    ) {
      return null;
    }
    const effectiveWorkpoolOptions =
      args.workpoolOptions ?? workflow.workpoolOptions;
    const workpool = await getWorkpool(ctx, effectiveWorkpoolOptions);
    await enqueueWorkflow(ctx, workflow, workpool, effectiveWorkpoolOptions);
    return null;
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

/**
 * Workpool completion for the driver itself (poll mutation or action runner).
 *
 * This is the durable recovery boundary: a driver that dies for any
 * infrastructure reason lands here with a failed result, and this mutation —
 * never the failure itself — decides what happens to the workflow. A driver
 * failure is not a workflow failure: user-code errors are caught inside the
 * poll and reported via `workflow.complete`, so a failed result here means
 * the driver was interrupted (OCC, timeout, restart, ...).
 *
 * Recovery per spec ("Recovery by step type"): durable steps are left for
 * their own completions; direct query/mutation claims are deleted so the next
 * driver re-executes them in the same generation (their execution is atomic
 * with journal completion, so an in-progress entry means nothing committed);
 * direct actions are possibly-started, so at-most-once demands they settle as
 * failed unless their retry policy grants another attempt, in which case one
 * attempt is consumed and the rest is handed to the workpool.
 */
export const handlerOnComplete = internalMutation({
  args: {
    workId: vWorkIdValidator,
    result: vResultValidator,
    context: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const console = await getDefaultLogger(ctx);
    if (!validate(handlerOnCompleteContext, args.context)) {
      // Should never happen: we enqueued this context ourselves. Record it
      // for investigation; there is no workflow we can safely act on.
      console.error("Invalid handlerOnComplete context", args.context);
      await ctx.db.insert("onCompleteFailures", args);
      return;
    }
    const { workflowId } = args.context;
    const workflow = await ctx.db.get("workflows", workflowId);
    if (!workflow) {
      console.debug(`Workflow ${workflowId} gone before driver completion`);
      return;
    }
    if (workflow.driverWorkId !== args.workId) {
      // A newer driver has been enqueued (deadline handoff, advancement,
      // restart). Its lifecycle owns the workflow now.
      console.debug(
        `Ignoring completion of superseded driver ${args.workId} for ${workflowId}`,
      );
      return;
    }
    if (workflow.runResult !== undefined) {
      return;
    }
    const options = workflow.workpoolOptions;
    if (args.result.kind === "success") {
      // A driver that exits cleanly either handed off (driverWorkId replaced,
      // caught above), left the generation blocked (completions advance it),
      // or observed a stale snapshot and quit. If the generation is fully
      // settled, advancing here is the safety net that keeps the workflow
      // moving; otherwise there is nothing to do.
      await advanceAndEnqueue(ctx, workflow, options);
      return;
    }

    console.error(
      `Driver for ${workflowId} (generation ${workflow.generationNumber}) ` +
        `${args.result.kind === "canceled" ? "was canceled" : `failed: ${args.result.error}`}. Recovering.`,
    );
    const inProgress = await ctx.db
      .query("steps")
      .withIndex("inProgress", (q) =>
        q.eq("step.inProgress", true).eq("workflowId", workflowId),
      )
      .collect();
    const retryable: { stepId: Id<"steps">; retry: RetryBehavior }[] = [];
    let blocked = false;
    for (const entry of inProgress) {
      const step = entry.step;
      const durable =
        step.kind === "workflow"
          ? step.workflowId !== undefined
          : step.kind === "event"
            ? step.eventId !== undefined
            : step.workId !== undefined;
      if (durable) {
        // Workpool / nested workflow / event completions still own these.
        blocked = true;
        continue;
      }
      if (step.kind === "function" && step.functionType === "action") {
        // The driver may have started this action; its outcome is unknown.
        const retry = retryBehavior(entry.retry, options);
        if (retry && retry.maxAttempts > 1) {
          const nextBackoffMs = retry.initialBackoffMs * retry.base;
          retryable.push({
            stepId: entry._id,
            retry: {
              ...retry,
              maxAttempts: retry.maxAttempts - 1,
              initialBackoffMs: nextBackoffMs,
            },
          });
          blocked = true;
        } else {
          await settleStep(ctx, console, workflow, entry, {
            kind: "failed",
            error:
              `Workflow driver failed while this action was in progress; ` +
              `its outcome is unknown and it will not be re-run. ` +
              `Driver error: ${args.result.kind === "failed" ? args.result.error : "canceled"}`,
          });
        }
      } else {
        // Direct queries/mutations and never-dispatched entries: delete them
        // so the next driver re-creates and re-executes them in this
        // generation. Their side effects are transactional with the journal
        // write, so an in-progress entry proves nothing committed.
        await ctx.db.delete("steps", entry._id);
      }
    }
    if (retryable.length > 0) {
      await ctx.runMutation(internal.journal.dispatchSteps, {
        workflowId,
        generationNumber: workflow.generationNumber,
        steps: retryable.map(({ stepId, retry }) => ({
          stepId,
          retry,
          schedulerOptions: { runAfter: retry.initialBackoffMs },
        })),
        workpoolOptions: options,
      });
    }
    const driverFailures = (workflow.driverFailures ?? 0) + 1;
    await ctx.db.patch("workflows", workflowId, { driverFailures });
    if (blocked) {
      // Recovered durable work remains; its completions advance the workflow.
      return;
    }
    // Tail-enqueue a replacement driver for the same generation, with capped
    // backoff against a persistently failing driver. Deliberately not
    // advancement: advancing would reset the failure count and skip the
    // backoff, and the replacement replays a settled wave just as well at
    // the same generation.
    const backoffMs = Math.min(
      DRIVER_BACKOFF_INITIAL_MS * 2 ** (driverFailures - 1),
      DRIVER_BACKOFF_MAX_MS,
    );
    const workpool = await getWorkpool(ctx, options);
    await enqueueWorkflow(ctx, workflow, workpool, options, {
      runAfter: backoffMs,
    });
  },
});
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
