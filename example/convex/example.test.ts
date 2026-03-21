/// <reference types="vite/client" />

import { expect, describe, test, vi, beforeEach, afterEach } from "vitest";
import { initConvexTest } from "./setup.test";
import { internal } from "./_generated/api";
import { workflow } from "./example";
import { assert } from "convex-helpers";

describe("catchError workflow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // TODO: stop skipping after https://github.com/get-convex/convex-test/pull/76
  test.skip("catches action error and retries", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.catchError.catchErrorWorkflow,
        { manualRetries: 3 },
        { startAsync: true },
      ),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    // With 3 manual retries, it tries 4 times (0, 1, 2, 3) then returns 4
    expect(status.result).toBe(4);
  });

  // TODO: stop skipping after https://github.com/get-convex/convex-test/pull/76
  test.skip("zero retries returns 1", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.catchError.catchErrorWorkflow,
        { manualRetries: 0 },
        { startAsync: true },
      ),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toBe(1);
  });
});

describe("nested workflow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("parent runs child workflow and mutation step", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.nestedWorkflow.parentWorkflow, {
        prompt: "hello",
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("completed");
  });

  test("child workflow returns string length", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.nestedWorkflow.childWorkflow, {
        foo: "test",
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toBe(4);
  });
});

describe("signal-based workflow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("completes after all signals are sent", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.passingSignals.signalBasedWorkflow, {}),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("completed");
  });
});

describe("user confirmation workflow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("completes with chosen proposal on approval", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.userConfirmation.confirmationWorkflow,
        { prompt: "Generate a recipe" },
        { startAsync: true },
      ),
    );
    // Let the workflow start and reach the awaitEvent point
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Should be in progress waiting for the event
    const inProgressStatus = await t.run((ctx) =>
      workflow.status(ctx, workflowId),
    );
    expect(inProgressStatus.type).toBe("inProgress");

    // Send approval event and let the workflow resume
    await t.mutation(internal.userConfirmation.chooseProposal, {
      workflowId,
      choice: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The workflow may need additional poll cycles after event delivery
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const status = await t.run((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toBe("proposal2");
  });
});

describe("workflow cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("canceling a workflow sets status to canceled", async () => {
    const t = initConvexTest();
    // Start a workflow that will block (user confirmation waits for event)
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.userConfirmation.confirmationWorkflow,
        { prompt: "test" },
        { startAsync: true },
      ),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Cancel it
    await t.run((ctx) => workflow.cancel(ctx, workflowId));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const status = await t.run((ctx) => workflow.status(ctx, workflowId));
    expect(status.type).toBe("canceled");
  });
});
