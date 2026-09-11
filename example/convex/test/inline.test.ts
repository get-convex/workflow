/// <reference types="vite/client" />

import { getStatus, WorkflowManager } from "@convex-dev/workflow";
import { assert } from "convex-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { components, internal } from "../_generated/api";
import { initConvexTest } from "../setup.test";

const workflow = new WorkflowManager(components.workflow);

async function drainScheduler(t: ReturnType<typeof initConvexTest>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
}

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
      workflow.start(ctx, internal.test.inline.sequentialInlineQueries, {
        key: "seq_test",
      }),
    );
    await drainScheduler(t);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toEqual({ a: 0, b: 0 });
  });

  test("parallel inline queries resolve in push order", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.test.inline.parallelInlineQueries, {
        key: "par_test",
      }),
    );
    await drainScheduler(t);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
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
      workflow.start(ctx, internal.test.inline.raceInlineQueries, {
        key: "race_test",
      }),
    );
    await drainScheduler(t);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    // 'a' was pushed to channel first → completeMessage called first
    assert(status.type === "completed");
    expect((status.result as any).winner).toBe("a");
  });

  test("inline mutations execute and return sequentially", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.test.inline.inlineMutations, {
        key: "mut_test",
      }),
    );
    await drainScheduler(t);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    // Mutations run inline in sequence, incrementing a counter
    expect(status.result).toEqual({ first: 1, second: 2 });
  });

  // Both modes: the inline query is resolved inside the handler's transaction
  // while the action still blocks, so the batch handed back mixes settled and
  // in-progress entries. The action runner must not try to start the settled
  // one again.
  test.each(["mutation", "action"] as const)(
    "mixed inline + action in %s mode: query runs inline, action does not",
    async (executionMode) => {
      const t = initConvexTest();
      const workflowId = await t.run((ctx) =>
        workflow.start(
          ctx,
          internal.test.inline.mixedInlineAndAction,
          { key: `mixed_test_${executionMode}` },
          { executionMode },
        ),
      );
      await drainScheduler(t);
      const status = await t.query((ctx) =>
        getStatus(ctx, components.workflow, workflowId),
      );
      expect(status.type).toBe("completed");
      assert(status.type === "completed");
      const result = status.result as {
        queryResult: number;
        actionResult: string;
      };
      expect(result.queryResult).toBe(0);
      expect(result.actionResult).toBe(`action:mixed_test_${executionMode}`);
    },
  );

  test("dependent inline queries: second uses result of first", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.test.inline.dependentInlineQueries, {
        key: "dep_test",
      }),
    );
    await drainScheduler(t);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toEqual({ first: 0, second: 0 });
  });
});

describe("action-driven workflows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("executes sequential queries, mutations, and actions from one runner", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.inline.actionDrivenSequence,
        { key: "action_sequence" },
        { executionMode: "action" },
      ),
    );
    await drainScheduler(t);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    assert(status.type === "completed");
    expect(status.result).toEqual({
      before: 0,
      incremented: 1,
      actionResult: "action:action_sequence",
      after: 1,
    });
  });

  test("hands a failed direct action to workpool with remaining retries", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.inline.actionDrivenRetry,
        { key: "action_retry" },
        { executionMode: "action" },
      ),
    );
    await drainScheduler(t);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    assert(status.type === "completed");
    expect(status.result).toBe("attempt:2");
  });

  test("hands off actions whose requested time does not fit", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.inline.actionDrivenBudgetHandoff,
        { label: "budget" },
        { executionMode: { type: "action", continuousSoftLimitMs: 100 } },
      ),
    );
    await drainScheduler(t);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    assert(status.type === "completed");
    expect(status.result).toBe("action:budget");
  });

  test("resumes the action runner after a sleep", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.inline.actionDrivenSleep,
        { label: "after-sleep" },
        { executionMode: "action" },
      ),
    );
    await drainScheduler(t);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    assert(status.type === "completed");
    expect(status.result).toBe("action:after-sleep");
  });

  test("commits an inline mutation once before handing off to sleep", async () => {
    const t = initConvexTest();
    const key = "action_inline_sleep";
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.inline.actionDrivenInlineThenSleep,
        { key },
        { executionMode: "action" },
      ),
    );
    await drainScheduler(t);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    const counter = await t.query(internal.test.inline.getCounter, { key });
    assert(status.type === "completed");
    expect(status.result).toBe(1);
    expect(counter).toBe(1);
  });

  test("rolls back a limited inline subtransaction and continues", async () => {
    const t = initConvexTest();
    const key = "action_inline_limit";
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.inline.catchTransactionLimit,
        { key },
        { executionMode: "action" },
      ),
    );
    await drainScheduler(t);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    const counter = await t.query(internal.test.inline.getCounter, { key });
    assert(status.type === "completed");
    expect(status.result).toEqual({ caught: true, finalValue: 1 });
    expect(counter).toBe(1);
  });

  test("resumes the action runner after an event arrives", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.inline.actionDrivenEvent,
        {},
        { executionMode: "action" },
      ),
    );
    await drainScheduler(t);
    const waiting = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    assert(waiting.type === "inProgress");
    expect(waiting.running.some((step) => step.kind === "event")).toBe(true);

    await t.run((ctx) =>
      workflow.sendEvent(ctx, {
        workflowId,
        name: "driver-event",
        value: "delivered",
      }),
    );
    await drainScheduler(t);
    const completed = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    assert(completed.type === "completed");
    expect(completed.result).toBe("delivered");
  });

  test("resumes after an action-driven nested workflow", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.nestedWorkflow.parentWorkflow,
        { prompt: "nested" },
        { executionMode: "action" },
      ),
    );
    await drainScheduler(t);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    assert(status.type === "completed");
    expect(status.result).toBe(6);
  });
});
