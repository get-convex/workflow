import { describe, expect, test } from "vitest";
import {
  DEFAULT_ACTION_EXECUTION_BUDGET_MS,
  MAX_ACTION_EXECUTION_BUDGET_MS,
  normalizeExecutionMode,
} from "./execution.js";

describe("normalizeExecutionMode", () => {
  test("uses the default step-start budget for action mode", () => {
    expect(normalizeExecutionMode("action")).toEqual({
      type: "action",
      maxDurationMs: DEFAULT_ACTION_EXECUTION_BUDGET_MS,
    });
  });

  test("maps the public step-start budget to the persisted execution shape", () => {
    expect(
      normalizeExecutionMode({
        type: "action",
        stepStartBudgetMs: 10 * 60_000,
      }),
    ).toEqual({ type: "action", maxDurationMs: 10 * 60_000 });
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid step-start budget %s",
    (stepStartBudgetMs) => {
      expect(() =>
        normalizeExecutionMode({ type: "action", stepStartBudgetMs }),
      ).toThrow("stepStartBudgetMs must be greater than 0");
    },
  );

  test("rejects a step-start budget above the action limit", () => {
    expect(() =>
      normalizeExecutionMode({
        type: "action",
        stepStartBudgetMs: MAX_ACTION_EXECUTION_BUDGET_MS + 1,
      }),
    ).toThrow(`at most ${MAX_ACTION_EXECUTION_BUDGET_MS}`);
  });
});
