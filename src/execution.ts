import { v, type Infer } from "convex/values";

export const DEFAULT_ACTION_EXECUTION_BUDGET_MS = 5 * 60 * 1000;
export const MAX_ACTION_EXECUTION_BUDGET_MS = 30 * 60 * 1000;

export type ExecutionMode =
  | "mutation"
  | "action"
  | {
      type: "action";
      /**
       * How long each action runner may start new steps before the workflow
       * continues in a fresh runner. This is not a timeout for started steps.
       */
      stepStartBudgetMs?: number;
    };

export const vExecutionMode = v.union(
  v.literal("mutation"),
  v.literal("action"),
  v.object({
    type: v.literal("action"),
    stepStartBudgetMs: v.optional(v.number()),
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
  const stepStartBudgetMs =
    executionMode === "action"
      ? DEFAULT_ACTION_EXECUTION_BUDGET_MS
      : (executionMode.stepStartBudgetMs ?? DEFAULT_ACTION_EXECUTION_BUDGET_MS);
  if (
    !Number.isFinite(stepStartBudgetMs) ||
    stepStartBudgetMs <= 0 ||
    stepStartBudgetMs > MAX_ACTION_EXECUTION_BUDGET_MS
  ) {
    throw new Error(
      `Action execution stepStartBudgetMs must be greater than 0 and at most ${MAX_ACTION_EXECUTION_BUDGET_MS}.`,
    );
  }
  // Keep the persisted representation internal so existing workflow documents
  // remain schema-compatible while the public option names its actual role.
  return { type: "action", maxDurationMs: stepStartBudgetMs };
}
