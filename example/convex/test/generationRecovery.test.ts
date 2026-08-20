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
    await t.run(async (ctx: any) =>
      ctx.runMutation(components.workflow.journal.startSteps, {
        workflowId,
        generationNumber: 0,
        deferExecution: true,
        steps: [
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

    await t.run((ctx: any) =>
      ctx.runMutation(components.workflow.workflow.restart, { workflowId }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    // Previously this hung in `inProgress` forever: the orphaned step had no
    // owner and every driver refused to run past it.
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
