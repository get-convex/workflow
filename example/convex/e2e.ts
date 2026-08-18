/**
 * Public functions for e2e testing.
 * These expose workflow start/status/signal operations for use from a client.
 */
import { v } from "convex/values";
import {
  getStatus,
  WorkflowId,
  WorkflowManager,
  WorkflowStatus,
  vWorkflowId,
} from "@convex-dev/workflow";
import { mutation, query } from "./_generated/server";
import { components, internal } from "./_generated/api";

const workflow = new WorkflowManager(components.workflow);

// Start various workflows and return their IDs
export const startAll = mutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    weather: WorkflowId;
    catchError: WorkflowId;
    nested: WorkflowId;
    signals: WorkflowId;
    confirmation: WorkflowId;
  }> => {
    const weather = await workflow.start(
      ctx,
      internal.example.myWorkflow,
      { location: "San Jose" },
      { startAsync: true, executionMode: "action" },
    );
    const catchError = await workflow.start(
      ctx,
      internal.catchError.catchErrorWorkflow,
      { manualRetries: 2 },
      { startAsync: true, executionMode: "action" },
    );
    const nested = await workflow.start(
      ctx,
      internal.nestedWorkflow.parentWorkflow,
      { prompt: "hello world" },
      { startAsync: true, executionMode: "action" },
    );
    const signals = await workflow.start(
      ctx,
      internal.passingSignals.signalWorkflow,
      {},
      { startAsync: true, executionMode: "action" },
    );
    const confirmation = await workflow.start(
      ctx,
      internal.userConfirmation.confirmationWorkflow,
      { prompt: "test prompt" },
      { startAsync: true, executionMode: "action" },
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
      results[name] = await getStatus(ctx, components.workflow, id);
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
