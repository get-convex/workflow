import { v } from "convex/values";
import { anyApi, type ApiFromModules } from "convex/server";
import { workflow } from "../example";
import { approvalEvent } from "./steps";

// This allows us to scope an `internal` object to just the steps file,
// breaking circular dependency issues.
const steps = (
  anyApi as unknown as ApiFromModules<{
    "userConfirmation/steps": typeof import("./steps");
  }>
).userConfirmation.steps;

export const confirmationWorkflow = workflow.define({
  args: { prompt: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const proposals = await ctx.runAction(
      steps.generateProposals,
      { prompt: args.prompt },
      { retry: true },
    );
    const approval = await ctx.awaitEvent(approvalEvent);
    if (!approval.approved) {
      return "rejected: " + approval.reason;
    }
    const choice = proposals[approval.choice];
    return choice;
  },
});
