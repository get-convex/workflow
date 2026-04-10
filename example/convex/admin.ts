import { v } from "convex/values";
import { cancel, getStatus, vWorkflowId } from "@convex-dev/workflow";
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";

export const getWorkflowStatus = query({
  args: {
    workflowId: vWorkflowId,
  },
  handler: async (ctx, args) => {
    return await getStatus(ctx, components.workflow, args.workflowId);
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
    workflowId: vWorkflowId,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    return cancel(ctx, components.workflow, args.workflowId);
  },
});
