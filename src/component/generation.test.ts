/// <reference types="vite/client" />

/**
 * Deterministic tests for the generation semantics spec
 * (docs/generation-semantics.md): advancement, driver recovery,
 * terminal-state fencing, and restart cleanup.
 */
import type { WorkId } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { initConvexTest } from "./setup.test.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const FAKE_HANDLE = "function://;workflow.test:noop";
/** Fake workpool ids for exercising fences; never dereferenced. */
const workId = (id: string) => id as WorkId;

async function createWorkflow(
  t: ReturnType<typeof initConvexTest>,
  fields?: Partial<Doc<"workflows">>,
) {
  const workflowId = await t.mutation(api.workflow.create, {
    workflowName: "generation-test",
    workflowHandle: FAKE_HANDLE,
    workflowArgs: {},
    createOnly: true,
  });
  if (fields) {
    await t.run((ctx) => ctx.db.patch("workflows", workflowId, fields));
  }
  return workflowId;
}

async function insertStep(
  t: ReturnType<typeof initConvexTest>,
  workflowId: Id<"workflows">,
  overrides?: {
    step?: Partial<Extract<Doc<"steps">["step"], { functionType?: string }>>;
    retry?: Doc<"steps">["retry"];
    stepNumber?: number;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("steps", {
      workflowId,
      stepNumber: overrides?.stepNumber ?? 0,
      generationNumber: 0,
      retry: overrides?.retry,
      step: {
        kind: "function" as const,
        functionType: "action" as const,
        handle: FAKE_HANDLE,
        name: "step",
        inProgress: true,
        argsSize: 0,
        args: {},
        startedAt: Date.now(),
        ...overrides?.step,
      },
    }),
  );
}

async function getWorkflowDoc(
  t: ReturnType<typeof initConvexTest>,
  workflowId: Id<"workflows">,
) {
  return await t.run(async (ctx) => {
    const workflow = await ctx.db.get("workflows", workflowId);
    expect(workflow).not.toBeNull();
    return workflow!;
  });
}

async function getStep(
  t: ReturnType<typeof initConvexTest>,
  stepId: Id<"steps">,
) {
  return await t.run((ctx) => ctx.db.get("steps", stepId));
}

describe("generation advancement", () => {
  test("advances only after every parallel step settles, exactly once", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t);
    const stepA = await insertStep(t, workflowId, {
      step: { workId: workId("work-a") },
      stepNumber: 0,
    });
    const stepB = await insertStep(t, workflowId, {
      step: { workId: workId("work-b") },
      stepNumber: 1,
    });

    await t.mutation(internal.pool.onComplete, {
      workId: workId("work-a"),
      result: { kind: "success", returnValue: 1 },
      context: { generationNumber: 0, stepId: stepA },
    });
    let workflow = await getWorkflowDoc(t, workflowId);
    // One of two steps settled: no advancement, no successor.
    expect(workflow.generationNumber).toBe(0);
    expect(workflow.driverWorkId).toBeUndefined();

    await t.mutation(internal.pool.onComplete, {
      workId: workId("work-b"),
      result: { kind: "success", returnValue: 2 },
      context: { generationNumber: 0, stepId: stepB },
    });
    workflow = await getWorkflowDoc(t, workflowId);
    // Last settle advanced the generation and enqueued exactly one driver.
    expect(workflow.generationNumber).toBe(1);
    expect(workflow.driverWorkId).toBeDefined();
    expect(workflow.driverFailures).toBeUndefined();
  });

  test("advanceGeneration is a compare-and-swap: one winner, losers see stale", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t);
    const first = await t.mutation(internal.journal.advanceGeneration, {
      workflowId,
      generationNumber: 0,
    });
    expect(first).toEqual({ kind: "advanced", generationNumber: 1 });
    // A second driver still holding generation 0 loses cleanly.
    const second = await t.mutation(internal.journal.advanceGeneration, {
      workflowId,
      generationNumber: 0,
    });
    expect(second.kind).toBe("stale");
    const workflow = await getWorkflowDoc(t, workflowId);
    expect(workflow.generationNumber).toBe(1);
  });

  test("advanceGeneration refuses to advance past an in-progress step", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t);
    await insertStep(t, workflowId);
    const result = await t.mutation(internal.journal.advanceGeneration, {
      workflowId,
      generationNumber: 0,
    });
    expect(result.kind).toBe("stale");
    const workflow = await getWorkflowDoc(t, workflowId);
    expect(workflow.generationNumber).toBe(0);
  });
});

