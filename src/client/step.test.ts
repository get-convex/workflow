/// <reference types="vite/client" />

import { describe, it, expect, vi } from "vitest";
import { BaseChannel } from "async-channel";
import { StepExecutor, type StepRequest } from "./step.js";
import type { JournalEntry } from "../component/schema.js";
import type { BatchWorkpool } from "@convex-dev/workpool";
import { makeFunctionReference } from "convex/server";

// Mock createFunctionHandle to avoid needing a real Convex backend
vi.mock("convex/server", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return {
    ...mod,
    createFunctionHandle: vi.fn(async (ref: any) => {
      const addr = mod.getFunctionAddress as (ref: any) => any;
      return `function://${addr(ref).name ?? "unknown"}`;
    }),
  };
});

// Helper to create a mock function reference
function mockFnRef(name: string) {
  return makeFunctionReference(name) as any;
}

// Helper to create a StepRequest for an action
function actionMessage(
  name: string,
  fnName: string,
  args: Record<string, unknown> = {},
): StepRequest {
  return {
    name,
    target: {
      kind: "function",
      functionType: "action",
      function: mockFnRef(fnName),
      args,
    },
    retry: undefined,
    schedulerOptions: {},
    resolve: vi.fn(),
    reject: vi.fn(),
  };
}

// Helper to create a StepRequest for a mutation (non-batch-eligible)
function mutationMessage(
  name: string,
  fnName: string,
  args: Record<string, unknown> = {},
): StepRequest {
  return {
    name,
    target: {
      kind: "function",
      functionType: "mutation",
      function: mockFnRef(fnName),
      args,
    },
    retry: undefined,
    schedulerOptions: {},
    resolve: vi.fn(),
    reject: vi.fn(),
  };
}

// Helper to create a fake journal entry
function fakeEntry(stepNumber: number, name: string): JournalEntry {
  return {
    _id: `step_${stepNumber}`,
    _creationTime: Date.now(),
    workflowId: "wf_test" as any,
    stepNumber,
    step: {
      kind: "function" as const,
      functionType: "action" as const,
      handle: "function://test",
      name,
      inProgress: true,
      argsSize: 2,
      args: {},
      runResult: undefined,
      startedAt: Date.now(),
      completedAt: undefined,
    },
  };
}

function createMockBatch(registeredNames: string[]) {
  return {
    isRegistered: vi.fn((name: string) => registeredNames.includes(name)),
    resolveHandlerName: vi.fn((name: string) =>
      registeredNames.includes(name) ? `handler:${name}` : null,
    ),
    enqueueByHandle: vi.fn(async () => {}),
  } as unknown as BatchWorkpool;
}

function createExecutor(batch?: BatchWorkpool) {
  // Track which mutations are called and in what order
  const callLog: Array<{ mutation: string; names: string[] }> = [];

  let stepCounter = 0;
  const mockCtx = {
    runMutation: vi.fn(async (_ref: any, args: any) => {
      const mutationName =
        _ref === mockComponent.journal.startSteps
          ? "startSteps"
          : _ref === mockComponent.journal.startBatchSteps
            ? "startBatchSteps"
            : "unknown";
      const names = args.steps.map((s: any) => s.step.name);
      callLog.push({ mutation: mutationName, names });

      const entries = args.steps.map((s: any) => {
        const entry = fakeEntry(stepCounter, s.step.name);
        stepCounter++;
        return entry;
      });

      if (mutationName === "startBatchSteps") {
        return { entries, onCompleteHandle: "function://onComplete" };
      }
      return entries;
    }),
  } as any;

  const mockComponent = {
    journal: {
      startSteps: { __type: "startSteps" } as any,
      startBatchSteps: { __type: "startBatchSteps" } as any,
    },
  } as any;

  // Patch the mock to use the component refs
  mockCtx.runMutation.mockImplementation(async (_ref: any, args: any) => {
    const mutationName =
      _ref === mockComponent.journal.startSteps
        ? "startSteps"
        : _ref === mockComponent.journal.startBatchSteps
          ? "startBatchSteps"
          : "unknown";
    const names = args.steps.map((s: any) => s.step.name);
    callLog.push({ mutation: mutationName, names });

    const entries = args.steps.map((s: any) => {
      const entry = fakeEntry(stepCounter, s.step.name);
      stepCounter++;
      return entry;
    });

    if (mutationName === "startBatchSteps") {
      return { entries, onCompleteHandle: "function://onComplete" };
    }
    return entries;
  });

  const channel = new BaseChannel<StepRequest>(100);
  const executor = new StepExecutor(
    "wf_test",
    1,
    mockCtx,
    mockComponent,
    [],
    channel,
    Date.now(),
    undefined,
    batch,
  );

  return { executor, callLog, mockCtx };
}

