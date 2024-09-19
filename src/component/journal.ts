import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { journalDocument, JournalEntry, outcome, step } from "./schema.js";
import { getWorkflow } from "./model.js";

export const load = query({
  args: {
    workflowId: v.string(),
  },
  returns: v.array(journalDocument),
  handler: async (ctx, args) => {
    const workflowId = ctx.db.normalizeId("workflows", args.workflowId);
    if (!workflowId) {
      throw new Error(`Invalid workflow ID: ${args.workflowId}`);
    }
    const workflow = await ctx.db.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${workflowId}`);
    }
    const entries = await ctx.db
      .query("workflowJournal")
      .withIndex("workflow", (q) => q.eq("workflowId", workflowId))
      .collect();
    return entries as JournalEntry[];
  },
});

export const pushEntry = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    stepNumber: v.number(),
    step,
  },
  returns: journalDocument,
  handler: async (ctx, args) => {
    if (!args.step.inProgress) {
      throw new Error(`Assertion failed: not in progress`);
    }
    const workflow = await getWorkflow(
      ctx,
      args.workflowId,
      args.generationNumber,
    );
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const existing = await ctx.db
      .query("workflowJournal")
      .withIndex("workflow", (q) =>
        q.eq("workflowId", workflow._id).eq("stepNumber", args.stepNumber),
      )
      .first();
    if (existing) {
      throw new Error(`Journal entry already exists: ${args.workflowId}`);
    }
    const maxEntry = await ctx.db
      .query("workflowJournal")
      .withIndex("workflow", (q) => q.eq("workflowId", workflow._id))
      .order("desc")
      .first();
    if (maxEntry && maxEntry.stepNumber + 1 !== args.stepNumber) {
      throw new Error(`Invalid step number: ${args.stepNumber}`);
    }
    const journalId = await ctx.db.insert("workflowJournal", {
      workflowId: workflow._id,
      stepNumber: args.stepNumber,
      step: args.step,
    });
    const entry = await ctx.db.get(journalId);
    return entry! as JournalEntry;
  },
});
