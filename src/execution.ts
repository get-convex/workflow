import { v, type Infer } from "convex/values";

export const DEFAULT_ACTION_EXECUTION_BUDGET_MS = 5 * 60 * 1000;
export const MAX_ACTION_EXECUTION_BUDGET_MS = 30 * 60 * 1000;

export type ExecutionMode =
  | "mutation"
  | "action"
  | {
      type: "action";
      maxDurationMs?: number;
    };

export const vExecutionMode = v.union(
  v.literal("mutation"),
  v.literal("action"),
  v.object({
    type: v.literal("action"),
    maxDurationMs: v.optional(v.number()),
  }),
);

export const vActionExecution = v.object({
  type: v.literal("action"),
  maxDurationMs: v.number(),
});

export type ActionExecution = Infer<typeof vActionExecution>;

export function normalizeExecutionMode(
  executionMode: ExecutionMode | undefined,
): ActionExecution | undefined {
  if (executionMode === undefined || executionMode === "mutation") {
    return undefined;
  }
  const maxDurationMs =
    executionMode === "action"
      ? DEFAULT_ACTION_EXECUTION_BUDGET_MS
      : (executionMode.maxDurationMs ?? DEFAULT_ACTION_EXECUTION_BUDGET_MS);
  if (
    !Number.isFinite(maxDurationMs) ||
    maxDurationMs <= 0 ||
    maxDurationMs > MAX_ACTION_EXECUTION_BUDGET_MS
  ) {
    throw new Error(
      `Action execution maxDurationMs must be greater than 0 and at most ${MAX_ACTION_EXECUTION_BUDGET_MS}.`,
    );
  }
  return { type: "action", maxDurationMs };
}
