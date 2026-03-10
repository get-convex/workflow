import { v } from "convex/values";
import { WorkflowId } from "@convex-dev/workflow";
import { internal } from "./_generated/api.js";
import { internalAction, internalMutation } from "./_generated/server.js";
import { workflow } from "./example.js";

export const alwaysFails = internalAction({
  args: {},
  returns: v.null(),
  handler: async (_ctx, _args) => {
    throw new Error("This action always fails for testing");
  },
});

export const catchErrorWorkflow = workflow.define({
  args: { manualRetries: v.number() },
  returns: v.number(),
  handler: async (step, args): Promise<number> => {
    let i;
    for (i = 0; i < args.manualRetries + 1; i++) {
      try {
        await step.runAction(internal.catchError.alwaysFails, {});
        return i;
      } catch (e) {
        if (e instanceof Error) {
          console.error(e.name, e.message, e.stack);
        } else {
          console.error("Caught error in workflow handler:", e);
        }
      }
    }
    return i;
  },
});

export const start = internalMutation({
  args: { manualRetries: v.optional(v.number()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const id: WorkflowId = await workflow.start(
      ctx,
      internal.catchError.catchErrorWorkflow,
      { manualRetries: args.manualRetries ?? 0 },
    );
    return id;
  },
});
