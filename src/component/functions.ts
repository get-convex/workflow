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
import { logLevel, outcome, valueSize } from "./schema.js";
import { createLogger } from "./utils.js";

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
    const workflow = await getWorkflow(
      ctx,
      args.workflowId,
      args.generationNumber,
    );
    const logger = createLogger(workflow.logLevel);

    const journalEntry = await getJournalEntry(ctx, args.journalId);
    if (journalEntry.step.type !== "function") {
      throw new Error(`Journal entry not a function: ${args.journalId}`);
    }
    if (!journalEntry.step.inProgress) {
      throw new Error(`Journal entry not in progress: ${args.journalId}`);
    }
    const runId = await ctx.scheduler.runAfter(0, internal.functions.run, {
      workflowId: args.workflowId,
      logLevel: workflow.logLevel,
      generationNumber: args.generationNumber,
      journalId: args.journalId,
      functionType: journalEntry.step.functionType,
      handle: journalEntry.step.handle,
      args: journalEntry.step.args,
    });
    logger.debug(
      `Starting function run for journal entry @ ${runId}`,
      journalEntry,
    );
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
      logger.debug(
        `Scheduling recovery for ${runId} in ${HEARTBEAT_INTERVAL_MS}ms @ ${recoveryId}`,
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
    const logger = createLogger(workflow.logLevel);

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
    logger.debug("Checking recovery", workflow, journalEntry);

    // The system will *eventually* fail in progress actions that fail either due to
    // (1) a system error or (2) an infrastructural timeout. So, we won't try to detect
    // this condition here. Instead, we'll look for a failed (or canceled) state that
    // doesn't have the outcome set in the journal.
    if (!step.inProgress && step.outcome) {
      logger.info(`Step completed, skipping recovery.`);
      return;
    }

    const runState = await ctx.db.system.get(args.runId);
    if (!runState) {
      logger.info(`Run state not found, skipping recovery.`);
      return;
    }
    logger.debug(
      `Current run state for ${args.journalId} @ ${args.runId}`,
      runState,
    );

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
      logger.debug(
        `Scheduling next recovery check in ${HEARTBEAT_INTERVAL_MS}ms @ ${nextRecoveryId}`,
      );
      step.functionType.recoveryId = nextRecoveryId;
      await ctx.db.replace(journalEntry._id, journalEntry);
      return;
    }

    // Fail the action and continue.
    logger.error(
      `Failing action run for ${args.journalId} that's not longer in progress.`,
    );
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
    logLevel,
    generationNumber: v.number(),
    journalId: v.string(),

    functionType,
    handle: v.string(),
    args: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const logger = createLogger(args.logLevel);
    let outcome: Result<any>;
    const runner: any = {
      query: ctx.runQuery,
      mutation: ctx.runMutation,
      action: ctx.runAction,
    }[args.functionType.type];
    if (!runner) {
      throw new Error(`Invalid function type: ${args.functionType.type}`);
    }
    const start = Date.now();
    try {
      logger.debug(
        `Starting execution of ${args.handle} for ${args.journalId}`,
        args.args,
      );
      const result = await runner(
        args.handle as FunctionHandle<any, any>,
        args.args,
      );
      const resultSize = valueSize(result);
      const duration = Date.now() - start;
      logger.debug(
        `Completed executing ${args.journalId} (${duration.toFixed(2)}ms): ${resultSize} bytes returned`,
        result,
      );
      outcome = { type: "success", result, resultSize };
    } catch (error: any) {
      const duration = Date.now() - start;
      logger.error(
        `Failed executing ${args.journalId} (${duration.toFixed(2)}ms): ${error.message}`,
      );
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
    const logger = createLogger(workflow.logLevel);

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
    logger.debug(`Completed execution of ${args.journalId}`, journalEntry);

    // Best effort cancel any scheduled recovery to save on function calls.
    if (journalEntry.step.functionType.type !== "action") {
      logger.debug(
        `${args.journalId} not an action, skipping recovery cancelation`,
      );
      return;
    }
    const recoveryIdStr = journalEntry.step.functionType.recoveryId;
    if (!recoveryIdStr) {
      logger.debug(`${args.journalId} missing recovery ID: ${recoveryIdStr}`);
      return;
    }
    const recoveryId = ctx.db.system.normalizeId(
      "_scheduled_functions",
      recoveryIdStr,
    );
    if (!recoveryId) {
      logger.debug(`${args.journalId}'s recovery ID is invalid: ${recoveryId}`);
      return;
    }
    const recovery = await ctx.db.system.get(recoveryId);
    if (!recovery) {
      logger.debug(
        `Can't find ${args.journalId}'s recovery ID in scheduler: ${recoveryId}`,
      );
      return;
    }
    if (recovery.state.kind !== "pending") {
      logger.debug(`${args.journalId}'s recovery isn't pending`, recovery);
      return;
    }
    logger.debug(`Canceling ${args.journalId}'s recovery @ ${recoveryId}`);
    await ctx.scheduler.cancel(recoveryId);
  },
});
