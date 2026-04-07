/// <reference types="vite/client" />

import { WorkflowManager } from "@convex-dev/workflow";
import { assert } from "convex-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { components } from "./_generated/api";
import {
  dependentInlineQueries,
  inlineMutations,
  mixedInlineAndAction,
  parallelInlineQueries,
  raceInlineQueries,
  sequentialInlineQueries,
} from "./inlineTest";
import { initConvexTest } from "./setup.test";

const workflow = new WorkflowManager(components.workflow);

describe("inline queries and mutations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("sequential inline queries complete in one poll", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      sequentialInlineQueries.start(ctx, { key: "seq_test" }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toEqual({ a: 0, b: 0 });
  });

  test("parallel inline queries resolve in push order", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      parallelInlineQueries.start(ctx, { key: "par_test" }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    const result = status.result as {
      a: number;
      b: number;
      resolveOrder: string[];
    };
    // 'a' was pushed first, so it should resolve first in both
    // first-run (batched inline) and replay paths
    expect(result.resolveOrder).toEqual(["a", "b"]);
  });

  test("Promise.race picks first-pushed query", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      raceInlineQueries.start(ctx, { key: "race_test" }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("completed");
    // 'a' was pushed to channel first → completeMessage called first
    assert(status.type === "completed");
    expect((status.result as any).winner).toBe("a");
  });

  test("inline mutations execute and return sequentially", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      inlineMutations.start(ctx, { key: "mut_test" }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    // Mutations run inline in sequence, incrementing a counter
    expect(status.result).toEqual({ first: 1, second: 2 });
  });

  test("mixed inline + action: query runs inline, action via workpool", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      mixedInlineAndAction.start(ctx, { key: "mixed_test" }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    const result = status.result as {
      queryResult: number;
      actionResult: string;
    };
    expect(result.queryResult).toBe(0);
    expect(result.actionResult).toBe("action:mixed_test");
  });

  test("dependent inline queries: second uses result of first", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      dependentInlineQueries.start(ctx, { key: "dep_test" }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toEqual({ first: 0, second: 0 });
  });
});