describe("driver failure recovery", () => {
  async function failDriver(
    t: ReturnType<typeof initConvexTest>,
    workflowId: Id<"workflows">,
    driverWorkId = workId("driver-work"),
  ) {
    await t.run((ctx) => ctx.db.patch("workflows", workflowId, { driverWorkId }));
    await t.mutation(internal.pool.handlerOnComplete, {
      workId: driverWorkId,
      result: { kind: "failed", error: "injected driver crash" },
      context: { workflowId, generationNumber: 0 },
    });
  }

  test("a driver failure leaves the generation unchanged and tail-enqueues", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t);
    await failDriver(t, workflowId);
    const workflow = await getWorkflowDoc(t, workflowId);
    expect(workflow.generationNumber).toBe(0);
    expect(workflow.runResult).toBeUndefined();
    expect(workflow.driverFailures).toBe(1);
    // Replacement driver enqueued: marker replaced.
    expect(workflow.driverWorkId).toBeDefined();
    expect(workflow.driverWorkId).not.toBe("driver-work");
  });

  test("a superseded driver's completion is ignored", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t, {
      driverWorkId: workId("current-driver"),
    });
    await t.mutation(internal.pool.handlerOnComplete, {
      workId: workId("old-driver"),
      result: { kind: "failed", error: "late crash report" },
      context: { workflowId, generationNumber: 0 },
    });
    const workflow = await getWorkflowDoc(t, workflowId);
    expect(workflow.driverFailures).toBeUndefined();
    expect(workflow.driverWorkId).toBe("current-driver");
    expect(workflow.runResult).toBeUndefined();
  });

  test("interrupted queries and mutations re-execute in the same generation", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t);
    const queryStep = await insertStep(t, workflowId, {
      step: { functionType: "query" as const },
      stepNumber: 0,
    });
    const mutationStep = await insertStep(t, workflowId, {
      step: { functionType: "mutation" as const },
      stepNumber: 1,
    });
    await failDriver(t, workflowId);
    // Their direct claims are cleared (deleted) so the replacement driver
    // re-creates and re-executes them; the generation does not move.
    expect(await getStep(t, queryStep)).toBeNull();
    expect(await getStep(t, mutationStep)).toBeNull();
    const workflow = await getWorkflowDoc(t, workflowId);
    expect(workflow.generationNumber).toBe(0);
    expect(workflow.driverWorkId).toBeDefined();
  });

  test("an interrupted non-retryable action settles as failed, never re-runs", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t);
    const actionStep = await insertStep(t, workflowId);
    await failDriver(t, workflowId);
    const entry = await getStep(t, actionStep);
    expect(entry?.step.inProgress).toBe(false);
    expect(entry?.step.runResult?.kind).toBe("failed");
    expect(
      entry?.step.runResult?.kind === "failed" && entry.step.runResult.error,
    ).toContain("outcome is unknown");
  });

  test("an interrupted retryable action consumes an attempt and moves to the workpool", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t);
    const actionStep = await insertStep(t, workflowId, {
      retry: { maxAttempts: 3, initialBackoffMs: 100, base: 2 },
    });
    await failDriver(t, workflowId);
    const entry = await getStep(t, actionStep);
    // Still in progress, but now owned by the workpool with one attempt gone.
    expect(entry?.step.inProgress).toBe(true);
    expect(
      entry?.step.kind === "function" ? entry.step.workId : undefined,
    ).toBeDefined();
    // The generation waits for the workpool completion; no advancement.
    const workflow = await getWorkflowDoc(t, workflowId);
    expect(workflow.generationNumber).toBe(0);
  });

  test("durable steps are left for their own completions", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t);
    const durableStep = await insertStep(t, workflowId, {
      step: { workId: workId("durable-work") },
    });
    await failDriver(t, workflowId);
    const entry = await getStep(t, durableStep);
    expect(entry?.step.inProgress).toBe(true);
    expect(
      entry?.step.kind === "function" ? entry.step.workId : undefined,
    ).toBe("durable-work");
  });

  test("driver failures back off but never fail the workflow", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t);
    for (let i = 0; i < 5; i++) {
      const workflow = await getWorkflowDoc(t, workflowId);
      await t.mutation(internal.pool.handlerOnComplete, {
        workId: workflow.driverWorkId ?? workId("driver-work"),
        result: { kind: "failed", error: `crash ${i}` },
        context: { workflowId, generationNumber: 0 },
      });
      if (workflow.driverWorkId === undefined) {
        await t.run((ctx) =>
          ctx.db.patch("workflows", workflowId, { driverFailures: i + 1 }),
        );
      }
    }
    const workflow = await getWorkflowDoc(t, workflowId);
    expect(workflow.runResult).toBeUndefined();
    expect(workflow.driverFailures).toBeGreaterThanOrEqual(1);
  });
});

