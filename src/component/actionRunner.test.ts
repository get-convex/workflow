/// <reference types="vite/client" />

import type { WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { initConvexTest } from "./setup.test.js";

describe("action runner state fences", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function createWorkflowWithStep(
    t: ReturnType<typeof initConvexTest>,
    step?: Partial<{ workId: WorkId }>,
  ) {
    const workflowId = await t.mutation(api.workflow.create, {
      workflowName: "generation-fence",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: {},
      createOnly: true,
    });
    const stepId = await t.run((ctx) =>
      ctx.db.insert("steps", {
        workflowId,
        stepNumber: 0,
        generationNumber: 0,
        step: {
          kind: "function" as const,
          functionType: "action" as const,
          handle: "function://;workflow.test:noop",
          name: "fenced-step",
          inProgress: true,
          argsSize: 0,
          args: {},
          startedAt: Date.now(),
          ...step,
        },
      }),
    );
    return { workflowId, stepId };
  }

  test("a stale or duplicate completion is rejected as a return value", async () => {
    const t = initConvexTest();
    const { stepId } = await createWorkflowWithStep(t);

    // Wrong generation: rejected without failing the caller.
    const staleGeneration = await t.mutation(
      internal.actionRunner.completeStep,
      {
        stepId,
        generationNumber: 1,
        runResult: { kind: "success", returnValue: "stale" },
      },
    );
    expect(staleGeneration.kind).toBe("stale");
    await expectStep(t, stepId, true, undefined);

    // Matching generation: commits.
    const committed = await t.mutation(internal.actionRunner.completeStep, {
      stepId,
      generationNumber: 0,
      runResult: { kind: "success", returnValue: "committed" },
    });
    expect(committed.kind).toBe("ok");
    await expectStep(t, stepId, false, "committed");

    // Duplicate: rejected, terminal result never overwritten.
    const duplicate = await t.mutation(internal.actionRunner.completeStep, {
      stepId,
      generationNumber: 0,
      runResult: { kind: "success", returnValue: "duplicate" },
    });
    expect(duplicate.kind).toBe("stale");
    await expectStep(t, stepId, false, "committed");
  });

  test("a late direct completion cannot overwrite a workpool-owned step", async () => {
    const t = initConvexTest();
    // Recovery handed the step to the workpool: workId is set.
    const { stepId } = await createWorkflowWithStep(t, {
      workId: "some-work-id" as WorkId,
    });
    const late = await t.mutation(internal.actionRunner.completeStep, {
      stepId,
      generationNumber: 0,
      runResult: { kind: "success", returnValue: "late-direct" },
    });
    expect(late.kind).toBe("stale");
    await expectStep(t, stepId, true, undefined);
  });

  test("a completion against a terminal workflow is rejected", async () => {
    const t = initConvexTest();
    const { workflowId, stepId } = await createWorkflowWithStep(t);
    await t.run(async (ctx) => {
      await ctx.db.patch("workflows", workflowId, {
        runResult: { kind: "canceled" },
      });
    });
    const late = await t.mutation(internal.actionRunner.completeStep, {
      stepId,
      generationNumber: 0,
      runResult: { kind: "success", returnValue: "late" },
    });
    expect(late.kind).toBe("stale");
    await expectStep(t, stepId, true, undefined);
  });
});

async function expectStep(
  t: ReturnType<typeof initConvexTest>,
  stepId: Id<"steps">,
  inProgress: boolean,
  returnValue: string | undefined,
) {
  await t.run(async (ctx) => {
    const entry = await ctx.db.get("steps", stepId);
    expect(entry?.step.inProgress).toBe(inProgress);
    expect(
      entry?.step.runResult?.kind === "success"
        ? entry.step.runResult.returnValue
        : undefined,
    ).toBe(returnValue);
  });
}
