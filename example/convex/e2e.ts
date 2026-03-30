/**
 * Public functions for e2e testing.
 * These expose workflow start/status/signal operations for use from a client.
 */
import { v } from "convex/values";
import { WorkflowId, WorkflowStatus, vWorkflowId } from "@convex-dev/workflow";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { workflow } from "./example";

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
    const weather: WorkflowId = await workflow.start(
      ctx,
      internal.example.exampleWorkflow,
      { location: "San Jose" },
      { startAsync: true },
    );
    const catchError: WorkflowId = await workflow.start(
      ctx,
      internal.catchError.catchErrorWorkflow,
      { manualRetries: 2 },
      { startAsync: true },
    );
    const nested: WorkflowId = await workflow.start(
      ctx,
      internal.nestedWorkflow.parentWorkflow,
      { prompt: "hello world" },
      { startAsync: true },
    );
    const signals: WorkflowId = await workflow.start(
      ctx,
      internal.passingSignals.signalBasedWorkflow,
      {},
      { startAsync: true },
    );
    const confirmation: WorkflowId = await workflow.start(
      ctx,
      internal.userConfirmation.confirmationWorkflow,
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
