import {
  resultValidator,
  vRetryBehavior,
  workIdValidator,
  Workpool,
  WorkpoolOptions,
} from "@convex-dev/workpool";
import { assert } from "convex-helpers";
import { validate } from "convex-helpers/validators";
import {
  FunctionHandle,
  FunctionReference,
  RegisteredAction,
} from "convex/server";
import { Infer, v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation, MutationCtx } from "./_generated/server.js";
import { logLevel } from "./logging.js";
import { getWorkflow } from "./model.js";
import { getDefaultLogger } from "./utils.js";
import { completeHandler } from "./workflow.js";

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

export const onCompleteContext = v.object({
  generationNumber: v.number(),
  stepId: v.id("steps"),
  workpoolOptions: v.optional(workpoolOptions),
});

export type OnCompleteContext = Infer<typeof onCompleteContext>;

// For a single step
export const onComplete = internalMutation({
  args: {
    workId: workIdValidator,
    result: resultValidator,
    context: v.any(), // Ensure we can catch invalid context to fail workflow.
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const console = await getDefaultLogger(ctx);
    const stepId = args.context.stepId;
    if (!validate(v.id("steps"), stepId, { db: ctx.db })) {
      // Write to failures table and return
      // So someone can investigate if this ever happens
      console.error("Invalid onComplete context", args.context);
      await ctx.db.insert("onCompleteFailures", args);
      return;
    }
    const journalEntry = await ctx.db.get(stepId);
    assert(journalEntry, `Journal entry not found: ${stepId}`);
    const workflowId = journalEntry.workflowId;

    const error = !validate(onCompleteContext, args.context)
      ? `Invalid onComplete context for workId ${args.workId}` +
        JSON.stringify(args.context)
      : !journalEntry.step.inProgress
        ? `Journal entry not in progress: ${stepId}`
        : undefined;
    if (error) {
      await ctx.db.patch(workflowId, {
        runResult: {
          kind: "failed",
          error,
        },
      });
      return;
    }
    const { generationNumber } = args.context;
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

    const workflow = await getWorkflow(ctx, workflowId, null);
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
    if (workflow.generationNumber !== generationNumber) {
      console.error(
        `Workflow: ${workflowId} already has generation number ${workflow.generationNumber} when completing ${stepId}`,
      );
      return;
    }
    const workpool = await getWorkpool(ctx, args.context.workpoolOptions);
    await workpool.enqueueMutation(
      ctx,
      workflow.workflowHandle as FunctionHandle<"mutation">,
      { workflowId: workflow._id, generationNumber },
      {
        onComplete: internal.pool.handlerOnComplete,
        context: { workflowId, generationNumber },
      },
    );
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
    workId: workIdValidator,
    result: resultValidator,
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
      if (
        validate(v.id("workflows"), args.context.workflowId, { db: ctx.db })
      ) {
        await ctx.db.insert("onCompleteFailures", args);
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
      }
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
