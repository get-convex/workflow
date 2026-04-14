/// <reference types="vite/client" />

import { expect, describe, test, vi, beforeEach, afterEach } from "vitest";
import { initConvexTest } from "../setup.test";
import { components, internal } from "../_generated/api";
import { assert } from "convex-helpers";
import { getStatus, start } from "@convex-dev/workflow";
import { workflow } from "../example";

describe("direct workflow call", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("calling workflow mutation directly starts and completes", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(
      internal.catchError.catchErrorWorkflow,
      { args: { manualRetries: 0 } },
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toBe(1);
  });

  test("direct call to nested child workflow", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(internal.nestedWorkflow.child, {
      args: { foo: "hello" },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toBe(5);
  });
});

describe("start() helper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("start() with startAsync option", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      start(
        ctx,
        internal.catchError.catchErrorWorkflow,
        {
          manualRetries: 2,
        },
        {
          startAsync: true,
        },
      ),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toBe(3);
  });
});

describe("backwards compatibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("workflow.start() still works", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.nestedWorkflow.child, { foo: "test" }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toBe(4);
  });
});
