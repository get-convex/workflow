/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import type { Id } from "./_generated/dataModel.js";

/**
 * Integration tests for batchGroup steps, exercising real Convex mutations
 * against the convex-test in-memory backend.
 *
 * These test the component-side code that unit tests can't reach:
 * - startBatchGroupStep (journal.ts)
 * - onCompleteBatchGroupItem (pool.ts)
 * - _checkBatchCompletion (pool.ts)
 * - loadBatchResults (journal.ts)
 * - cleanup with batchResults (workflow.ts)
 * - cancel mid-batchGroup (workflow.ts)
 */

// Helper: create a workflow and return its ID + generationNumber
async function createTestWorkflow(t: ReturnType<typeof initConvexTest>) {
  const id = await t.mutation(api.workflow.create, {
    workflowName: "batchTest",
    workflowHandle: "function://internal.example.exampleWorkflow",
    workflowArgs: {},
    startAsync: true,
  });
  return { workflowId: id, generationNumber: 0 };
}

describe("startBatchGroupStep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("creates a single step doc with kind=batchGroup", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    const result = await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 10,
    });

    expect(result.entry.step.kind).toBe("batchGroup");
    expect(result.entry.step.count).toBe(10);
    expect(result.entry.step.inProgress).toBe(true);
    expect(result.entry.step.name).toBe("batchGroup");
    expect(result.onCompleteHandle).toBeTruthy();
  });

  test("step has correct stepNumber based on existing steps", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    // Create a regular step first (stepNumber 0)
    await t.mutation(api.journal.startSteps, {
      workflowId,
      generationNumber,
      steps: [
        {
          step: {
            kind: "function" as const,
            functionType: "action" as const,
            handle: "function://test",
            name: "regularStep",
            inProgress: true,
            argsSize: 2,
            args: {},
            startedAt: Date.now(),
          },
        },
      ],
    });

    // Now create a batchGroup step (should be stepNumber 1)
    const result = await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 5,
    });

    expect(result.entry.stepNumber).toBe(1);
  });

  test("schedules _checkBatchCompletion poller", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 3,
    });

    // The poller should have been scheduled. Running scheduled functions
    // should trigger it (though it will just re-schedule since no results yet).
    // We verify it doesn't crash.
    const timer = vi.advanceTimersByTime;
    await t.finishAllScheduledFunctions(timer);
  });

  test("rejects if workflow is already completed", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    // Cancel the workflow (marks it as completed)
    await t.mutation(api.workflow.cancel, { workflowId });

    // Should throw — either "not running" or "Invalid generation number"
    // (cancel bumps generationNumber, so the old one is stale)
    await expect(
      t.mutation(api.journal.startBatchGroupStep, {
        workflowId,
        generationNumber,
        count: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("onCompleteBatchGroupItem", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("inserts a result doc into batchResults", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    const { entry } = await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 3,
    });

    // Simulate item 0 completing
    await t.mutation(internal.pool.onCompleteBatchGroupItem, {
      workId: "work_123" as any,
      result: { kind: "success", returnValue: "result_0" },
      context: { batchStepId: entry._id, index: 0 },
    });

    // Verify the result was inserted
    const results = await t.query(api.journal.loadBatchResults, {
      batchStepId: entry._id as Id<"steps">,
    });
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(0);
    expect(results[0].result).toEqual({
      kind: "success",
      returnValue: "result_0",
    });
  });

  test("multiple items create separate result docs (no OCC contention)", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    const { entry } = await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 5,
    });

    // Simulate all 5 items completing (in arbitrary order)
    for (const i of [3, 0, 4, 1, 2]) {
      await t.mutation(internal.pool.onCompleteBatchGroupItem, {
        workId: `work_${i}` as any,
        result: { kind: "success", returnValue: `result_${i}` },
        context: { batchStepId: entry._id, index: i },
      });
    }

    // All 5 should be present
    const results = await t.query(api.journal.loadBatchResults, {
      batchStepId: entry._id as Id<"steps">,
    });
    expect(results).toHaveLength(5);
    // Results should be sorted by index
    for (let i = 0; i < 5; i++) {
      expect(results[i].index).toBe(i);
      expect(results[i].result).toEqual({
        kind: "success",
        returnValue: `result_${i}`,
      });
    }
  });

  test("handles failed and canceled results", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    const { entry } = await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 3,
    });

    await t.mutation(internal.pool.onCompleteBatchGroupItem, {
      workId: "w0" as any,
      result: { kind: "success", returnValue: "ok" },
      context: { batchStepId: entry._id, index: 0 },
    });
    await t.mutation(internal.pool.onCompleteBatchGroupItem, {
      workId: "w1" as any,
      result: { kind: "failed", error: "boom" },
      context: { batchStepId: entry._id, index: 1 },
    });
    await t.mutation(internal.pool.onCompleteBatchGroupItem, {
      workId: "w2" as any,
      result: { kind: "canceled" },
      context: { batchStepId: entry._id, index: 2 },
    });

    const results = await t.query(api.journal.loadBatchResults, {
      batchStepId: entry._id as Id<"steps">,
    });
    expect(results).toHaveLength(3);
    expect(results[0].result.kind).toBe("success");
    expect(results[1].result.kind).toBe("failed");
    expect(results[2].result.kind).toBe("canceled");
  });

  test("silently ignores invalid batchStepId", async () => {
    const t = initConvexTest();

    // Should not throw — just return without inserting
    await t.mutation(internal.pool.onCompleteBatchGroupItem, {
      workId: "w0" as any,
      result: { kind: "success", returnValue: "ok" },
      context: { batchStepId: "invalid_id", index: 0 },
    });
  });
});

