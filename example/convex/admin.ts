import { v } from "convex/values";
import { WorkflowId } from "../../src/types";
import { mutation, query } from "./_generated/server";
import { workflow } from ".";
import { internal } from "./_generated/api";

export const kickoffWorkflow = mutation({
  args: {
    storageId: v.id("_storage"),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const workflowId: string = await workflow.start(
      ctx,
      internal.index.exampleWorkflow,
      { storageId: args.storageId },
    );
    return workflowId;
  },
});

export const getWorkflowStatus = query({
  args: {
    workflowId: v.string(),
  },
  handler: async (ctx, args) => {
    return await workflow.status(ctx, args.workflowId as WorkflowId);
  },
});

export const cancelWorkflow = mutation({
  args: {
    workflowId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    return await workflow.cancel(ctx, args.workflowId as WorkflowId);
  },
});
