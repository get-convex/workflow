/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

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
});
