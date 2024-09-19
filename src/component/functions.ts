import { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { functionType, Result } from "../types.js";
import { internal } from "./_generated/api.js";
import {
  mutation,
  internalMutation,
  internalAction,
} from "./_generated/server.js";
import { getJournalEntry, getWorkflow } from "./model.js";
import { outcome, valueSize } from "./schema.js";

const HEARTBEAT_INTERVAL_MS = 10 * 1000;

export const start = mutation({
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
    const runId = await ctx.scheduler.runAfter(0, internal.functions.run, {
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
        internal.functions.recover,
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

export const recover = internalMutation({
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
        internal.functions.recover,
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

    await ctx.runMutation(internal.functions.complete, {
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

export const run = internalAction({
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
      const resultSize = valueSize(result);
      outcome = { type: "success", result, resultSize };
    } catch (error: any) {
      outcome = { type: "error", error: error.message };
    }
    await ctx.runMutation(internal.functions.complete, {
      workflowId: args.workflowId,
      generationNumber: args.generationNumber,
      journalId: args.journalId,
      outcome,
    });
  },
});

export const complete = internalMutation({
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