describe("_checkBatchCompletion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("marks batchGroup complete when all results are in", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    const { entry } = await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 3,
    });

    // Insert all 3 results
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.pool.onCompleteBatchGroupItem, {
        workId: `w${i}` as any,
        result: { kind: "success", returnValue: `r${i}` },
        context: { batchStepId: entry._id, index: i },
      });
    }

    // Run the poller — it should mark the step as complete
    await t.mutation(internal.pool._checkBatchCompletion, {
      workflowId,
      generationNumber,
    });

    // Verify step is no longer in progress
    const step = await t.run(async (ctx) => {
      return ctx.db.get(entry._id as Id<"steps">);
    });
    expect(step).not.toBeNull();
    expect(step!.step.inProgress).toBe(false);
    expect(step!.step.runResult).toEqual({
      kind: "success",
      returnValue: null,
    });
  });

  test("re-schedules poll when results are incomplete", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    const { entry } = await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 3,
    });

    // Insert only 1 of 3 results
    await t.mutation(internal.pool.onCompleteBatchGroupItem, {
      workId: "w0" as any,
      result: { kind: "success", returnValue: "r0" },
      context: { batchStepId: entry._id, index: 0 },
    });

    // Run the poller — should NOT mark complete, should re-schedule
    await t.mutation(internal.pool._checkBatchCompletion, {
      workflowId,
      generationNumber,
    });

    // Step should still be in progress
    const step = await t.run(async (ctx) => {
      return ctx.db.get(entry._id as Id<"steps">);
    });
    expect(step!.step.inProgress).toBe(true);
  });

  test("stops polling when workflow generationNumber changes", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 3,
    });

    // Cancel the workflow (bumps generationNumber)
    await t.mutation(api.workflow.cancel, { workflowId });

    // Run the poller with the OLD generationNumber — should be a no-op
    // (no crash, no re-enqueue)
    await t.mutation(internal.pool._checkBatchCompletion, {
      workflowId,
      generationNumber, // old generation
    });

    // Workflow should still be canceled
    const status = await t.query(api.workflow.getStatus, { workflowId });
    expect(status.workflow.runResult?.kind).toBe("canceled");
  });

  test("stops polling when workflow is already completed", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 2,
    });

    // Complete the workflow manually
    await t.mutation(api.workflow.complete, {
      workflowId,
      generationNumber,
      runResult: { kind: "success", returnValue: "done" },
    });

    // Poller should not crash or re-enqueue
    await t.mutation(internal.pool._checkBatchCompletion, {
      workflowId,
      generationNumber,
    });
  });
});

describe("cleanup with batchResults", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("deletes batchResults when cleaning up a batchGroup workflow", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    const { entry } = await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 3,
    });

    // Insert results
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.pool.onCompleteBatchGroupItem, {
        workId: `w${i}` as any,
        result: { kind: "success", returnValue: `r${i}` },
        context: { batchStepId: entry._id, index: i },
      });
    }

    // Mark step as complete
    await t.mutation(internal.pool._checkBatchCompletion, {
      workflowId,
      generationNumber,
    });

    // Complete the workflow so cleanup is allowed
    await t.mutation(api.workflow.cancel, { workflowId });

    // Clean up
    const cleaned = await t.mutation(api.workflow.cleanup, { workflowId });
    expect(cleaned).toBe(true);

    // Verify everything is gone
    await t.run(async (ctx) => {
      // Workflow doc gone
      const workflow = await ctx.db.get(workflowId);
      expect(workflow).toBeNull();

      // Step doc gone
      const step = await ctx.db.get(entry._id as Id<"steps">);
      expect(step).toBeNull();

      // All batchResults gone
      const remaining = await ctx.db
        .query("batchResults")
        .withIndex("batchStep", (q) =>
          q.eq("batchStepId", entry._id as Id<"steps">),
        )
        .collect();
      expect(remaining).toHaveLength(0);
    });
  });

  test("cleanup handles workflow with mixed regular + batchGroup steps", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    // Create a regular step
    const regularEntries = await t.mutation(api.journal.startSteps, {
      workflowId,
      generationNumber,
      steps: [
        {
          step: {
            kind: "function" as const,
            functionType: "action" as const,
            handle: "function://test",
            name: "regularStep",
            inProgress: true,
            argsSize: 2,
            args: {},
            startedAt: Date.now(),
          },
        },
      ],
    });

    // Create a batchGroup step
    const { entry: bgEntry } = await t.mutation(
      api.journal.startBatchGroupStep,
      {
        workflowId,
        generationNumber,
        count: 2,
      },
    );

    // Insert batch results
    for (let i = 0; i < 2; i++) {
      await t.mutation(internal.pool.onCompleteBatchGroupItem, {
        workId: `w${i}` as any,
        result: { kind: "success", returnValue: `r${i}` },
        context: { batchStepId: bgEntry._id, index: i },
      });
    }

    // Cancel and cleanup
    await t.mutation(api.workflow.cancel, { workflowId });
    const cleaned = await t.mutation(api.workflow.cleanup, { workflowId });
    expect(cleaned).toBe(true);

    // Everything gone
    await t.run(async (ctx) => {
      const workflow = await ctx.db.get(workflowId);
      expect(workflow).toBeNull();

      // Both steps gone
      const steps = await ctx.db
        .query("steps")
        .withIndex("workflow", (q) => q.eq("workflowId", workflowId))
        .collect();
      expect(steps).toHaveLength(0);

      // All batchResults gone
      const batchResults = await ctx.db.query("batchResults").collect();
      expect(batchResults).toHaveLength(0);
    });
  });
});

