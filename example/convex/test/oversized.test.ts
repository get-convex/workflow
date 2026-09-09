/// <reference types="vite/client" />

import { expect, describe, test, vi, beforeEach, afterEach } from "vitest";
import { initConvexTest } from "../setup.test";
import { components, internal } from "../_generated/api";
import { assert } from "convex-helpers";
import { getStatus } from "@convex-dev/workflow";
import { workflow } from "../example";

async function drainScheduler(t: ReturnType<typeof initConvexTest>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
}

describe("oversized values", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("large step return value fails workflow and calls onComplete", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(async (ctx) => {
      const wfId = await workflow.start(
        ctx,
        internal.test.oversized.largeReturnWorkflow,
        {},
        {
          onComplete: internal.test.oversized.onComplete,
          context: {},
          startAsync: true,
        },
      );
      await ctx.db.insert("flows", {
        workflowId: wfId,
        in: "largeReturn",
        out: null,
      });
      return wfId;
    });
    await drainScheduler(t);

    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("failed");
    assert(status.type === "failed");
    expect(status.error).toContain("Step return value too large");

    const flow = await t.query(async (ctx) => {
      return ctx.db
        .query("flows")
        .withIndex("workflowId", (q) => q.eq("workflowId", workflowId))
        .first();
    });
    expect(flow).not.toBeNull();
    assert(flow);
    expect(flow.out).not.toBeNull();
    expect(flow.out.kind).toBe("failed");
    expect(flow.out.error).toContain("Step return value too large");
  });

  test("large event value fails workflow and calls onComplete", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(async (ctx) => {
      const wfId = await workflow.start(
        ctx,
        internal.test.oversized.eventWorkflow,
        {},
        {
          onComplete: internal.test.oversized.onComplete,
          context: {},
          startAsync: true,
        },
      );
      await ctx.db.insert("flows", {
        workflowId: wfId,
        in: "eventWorkflow",
        out: null,
      });
      return wfId;
    });
    // Let the workflow start and reach the awaitEvent point
    await drainScheduler(t);

    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("inProgress");

    // Send the oversized event
    await t.mutation(internal.test.oversized.sendBigEvent, { workflowId });
    await drainScheduler(t);

    const status2 = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status2.type).toBe("failed");
    assert(status2.type === "failed");
    expect(status2.error).toContain("Step return value too large");
    expect(status2.error).toContain("900002 bytes");

    const flow = await t.query(async (ctx) => {
      return ctx.db
        .query("flows")
        .withIndex("workflowId", (q) => q.eq("workflowId", workflowId))
        .first();
    });
    expect(flow).not.toBeNull();
    expect(flow!.out).not.toBeNull();
    expect(flow!.out.kind).toBe("failed");
    expect(flow!.out.error).toContain("Step return value too large");
  });

  test("large action return fails cleanly in action execution mode", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.oversized.largeReturnWorkflow,
        {},
        {
          executionMode: "action",
        },
      ),
    );
    await drainScheduler(t);

    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    const loaded = await t.run((ctx) =>
      ctx.runQuery(components.workflow.journal.load, { workflowId }),
    );
    assert(status.type === "failed");
    expect(status.error).toContain("Step return value too large");
    expect(loaded.journalEntries).toHaveLength(1);
    expect(loaded.journalEntries[0].step.inProgress).toBe(false);
    expect(loaded.journalEntries[0].step.runResult?.kind).toBe("failed");
  });

  test("oversized step arguments fail before a durable claim", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.oversized.largeArgumentWorkflow,
        {},
        {
          executionMode: "action",
        },
      ),
    );
    await drainScheduler(t);

    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    const loaded = await t.run((ctx) =>
      ctx.runQuery(components.workflow.journal.load, { workflowId }),
    );
    assert(status.type === "failed");
    expect(status.error).toContain("Step arguments too large");
    expect(loaded.journalEntries).toHaveLength(0);
  });

  test("oversized inline return uses the same step result guard", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.oversized.largeInlineReturnWorkflow,
        {},
        {
          executionMode: "action",
        },
      ),
    );
    await drainScheduler(t);

    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    const loaded = await t.run((ctx) =>
      ctx.runQuery(components.workflow.journal.load, { workflowId }),
    );
    assert(status.type === "failed");
    expect(status.error).toContain("Step return value too large");
    expect(loaded.journalEntries).toHaveLength(1);
    expect(loaded.journalEntries[0].step.runResult?.kind).toBe("failed");
  });

  test.each([
    { unstableArgs: false, storesHash: true },
    { unstableArgs: true, storesHash: false },
  ])(
    "oversized inline arguments survive replay with compact identity ($unstableArgs)",
    async ({ unstableArgs, storesHash }) => {
      const t = initConvexTest();
      const key = `oversized-inline-${unstableArgs}`;
      const workflowId = await t.run((ctx) =>
        workflow.start(
          ctx,
          internal.test.oversized.largeInlineArgumentWorkflow,
          { key, unstableArgs },
          { executionMode: "action" },
        ),
      );
      await drainScheduler(t);

      const status = await t.run((ctx) =>
        getStatus(ctx, components.workflow, workflowId),
      );
      const loaded = await t.run((ctx) =>
        ctx.runQuery(components.workflow.journal.load, { workflowId }),
      );
      const commits = await t.run((ctx) =>
        ctx.db
          .query("workflowHarnessCommits")
          .withIndex("by_runId_and_operationId", (q) =>
            q.eq("runId", key).eq("operationId", "oversized-inline-argument"),
          )
          .collect(),
      );

      assert(status.type === "completed");
      expect(status.result).toBe(900_000);
      expect(commits).toHaveLength(1);
      expect(loaded.journalEntries).toHaveLength(2);
      expect(loaded.journalEntries[0].step.args).toEqual({});
      expect(loaded.journalEntries[0].step.argsSize).toBeGreaterThan(800 << 10);
      if (storesHash) {
        expect(loaded.journalEntries[0].step.argsHash).toMatch(
          /^[a-f0-9]{64}$/,
        );
      } else {
        expect(loaded.journalEntries[0].step.argsHash).toBeUndefined();
      }
    },
  );
});
