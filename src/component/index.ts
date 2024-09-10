import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server.js";
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
import { functionType, Result } from "../types.js";
import { getWorkflow, getJournalEntry } from "./model.js";

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

export const cancelWorkflow = mutation({
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

export const completeWorkflow = mutation({
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

export const completeSleep = mutation({
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

const HEARTBEAT_INTERVAL_MS = 10 * 1000;

export const startFunction = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    journalId: v.string(),

    functionType,
    handle: v.string(),
    args: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const journalEntry = await getJournalEntry(ctx, args.journalId);
    if (journalEntry.step.type !== "function") {
      throw new Error(`Journal entry not a function: ${args.journalId}`);
    }
    if (!journalEntry.step.inProgress) {
      throw new Error(`Journal entry not in progress: ${args.journalId}`);
    }
    const runId = await ctx.scheduler.runAfter(0, internal.index.runFunction, {
      workflowId: args.workflowId,
      generationNumber: args.generationNumber,
      journalId: args.journalId,
      functionType: journalEntry.step.functionType,
      handle: journalEntry.step.handle,
      args: journalEntry.step.args,
    });
    if (journalEntry.step.functionType.type === "action") {
      const recoveryId = await ctx.scheduler.runAfter(
        HEARTBEAT_INTERVAL_MS,
        internal.index.recoverFunction,
        {
          workflowId: args.workflowId,
          generationNumber: args.generationNumber,
          journalId: args.journalId,
          runId,
        },
      );
      journalEntry.step.functionType.recoveryId = recoveryId;
      await ctx.db.replace(journalEntry._id, journalEntry);
    }
  },
});

export const recoverFunction = internalMutation({
  args: {
    workflowId: v.string(),
    journalId: v.string(),
    generationNumber: v.number(),
    runId: v.id("_scheduled_functions"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workflow = await getWorkflow(
      ctx,
      args.workflowId,
      args.generationNumber,
    );
    const journalEntry = await getJournalEntry(ctx, args.journalId);
    const { step } = journalEntry;
    if (step.type !== "function") {
      throw new Error(`Journal entry not a function: ${args.journalId}`);
    }
    if (step.functionType.type !== "action") {
      throw new Error(
        `Journal entry function type not action: ${args.journalId}`,
      );
    }

    // The system will *eventually* fail in progress actions that fail either due to
    // (1) a system error or (2) an infrastructural timeout. So, we won't try to detect
    // this condition here. Instead, we'll look for a failed (or canceled) state that
    // doesn't have the outcome set in the journal.
    if (!step.inProgress && step.outcome) {
      console.log(`Step completed, skipping recovery.`);
      return;
    }

    const runState = await ctx.db.system.get(args.runId);
    if (!runState) {
      console.log(`Run state not found, skipping recovery.`);
      return;
    }

    const isInProgress =
      runState.state.kind === "inProgress" || runState.state.kind === "pending";
    // Reschedule ourselves to run again in HEARTBEAT_INTERVAL_MS.
    if (isInProgress) {
      const nextHeartbeat = Date.now() + HEARTBEAT_INTERVAL_MS;
      const nextRecoveryId = await ctx.scheduler.runAt(
        nextHeartbeat,
        internal.index.recoverFunction,
        {
          workflowId: args.workflowId,
          journalId: args.journalId,
          generationNumber: args.generationNumber,
          runId: args.runId,
        },
      );
      step.functionType.recoveryId = nextRecoveryId;
      await ctx.db.replace(journalEntry._id, journalEntry);
      return;
    }

    // Fail the action and continue.
    const newGenerationNumber = workflow.generationNumber + 1;
    workflow.generationNumber = newGenerationNumber;
    await ctx.db.replace(workflow._id, workflow);

    // Unlink ourselves from the journal entry so we don't try to cancel ourselves.
    step.functionType.recoveryId = undefined;
    await ctx.db.replace(journalEntry._id, journalEntry);

    await ctx.runMutation(internal.index.completeFunction, {
      workflowId: args.workflowId,
      generationNumber: newGenerationNumber,
      journalId: args.journalId,
      outcome: {
        type: "error",
        error: "Transient error when executing action",
      },
    });
  },
});

export const runFunction = internalAction({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    journalId: v.string(),

    functionType,
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
    }[args.functionType.type];
    if (!runner) {
      throw new Error(`Invalid function type: ${args.functionType.type}`);
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
    if (journalEntry.step.type !== "function") {
      throw new Error(`Journal entry not a function: ${args.journalId}`);
    }
    if (!journalEntry.step.inProgress) {
      throw new Error(`Journal entry not in progress: ${args.journalId}`);
    }
    journalEntry.step.inProgress = false;
    journalEntry.step.outcome = args.outcome;
    journalEntry.step.completedAt = Date.now();
    await ctx.db.replace(journalEntry._id, journalEntry);
    await ctx.runMutation(workflow.workflowHandle as any, {
      workflowId: workflow._id,
      generationNumber: args.generationNumber,
    });

    // Best effort cancel any scheduled recovery to save on function calls.
    if (journalEntry.step.functionType.type !== "action") {
      return;
    }
    const recoveryIdStr = journalEntry.step.functionType.recoveryId;
    if (!recoveryIdStr) {
      return;
    }
    const recoveryId = ctx.db.system.normalizeId(
      "_scheduled_functions",
      recoveryIdStr,
    );
    if (!recoveryId) {
      return;
    }
    const recovery = await ctx.db.system.get(recoveryId);
    if (!recovery) {
      return;
    }
    if (recovery.state.kind !== "pending") {
      return;
    }
    await ctx.scheduler.cancel(recoveryId);
  },
});
