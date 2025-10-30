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
