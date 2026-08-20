import { getConvexSize, v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server.js";
import { vStepWithIds } from "./schema.js";
import {
  journalDocument,
  type JournalEntry,
  workflowDocument,
} from "../validators.js";
import { getWorkflow } from "./model.js";
import { logLevel } from "../logging.js";
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
import type { Doc } from "./_generated/dataModel.js";

const schedulerOptionsValidator = v.union(
  v.object({ runAt: v.optional(v.number()) }),
  v.object({ runAfter: v.optional(v.number()) }),
);

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
    const workflow = await ctx.db.get("workflows", workflowId);
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
      journalSize += getConvexSize(entry);
      if (journalSize > MAX_JOURNAL_SIZE) {
        return { journalEntries, workflow, logLevel, ok: false };
      }
    }
    return { journalEntries, workflow, logLevel, ok: true };
  },
});

export const startSteps = mutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    steps: v.array(
      v.object({
        step: vStepWithIds,
        retry: v.optional(v.union(v.boolean(), vRetryBehavior)),
        schedulerOptions: v.optional(schedulerOptionsValidator),
        timeRequired: v.optional(v.number()),
      }),
    ),
    workpoolOptions: v.optional(workpoolOptions),
    deferExecution: v.optional(v.boolean()),
  },
  returns: v.array(journalDocument),
  handler: async (ctx, args): Promise<JournalEntry[]> => {
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
    const entries = await Promise.all(
      args.steps.map(async (stepArgs, index) => {
        const stepNumber = stepNumberBase + index;
        const stepId = await ctx.db.insert("steps", {
          workflowId: workflow._id,
          stepNumber,
          generationNumber,
          step: stepArgs.step,
          retry: stepArgs.retry,
          schedulerOptions: stepArgs.schedulerOptions,
          timeRequired: stepArgs.timeRequired,
        });
        let entry = await ctx.db.get("steps", stepId);
        assert(entry, "Step not found");
        console.event("started", {
          workflowId: workflow._id,
          workflowName: workflow.name,
          stepName: entry.step.name,
          stepNumber,
        });
        if (entry.step.runResult) {
          // Already completed inline by the caller — nothing to enqueue.
          console.event("stepCompleted", {
            workflowId: entry.workflowId,
            workflowName: workflow.name,
            status: entry.step.runResult.kind,
            stepName: entry.step.name,
            stepNumber: stepNumber,
          });
        } else if (!args.deferExecution) {
          entry = await dispatchStep(
            ctx,
            workflow,
            entry,
            generationNumber,
            args.workpoolOptions,
          );
        }
        await ctx.db.replace("steps", entry._id, entry);

        return entry;
      }),
    );
    return entries;
  },
});

// Called from outside the driver's transaction (the action runner), so
// staleness is a return value rather than an error: a canceled or restarted
// workflow must not fail the runner, it must make it exit cleanly.
export const dispatchSteps = internalMutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    steps: v.array(
      v.object({
        stepId: v.id("steps"),
        retry: v.optional(v.union(v.boolean(), vRetryBehavior)),
        schedulerOptions: v.optional(schedulerOptionsValidator),
      }),
    ),
    workpoolOptions: v.optional(workpoolOptions),
  },
  returns: v.union(
    v.object({ kind: v.literal("stale"), reason: v.string() }),
    v.object({ kind: v.literal("ok"), entries: v.array(journalDocument) }),
  ),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get("workflows", args.workflowId);
    if (!workflow || workflow.runResult !== undefined) {
      return {
        kind: "stale" as const,
        reason: `Workflow not running: ${args.workflowId}`,
      };
    }
    if (workflow.generationNumber !== args.generationNumber) {
      return {
        kind: "stale" as const,
        reason: `Invalid generation number: ${args.generationNumber} for workflow ${args.workflowId}`,
      };
    }
    const entries = await Promise.all(
      args.steps.map(async (requested) => {
        let entry = await ctx.db.get("steps", requested.stepId);
        assert(entry, `Step not found: ${requested.stepId}`);
        assert(
          entry.workflowId === workflow._id,
          `Step ${requested.stepId} does not belong to ${workflow._id}`,
        );
        if (
          !entry.step.inProgress ||
          ((entry.step.kind === "function" || entry.step.kind === "sleep") &&
            entry.step.workId)
        ) {
          return entry;
        }
        entry = await dispatchStep(
          ctx,
          workflow,
          entry,
          args.generationNumber,
          args.workpoolOptions,
          requested.retry,
          requested.schedulerOptions,
        );
        await ctx.db.replace("steps", entry._id, entry);
        return entry;
      }),
    );
    return { kind: "ok" as const, entries };
  },
});