describe("StepExecutor.startSteps", () => {
  it("routes all messages through regular when no batch is configured", async () => {
    const { executor, callLog } = createExecutor();

    const messages = [
      actionMessage("step1", "module:action1"),
      actionMessage("step2", "module:action2"),
    ];

    const entries = await executor.startSteps(messages);

    expect(callLog).toHaveLength(1);
    expect(callLog[0].mutation).toBe("startSteps");
    expect(callLog[0].names).toEqual(["step1", "step2"]);
    expect(entries).toHaveLength(2);
  });

  it("routes all messages through regular when none are batch-registered", async () => {
    const batch = createMockBatch([]); // nothing registered
    const { executor, callLog } = createExecutor(batch);

    const messages = [
      actionMessage("step1", "module:action1"),
      actionMessage("step2", "module:action2"),
    ];

    const entries = await executor.startSteps(messages);

    expect(callLog).toHaveLength(1);
    expect(callLog[0].mutation).toBe("startSteps");
    expect(entries).toHaveLength(2);
  });

  it("routes all batch-eligible messages through batch", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const { executor, callLog } = createExecutor(batch);

    const messages = [
      actionMessage("step1", "module:batchAction", { a: 1 }),
      actionMessage("step2", "module:batchAction", { a: 2 }),
    ];

    const entries = await executor.startSteps(messages);

    expect(callLog).toHaveLength(1);
    expect(callLog[0].mutation).toBe("startBatchSteps");
    expect(callLog[0].names).toEqual(["step1", "step2"]);
    expect(entries).toHaveLength(2);
  });

  it("preserves original message order for interleaved batch/regular steps", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const { executor, callLog } = createExecutor(batch);

    // Interleaved: batch, regular, batch
    const messages = [
      actionMessage("batch1", "module:batchAction"),
      mutationMessage("regular1", "module:myMutation"),
      actionMessage("batch2", "module:batchAction"),
    ];

    const entries = await executor.startSteps(messages);

    // Should process 3 contiguous groups in order
    expect(callLog).toHaveLength(3);
    expect(callLog[0]).toEqual({
      mutation: "startBatchSteps",
      names: ["batch1"],
    });
    expect(callLog[1]).toEqual({
      mutation: "startSteps",
      names: ["regular1"],
    });
    expect(callLog[2]).toEqual({
      mutation: "startBatchSteps",
      names: ["batch2"],
    });

    // Step numbers should be in original message order
    expect(entries.map((e) => e.step.name)).toEqual([
      "batch1",
      "regular1",
      "batch2",
    ]);
    expect(entries.map((e) => e.stepNumber)).toEqual([0, 1, 2]);
  });

  it("handles contiguous groups correctly", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const { executor, callLog } = createExecutor(batch);

    // Two batch, two regular, one batch
    const messages = [
      actionMessage("b1", "module:batchAction"),
      actionMessage("b2", "module:batchAction"),
      mutationMessage("r1", "module:myMutation"),
      mutationMessage("r2", "module:myMutation"),
      actionMessage("b3", "module:batchAction"),
    ];

    const entries = await executor.startSteps(messages);

    expect(callLog).toHaveLength(3);
    expect(callLog[0]).toEqual({
      mutation: "startBatchSteps",
      names: ["b1", "b2"],
    });
    expect(callLog[1]).toEqual({
      mutation: "startSteps",
      names: ["r1", "r2"],
    });
    expect(callLog[2]).toEqual({
      mutation: "startBatchSteps",
      names: ["b3"],
    });

    expect(entries.map((e) => e.step.name)).toEqual([
      "b1",
      "b2",
      "r1",
      "r2",
      "b3",
    ]);
    expect(entries.map((e) => e.stepNumber)).toEqual([0, 1, 2, 3, 4]);
  });

  it("mutations are never batch-eligible even with batch configured", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const { executor, callLog } = createExecutor(batch);

    const messages = [
      mutationMessage("mut1", "module:myMutation"),
      mutationMessage("mut2", "module:myMutation"),
    ];

    const entries = await executor.startSteps(messages);

    expect(callLog).toHaveLength(1);
    expect(callLog[0].mutation).toBe("startSteps");
    expect(entries).toHaveLength(2);
  });

  it("unregistered actions go through regular workpool", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const { executor, callLog } = createExecutor(batch);

    const messages = [
      actionMessage("step1", "module:nonBatchAction"),
      actionMessage("step2", "module:batchAction"),
    ];

    const entries = await executor.startSteps(messages);

    // nonBatchAction is regular, batchAction is batch
    expect(callLog).toHaveLength(2);
    expect(callLog[0]).toEqual({
      mutation: "startSteps",
      names: ["step1"],
    });
    expect(callLog[1]).toEqual({
      mutation: "startBatchSteps",
      names: ["step2"],
    });
    expect(entries.map((e) => e.stepNumber)).toEqual([0, 1]);
  });
});