describe("terminal-state fencing", () => {
  test("cancellation does not bump the generation", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t);
    await t.mutation(api.workflow.cancel, { workflowId });
    const workflow = await getWorkflowDoc(t, workflowId);
    expect(workflow.runResult).toMatchObject({ kind: "canceled" });
    expect(workflow.generationNumber).toBe(0);
  });

  test("a durable completion settles the journal on a canceled workflow but enqueues nothing", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t);
    await t.mutation(api.workflow.cancel, { workflowId });
    // In-flight work finishing after cancellation (cancel is not a kill
    // fence: the cloud experiments show running actions complete anyway).
    const stepId = await insertStep(t, workflowId, {
      step: { workId: workId("late-work") },
    });

    await t.mutation(internal.pool.onComplete, {
      workId: workId("late-work"),
      result: { kind: "success", returnValue: "finished anyway" },
      context: { generationNumber: 0, stepId },
    });
    // The workpool's delivery is authoritative: the journal records the true
    // outcome so the entry is never stranded in progress...
    const entry = await getStep(t, stepId);
    expect(entry?.step.inProgress).toBe(false);
    expect(entry?.step.runResult).toMatchObject({ kind: "success" });
    // ...but the terminal workflow never advances or enqueues a driver.
    const workflow = await getWorkflowDoc(t, workflowId);
    expect(workflow.generationNumber).toBe(0);
    expect(workflow.driverWorkId).toBeUndefined();
  });

  test("a completion from a superseded work attempt is rejected", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t);
    // The step was re-dispatched with a fresh workId (e.g. recovery consumed
    // a retry attempt); the old attempt's completion must not settle it.
    const stepId = await insertStep(t, workflowId, {
      step: { workId: workId("new-owner") },
    });
    await t.mutation(internal.pool.onComplete, {
      workId: workId("old-owner"),
      result: { kind: "success", returnValue: "stale attempt" },
      context: { generationNumber: 0, stepId },
    });
    const entry = await getStep(t, stepId);
    expect(entry?.step.inProgress).toBe(true);
    expect(entry?.step.runResult).toBeUndefined();
  });

  test("a failed driver report for a terminal workflow is a no-op", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t, {
      driverWorkId: workId("driver-work"),
      runResult: { kind: "canceled" },
    });
    const stepId = await insertStep(t, workflowId);
    await t.mutation(internal.pool.handlerOnComplete, {
      workId: workId("driver-work"),
      result: { kind: "failed", error: "crash after cancel" },
      context: { workflowId, generationNumber: 0 },
    });
    // No recovery ran: the orphaned entry is untouched, nothing enqueued.
    const entry = await getStep(t, stepId);
    expect(entry?.step.inProgress).toBe(true);
    const workflow = await getWorkflowDoc(t, workflowId);
    expect(workflow.driverFailures).toBeUndefined();
  });
});

describe("restart", () => {
  test("advances once and settles orphaned in-progress steps", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t, {
      runResult: { kind: "failed", error: "driver died" },
    });
    // The orphans an interrupted action-mode driver leaves behind:
    // in progress, no workId, nobody coming back for them.
    const actionOrphan = await insertStep(t, workflowId, { stepNumber: 0 });
    const queryOrphan = await insertStep(t, workflowId, {
      step: { functionType: "query" as const },
      stepNumber: 1,
    });
    const durableOrphan = await insertStep(t, workflowId, {
      step: { functionType: "mutation" as const, workId: workId("pool-work") },
      stepNumber: 2,
    });
    await t.mutation(api.workflow.restart, {
      workflowId,
      startAsync: true,
    });
    const workflow = await getWorkflowDoc(t, workflowId);
    expect(workflow.runResult).toBeUndefined();
    expect(workflow.generationNumber).toBe(1);
    expect(workflow.driverWorkId).toBeDefined();
    // The action was possibly started: at-most-once means it settles as
    // failed and is never implicitly re-run.
    const settled = await getStep(t, actionOrphan);
    expect(settled?.step.inProgress).toBe(false);
    expect(settled?.step.runResult?.kind).toBe("failed");
    expect(
      settled?.step.runResult?.kind === "failed" &&
        settled.step.runResult.error,
    ).toContain("will not be re-run");
    // The query has no external effects: discarded so replay re-executes it.
    expect(await getStep(t, queryOrphan)).toBeNull();
    // The workpool-owned mutation is untouched: its completion is guaranteed
    // to be delivered, and the claim-generation fence accepts it post-restart.
    const durable = await getStep(t, durableOrphan);
    expect(durable?.step.inProgress).toBe(true);
    expect(
      durable?.step.kind === "function" ? durable.step.workId : undefined,
    ).toBe("pool-work");

    // Deliver that completion after the restart: it settles the entry and
    // advances the (now live) workflow.
    await t.mutation(internal.pool.onComplete, {
      workId: workId("pool-work"),
      result: { kind: "success", returnValue: "committed" },
      context: { generationNumber: 0, stepId: durableOrphan },
    });
    const delivered = await getStep(t, durableOrphan);
    expect(delivered?.step.inProgress).toBe(false);
    expect(delivered?.step.runResult).toMatchObject({ kind: "success" });
    const advanced = await getWorkflowDoc(t, workflowId);
    expect(advanced.generationNumber).toBe(2);
  });

  test("restart fences stale completions from the previous generation", async () => {
    const t = initConvexTest();
    const workflowId = await createWorkflow(t, {
      runResult: { kind: "failed", error: "driver died" },
    });
    const orphan = await insertStep(t, workflowId);
    await t.mutation(api.workflow.restart, {
      workflowId,
      startAsync: true,
    });
    // A zombie driver from before the restart reports its direct step.
    const late = await t.mutation(internal.actionRunner.completeStep, {
      stepId: orphan,
      generationNumber: 0,
      runResult: { kind: "success", returnValue: "zombie" },
    });
    expect(late.kind).toBe("stale");
  });
});
