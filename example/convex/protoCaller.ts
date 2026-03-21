/**
 * Cross-file test: usage file.
 * Imports the bound workflow — .start()/.status() just work.
 */
import { paymentWorkflow } from "./protoShared.js";
import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";
import { vWorkflowId } from "@convex-dev/workflow";

export const initiatePayment = internalMutation({
  args: { amount: v.number(), currency: v.string() },
  handler: async (ctx, args) => {
    const id = await paymentWorkflow.start(ctx, {
      amount: args.amount,
      currency: args.currency,
    });
    return id;
  },
});

export const checkPayment = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    const status = await paymentWorkflow.status(ctx, args.workflowId);
    return status;
  },
});

// ---- Negative tests ----

export const badStart = internalMutation({
  args: {},
  handler: async (ctx) => {
    // @ts-expect-error — missing currency
    await paymentWorkflow.start(ctx, { amount: 100 });
  },
});
