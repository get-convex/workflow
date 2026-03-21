/**
 * Cross-file test: shared workflow definition + binding.
 *
 * The ref is set HERE (at the definition site), not in the handler file.
 * This ensures .start() always works regardless of import order.
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

// ---- Unbound: has .handler() and .bind(), but no .start() ----

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

  /** Bind to a function reference. Returns a BoundWorkflow with .start()/.status(). */
  bind(ref: MatchingRef<AV, RV>): BoundWorkflow<AV, RV>;
}

// ---- Bound: has .handler(), .start(), .status() ----

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

function defineWorkflow<
  AV extends PropertyValidators,
  RV extends Validator<any, "required", any> | void = void,
>(config: { args: AV; returns?: RV }): UnboundWorkflow<AV, RV> {
  function makeHandler(fn: any) {
    return internalMutationGeneric({
      handler: async (ctx: any, args: any) => fn({} as any, args),
    }) as any;
  }
  return {
    handler: makeHandler,
    bind(ref) {
      return {
        handler: makeHandler,
        start(_ctx, _args) {
          // Real impl would use ref to start the workflow
          return null as any;
        },
        status(_ctx, _workflowId) {
          return null as any;
        },
      };
    },
  };
}

// ============================================================
// Definition + binding in one place
// ============================================================

export const paymentWorkflow = defineWorkflow({
  args: { amount: v.number(), currency: v.string() },
  returns: v.object({ receiptId: v.string(), charged: v.number() }),
}).bind(internal.protoHandler.chargePayment);

// .start() is available because .bind() was called ✅
// If you forget .bind(), TypeScript won't let you call .start()
