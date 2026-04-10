import {
  defineEvent,
  sendEvent,
  vWorkflowId,
  WorkflowId,
} from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { workflow } from "./example";

export const approvalEvent = defineEvent({
  name: "approval",
  validator: v.union(
    v.object({ approved: v.literal(true), choice: v.number() }),
    v.object({ approved: v.literal(false), reason: v.string() }),
  ),
});

export const confirmationWorkflow = workflow
  .define({
    args: { prompt: v.string() },
    returns: v.string(),
  })
  .handler(async (step, args): Promise<string> => {
    console.log("Starting confirmation workflow");
    const proposals = await step.runAction(
      internal.userConfirmation.generateProposals,
      { prompt: args.prompt },
      { retry: true },
    );
    console.log("Proposals generated", proposals);
    const approval = await step.awaitEvent(approvalEvent);
    if (!approval.approved) {
      return "rejected: " + approval.reason;
    }
    const choice = proposals[approval.choice];
    console.log("Choice selected", choice);
    return choice;
  });

export const generateProposals = internalAction({
  args: { prompt: v.string() },
  handler: async () => {
    // imagine this is a call to an LLM
    return ["proposal1", "proposal2", "proposal3"];
  },
});

export const chooseProposal = internalMutation({
  args: { workflowId: vWorkflowId, choice: v.number() },
  handler: async (ctx, args) => {
    await sendEvent(ctx, components.workflow, {
      ...approvalEvent,
      workflowId: args.workflowId,
      value: { approved: true, choice: args.choice },
    });
    return true;
  },
});

/**
 * Test this from the CLI:
 * ```sh
 * npx convex run userConfirmation:startConfirmationWorkflow
 * ```
 * Copy the ID it returns, then run:
 * ```sh
 * npx convex run userConfirmation:chooseProposal '{workflowId:"...", choice:1}'
 * ```
 * Watch the logs from `npx convex dev` or `npx convex logs` to see progress.
 */
export const startConfirmationWorkflow = internalMutation({
  args: { prompt: v.optional(v.string()) },
  handler: async (ctx, args): Promise<WorkflowId> => {
    return await workflow.start(
      ctx,
      internal.userConfirmation.confirmationWorkflow,
      { prompt: args.prompt ?? "Generate a recipe for me" },
    );
  },
});
