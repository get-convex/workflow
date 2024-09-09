// TODO:
// [ ] Progress indication
// [ ] Cancelation
// [ ] Retries for actions
// [ ] Signal if retriable / num retries / etc.
// [ ] Preemption for idempotent steps
// [ ] Capture logs
// [ ] Determinism: Date.now(), Math.random(), etc.

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import { FunctionHandle } from "convex/server";
import {
  journalDocument,
  JournalEntry,
  outcome,
  step,
  STEP_TYPES,
  Workflow,
  workflowDocument,
} from "./schema.js";
import { internal } from "./_generated/api.js";
import { Result } from "../types.js";

export const createWorkflow = mutation({
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

export const loadWorkflow = query({
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

export const completeWorkflow = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    outcome,
    now: v.number(),
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
    if (workflow.generationNumber !== args.generationNumber) {
      throw new Error(`Invalid generation number: ${args.generationNumber}`);
    }
    if (workflow.state.type !== "running") {
      throw new Error(`Workflow not running: ${workflowId}`);
    }
    workflow.state = {
      type: "completed",
      completedAt: args.now,
      outcome: args.outcome,
    };
    await ctx.db.replace(workflow._id, workflow);
  },
});

export const workflowBlockedBy = query({
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

export const loadJournal = query({
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

export const pushJournalEntry = mutation({
  args: {
    workflowId: v.string(),
    stepNumber: v.number(),
    step,
  },
  returns: journalDocument,
  handler: async (ctx, args) => {
    const workflowId = ctx.db.normalizeId("workflows", args.workflowId);
    if (!workflowId) {
      throw new Error(`Invalid workflow ID: ${args.workflowId}`);
    }
    if (!args.step.inProgress) {
      throw new Error(`Assertion failed: not in progress`);
    }
    const workflow = await ctx.db.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${workflowId}`);
    }
    const existing = await ctx.db
      .query("workflowJournal")
      .withIndex("workflow", (q) =>
        q.eq("workflowId", workflowId).eq("stepNumber", args.stepNumber),
      )
      .first();
    if (existing) {
      throw new Error(`Journal entry already exists: ${workflowId}`);
    }
    const maxEntry = await ctx.db
      .query("workflowJournal")
      .withIndex("workflow", (q) => q.eq("workflowId", workflowId))
      .order("desc")
      .first();
    if (maxEntry && maxEntry.stepNumber + 1 !== args.stepNumber) {
      throw new Error(`Invalid step number: ${args.stepNumber}`);
    }
    const journalId = await ctx.db.insert("workflowJournal", {
      workflowId,
      stepNumber: args.stepNumber,
      step: args.step,
    });
    const entry = await ctx.db.get(journalId);
    return entry! as JournalEntry;
  },
});

export const completeSleep = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    journalId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workflowId = ctx.db.normalizeId("workflows", args.workflowId);
    if (!workflowId) {
      throw new Error(`Invalid workflow ID: ${args.workflowId}`);
    }
    const journalId = ctx.db.normalizeId("workflowJournal", args.journalId);
    if (!journalId) {
      throw new Error(`Invalid journal ID: ${args.journalId}`);
    }
    const workflow = await ctx.db.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    if (workflow.generationNumber !== args.generationNumber) {
      throw new Error(`Invalid generation number: ${args.generationNumber}`);
    }
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${workflowId}`);
    }
    const journalEntry = await ctx.db.get(journalId);
    if (!journalEntry) {
      throw new Error(`Journal entry not found: ${journalId}`);
    }
    if (journalEntry.workflowId !== workflowId) {
      throw new Error(`Journal entry not for this workflow: ${journalId}`);
    }
    if (journalEntry.step.type !== "sleep") {
      throw new Error(`Journal entry not a sleep: ${journalId}`);
    }
    if (!journalEntry.step.inProgress) {
      throw new Error(`Journal entry not in progress: ${journalId}`);
    }
    journalEntry.step.inProgress = false;
    await ctx.db.replace(journalEntry._id, journalEntry);
    await ctx.runMutation(workflow.workflowHandle as any, {
      workflowId: args.workflowId,
      generationNumber: args.generationNumber,
    });
  },
});

export const runFunction = action({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    journalId: v.string(),

    functionType: v.union(
      v.literal("query"),
      v.literal("mutation"),
      v.literal("action"),
    ),
    handle: v.string(),
    args: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    let outcome: Result<any>;
    const runner: any = {
      query: ctx.runQuery,
      mutation: ctx.runMutation,
      action: ctx.runAction,
    }[args.functionType];
    if (!runner) {
      throw new Error(`Invalid function type: ${args.functionType}`);
    }
    try {
      const result = await runner(
        args.handle as FunctionHandle<any, any>,
        args.args,
      );
      outcome = { type: "success", result };
    } catch (error: any) {
      outcome = { type: "error", error: error.message };
    }
    await ctx.runMutation(internal.index.completeFunction, {
      workflowId: args.workflowId,
      generationNumber: args.generationNumber,
      journalId: args.journalId,
      outcome,
    });
  },
});

export const completeFunction = internalMutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    journalId: v.string(),
    outcome,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workflowId = ctx.db.normalizeId("workflows", args.workflowId);
    if (!workflowId) {
      throw new Error(`Invalid workflow ID: ${args.workflowId}`);
    }
    const journalId = ctx.db.normalizeId("workflowJournal", args.journalId);
    if (!journalId) {
      throw new Error(`Invalid journal ID: ${args.journalId}`);
    }
    const workflow = await ctx.db.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    if (workflow.generationNumber !== args.generationNumber) {
      throw new Error(`Invalid generation number: ${args.generationNumber}`);
    }
    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${workflowId}`);
    }
    const journalEntry = await ctx.db.get(journalId);
    if (!journalEntry) {
      throw new Error(`Journal entry not found: ${journalId}`);
    }
    if (journalEntry.workflowId !== args.workflowId) {
      throw new Error(`Journal entry not for this workflow: ${journalId}`);
    }
    if (journalEntry.step.type !== "function") {
      throw new Error(`Journal entry not a function: ${journalId}`);
    }
    if (!journalEntry.step.inProgress) {
      throw new Error(`Journal entry not in progress: ${journalId}`);
    }
    journalEntry.step.inProgress = false;
    journalEntry.step.outcome = args.outcome;
    journalEntry.step.completedAt = Date.now();
    await ctx.db.replace(journalEntry._id, journalEntry);
    await ctx.runMutation(workflow.workflowHandle as any, {
      workflowId,
      generationNumber: args.generationNumber,
    });
  },
});
