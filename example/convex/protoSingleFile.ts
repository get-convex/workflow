/**
 * Test: Everything in one file.
 * Does .bind(internal.protoSingleFile.chargePayment) create circular types
 * when chargePayment is exported from the same file?
 *
 * Also tests: handler return type derived from ctx.runQuery(internal.*)
 */
import { v } from "convex/values";
import type {
  FunctionReference,
  RegisteredMutation,
  ReturnValueForOptionalValidator,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import { internalMutationGeneric } from "convex/server";
import type { ObjectType, PropertyValidators, Validator } from "convex/values";
import type {
  WorkflowCtx,
  WorkflowId,
  WorkflowStatus,
} from "@convex-dev/workflow";
import { internal } from "./_generated/api.js";

// ============================================================
// Types (same as protoShared)
// ============================================================

type RunQueryCtx = { runQuery: GenericQueryCtx<GenericDataModel>["runQuery"] };
type RunMutationCtx = {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
};

type MatchingRef<
  AV extends PropertyValidators,
  RV extends Validator<any, any, any> | PropertyValidators | void,
> = FunctionReference<
  "mutation",
  "internal",
  { fn: string; args: ObjectType<AV> },
  ReturnValueForOptionalValidator<RV>
>;

interface UnboundWorkflow<
  AV extends PropertyValidators,
  RV extends Validator<any, "required", any> | void,
> {
  handler(
    fn: (
      step: WorkflowCtx,
      args: ObjectType<AV>,
    ) => Promise<ReturnValueForOptionalValidator<RV>>,
  ): RegisteredMutation<
    "internal",
    { fn: string; args: ObjectType<AV> },
    ReturnValueForOptionalValidator<RV>
  >;
  bind(ref: MatchingRef<AV, RV>): BoundWorkflow<AV, RV>;
}

interface BoundWorkflow<
  AV extends PropertyValidators,
  RV extends Validator<any, "required", any> | void,
> {
  handler(
    fn: (
      step: WorkflowCtx,
      args: ObjectType<AV>,
    ) => Promise<ReturnValueForOptionalValidator<RV>>,
  ): RegisteredMutation<
    "internal",
    { fn: string; args: ObjectType<AV> },
    ReturnValueForOptionalValidator<RV>
  >;
  start(ctx: RunMutationCtx, args: ObjectType<AV>): Promise<WorkflowId>;
  status(ctx: RunQueryCtx, workflowId: WorkflowId): Promise<WorkflowStatus>;
}

declare function defineWorkflow<
  AV extends PropertyValidators,
  RV extends Validator<any, "required", any> | void = void,
>(config: { args: AV; returns?: RV }): UnboundWorkflow<AV, RV>;

// ============================================================
// Test 1: Single-file define + bind + handler
// ============================================================

export const paymentWorkflow = defineWorkflow({
  args: { amount: v.number(), currency: v.string() },
  returns: v.object({ receiptId: v.string(), charged: v.number() }),
}).bind(internal.protoSingleFile.chargePayment);

export const chargePayment = paymentWorkflow.handler(async (step, args) => {
  const charged = args.amount * 1.1;
  const receiptId = `receipt_${args.currency}_${charged}`;
  return { receiptId, charged };
});

// ============================================================
// Test 2: Handler return type depends on ctx.runQuery(internal.*)
// ============================================================

// A helper query exported from this same file
import { internalQuery } from "./_generated/server.js";

export const getPrice = internalQuery({
  args: { item: v.string() },
  returns: v.number(),
  handler: async (_ctx, _args) => {
    return 42;
  },
});

export const pricingWorkflow = defineWorkflow({
  args: { item: v.string() },
  returns: v.number(),
}).bind(internal.protoSingleFile.computePrice);

export const computePrice = pricingWorkflow.handler(async (step, args) => {
  // This calls internal.protoSingleFile.getPrice — from the SAME file.
  // The return type of runQuery should flow through.
  const price = await step.runQuery(internal.protoSingleFile.getPrice, {
    item: args.item,
  });
  // price should be typed as number
  return price * 2;
});

// ============================================================
// Test 3: Handler calls a function from a DIFFERENT file via internal.*
// ============================================================

export const crossFileWorkflow = defineWorkflow({
  args: { id: v.string() },
  returns: v.string(),
}).bind(internal.protoSingleFile.crossFileHandler);

export const crossFileHandler = crossFileWorkflow.handler(async (step, args) => {
  // Calls protoCaller.initiatePayment — a function from another file
  // This tests that internal refs to other files work in the handler
  const result = await step.runMutation(
    internal.protoCaller.initiatePayment,
    { amount: 100, currency: "USD" },
  );
  // result type comes from the other file's return type
  return String(result);
});

// ============================================================
// Usage in same file
// ============================================================

import { internalMutation } from "./_generated/server.js";

export const doPayment = internalMutation({
  args: { amount: v.number(), currency: v.string() },
  handler: async (ctx, args) => {
    const id = await paymentWorkflow.start(ctx, args);
    return id;
  },
});
