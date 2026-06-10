import type { ComponentApi } from "../component/_generated/component.js";
import type { GenericId, Value } from "convex/values";

export type WorkflowComponent = ComponentApi;

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
