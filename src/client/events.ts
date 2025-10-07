import type { EventId, EventSpec, VEventId } from "../types.js";
import { v, type Infer, type Validator } from "convex/values";

/**
 * Define a named event with a validator.
 * @param spec - The event spec.
 * @returns Utility functions to specify type-safe events and results.
 */
export function defineEvent<
  Name extends string,
  V extends Validator<any, any, any>,
>(spec: {
  name: Name;
  validator?: V;
}): EventSpec<Name, Infer<V>> & {
  /**
   * A validator for the named event ID.
   */
  vEventId: VEventId<Name>;
  /**
   * Use this to provide an ID to `awaitEvent` or `sendEvent`.
   */
  withId: (id: EventId<Name>) => EventSpec<Name, Infer<V>>;
} {
  return {
    ...spec,
    withId: (id: EventId<Name>) => ({ ...spec, id }),
    vEventId: v.string() as VEventId<Name>,
  };
}

export type TypedRunResult<T> =
  | { kind: "success"; returnValue: T }
  | { kind: "failed"; error: string }
  | { kind: "canceled" };
