import { RunResult, WorkId } from "@convex-dev/workpool";
import { Expand, FunctionReference } from "convex/server";
import { GenericId, v, VString } from "convex/values";

export type WorkflowId = string & { __isWorkflowId: true };
export const vWorkflowId = v.string() as VString<WorkflowId>;

export type UseApi<API> = Expand<{
  [mod in keyof API]: API[mod] extends FunctionReference<
    infer FType,
    "public",
    infer FArgs,
    infer FReturnType,
    infer FComponentPath
  >
    ? FunctionReference<
        FType,
        "internal",
        OpaqueIds<FArgs>,
        OpaqueIds<FReturnType>,
        FComponentPath
      >
    : UseApi<API[mod]>;
}>;

export type OpaqueIds<T> =
  T extends GenericId<infer _T>
    ? string
    : T extends WorkId
      ? string
      : T extends (infer U)[]
        ? OpaqueIds<U>[]
        : T extends object
          ? { [K in keyof T]: OpaqueIds<T[K]> }
          : T;
export type OnCompleteArgs = {
  /**
   * The ID of the work that completed.
   */
  workflowId: WorkflowId;
  /**
   * The context object passed when enqueuing the work.
   * Useful for passing data from the enqueue site to the onComplete site.
   */
  context: unknown;
  /**
   * The result of the run that completed.
   */
  result: RunResult;
};
