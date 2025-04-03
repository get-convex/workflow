import { resultValidator, workIdValidator } from "@convex-dev/workpool";
import { assert } from "convex-helpers";
import { validate } from "convex-helpers/validators";
import {
  FunctionHandle,
  FunctionReference,
  RegisteredAction,
} from "convex/server";
import { Infer, v } from "convex/values";
import { mutation } from "./_generated/server.js";
import { getWorkflow } from "./model.js";
import { valueSize } from "./schema.js";
import { getDefaultLogger } from "./utils.js";

export const onCompleteContext = v.object({
  generationNumber: v.number(),
  journalId: v.id("journal"),
});

export type OnCompleteContext = Infer<typeof onCompleteContext>;

export const onComplete = mutation({
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
      : !["function", "sleep"].includes(journalEntry.step.type)
        ? `Journal entry not a function or sleep: ${journalId}`
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
    journalEntry.step.inProgress = false;
    if (journalEntry.step.type === "function") {
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

export type OnComplete =
  typeof onComplete extends RegisteredAction<
    "public",
    infer Args,
    infer ReturnValue
  >
    ? FunctionReference<"action", "internal", Args, null>
    : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
