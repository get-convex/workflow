import { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { mutation, query, QueryCtx } from "./_generated/server.js";
import { getWorkflow } from "./model.js";
import {
  workflowDocument,
  Workflow,
  journalDocument,
  STEP_TYPES,
  JournalEntry,
  outcome,
} from "./schema.js";
import { createDefaultLogger, getDefaultLogger } from "./utils.js";
import { logLevel } from "./logging.js";
import { assert } from "convex-helpers";
import { Id } from "./_generated/dataModel.js";

export const create = mutation({
  args: {
    workflowName: v.string(),
    workflowHandle: v.string(),
    workflowArgs: v.any(),
    // TODO: ttl
    // TODO: onComplete hook
    // TODO: onComplete context
    logLevel: v.optional(logLevel),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const console = await createDefaultLogger(ctx, args.logLevel);
    const workflowId = await ctx.db.insert("workflows", {
      name: args.workflowName,
      startedAt: now,
      logLevel: args.logLevel,
      workflowHandle: args.workflowHandle,
      args: args.workflowArgs,
      state: { type: "running" },
      generationNumber: 0,
    });
    console.debug(
      `Created workflow ${workflowId}:`,
      args.workflowArgs,
      args.workflowHandle,
    );
    // If we can't start it, may as well not create it, eh? Fail fast...
    await ctx.runMutation(args.workflowHandle as FunctionHandle<"mutation">, {
      workflowId,
      generationNumber: 0,
    });
    return workflowId as string;
  },
});

export const getStatus = query({
  args: {
    workflowId: v.id("workflows"),
  },
  returns: v.object({
    workflow: workflowDocument,
    inProgress: v.array(journalDocument),
    logLevel: logLevel,
  }),
  handler: getStatusHandler,
});

export async function getStatusHandler(
  ctx: QueryCtx,
  args: { workflowId: Id<"workflows"> },
) {
  const workflow = await ctx.db.get(args.workflowId);
  assert(workflow, `Workflow not found: ${args.workflowId}`);
  const console = await getDefaultLogger(ctx);

  const result: JournalEntry[] = [];
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
  console.debug(`${args.workflowId} blocked by`, result);
  return { workflow, inProgress: result, logLevel: console.logLevel };
}

export const cancel = mutation({
  args: {
    workflowId: v.id("workflows"),
  },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    const workflow = await ctx.db.get(workflowId);
    assert(workflow, `Workflow not found: ${workflowId}`);
    const console = await getDefaultLogger(ctx);
    assert(workflow.state.type === "running", `Not running: ${workflowId}`);
    workflow.state = { type: "canceled", canceledAt: Date.now() };
    workflow.generationNumber += 1;
    console.debug(`Canceled workflow ${workflowId}:`, workflow);
    // TODO: Call onComplete hook
    // TODO: delete everything unless ttl is set
    await ctx.db.replace(workflow._id, workflow);
  },
});

export const complete = mutation({
  args: {
    workflowId: v.id("workflows"),
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
    const logger = await getDefaultLogger(ctx);
    if (workflow.state.type !== "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    workflow.state = {
      type: "completed",
      completedAt: args.now,
      outcome: args.outcome,
    };
    // TODO: Call onComplete hook
    // TODO: delete everything unless ttl is set
    logger.debug(`Completed workflow ${workflow._id}:`, workflow);
    await ctx.db.replace(workflow._id, workflow);
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
    const logger = await getDefaultLogger(ctx);
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

export const sleep = mutation({
  args: {
    journalId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const console = await getDefaultLogger(ctx);
    console.debug(`Sleep over for ${args.journalId}`);
  },
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
