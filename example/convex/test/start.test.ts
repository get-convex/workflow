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
    const workflowId = await t.mutation((ctx) =>
      start(ctx, internal.catchError.catchErrorWorkflow, {
        manualRetries: 0,
      }),
    );
    assert(typeof workflowId === "string");
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
    const workflowId = await t.mutation((ctx) =>
      start(ctx, internal.nestedWorkflow.child, { foo: "hello" }),
    );
    assert(typeof workflowId === "string");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toBe(5);
  });

  test("parent workflow returns the nested child's return value", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation((ctx) =>
      start(ctx, internal.nestedWorkflow.parentWorkflow, {
        prompt: "hello",
      }),
    );
    assert(typeof workflowId === "string");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    assert(status.type === "completed");
    expect(status.result).toBe(5);
  });

  test("an internal poll returns the validated completion result", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation((ctx) =>
      start(
        ctx,
        internal.nestedWorkflow.child,
        {
          foo: "hello",
        },
        {
          startAsync: true,
        },
      ),
    );
    assert(typeof workflowId === "string");

    const result = await t.mutation(internal.nestedWorkflow.child, {
      workflowId,
      generationNumber: 0,
    } as any);
    expect(result).toEqual({
      kind: "complete",
      runResult: { kind: "success", returnValue: 5 },
    });
  });

  test("manual return validation preserves its error message", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(internal.nestedWorkflow.invalidReturn, {
      args: {},
      startAsync: true,
    });
    assert(typeof workflowId === "string");

    const result = await t.mutation(internal.nestedWorkflow.invalidReturn, {
      workflowId,
      generationNumber: 0,
    } as any);
    assert(typeof result !== "string");
    expect(result.kind).toBe("complete");
    assert(result.kind === "complete");
    expect(result.runResult.kind).toBe("failed");
    assert(result.runResult.kind === "failed");
    expect(result.runResult.error).toContain("Invalid return value:");
    expect(result.runResult.error).toContain("Expected `number`");
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
