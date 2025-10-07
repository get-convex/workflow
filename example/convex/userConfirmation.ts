import { defineEvent, vWorkflowId } from "@convex-dev/workflow";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, mutation } from "./_generated/server";
import { workflow } from "./example";

const approvalEvent = defineEvent({
  name: "approval",
  validator: v.union(
    v.object({ approved: v.literal(true), choice: v.number() }),
    v.object({ approved: v.literal(false), reason: v.string() }),
  ),
});

export const confirmationWorkflow = workflow.define({
  args: { prompt: v.string() },
  returns: v.string(),
  handler: async (step, args): Promise<string> => {
    const proposals = await step.runAction(
      internal.userConfirmation.generateProposals,
      { prompt: args.prompt },
      { retry: true },
    );
    const approval = await step.awaitEvent(approvalEvent);
    if (!approval.approved) {
      return "rejected: " + approval.reason;
    }
    const choice = proposals[approval.choice];
    return choice;
  },
});

export const generateProposals = internalAction({
  args: { prompt: v.string() },
  handler: async (_ctx, _args) => {
    // imagine this is a call to an LLM
    return ["proposal1", "proposal2", "proposal3"];
  },
});

export const chooseProposal = mutation({
  args: { workflowId: vWorkflowId, choice: v.number() },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, args.workflowId, approvalEvent, {
      approved: true,
      choice: args.choice,
    });
    return true;
  },
});
