import { v } from "convex/values";
import { api, internal } from "./_generated/api.js";
import { internalMutation, mutation } from "./_generated/server.js";
import { getWorkflow, getJournalEntry } from "./model.js";

export const start = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    journalId: v.string(),
    durationMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      Date.now() + args.durationMs,
      internal.sleep.complete,
      {
        workflowId: args.workflowId,
        generationNumber: args.generationNumber,
        journalId: args.journalId,
      },
    );
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
    await ctx.runMutation(workflow.workflowHandle as any, {
      workflowId: args.workflowId,
      generationNumber: args.generationNumber,
    });
  },
});
