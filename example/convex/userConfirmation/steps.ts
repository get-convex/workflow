import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { workflow } from "../example";
import { vWorkflowId, defineEvent } from "@convex-dev/workflow";

export const approvalEvent = defineEvent({
  name: "approval",
  validator: v.union(
    v.object({ approved: v.literal(true), choice: v.number() }),
    v.object({ approved: v.literal(false), reason: v.string() }),
  ),
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
    await workflow.sendEvent(ctx, args.workflowId, approvalEvent, {
      approved: true,
      choice: args.choice,
    });
    return true;
  },
});
