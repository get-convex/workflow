import {
  defineEvent,
  vWorkflowId,
  WorkflowManager,
} from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";

export const approvalEvent = defineEvent({
  name: "approval",
  validator: v.union(
    v.object({ approved: v.literal(true), choice: v.number() }),
    v.object({ approved: v.literal(false), reason: v.string() }),
  ),
});

const workflow = new WorkflowManager(components.workflow);

export const confirmationWorkflow = workflow.define({
  args: { prompt: v.string() },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    console.log("Starting confirmation workflow");
    const proposals = await ctx.runAction(
      internal.userConfirmation.generateProposals,
      { prompt: args.prompt },
      { retry: true },
    );
    console.log("Proposals generated", proposals);
    const approval = await ctx.awaitEvent(approvalEvent);
    if (!approval.approved) {
      return "rejected: " + approval.reason;
    }
    const choice = proposals[approval.choice];
    console.log("Choice selected", choice);
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

export const chooseProposal = internalMutation({
  args: { workflowId: vWorkflowId, choice: v.number() },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      ...approvalEvent,
      workflowId: args.workflowId,
      value: { approved: true, choice: args.choice },
    });
    return true;
  },
});
