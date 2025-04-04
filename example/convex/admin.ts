import { v } from "convex/values";
import { WorkflowId, vWorkflowId } from "@convex-dev/workflow";
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

export const getWorkflowResult = query({
  args: {
    workflowId: vWorkflowId,
  },
  handler: async (ctx, args) => {
    const flow = await ctx.db
      .query("flows")
      .withIndex("workflowId", (q) => q.eq("workflowId", args.workflowId))
      .first();
    if (!flow) {
      throw new Error(`Flow not found: ${args.workflowId}`);
    }
    return flow.out;
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
