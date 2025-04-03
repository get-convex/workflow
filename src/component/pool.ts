import {
  RetryBehavior,
  Workpool,
  WorkpoolOptions,
  resultValidator,
  vRetryBehavior,
  workIdValidator,
} from "@convex-dev/workpool";
import { assert } from "convex-helpers";
import { validate } from "convex-helpers/validators";
import {
  FunctionHandle,
  FunctionReference,
  RegisteredAction,
} from "convex/server";
import { Infer, v } from "convex/values";
import { components } from "./_generated/api.js";
import {
  internalMutation,
  mutation,
  MutationCtx,
} from "./_generated/server.js";
import {
  DEFAULT_LOG_LEVEL,
  LogLevel,
  createLogger,
  logLevel,
} from "./logging.js";
import { getWorkflow } from "./model.js";
import { valueSize } from "./schema.js";
import { getDefaultLogger } from "./utils.js";

export const workpoolOptions = v.object({
  logLevel: v.optional(logLevel),
  maxParallelism: v.optional(v.number()),
  defaultRetryBehavior: v.optional(vRetryBehavior),
  retryActionsByDefault: v.optional(v.boolean()),
});
// type check
const _: WorkpoolOptions = {} as Infer<typeof workpoolOptions>;

export const DEFAULT_MAX_PARALLELISM = 50;
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
  const logLevel = opts?.logLevel ?? config?.logLevel ?? DEFAULT_LOG_LEVEL;
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
});

export type OnCompleteContext = Infer<typeof onCompleteContext>;

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
        state: {
          type: "completed",
          completedAt: Date.now(),
          runResult: {
            kind: "failed",
            error,
          },
        },
      });
      return;
    }
    const { generationNumber } = args.context;
    const workflow = await getWorkflow(ctx, workflowId, generationNumber);
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
    if (workflow.state.type === "running") {
      // TODO: Technically this doesn't obey the workpool, but...
      // it's better than calling it directly, and enqueuing can now happen
      // in the root component.
      await ctx.scheduler.runAfter(
        0,
        workflow.workflowHandle as FunctionHandle<"mutation">,
        {
          workflowId: workflow._id,
          generationNumber,
        },
      );
    } else {
      console.error(
        `Workflow not running: ${workflowId} when completing ${stepId}`,
      );
    }
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
