/// <reference types="vite/client" />

import { expect, describe, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { internal } from "./_generated/api";
import { WorkflowManager } from "@convex-dev/workflow";

describe("inline queries and mutations", () => {
  test("sequential inline queries complete in one poll", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const workflowId = await t.mutation(
      internal.inlineTest.startSequential,
      { key: "seq_test" },
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run(async (ctx) => {
      const wf = await ctx.db.get(workflowId as any);
      return wf?.runResult;
    });
    expect(status).toBeDefined();
    expect(status?.kind).toBe("success");
    expect(status?.returnValue).toEqual({ a: 0, b: 0 });
    vi.useRealTimers();
  });

  test("parallel inline queries resolve in push order", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const workflowId = await t.mutation(
      internal.inlineTest.startParallel,
      { key: "par_test" },
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run(async (ctx) => {
      const wf = await ctx.db.get(workflowId as any);
      return wf?.runResult;
    });
    expect(status?.kind).toBe("success");
    const result = status?.returnValue as {
      a: number;
      b: number;
      resolveOrder: string[];
    };
    // 'a' was pushed first, so it should resolve first in both
    // first-run (batched inline) and replay paths
    expect(result.resolveOrder).toEqual(["a", "b"]);
    vi.useRealTimers();
  });

  test("Promise.race picks first-pushed query", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const workflowId = await t.mutation(
      internal.inlineTest.startRace,
      { key: "race_test" },
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run(async (ctx) => {
      const wf = await ctx.db.get(workflowId as any);
      return wf?.runResult;
    });
    expect(status?.kind).toBe("success");
    // 'a' was pushed to channel first → completeMessage called first
    expect((status?.returnValue as any).winner).toBe("a");
    vi.useRealTimers();
  });

  test("inline mutations execute and return sequentially", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const workflowId = await t.mutation(
      internal.inlineTest.startMutations,
      { key: "mut_test" },
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run(async (ctx) => {
      const wf = await ctx.db.get(workflowId as any);
      return wf?.runResult;
    });
    expect(status?.kind).toBe("success");
    // Mutations run inline in sequence, incrementing a counter
    expect(status?.returnValue).toEqual({ first: 1, second: 2 });
    vi.useRealTimers();
  });

  test("per-call inline override works without shareTransaction", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const workflowId = await t.mutation(
      internal.inlineTest.startPerCall,
      { key: "percall_test" },
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run(async (ctx) => {
      const wf = await ctx.db.get(workflowId as any);
      return wf?.runResult;
    });
    expect(status?.kind).toBe("success");
    expect(status?.returnValue).toBe(0);
    vi.useRealTimers();
  });

  test("mixed inline + action: all-or-nothing sends all to workpool", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const workflowId = await t.mutation(
      internal.inlineTest.startMixed,
      { key: "mixed_test" },
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run(async (ctx) => {
      const wf = await ctx.db.get(workflowId as any);
      return wf?.runResult;
    });
    expect(status?.kind).toBe("success");
    const result = status?.returnValue as {
      queryResult: number;
      actionResult: string;
    };
    expect(result.queryResult).toBe(0);
    expect(result.actionResult).toBe("action:mixed_test");
    vi.useRealTimers();
  });

  test("dependent inline queries: second uses result of first", async () => {
    vi.useFakeTimers();
    const t = initConvexTest();
    const workflowId = await t.mutation(
      internal.inlineTest.startDependent,
      { key: "dep_test" },
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run(async (ctx) => {
      const wf = await ctx.db.get(workflowId as any);
      return wf?.runResult;
    });
    expect(status?.kind).toBe("success");
    expect(status?.returnValue).toEqual({ first: 0, second: 0 });
    vi.useRealTimers();
  });
});
