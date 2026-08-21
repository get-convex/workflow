import { describe, expect, test } from "vitest";
import {
  DEFAULT_ACTION_EXECUTION_BUDGET_MS,
  MAX_ACTION_EXECUTION_BUDGET_MS,
  normalizeExecutionMode,
} from "./execution.js";

describe("normalizeExecutionMode", () => {
  test("uses the default continuous soft limit for action mode", () => {
    expect(normalizeExecutionMode("action")).toEqual({
      type: "action",
      maxDurationMs: DEFAULT_ACTION_EXECUTION_BUDGET_MS,
    });
  });

  test("maps the public continuous soft limit to the persisted execution shape", () => {
    expect(
      normalizeExecutionMode({
        type: "action",
        continuousSoftLimitMs: 10 * 60_000,
      }),
    ).toEqual({ type: "action", maxDurationMs: 10 * 60_000 });
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid continuous soft limit %s",
    (continuousSoftLimitMs) => {
      expect(() =>
        normalizeExecutionMode({ type: "action", continuousSoftLimitMs }),
      ).toThrow("continuousSoftLimitMs must be greater than 0");
    },
  );

  test("rejects a continuous soft limit above the action limit", () => {
    expect(() =>
      normalizeExecutionMode({
        type: "action",
        continuousSoftLimitMs: MAX_ACTION_EXECUTION_BUDGET_MS + 1,
      }),
    ).toThrow(`at most ${MAX_ACTION_EXECUTION_BUDGET_MS}`);
  });
});
