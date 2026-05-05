import { v } from "convex/values";
import { vWorkflowId } from "@convex-dev/workflow";
import { vResultValidator } from "@convex-dev/workpool";
import { internalMutation } from "../_generated/server.js";
import { workflow } from "../example.js";

export const throwingWorkflow = workflow
  .define({
    args: {},
  })
  .handler(async () => {
    throw new Error("intentional failure");
  });

// onComplete that captures both the result and the received context, so tests
// can verify the context round-trips through every failure path.
export const captureOnComplete = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const flow = await ctx.db
      .query("flows")
      .withIndex("workflowId", (q) => q.eq("workflowId", args.workflowId))
      .first();
    if (!flow) return null;
    await ctx.db.patch("flows", flow._id, {
      out: { result: args.result, capturedContext: args.context },
    });
    return null;
  },
});
