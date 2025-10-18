import type { Expand, FunctionReference } from "convex/server";
import type { api } from "../component/_generated/api.js";
import type { GenericId } from "convex/values";

export type WorkflowComponent = UseApi<typeof api>;

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
    : T extends string
      ? `${T}` extends T
        ? T
        : string
      : T extends (infer U)[]
        ? OpaqueIds<U>[]
        : T extends ArrayBuffer
          ? ArrayBuffer
          : T extends object
            ? { [K in keyof T]: OpaqueIds<T[K]> }
            : T;
