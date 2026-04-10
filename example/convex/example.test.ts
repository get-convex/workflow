/// <reference types="vite/client" />

import { expect, describe, test, vi, beforeEach, afterEach } from "vitest";
import { initConvexTest } from "./setup.test";
import { components, internal } from "./_generated/api";
import { catchErrorWorkflow } from "./catchError";
import { parentWorkflow, childWorkflow } from "./nestedWorkflow";
import { signalWorkflow } from "./passingSignals";
import { confirmationWorkflow } from "./userConfirmation";
import { assert } from "convex-helpers";
import { getStatus, cancel } from "@convex-dev/workflow";

describe("catchError workflow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("catches action error and retries", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation((ctx) =>
      catchErrorWorkflow.start(ctx, { manualRetries: 3 }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    // With 3 manual retries, it tries 4 times (0, 1, 2, 3) then returns 4
    expect(status.result).toBe(4);
  });

  test("zero retries returns 1", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation((ctx) =>
      catchErrorWorkflow.start(ctx, { manualRetries: 0 }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
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
      parentWorkflow.start(ctx, { prompt: "hello" }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
  });

  test("child workflow returns string length", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      childWorkflow.start(ctx, { foo: "test" }),
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

describe("signal-based workflow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("completes after all signals are sent", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) => signalWorkflow.start(ctx, {}));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) => signalWorkflow.status(ctx, workflowId));
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
      confirmationWorkflow.start(
        ctx,
        { prompt: "Generate a recipe" },
        { startAsync: true },
      ),
    );
    // Let the workflow start and reach the awaitEvent point
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Should be in progress waiting for the event
    const inProgressStatus = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
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

    const status = await t.run((ctx) =>
      confirmationWorkflow.status(ctx, workflowId),
    );
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
      confirmationWorkflow.start(ctx, { prompt: "test" }, { startAsync: true }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Cancel it
    await t.run((ctx) => confirmationWorkflow.cancel(ctx, workflowId));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const status = await t.run((ctx) =>
      confirmationWorkflow.status(ctx, workflowId),
    );
    expect(status.type).toBe("canceled");
  });
});
