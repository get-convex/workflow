import { Expand, FunctionReference } from "convex/server";
import { GenericId, Infer, v } from "convex/values";

export type Result<T> =
  | { type: "success"; result: T }
  | { type: "error"; error: string };

export type WorkflowId<T> = string & { __workflowReturns: T };

export const functionType = v.union(
  v.object({ type: v.literal("query") }),
  v.object({ type: v.literal("mutation") }),
  v.object({ type: v.literal("action") }),
);
export type FunctionType = Infer<typeof functionType>;

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

type OpaqueIds<T> =
  T extends GenericId<infer _T>
    ? string
    : T extends (infer U)[]
      ? OpaqueIds<U>[]
      : T extends object
        ? { [K in keyof T]: OpaqueIds<T[K]> }
        : T;