/**
 * Compare-and-swap generation advancement for the action runner.
 *
 * The runner calls this after a batch of directly-executed steps settles,
 * before evaluating the handler again. The advancement transaction is the
 * mutual exclusion between drivers: two drivers holding the same generation
 * race here, exactly one commits, and the loser sees `stale` and exits. The
 * runner continues as the driver for the new generation, so unlike
 * completion-driven advancement (see `pool.advanceAndEnqueue`) no successor
 * is enqueued and `driverWorkId` is left pointing at the running action.
 */
export const advanceGeneration = internalMutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
  },
  returns: v.union(
    v.object({ kind: v.literal("stale"), reason: v.string() }),
    v.object({ kind: v.literal("advanced"), generationNumber: v.number() }),
  ),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get("workflows", args.workflowId);
    if (!workflow || workflow.runResult !== undefined) {
      return {
        kind: "stale" as const,
        reason: `Workflow not running: ${args.workflowId}`,
      };
    }
    if (workflow.generationNumber !== args.generationNumber) {
      return {
        kind: "stale" as const,
        reason: `Invalid generation number: ${args.generationNumber} for workflow ${args.workflowId}`,
      };
    }
    const inProgress = await ctx.db
      .query("steps")
      .withIndex("inProgress", (q) =>
        q.eq("step.inProgress", true).eq("workflowId", args.workflowId),
      )
      .first();
    if (inProgress) {
      return {
        kind: "stale" as const,
        reason: `Cannot advance ${args.workflowId} past in-progress step ${inProgress._id}`,
      };
    }
    const generationNumber = workflow.generationNumber + 1;
    await ctx.db.patch("workflows", args.workflowId, {
      generationNumber,
      driverFailures: undefined,
    });
    return { kind: "advanced" as const, generationNumber };
  },
});

async function dispatchStep(
  ctx: MutationCtx,
  workflow: Doc<"workflows">,
  entry: Doc<"steps">,
  generationNumber: number,
  workpoolOpts: Parameters<typeof getWorkpool>[1],
  retryOverride?: Doc<"steps">["retry"],
  schedulerOptionsOverride?: Doc<"steps">["schedulerOptions"],
): Promise<Doc<"steps">> {
  workpoolOpts ??= workflow.workpoolOptions;
  const stepDoc = entry.step;
  const { name } = stepDoc;
  const retry = retryOverride ?? entry.retry;
  const schedulerOptions = schedulerOptionsOverride ?? entry.schedulerOptions;
  const context: OnCompleteContext = {
    generationNumber,
    stepId: entry._id,
    workpoolOptions: workpoolOpts,
  };

  if (stepDoc.kind === "event") {
    entry = await awaitEvent(ctx, entry, {
      name,
      eventId: stepDoc.args.eventId,
    });
    if (entry.step.runResult) {
      const console = await getDefaultLogger(ctx);
      console.event("eventConsumed", {
        workflowId: entry.workflowId,
        workflowName: workflow.name,
        status: entry.step.runResult.kind,
        eventName: entry.step.name,
        stepNumber: entry.stepNumber,
        durationMs: entry.step.completedAt! - entry.step.startedAt,
      });
    }
    return entry;
  }

  if (stepDoc.kind === "workflow") {
    stepDoc.workflowId = await createHandler(ctx, {
      workflowName: stepDoc.name,
      workflowHandle: stepDoc.handle,
      workflowArgs: stepDoc.args,
      maxParallelism: workpoolOpts?.maxParallelism,
      onComplete: {
        fnHandle: await createFunctionHandle(
          internal.pool.nestedWorkflowOnComplete,
        ),
        context,
      },
      startAsync: true,
      execution: workflow.execution,
      workpoolOptions: workpoolOpts,
    });
    return entry;
  }

  const workpool = await getWorkpool(ctx, workpoolOpts);
  const onComplete = internal.pool.onComplete;
  let workId: WorkId;
  if (stepDoc.kind === "sleep") {
    workId = await workpool.enqueueQuery(
      ctx,
      internal.workflow.sleep,
      {},
      {
        context,
        onComplete,
        name,
        ...schedulerOptions,
      },
    );
  } else {
    switch (stepDoc.functionType) {
      case "query":
        workId = await workpool.enqueueQuery(
          ctx,
          stepDoc.handle as FunctionHandle<"query">,
          stepDoc.args,
          { context, onComplete, name, ...schedulerOptions },
        );
        break;
      case "mutation":
        workId = await workpool.enqueueMutation(
          ctx,
          stepDoc.handle as FunctionHandle<"mutation">,
          stepDoc.args,
          { context, onComplete, name, ...schedulerOptions },
        );
        break;
      case "action":
        workId = await workpool.enqueueAction(
          ctx,
          stepDoc.handle as FunctionHandle<"action">,
          stepDoc.args,
          { context, onComplete, name, retry, ...schedulerOptions },
        );
        break;
    }
  }
  stepDoc.workId = workId;
  return entry;
}
