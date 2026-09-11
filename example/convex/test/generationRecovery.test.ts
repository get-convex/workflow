/// <reference types="vite/client" />

/**
 * End-to-end recovery tests for action-driven workflows, against real
 * workflow definitions (see docs/generation-semantics.md).
 */
import { getStatus, WorkflowManager } from "@convex-dev/workflow";
import { assert } from "convex-helpers";
import { createFunctionHandle } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { components, internal } from "../_generated/api";
import { initConvexTest } from "../setup.test";

const workflow = new WorkflowManager(components.workflow);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("action-driven recovery", () => {
  test("restart recovers a workflow whose driver died mid direct-step", async () => {
    const t = initConvexTest();
    // Reproduce the state an interrupted action runner leaves behind: a step
    // journaled with deferExecution (in progress, no workId) and a workflow
    // failed by the driver's completion path.
    const workflowId: any = await t.run(async (ctx: any) =>
      ctx.runMutation(components.workflow.workflow.create, {
        workflowName: "test/inline:actionDrivenSequence",
        workflowHandle: await createFunctionHandle(
          internal.test.inline.actionDrivenSequence,
        ),
        workflowArgs: { key: "orphan" },
        createOnly: true,
        execution: { type: "action", maxDurationMs: 60_000 },
      }),
    );
    // The journal state at the moment the driver died: the first two steps
    // settled, the action journaled (claimed) but with no completion coming.
    await t.run(async (ctx: any) =>
      ctx.runMutation(components.workflow.journal.startSteps, {
        workflowId,
        generationNumber: 0,
        deferExecution: true,
        steps: [
          {
            step: {
              kind: "function",
              functionType: "query",
              handle: await createFunctionHandle(
                internal.test.inline.getCounter,
              ),
              name: "test/inline:getCounter",
              args: { key: "orphan" },
              argsSize: 10,
              inProgress: false,
              runResult: { kind: "success", returnValue: 0 },
              startedAt: Date.now(),
              completedAt: Date.now(),
            },
          },
          {
            step: {
              kind: "function",
              functionType: "mutation",
              handle: await createFunctionHandle(
                internal.test.inline.incrementCounter,
              ),
              name: "test/inline:incrementCounter",
              args: { key: "orphan" },
              argsSize: 10,
              inProgress: false,
              runResult: { kind: "success", returnValue: 1 },
              startedAt: Date.now(),
              completedAt: Date.now(),
            },
          },
          {
            step: {
              kind: "function",
              functionType: "action",
              handle: await createFunctionHandle(
                internal.test.inline.someAction,
              ),
              name: "test/inline:someAction",
              args: { label: "orphan" },
              argsSize: 10,
              inProgress: true,
              startedAt: Date.now(),
            },
          },
        ],
      }),
    );
    await t.run((ctx: any) =>
      ctx.runMutation(components.workflow.workflow.complete, {
        workflowId,
        generationNumber: 0,
        runResult: { kind: "failed", error: "action runner died" },
      }),
    );

    // A bare restart never re-runs a possibly-started action: the orphan
    // settles as failed and replay surfaces that failure to the handler.
    // Previously this hung in `inProgress` forever instead.
    await t.run((ctx: any) =>
      ctx.runMutation(components.workflow.workflow.restart, { workflowId }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    assert(status.type === "failed");
    expect(status.error).toContain("will not be re-run");

    // Re-running the action is an explicit operator decision: restart from
    // the orphaned step, deleting it so replay re-executes it.
    await t.run((ctx: any) =>
      ctx.runMutation(components.workflow.workflow.restart, {
        workflowId,
        from: 2,
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    assert(status.type === "completed");
    expect(status.result).toMatchObject({ actionResult: "action:orphan" });
  });

  test("multiple direct batches in one action use increasing generations", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.inline.actionDrivenSequence,
        { key: "generations" },
        { executionMode: "action" },
      ),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    assert(status.type === "completed");
    const loaded: any = await t.run((ctx: any) =>
      ctx.runQuery(components.workflow.journal.load, { workflowId }),
    );
    // The workflow ran several sequential waves; each settled batch advanced
    // the generation before the next handler evaluation.
    expect(loaded.workflow.generationNumber).toBeGreaterThan(1);
    const generations = loaded.journalEntries.map(
      (entry: any) => entry.generationNumber,
    );
    // Claims are monotonically non-decreasing across the journal.
    for (let i = 1; i < generations.length; i++) {
      expect(generations[i]).toBeGreaterThanOrEqual(generations[i - 1]);
    }
  });

  test("cancel mid-flight exits the runner cleanly and stays canceled", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.inline.actionDrivenSleep,
        { label: "cancel-me" },
        { executionMode: "action" },
      ),
    );
    await t.run((ctx: any) =>
      ctx.runMutation(components.workflow.workflow.cancel, { workflowId }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("canceled");
  });
});
