import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, mutation } from "./_generated/server.js";
import { getWorkflow, getJournalEntry } from "./model.js";
import { getDefaultLogger } from "./utils.js";
import { getWorkpool } from "./pool.js";
import type { FunctionHandle } from "convex/server";

export const start = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    journalId: v.string(),
    durationMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const logger = await getDefaultLogger(ctx);
    const workpool = await getWorkpool(ctx);
    const sleepId = await workpool.enqueueMutation(
      ctx,
      internal.sleep.complete,
      {
        workflowId: args.workflowId,
        generationNumber: args.generationNumber,
        journalId: args.journalId,
      },
      { runAfter: args.durationMs },
    );
    logger.debug(`Scheduled sleep @ ${sleepId}`, args);
  },
});

export const complete = internalMutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    journalId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workflow = await getWorkflow(
      ctx,
      args.workflowId,
      args.generationNumber,
    );
    const logger = await getDefaultLogger(ctx);

    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }

    const journalEntry = await getJournalEntry(ctx, args.journalId);
    if (journalEntry.workflowId !== args.workflowId) {
      throw new Error(`Journal entry not for this workflow: ${args.journalId}`);
    }
    if (journalEntry.step.type !== "sleep") {
      throw new Error(`Journal entry not a sleep: ${args.journalId}`);
    }
    if (!journalEntry.step.inProgress) {
      throw new Error(`Journal entry not in progress: ${args.journalId}`);
    }

    journalEntry.step.inProgress = false;
    await ctx.db.replace(journalEntry._id, journalEntry);
    const handle = workflow.workflowHandle as FunctionHandle<"mutation">;
    await ctx.runMutation(handle, {
      workflowId: args.workflowId,
      generationNumber: args.generationNumber,
    });
    logger.debug(`Completed sleep`, args, journalEntry);
  },
});
