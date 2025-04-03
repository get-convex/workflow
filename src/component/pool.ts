import {
  RetryBehavior,
  Workpool,
  resultValidator,
  workIdValidator,
} from "@convex-dev/workpool";
import { assert } from "convex-helpers";
import { validate } from "convex-helpers/validators";
import { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { MutationCtx, internalMutation } from "./_generated/server.js";
import { DEFAULT_LOG_LEVEL, LogLevel, createLogger } from "./logging.js";
import { getJournalEntry, getWorkflow } from "./model.js";
import { valueSize } from "./schema.js";
import { getDefaultLogger } from "./utils.js";

export const DEFAULT_MAX_PARALLELISM = 50;
export const DEFAULT_RETRY_BEHAVIOR = {
  maxAttempts: 5,
  initialBackoffMs: 500,
  base: 2,
};

export async function getWorkpool(
  ctx: MutationCtx,
  opts: {
    logLevel?: LogLevel | undefined;
    maxParallelism?: number | undefined;
    defaultRetryBehavior: RetryBehavior | undefined;
    retryActionsByDefault: boolean | undefined;
  },
) {
  const config = await ctx.db.query("config").first();
  const logLevel = opts?.logLevel ?? config?.logLevel ?? DEFAULT_LOG_LEVEL;
  const console = createLogger(logLevel);
  if (config) {
    if (opts?.logLevel && logLevel !== config.logLevel) {
      await ctx.db.patch(config._id, { logLevel });
    }
    if (opts?.maxParallelism && opts.maxParallelism !== config.maxParallelism) {
      console.warn("Updating max parallelism", opts.maxParallelism);
      await ctx.db.patch(config._id, { maxParallelism: opts.maxParallelism });
    }
  } else {
    await ctx.db.insert("config", {
      logLevel,
      maxParallelism: opts?.maxParallelism,
    });
  }
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
  journalId: v.id("journal"),
});

export const onComplete = internalMutation({
  args: {
    workId: workIdValidator,
    result: resultValidator,
    context: v.any(), // Ensure we can catch invalid context to fail workflow.
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const console = await getDefaultLogger(ctx);
    const journalId = args.context.journalId;
    if (!validate(v.id("workflowJournal"), journalId, { db: ctx.db })) {
      // Write to failures table and return
      // So someone can investigate if this ever happens
      console.error("Invalid onComplete context", args.context);
      await ctx.db.insert("onCompleteFailures", args);
      return;
    }
    const journalEntry = await ctx.db.get(journalId);
    assert(journalEntry, `Journal entry not found: ${journalId}`);
    const workflowId = journalEntry.workflowId;

    const error = !validate(onCompleteContext, args.context)
      ? `Invalid onComplete context for workId ${args.workId}` +
        JSON.stringify(args.context)
      : journalEntry.step.type !== "function"
        ? `Journal entry not a function: ${journalId}`
        : !journalEntry.step.inProgress
          ? `Journal entry not in progress: ${journalId}`
          : undefined;
    if (error) {
      await ctx.db.patch(workflowId, {
        state: {
          type: "completed",
          completedAt: Date.now(),
          outcome: {
            type: "error",
            error,
          },
        },
      });
      return;
    }
    const { generationNumber } = args.context;
    const workflow = await getWorkflow(ctx, workflowId, generationNumber);
    assert(journalEntry.step.type === "function");
    journalEntry.step.inProgress = false;
    journalEntry.step.completedAt = Date.now();
    switch (args.result.kind) {
      case "success":
        journalEntry.step.outcome = {
          type: "success",
          result: args.result.returnValue,
          resultSize: valueSize(args.result.returnValue),
        };
        break;
      case "failed":
        journalEntry.step.outcome = {
          type: "error",
          error: args.result.error,
        };
        break;
      case "canceled":
        journalEntry.step.outcome = {
          type: "error",
          error: "Canceled",
        };
        break;
    }
    await ctx.db.replace(journalEntry._id, journalEntry);
    console.debug(`Completed execution of ${journalId}`, journalEntry);
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
        `Workflow not running: ${workflowId} when completing ${journalId}`,
      );
    }
  },
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
