/**
 * Cross-file test: handler file.
 * Just exports the handler — no .bind() needed here.
 */
import { paymentWorkflow } from "./protoShared.js";

export const chargePayment = paymentWorkflow.handler(async (step, args) => {
  // ✅ args typed as { amount: number; currency: string }
  const charged = args.amount * 1.1;
  const receiptId = `receipt_${args.currency}_${charged}`;
  // ✅ return type enforced: { receiptId: string; charged: number }
  return { receiptId, charged };
});
