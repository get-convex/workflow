/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { initConvexTest } from "./setup.test.js";

describe("action runner state fences", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a stale or duplicate completion cannot overwrite journal state", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.workflow.create, {
      workflowName: "generation-fence",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: {},
      startAsync: true,
    });
    const stepId = await t.run((ctx) =>
      ctx.db.insert("steps", {
        workflowId,
        stepNumber: 0,
        step: {
          kind: "function" as const,
          functionType: "action" as const,
          handle: "function://;workflow.test:noop",
          name: "fenced-step",
          inProgress: true,
          argsSize: 0,
          args: {},
          startedAt: Date.now(),
        },
      }),
    );

    await expect(
      t.mutation(internal.actionRunner.completeStep, {
        stepId,
        generationNumber: 1,
        runResult: { kind: "success", returnValue: "stale" },
      }),
    ).rejects.toThrow("Invalid generation number");
    await expectStep(t, stepId, true, undefined);

    await t.mutation(internal.actionRunner.completeStep, {
      stepId,
      generationNumber: 0,
      runResult: { kind: "success", returnValue: "committed" },
    });
    await expectStep(t, stepId, false, "committed");

    await expect(
      t.mutation(internal.actionRunner.completeStep, {
        stepId,
        generationNumber: 0,
        runResult: { kind: "success", returnValue: "duplicate" },
      }),
    ).rejects.toThrow("already completed");
    await expectStep(t, stepId, false, "committed");
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
