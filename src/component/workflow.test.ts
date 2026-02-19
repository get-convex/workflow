/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import type { Id } from "./_generated/dataModel.js";

describe("workflow", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("can create a workflow async", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://internal.example.exampleWorkflow",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });
    const workflow = await t.query(api.workflow.getStatus, { workflowId: id });
    expect(workflow.workflow.name).toBe("test");
    expect(workflow.workflow.args).toEqual({ location: "San Francisco" });
    expect(workflow.workflow.runResult).toBeUndefined();
    expect(workflow.inProgress).toHaveLength(0);
  });

  test("can cancel a workflow", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://internal.example.exampleWorkflow",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });
    const workflow = await t.query(api.workflow.getStatus, { workflowId: id });
    expect(workflow.workflow.runResult).toBeUndefined();
    await t.mutation(api.workflow.cancel, { workflowId: id });
    const workflow2 = await t.query(api.workflow.getStatus, { workflowId: id });
    expect(workflow2.workflow.runResult).toMatchObject({ kind: "canceled" });
  });

  test("cleaning up a workflow", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://internal.example.exampleWorkflow",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });
    const workflow = await t.query(api.workflow.getStatus, { workflowId: id });
    expect(workflow.workflow.runResult).toBeUndefined();
    await t.mutation(api.workflow.cancel, { workflowId: id });
    const workflow2 = await t.query(api.workflow.getStatus, { workflowId: id });
    expect(workflow2.workflow.runResult).toMatchObject({ kind: "canceled" });
    const cleaned = await t.mutation(api.workflow.cleanup, { workflowId: id });
    expect(cleaned).toBe(true);
    await t.run(async (ctx) => {
      const workflow = await ctx.db.get(id);
      expect(workflow).toBeNull();
    });
  });

  test("cleanup deletes associated events", async () => {
    const t = initConvexTest();

    // Create a workflow
    const workflowId = await t.mutation(api.workflow.create, {
      workflowName: "test-with-event",
      workflowHandle: "function://internal.example.exampleWorkflow",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });

    // Create an event associated with the workflow
    const eventId = await t.mutation(api.event.create, {
      name: "test-event",
      workflowId,
    });

    // Create a step entry with kind "event" that references the event using startSteps API
    const entries = await t.mutation(api.journal.startSteps, {
      workflowId,
      generationNumber: 0,
      steps: [
        {
          step: {
            kind: "event" as const,
            name: "test-event-step",
            inProgress: true,
            argsSize: 0,
            args: { eventId },
            startedAt: Date.now(),
          },
        },
      ],
    });
    const stepId = entries[0]._id as Id<"steps">;

    // Verify event exists
    await t.run(async (ctx) => {
      const event = await ctx.db.get(eventId);
      expect(event).not.toBeNull();
    });

    // Cancel the workflow so it can be cleaned up
    await t.mutation(api.workflow.cancel, { workflowId });

    // Clean up the workflow
    const cleaned = await t.mutation(api.workflow.cleanup, {
      workflowId,
    });
    expect(cleaned).toBe(true);

    // Verify the workflow is deleted
    await t.run(async (ctx) => {
      const workflow = await ctx.db.get(workflowId);
      expect(workflow).toBeNull();
    });

    // Verify the step is deleted
    await t.run(async (ctx) => {
      const step = await ctx.db.get(stepId);
      expect(step).toBeNull();
    });

    // Verify the event is deleted
    await t.run(async (ctx) => {
      const event = await ctx.db.get(eventId);
      expect(event).toBeNull();
    });
  });

  test("cleanup enqueues cleanup for nested workflows", async () => {
    const t = initConvexTest();

    // Create a parent workflow
    const parentWorkflowId = await t.mutation(api.workflow.create, {
      workflowName: "parent-workflow",
      workflowHandle: "function://internal.example.exampleWorkflow",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });

    // Create a workflow step which will automatically create a nested workflow via startSteps
    // The startSteps handler creates the nested workflow when kind is "workflow"
    const entries = await t.mutation(api.journal.startSteps, {
      workflowId: parentWorkflowId,
      generationNumber: 0,
      steps: [
        {
          step: {
            kind: "workflow" as const,
            name: "nested-workflow-step",
            handle: "function://internal.example.exampleWorkflow",
            inProgress: true,
            argsSize: 0,
            args: { location: "New York" },
            startedAt: Date.now(),
          },
        },
      ],
    });
    const stepId = entries[0]._id as Id<"steps">;

    // Get the nested workflow ID that was created by startSteps
    let nestedWorkflowId: Id<"workflows"> | undefined;
    await t.run(async (ctx) => {
      const step = await ctx.db.get(stepId);
      if (step && step.step.kind === "workflow") {
        nestedWorkflowId = step.step.workflowId;
      }
    });
    expect(nestedWorkflowId).toBeDefined();

    // Cancel parent workflow so it can be cleaned up
    await t.mutation(api.workflow.cancel, { workflowId: parentWorkflowId });

    // Check nested workflow status - it may already be completed
    // If it's still running, cancel it. If already completed, that's fine too.
    let nestedWorkflowCompleted = false;
    await t.run(async (ctx) => {
      const nested = await ctx.db.get(nestedWorkflowId!);
      if (nested?.runResult) {
        nestedWorkflowCompleted = true;
      }
    });
    if (!nestedWorkflowCompleted) {
      await t.mutation(api.workflow.cancel, { workflowId: nestedWorkflowId! });
    }

    // Verify both workflows exist before cleanup
    await t.run(async (ctx) => {
      const parent = await ctx.db.get(parentWorkflowId);
      const nested = await ctx.db.get(nestedWorkflowId!);
      expect(parent).not.toBeNull();
      expect(nested).not.toBeNull();
    });

    // Clean up the parent workflow
    const cleaned = await t.mutation(api.workflow.cleanup, {
      workflowId: parentWorkflowId,
    });
    expect(cleaned).toBe(true);

    // Verify the parent workflow is deleted
    await t.run(async (ctx) => {
      const parent = await ctx.db.get(parentWorkflowId);
      expect(parent).toBeNull();
    });

    // Verify the step is deleted
    await t.run(async (ctx) => {
      const step = await ctx.db.get(stepId);
      expect(step).toBeNull();
    });

    // The nested workflow cleanup is enqueued via workpool.
    // Run scheduled functions to process the cleanup.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Verify the nested workflow is also cleaned up
    await t.run(async (ctx) => {
      const nested = await ctx.db.get(nestedWorkflowId!);
      expect(nested).toBeNull();
    });
  });

  test("cleanup handles workflow step without workflowId", async () => {
    const t = initConvexTest();

    // Create a workflow
    const workflowId = await t.mutation(api.workflow.create, {
      workflowName: "test-workflow",
      workflowHandle: "function://internal.example.exampleWorkflow",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });

    // Create a workflow step without workflowId (not yet started nested workflow) using startSteps
    await t.mutation(api.journal.startSteps, {
      workflowId,
      generationNumber: 0,
      steps: [
        {
          step: {
            kind: "workflow" as const,
            name: "pending-nested-workflow",
            handle: "function://internal.example.exampleWorkflow",
            inProgress: true,
            argsSize: 0,
            args: { location: "Boston" },
            startedAt: Date.now(),
          },
        },
      ],
    });

    // Cancel the workflow
    await t.mutation(api.workflow.cancel, { workflowId });

    // Cleanup should succeed without errors
    const cleaned = await t.mutation(api.workflow.cleanup, { workflowId });
    expect(cleaned).toBe(true);

    // Verify the workflow is deleted
    await t.run(async (ctx) => {
      const workflow = await ctx.db.get(workflowId);
      expect(workflow).toBeNull();
    });
  });

  test("cleanup handles event step without eventId", async () => {
    const t = initConvexTest();

    // Create a workflow
    const workflowId = await t.mutation(api.workflow.create, {
      workflowName: "test-workflow",
      workflowHandle: "function://internal.example.exampleWorkflow",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });

    // Create an event step that starts waiting (no event sent yet, so it won't have a response)
    await t.mutation(api.journal.startSteps, {
      workflowId,
      generationNumber: 0,
      steps: [
        {
          step: {
            kind: "event" as const,
            name: "pending-event",
            inProgress: true,
            argsSize: 0,
            args: {},
            startedAt: Date.now(),
          },
        },
      ],
    });

    // Cancel the workflow
    await t.mutation(api.workflow.cancel, { workflowId });

    // Cleanup should succeed without errors (eventId is set by awaitEvent)
    const cleaned = await t.mutation(api.workflow.cleanup, { workflowId });
    expect(cleaned).toBe(true);

    // Verify the workflow is deleted
    await t.run(async (ctx) => {
      const workflow = await ctx.db.get(workflowId);
      expect(workflow).toBeNull();
    });
  });

  test("cleanup with mixed event and workflow steps", async () => {
    const t = initConvexTest();

    // Create parent workflow
    const parentWorkflowId = await t.mutation(api.workflow.create, {
      workflowName: "parent-workflow",
      workflowHandle: "function://internal.example.exampleWorkflow",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });

    // Create an event
    const eventId = await t.mutation(api.event.create, {
      name: "test-event",
      workflowId: parentWorkflowId,
    });

    // Create mixed steps using startSteps API
    // The workflow step will automatically create a nested workflow
    const entries = await t.mutation(api.journal.startSteps, {
      workflowId: parentWorkflowId,
      generationNumber: 0,
      steps: [
        {
          step: {
            kind: "event" as const,
            name: "event-step",
            inProgress: true,
            argsSize: 0,
            args: { eventId },
            startedAt: Date.now(),
          },
        },
        {
          step: {
            kind: "workflow" as const,
            name: "workflow-step",
            handle: "function://internal.example.exampleWorkflow",
            inProgress: true,
            argsSize: 0,
            args: { location: "New York" },
            startedAt: Date.now(),
          },
        },
      ],
    });

    // Get the nested workflow ID that was created by startSteps
    const workflowStepId = entries[1]._id as Id<"steps">;
    let nestedWorkflowId: Id<"workflows"> | undefined;
    await t.run(async (ctx) => {
      const step = await ctx.db.get(workflowStepId);
      if (step && step.step.kind === "workflow") {
        nestedWorkflowId = step.step.workflowId;
      }
    });
    expect(nestedWorkflowId).toBeDefined();

    // Cancel parent workflow
    await t.mutation(api.workflow.cancel, { workflowId: parentWorkflowId });

    // Check nested workflow status - it may already be completed
    // If it's still running, cancel it. If already completed, that's fine too.
    let nestedWorkflowCompleted = false;
    await t.run(async (ctx) => {
      const nested = await ctx.db.get(nestedWorkflowId!);
      if (nested?.runResult) {
        nestedWorkflowCompleted = true;
      }
    });
    if (!nestedWorkflowCompleted) {
      await t.mutation(api.workflow.cancel, { workflowId: nestedWorkflowId! });
    }

    // Verify resources exist before cleanup
    await t.run(async (ctx) => {
      const parent = await ctx.db.get(parentWorkflowId);
      const nested = await ctx.db.get(nestedWorkflowId!);
      const event = await ctx.db.get(eventId);
      expect(parent).not.toBeNull();
      expect(nested).not.toBeNull();
      expect(event).not.toBeNull();
    });

    // Clean up the parent workflow
    const cleaned = await t.mutation(api.workflow.cleanup, {
      workflowId: parentWorkflowId,
    });
    expect(cleaned).toBe(true);

    // Run scheduled functions to process nested cleanup
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Verify all resources are cleaned up
    await t.run(async (ctx) => {
      const parent = await ctx.db.get(parentWorkflowId);
      const nested = await ctx.db.get(nestedWorkflowId!);
      const event = await ctx.db.get(eventId);
      expect(parent).toBeNull();
      expect(nested).toBeNull();
      expect(event).toBeNull();
    });
  });
});
