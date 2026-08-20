/// <reference types="vite/client" />

import type { WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { initConvexTest } from "./setup.test.js";
import { executeDirectStep } from "./actionRunner.js";

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

describe("direct mutation fallback", () => {
  test("hands an outer mutation failure to Workpool", async () => {
    const claimed = {
      _id: "step-id",
      _creationTime: 0,
      workflowId: "workflow-id",
      generationNumber: 3,
      stepNumber: 4,
      step: {
        kind: "function" as const,
        functionType: "mutation" as const,
        handle: "function://;test:mutation",
        name: "mutation",
        inProgress: true,
        argsSize: 0,
        args: { value: 1 },
        startedAt: 0,
      },
    } as Doc<"steps">;
    const dispatched = {
      ...claimed,
      step: { ...claimed.step, workId: "fallback-work-id" },
    } as Doc<"steps">;
    const calls: unknown[] = [];
    const ctx = {
      runMutation: async (_function: unknown, args: unknown) => {
        calls.push(args);
        if (calls.length === 1) {
          throw new Error("Documents changed during every OCC retry");
        }
        return { kind: "ok" as const, entries: [dispatched] };
      },
    };

    const result = await executeDirectStep(
      ctx as any,
      claimed,
      3,
      undefined,
    );

    expect(result).toEqual(dispatched);
    expect(calls).toEqual([
      { stepId: "step-id", generationNumber: 3 },
      {
        workflowId: "workflow-id",
        generationNumber: 3,
        steps: [{ stepId: "step-id" }],
        workpoolOptions: undefined,
      },
    ]);
  });

  test("dispatch fencing does not re-run a mutation whose result committed", async () => {
    const t = initConvexTest();
    const { workflowId, stepId } = await (async () => {
      const workflowId = await t.mutation(api.workflow.create, {
        workflowName: "response-lost",
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
            functionType: "mutation" as const,
            handle: "function://;workflow.test:noop",
            name: "mutation",
            inProgress: true,
            argsSize: 0,
            args: {},
            startedAt: 0,
          },
        }),
      );
      return { workflowId, stepId };
    })();
    await t.mutation(internal.actionRunner.completeStep, {
      stepId,
      generationNumber: 0,
      runResult: { kind: "success", returnValue: "committed" },
    });

    const result = await t.mutation(internal.journal.dispatchSteps, {
      workflowId,
      generationNumber: 0,
      steps: [{ stepId }],
    });

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.entries[0].step.inProgress).toBe(false);
      expect(result.entries[0].step.runResult).toEqual({
        kind: "success",
        returnValue: "committed",
      });
      expect(
        result.entries[0].step.kind === "function"
          ? result.entries[0].step.workId
          : undefined,
      ).toBeUndefined();
    }
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
