import { defineWorkflow } from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";

export const alwaysFails = internalAction({
  args: {},
  returns: v.null(),
  handler: async (_ctx, _args) => {
    throw new Error("This action always fails for testing");
  },
});

export const catchErrorWorkflow = defineWorkflow(components.workflow, {
  args: { manualRetries: v.number() },
  returns: v.number(),
}).bind(internal.catchError.catchError);

export const catchError = catchErrorWorkflow.handler(
  async (step, args): Promise<number> => {
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
);
