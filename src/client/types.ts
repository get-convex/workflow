import type {
  FunctionArgs,
  FunctionHandle,
  FunctionReference,
} from "convex/server";
import type {
  GenericId,
  Infer,
  ObjectType,
  PropertyValidators,
  Validator,
  Value,
} from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import type { OnCompleteArgs } from "../types.js";

export type WorkflowComponent = ComponentApi;

export type WorkflowArgs<
  V extends PropertyValidators,
  Context = unknown,
  Returns = unknown,
> = {
  /**
   * The arguments to pass to the Workflow handler.
   */
  args: ObjectType<V>;
  /**
   * Whether to enqueue the Workflow for asynchronous execution only.
   * By default it will start evaluating the handler's first step in the
   * current transaction.
   */
  startAsync?: boolean;
  /**
   * @deprecated Not an input. Only present to carry the workflow's return type,
   * so a parent workflow's `runWorkflow` can recover it. Passing a value throws.
   */
  result?: Returns;
} & (
  | {
      /**
       * A function handle (created with createFunctionHandle) that will be
       * called when the Workflow completes.
       */
      onComplete: FunctionHandle<"mutation", OnCompleteArgs<Context>>;
      /**
       * Context forwarded to the `onComplete` mutation.
       */
      context: Context;
    }
  | {
      onComplete?: undefined;
      context?: undefined;
    }
);

/**
 * The value a workflow handler resolves to, according to its `returns`
 * validator. Defaults to `unknown` if the workflow has no `returns` validator.
 */
export type InferFromOptionalValidator<ReturnsValidator> = [
  ReturnsValidator,
] extends [Validator<any, any, any>]
  ? Infer<ReturnsValidator>
  : unknown;

/**
 * Recover a workflow's return type from its function reference.
 *
 * The mutation itself resolves to a `WorkflowId`, so the return type rides
 * along in the args type (see `result` above) and is read back out here.
 */
export type WorkflowReturnType<
  Workflow extends FunctionReference<"mutation", any, any>,
> =
  FunctionArgs<Workflow> extends WorkflowArgs<any, any, infer Returns>
    ? Returns
    : unknown;

export type IdsToStrings<T> =
  T extends GenericId<string>
    ? string
    : T extends (infer U)[]
      ? IdsToStrings<U>[]
      : T extends Record<string, Value | undefined>
        ? { [K in keyof T]: IdsToStrings<T[K]> }
        : T;

/**
 * Per-transaction resource limits for an inline query or mutation.
 *
 * When passed to an inline `runQuery`/`runMutation` step, these caps are
 * enforced on that step's transaction; exceeding any of them throws an error
 * (which is catchable in the workflow handler, like any other step failure).
 *
 * **Requires Convex >= 1.41.** On older versions this option is ignored / not
 * supported by the running backend. Only applies to `inline` steps.
 */
export interface TransactionLimits {
  bytesRead?: number;
  bytesWritten?: number;
  databaseQueries?: number;
  documentsRead?: number;
  documentsWritten?: number;
  functionsScheduled?: number;
  scheduledFunctionArgsBytes?: number;
}
