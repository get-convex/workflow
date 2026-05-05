/// <reference types="vite/client" />

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createFunctionHandle } from "convex/server";
import { assert } from "convex-helpers";
import { workflow } from "../example";
import { internal } from "../_generated/api";
import { initConvexTest } from "../setup.test";

describe("context round-trips through failure paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("[1] direct call + handler throws", async () => {
    const t = initConvexTest();
    const ctxValue = { case: "directThrow", marker: 12345 };
    const workflowId = await t.mutation(async (ctx) => {
      const onCompleteHandle = await createFunctionHandle(
        internal.test.contextRoundtrip.captureOnComplete,
      );
      const wfId = await ctx.runMutation(
        internal.test.contextRoundtrip.throwingWorkflow,
        {
          args: {},
          onComplete: onCompleteHandle,
          context: ctxValue,
          startAsync: true,
        },
      );
      await ctx.db.insert("flows", {
        workflowId: wfId,
        in: "directThrow",
        out: null,
      });
      return wfId;
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const flow = await t.query(async (ctx) =>
      ctx.db
        .query("flows")
        .withIndex("workflowId", (q) => q.eq("workflowId", workflowId))
        .first(),
    );
    assert(flow);
    expect(flow.out?.result?.kind).toBe("failed");
    expect(flow.out?.capturedContext).toEqual(ctxValue);
  });

  test("[2] start() + handler throws", async () => {
    const t = initConvexTest();
    const ctxValue = { case: "startThrow", marker: 23456 };
    const workflowId = await t.mutation(async (ctx) => {
      const wfId = await workflow.start(
        ctx,
        internal.test.contextRoundtrip.throwingWorkflow,
        {},
        {
          onComplete: internal.test.contextRoundtrip.captureOnComplete,
          context: ctxValue,
          startAsync: true,
        },
      );
      await ctx.db.insert("flows", {
        workflowId: wfId,
        in: "startThrow",
        out: null,
      });
      return wfId;
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const flow = await t.query(async (ctx) =>
      ctx.db
        .query("flows")
        .withIndex("workflowId", (q) => q.eq("workflowId", workflowId))
        .first(),
    );
    assert(flow);
    expect(flow.out?.result?.kind).toBe("failed");
    expect(flow.out?.capturedContext).toEqual(ctxValue);
  });

  test("[3] direct call + oversized return", async () => {
    const t = initConvexTest();
    const ctxValue = { case: "directOversized", marker: 34567 };
    const workflowId = await t.mutation(async (ctx) => {
      const onCompleteHandle = await createFunctionHandle(
        internal.test.contextRoundtrip.captureOnComplete,
      );
      const wfId = await ctx.runMutation(
        internal.oversized.largeReturnWorkflow,
        {
          args: {},
          onComplete: onCompleteHandle,
          context: ctxValue,
          startAsync: true,
        },
      );
      await ctx.db.insert("flows", {
        workflowId: wfId,
        in: "directOversized",
        out: null,
      });
      return wfId;
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const flow = await t.query(async (ctx) =>
      ctx.db
        .query("flows")
        .withIndex("workflowId", (q) => q.eq("workflowId", workflowId))
        .first(),
    );
    assert(flow);
    expect(flow.out?.result?.kind).toBe("failed");
    expect(flow.out?.capturedContext).toEqual(ctxValue);
  });

  test("[4] start() + oversized return", async () => {
    const t = initConvexTest();
    const ctxValue = { case: "startOversized", marker: 45678 };
    const workflowId = await t.mutation(async (ctx) => {
      const wfId = await workflow.start(
        ctx,
        internal.oversized.largeReturnWorkflow,
        {},
        {
          onComplete: internal.test.contextRoundtrip.captureOnComplete,
          context: ctxValue,
          startAsync: true,
        },
      );
      await ctx.db.insert("flows", {
        workflowId: wfId,
        in: "startOversized",
        out: null,
      });
      return wfId;
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const flow = await t.query(async (ctx) =>
      ctx.db
        .query("flows")
        .withIndex("workflowId", (q) => q.eq("workflowId", workflowId))
        .first(),
    );
    assert(flow);
    expect(flow.out?.result?.kind).toBe("failed");
    expect(flow.out?.capturedContext).toEqual(ctxValue);
  });
});
