import { v } from "convex/values";
import { WorkflowId } from "@convex-dev/workflow";
import { mutation, query } from "./_generated/server";
import { workflow } from "./example";

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
