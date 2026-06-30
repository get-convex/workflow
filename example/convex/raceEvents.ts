import {
  defineEvent,
  vOnComplete,
  vWorkflowId,
  WorkflowManager,
} from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { literals } from "convex-helpers/validators";

const workflow = new WorkflowManager(components.workflow);

const proposals = {
  A: "Proposal A",
  B: "Proposal B",
  C: "Proposal C",
};
const vProposal = literals("A", "B", "C");
export const approvalEvent = defineEvent({
  name: "approval",
  validator: v.object({ proposal: vProposal }),
});
export const rejectionEvent = defineEvent({
  name: "rejection",
  validator: v.object({ reason: v.string() }),
});

export const raceExample = workflow.define({
  args: {},
  returns: v.string(),
  handler: async (step): Promise<string> => {
    const result = await step.raceEvents([approvalEvent, rejectionEvent], {
      name: "waitForDecision",
      timeout: 15 * 60 * 1000, // 15 minutes
    });

    switch (result.name) {
      case "approval": {
        return `Approved. Selected: ${proposals[result.value.proposal]}`;
      }
      case "rejection": {
        const val = result.value;
        return `Rejected: ${val.reason}`;
      }
    }
  },
});

export const sendApproval = internalMutation({
  args: { workflowId: vWorkflowId, proposal: vProposal },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      ...approvalEvent,
      workflowId: args.workflowId,
      value: { proposal: args.proposal },
    });
  },
});
export const sendRejection = internalMutation({
  args: { workflowId: vWorkflowId, reason: v.string() },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      ...rejectionEvent,
      workflowId: args.workflowId,
      value: { reason: args.reason },
    });
  },
});

export const startWorkflow = internalMutation({
  args: {},
  handler: async (ctx) => {
    const id = await workflow.start(
      ctx,
      internal.raceEvents.raceExample,
      {},
      {
        context: {},
        onComplete: internal.raceEvents.completeWorkflow,
      },
    );
    await ctx.db.insert("flows", { workflowId: id, in: "", out: null });
  },
});
export const completeWorkflow = internalMutation({
  args: vOnComplete(v.any()),
  handler: async (ctx, args): Promise<void> => {
    const flow = await ctx.db
      .query("flows")
      .withIndex("workflowId", (q) => q.eq("workflowId", args.workflowId))
      .first();
    if (!flow) {
      throw new Error(`Flow not found: ${args.workflowId}`);
    }
    await ctx.db.patch("flows", flow._id, { out: args.result });
  },
});

export const raceWithoutValidators = workflow.define({
  args: {},
  returns: v.string(),
  handler: async (step): Promise<string> => {
    const result = await step.raceEvents([{ name: "go" }, { name: "stop" }]);
    if (result.name === "go") {
      return "Proceeding";
    }
    return "Stopped";
  },
});
export const sendGo = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      name: "go",
      workflowId: args.workflowId,
    });
  },
});
export const sendStop = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      name: "stop",
      workflowId: args.workflowId,
    });
  },
});
