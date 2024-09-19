import { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { getWorkflow } from "./model.js";
import {
  workflowDocument,
  Workflow,
  journalDocument,
  STEP_TYPES,
  JournalEntry,
  outcome,
} from "./schema.js";

export const create = mutation({
  args: {
    workflowHandle: v.string(),
    workflowArgs: v.any(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const workflowId = await ctx.db.insert("workflows", {
      startedAt: now,
      workflowHandle: args.workflowHandle,
      args: args.workflowArgs,
      state: { type: "running" },
      generationNumber: 0,
    });
    await ctx.scheduler.runAfter(
      0,
      args.workflowHandle as FunctionHandle<"mutation", any, any>,
      {
        workflowId,
        generationNumber: 0,
      },
    );
    return workflowId as string;
  },
});

export const load = query({
  args: {
    workflowId: v.string(),
  },
  returns: workflowDocument,
  handler: async (ctx, args) => {
    const workflowId = ctx.db.normalizeId("workflows", args.workflowId);
    if (!workflowId) {
      throw new Error(`Invalid workflow ID: ${args.workflowId}`);
    }
    const workflow = await ctx.db.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.workflowId}`);
    }
    return workflow as Workflow;
  },
});

export const cancel = mutation({
  args: {
    workflowId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workflowId = ctx.db.normalizeId("workflows", args.workflowId);
    if (!workflowId) {
      throw new Error(`Invalid workflow ID: ${args.workflowId}`);
    }
    const workflow = await ctx.db.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    if (workflow.state.type !== "running") {
      throw new Error(`Workflow not running: ${workflowId}`);
    }
    workflow.state = { type: "canceled", canceledAt: Date.now() };
    workflow.generationNumber += 1;
    await ctx.db.replace(workflow._id, workflow);
  },
});

export const complete = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    outcome,
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workflow = await getWorkflow(
      ctx,
      args.workflowId,
      args.generationNumber,
    );
    if (workflow.state.type !== "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    workflow.state = {
      type: "completed",
      completedAt: args.now,
      outcome: args.outcome,
    };
    await ctx.db.replace(workflow._id, workflow);
  },
});

export const blockedBy = query({
  args: {
    workflowId: v.string(),
  },
  returns: v.union(journalDocument, v.null()),
  handler: async (ctx, args) => {
    const workflowId = ctx.db.normalizeId("workflows", args.workflowId);
    if (!workflowId) {
      throw new Error(`Invalid workflow ID: ${args.workflowId}`);
    }
    const result = [];
    for (const stepType of STEP_TYPES) {
      const inProgressEntries = await ctx.db
        .query("workflowJournal")
        .withIndex("inProgress", (q) =>
          q
            .eq("step.type", stepType)
            .eq("step.inProgress", true)
            .eq("workflowId", args.workflowId),
        )
        .collect();
      result.push(...inProgressEntries);
    }
    if (result.length > 1) {
      throw new Error("TODO: multiple in-progress entries");
    }
    return (result[0] ?? null) as JournalEntry | null;
  },
});

export const cleanup = mutation({
  args: {
    workflowId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workflowId = ctx.db.normalizeId("workflows", args.workflowId);
    if (!workflowId) {
      throw new Error(`Invalid workflow ID: ${args.workflowId}`);
    }
    const workflow = await ctx.db.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    if (workflow.state.type !== "completed") {
      throw new Error(`Workflow not completed: ${workflowId}`);
    }
    await ctx.db.delete(workflowId);
    const journalEntries = await ctx.db
      .query("workflowJournal")
      .withIndex("workflow", (q) => q.eq("workflowId", workflowId))
      .collect();
    for (const journalEntry of journalEntries) {
      await ctx.db.delete(journalEntry._id);
    }
  },
});