describe("cancel mid-batchGroup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("canceling workflow with in-progress batchGroup bumps generationNumber", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    // Create batchGroup step (in progress)
    const { entry } = await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 100,
    });

    // Cancel while batchGroup is in flight
    await t.mutation(api.workflow.cancel, { workflowId });

    // Verify workflow is canceled with bumped generationNumber
    const status = await t.query(api.workflow.getStatus, { workflowId });
    expect(status.workflow.runResult?.kind).toBe("canceled");
    expect(status.workflow.generationNumber).toBe(generationNumber + 1);
  });

  test("results arriving after cancel don't crash", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    const { entry } = await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 3,
    });

    // Cancel
    await t.mutation(api.workflow.cancel, { workflowId });

    // Results arrive late — should not crash
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.pool.onCompleteBatchGroupItem, {
        workId: `w${i}` as any,
        result: { kind: "success", returnValue: `r${i}` },
        context: { batchStepId: entry._id, index: i },
      });
    }

    // Results are still written (orphaned but harmless)
    const results = await t.query(api.journal.loadBatchResults, {
      batchStepId: entry._id as Id<"steps">,
    });
    expect(results).toHaveLength(3);
  });

  test("poller does not re-enqueue workflow after cancel", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    const { entry } = await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 2,
    });

    // Insert all results
    for (let i = 0; i < 2; i++) {
      await t.mutation(internal.pool.onCompleteBatchGroupItem, {
        workId: `w${i}` as any,
        result: { kind: "success", returnValue: `r${i}` },
        context: { batchStepId: entry._id, index: i },
      });
    }

    // Cancel BEFORE poller runs
    await t.mutation(api.workflow.cancel, { workflowId });

    // Run poller with old generationNumber — should detect mismatch and stop
    await t.mutation(internal.pool._checkBatchCompletion, {
      workflowId,
      generationNumber, // old generation, workflow was bumped
    });

    // Workflow should still be canceled, not re-enqueued
    const status = await t.query(api.workflow.getStatus, { workflowId });
    expect(status.workflow.runResult?.kind).toBe("canceled");
  });
});

describe("loadBatchResults", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns results sorted by index", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    const { entry } = await t.mutation(api.journal.startBatchGroupStep, {
      workflowId,
      generationNumber,
      count: 5,
    });

    // Insert in reverse order
    for (let i = 4; i >= 0; i--) {
      await t.mutation(internal.pool.onCompleteBatchGroupItem, {
        workId: `w${i}` as any,
        result: { kind: "success", returnValue: `r${i}` },
        context: { batchStepId: entry._id, index: i },
      });
    }

    const results = await t.query(api.journal.loadBatchResults, {
      batchStepId: entry._id as Id<"steps">,
    });
    expect(results).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(results[i].index).toBe(i);
    }
  });

  test("returns empty array for non-existent batchStepId", async () => {
    const t = initConvexTest();
    const { workflowId, generationNumber } = await createTestWorkflow(t);

    // Create a regular step (not batchGroup) to get a valid step ID
    const entries = await t.mutation(api.journal.startSteps, {
      workflowId,
      generationNumber,
      steps: [
        {
          step: {
            kind: "function" as const,
            functionType: "action" as const,
            handle: "function://test",
            name: "notBatch",
            inProgress: true,
            argsSize: 2,
            args: {},
            startedAt: Date.now(),
          },
        },
      ],
    });

    // Query batchResults for a step that has no batch results
    const results = await t.query(api.journal.loadBatchResults, {
      batchStepId: entries[0]._id as Id<"steps">,
    });
    expect(results).toHaveLength(0);
  });
});
