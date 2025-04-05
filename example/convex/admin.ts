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
    workflowId: v.optional(vWorkflowId),
  },
  handler: async (ctx, args) => {
    const workflowId = args.workflowId;
    const flow = await (workflowId
      ? ctx.db
          .query("flows")
          .withIndex("workflowId", (q) => q.eq("workflowId", workflowId))
          .first()
      : ctx.db.query("flows").order("desc").first());
    if (!flow) {
      throw new Error(`Flow not found: ${workflowId}`);
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
