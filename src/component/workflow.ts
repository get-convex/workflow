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
  logLevel,
} from "./schema.js";
import { createLogger } from "./utils.js";

export const create = mutation({
  args: {
    workflowHandle: v.string(),
    workflowArgs: v.any(),
    logLevel,
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const logger = createLogger(args.logLevel);
    const workflowId = await ctx.db.insert("workflows", {
      startedAt: now,
      logLevel: args.logLevel,
      workflowHandle: args.workflowHandle,
      args: args.workflowArgs,
      state: { type: "running" },
      generationNumber: 0,
    });
    logger.debug(
      `Created workflow ${workflowId}:`,
      args.workflowArgs,
      args.workflowHandle,
    );
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
    const logger = createLogger(workflow.logLevel);
    logger.debug(`Loaded workflow ${workflowId}:`, workflow);
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
    const logger = createLogger(workflow.logLevel);
    if (workflow.state.type !== "running") {
      throw new Error(`Workflow not running: ${workflowId}`);
    }
    workflow.state = { type: "canceled", canceledAt: Date.now() };
    workflow.generationNumber += 1;
    logger.debug(`Canceled workflow ${workflowId}:`, workflow);
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
    const logger = createLogger(workflow.logLevel);
    if (workflow.state.type !== "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    workflow.state = {
      type: "completed",
      completedAt: args.now,
      outcome: args.outcome,
    };
    logger.debug(`Completed workflow ${workflow._id}:`, workflow);
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
    const workflow = await ctx.db.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    const logger = createLogger(workflow.logLevel);

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
      throw new Error(`Multiple in-progress entries for ${args.workflowId}`);
    }
    const entry = (result[0] ?? null) as JournalEntry | null;
    logger.debug(`${args.workflowId} blocked by`, entry);
    return entry;
  },
});

export const cleanup = mutation({
  args: {
    workflowId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const workflowId = ctx.db.normalizeId("workflows", args.workflowId);
    if (!workflowId) {
      throw new Error(`Invalid workflow ID: ${args.workflowId}`);
    }
    const workflow = await ctx.db.get(workflowId);
    if (!workflow) {
      return false;
    }
    const logger = createLogger(workflow.logLevel);
    if (workflow.state.type !== "completed") {
      logger.debug(
        `Can't clean up workflow ${workflowId} since it hasn't completed.`,
      );
      return false;
    }
    logger.debug(`Cleaning up workflow ${workflowId}`, workflow);
    await ctx.db.delete(workflowId);
    const journalEntries = await ctx.db
      .query("workflowJournal")
      .withIndex("workflow", (q) => q.eq("workflowId", workflowId))
      .collect();
    for (const journalEntry of journalEntries) {
      logger.debug("Deleting journal entry", journalEntry);
      await ctx.db.delete(journalEntry._id);
    }
    return true;
  },
});
