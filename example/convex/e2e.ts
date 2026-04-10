/**
 * Public functions for e2e testing.
 * These expose workflow start/status/signal operations for use from a client.
 */
import { v } from "convex/values";
import {
  WorkflowManager,
  WorkflowStatus,
  vWorkflowId,
} from "@convex-dev/workflow";
import { mutation, query } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { myWorkflow } from "./example";
import { catchErrorWorkflow } from "./catchError";
import { parentWorkflow } from "./nestedWorkflow";
import { signalWorkflow } from "./passingSignals";
import { confirmationWorkflow } from "./userConfirmation";

const workflow = new WorkflowManager(components.workflow);

// Start various workflows and return their IDs
export const startAll = mutation({
  args: {},
  returns: v.object({
    weather: v.string(),
    catchError: v.string(),
    nested: v.string(),
    signals: v.string(),
    confirmation: v.string(),
  }),
  handler: async (ctx) => {
    const weather = await myWorkflow.start(
      ctx,
      { location: "San Jose" },
      { startAsync: true },
    );
    const catchError = await catchErrorWorkflow.start(
      ctx,
      { manualRetries: 2 },
      { startAsync: true },
    );
    const nested = await parentWorkflow.start(
      ctx,
      { prompt: "hello world" },
      { startAsync: true },
    );
    const signals = await signalWorkflow.start(ctx, {}, { startAsync: true });
    const confirmation = await confirmationWorkflow.start(
      ctx,
      { prompt: "test prompt" },
      { startAsync: true },
    );
    return { weather, catchError, nested, signals, confirmation };
  },
});

// Query status of all workflows at once
export const statusAll = query({
  args: {
    ids: v.object({
      weather: vWorkflowId,
      catchError: vWorkflowId,
      nested: vWorkflowId,
      signals: vWorkflowId,
      confirmation: vWorkflowId,
    }),
  },
  handler: async (ctx, { ids }): Promise<Record<string, WorkflowStatus>> => {
    const results: Record<string, WorkflowStatus> = {};
    for (const [name, id] of Object.entries(ids)) {
      results[name] = await workflow.status(ctx, id);
    }
    return results;
  },
});

// Approve the confirmation workflow (delegates to the existing chooseProposal mutation)
export const approveConfirmation = mutation({
  args: { workflowId: vWorkflowId },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    await ctx.runMutation(internal.userConfirmation.chooseProposal, {
      workflowId,
      choice: 1,
    });
  },
});
