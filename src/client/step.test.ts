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

// Helper to create a fake journal entry (function kind)
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

// Helper to create a fake batchGroup journal entry
function fakeBatchGroupEntry(
  stepNumber: number,
  count: number,
  opts?: { inProgress?: boolean },
): JournalEntry {
  return {
    _id: `step_bg_${stepNumber}`,
    _creationTime: Date.now(),
    workflowId: "wf_test" as any,
    stepNumber,
    step: {
      kind: "batchGroup" as const,
      count,
      name: "batchGroup",
      inProgress: opts?.inProgress ?? false,
      argsSize: 0,
      args: {},
      runResult:
        opts?.inProgress === true
          ? undefined
          : { kind: "success" as const, returnValue: null },
      startedAt: Date.now(),
      completedAt: opts?.inProgress === true ? undefined : Date.now(),
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
    options: { maxWorkers: 2 },
    component: {
      batch: {
        enqueueBatch: { __type: "enqueueBatch" } as any,
      },
    },
  } as unknown as BatchWorkpool;
}

function createExecutor(
  opts?: {
    batch?: BatchWorkpool;
    journalEntries?: JournalEntry[];
  },
) {
  const batch = opts?.batch;
  const journalEntries = opts?.journalEntries ?? [];

  // Track which mutations/queries are called and in what order
  const callLog: Array<{ mutation: string; names?: string[]; count?: number }> =
    [];

  let stepCounter = 0;
  const mockComponent = {
    journal: {
      startSteps: { __type: "startSteps" } as any,
      startBatchSteps: { __type: "startBatchSteps" } as any,
      startBatchGroupStep: { __type: "startBatchGroupStep" } as any,
      loadBatchResults: { __type: "loadBatchResults" } as any,
    },
  } as any;

  // Mock batch results that can be pre-loaded for replay tests
  let mockBatchResults: Array<{
    index: number;
    result: { kind: string; returnValue?: unknown; error?: string };
  }> = [];

  const batchEnqueueRef = batch
    ? (batch as any).component.batch.enqueueBatch
    : null;

  const mockCtx = {
    runMutation: vi.fn(async (_ref: any, args: any) => {
      if (batchEnqueueRef && _ref === batchEnqueueRef) {
        callLog.push({
          mutation: "batchEnqueueBatch",
          names: args.tasks.map((t: any) => t.name),
        });
        return args.tasks.map(() => "task_id");
      }
      if (_ref === mockComponent.journal.startBatchGroupStep) {
        const entry = fakeBatchGroupEntry(stepCounter, args.count, {
          inProgress: true,
        });
        stepCounter++;
        callLog.push({
          mutation: "startBatchGroupStep",
          count: args.count,
        });
        return { entry, onCompleteHandle: "function://onComplete" };
      }
      if (_ref === mockComponent.journal.startBatchSteps) {
        const names = args.steps.map((s: any) => s.step.name);
        callLog.push({ mutation: "startBatchSteps", names });
        const entries = args.steps.map((s: any) => {
          const entry = fakeEntry(stepCounter, s.step.name);
          stepCounter++;
          return entry;
        });
        return { entries, onCompleteHandle: "function://onComplete" };
      }
      if (_ref === mockComponent.journal.startSteps) {
        const names = args.steps.map((s: any) => s.step.name);
        callLog.push({ mutation: "startSteps", names });
        const entries = args.steps.map((s: any) => {
          const entry = fakeEntry(stepCounter, s.step.name);
          stepCounter++;
          return entry;
        });
        return entries;
      }
      callLog.push({ mutation: "unknown" });
      return null;
    }),
    runQuery: vi.fn(async (_ref: any, _args: any) => {
      if (_ref === mockComponent.journal.loadBatchResults) {
        return mockBatchResults;
      }
      return [];
    }),
  } as any;

  const channel = new BaseChannel<StepRequest>(100);
  const executor = new StepExecutor(
    "wf_test",
    1,
    mockCtx,
    mockComponent,
    journalEntries,
    channel,
    Date.now(),
    undefined,
    batch,
  );

  return {
    executor,
    callLog,
    mockCtx,
    channel,
    setMockBatchResults(
      results: Array<{
        index: number;
        result: { kind: string; returnValue?: unknown; error?: string };
      }>,
    ) {
      mockBatchResults = results;
    },
  };
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
    const { executor, callLog } = createExecutor({ batch });

    const messages = [
      actionMessage("step1", "module:action1"),
      actionMessage("step2", "module:action2"),
    ];

    const entries = await executor.startSteps(messages);

    expect(callLog).toHaveLength(1);
    expect(callLog[0].mutation).toBe("startSteps");
    expect(entries).toHaveLength(2);
  });

  it("routes all batch-eligible messages through batchGroup", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const { executor, callLog } = createExecutor({ batch });

    const messages = [
      actionMessage("step1", "module:batchAction", { a: 1 }),
      actionMessage("step2", "module:batchAction", { a: 2 }),
    ];

    const entries = await executor.startSteps(messages);

    // startBatchGroupStep creates 1 journal entry, then enqueueByHandle (1st,
    // not logged) + batchEnqueueBatch (rest) enqueue the tasks.
    expect(callLog).toHaveLength(2);
    expect(callLog[0].mutation).toBe("startBatchGroupStep");
    expect(callLog[0].count).toBe(2);
    expect(callLog[1].mutation).toBe("batchEnqueueBatch");
    expect(callLog[1].names).toEqual(["handler:module:batchAction"]);
    // Only 1 entry returned (the batchGroup step)
    expect(entries).toHaveLength(1);
  });

  it("preserves original message order for interleaved batch/regular steps", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const { executor, callLog } = createExecutor({ batch });

    // Interleaved: batch, regular, batch
    const messages = [
      actionMessage("batch1", "module:batchAction"),
      mutationMessage("regular1", "module:myMutation"),
      actionMessage("batch2", "module:batchAction"),
    ];

    const entries = await executor.startSteps(messages);

    // 3 groups: batchGroup(1 item) -> startSteps(1 item) -> batchGroup(1 item)
    expect(callLog).toHaveLength(3);
    expect(callLog[0]).toMatchObject({
      mutation: "startBatchGroupStep",
      count: 1,
    });
    expect(callLog[1]).toEqual({
      mutation: "startSteps",
      names: ["regular1"],
    });
    expect(callLog[2]).toMatchObject({
      mutation: "startBatchGroupStep",
      count: 1,
    });

    // Entries: batchGroup entry, regular entry, batchGroup entry
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.step.kind)).toEqual([
      "batchGroup",
      "function",
      "batchGroup",
    ]);
  });

  it("handles contiguous groups correctly", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const { executor, callLog } = createExecutor({ batch });

    // Two batch, two regular, one batch
    const messages = [
      actionMessage("b1", "module:batchAction"),
      actionMessage("b2", "module:batchAction"),
      mutationMessage("r1", "module:myMutation"),
      mutationMessage("r2", "module:myMutation"),
      actionMessage("b3", "module:batchAction"),
    ];

    const entries = await executor.startSteps(messages);

    // First batch group: startBatchGroupStep(count=2) + batchEnqueueBatch(1 remaining)
    // Regular group: startSteps
    // Second batch group: startBatchGroupStep(count=1)
    expect(callLog).toHaveLength(4);
    expect(callLog[0]).toMatchObject({
      mutation: "startBatchGroupStep",
      count: 2,
    });
    expect(callLog[1]).toEqual({
      mutation: "batchEnqueueBatch",
      names: ["handler:module:batchAction"],
    });
    expect(callLog[2]).toEqual({
      mutation: "startSteps",
      names: ["r1", "r2"],
    });
    expect(callLog[3]).toMatchObject({
      mutation: "startBatchGroupStep",
      count: 1,
    });

    // 1 batchGroup + 2 regular + 1 batchGroup = 4 entries
    expect(entries).toHaveLength(4);
  });

  it("mutations are never batch-eligible even with batch configured", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const { executor, callLog } = createExecutor({ batch });

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
    const { executor, callLog } = createExecutor({ batch });

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
    expect(callLog[1]).toMatchObject({
      mutation: "startBatchGroupStep",
      count: 1,
    });
    // 1 regular entry + 1 batchGroup entry = 2
    expect(entries).toHaveLength(2);
  });
});

describe("StepExecutor.run batchGroup replay", () => {
  it("replays a completed batchGroup entry resolving N messages", async () => {
    // Pre-load a completed batchGroup entry for 3 items
    const bgEntry = fakeBatchGroupEntry(0, 3);
    const { executor, channel, setMockBatchResults } = createExecutor({
      journalEntries: [bgEntry],
    });

    // Pre-load batch results
    setMockBatchResults([
      { index: 0, result: { kind: "success", returnValue: "result0" } },
      { index: 1, result: { kind: "success", returnValue: "result1" } },
      { index: 2, result: { kind: "success", returnValue: "result2" } },
    ]);

    // Send 3 messages that will be replayed from the batchGroup entry.
    // We need a 4th message to trigger executorBlocked (since after replay,
    // the loop continues and picks up the next message).
    const msg0 = actionMessage("s0", "module:action");
    const msg1 = actionMessage("s1", "module:action");
    const msg2 = actionMessage("s2", "module:action");
    const msgBlock = actionMessage("sBlock", "module:action");

    // Put msg1 and msg2 in buffer first (msg0 will be consumed by get())
    await channel.push(msg0);
    await channel.push(msg1);
    await channel.push(msg2);
    await channel.push(msgBlock);

    const result = await executor.run();

    expect(result.type).toBe("executorBlocked");
    expect(msg0.resolve).toHaveBeenCalledWith("result0");
    expect(msg1.resolve).toHaveBeenCalledWith("result1");
    expect(msg2.resolve).toHaveBeenCalledWith("result2");
  });

  it("replays mixed regular + batchGroup entries", async () => {
    // Pre-load: regular entry, batchGroup(2), regular entry
    const regularEntry0: JournalEntry = {
      _id: "step_0",
      _creationTime: Date.now(),
      workflowId: "wf_test" as any,
      stepNumber: 0,
      step: {
        kind: "function" as const,
        functionType: "action" as const,
        handle: "function://test",
        name: "regular0",
        inProgress: false,
        argsSize: 2,
        args: {},
        runResult: { kind: "success" as const, returnValue: "r0" },
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
    };
    const bgEntry = fakeBatchGroupEntry(1, 2);
    const regularEntry2: JournalEntry = {
      _id: "step_2",
      _creationTime: Date.now(),
      workflowId: "wf_test" as any,
      stepNumber: 2,
      step: {
        kind: "function" as const,
        functionType: "action" as const,
        handle: "function://test",
        name: "regular2",
        inProgress: false,
        argsSize: 2,
        args: {},
        runResult: { kind: "success" as const, returnValue: "r2" },
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
    };

    const { executor, channel, setMockBatchResults } = createExecutor({
      journalEntries: [regularEntry0, bgEntry, regularEntry2],
    });

    setMockBatchResults([
      { index: 0, result: { kind: "success", returnValue: "batch0" } },
      { index: 1, result: { kind: "success", returnValue: "batch1" } },
    ]);

    const msg0 = actionMessage("regular0", "module:action", {});
    const msgBatch0 = actionMessage("batchStep0", "module:action");
    const msgBatch1 = actionMessage("batchStep1", "module:action");
    const msg2 = actionMessage("regular2", "module:action", {});
    const msgBlock = actionMessage("block", "module:action");

    await channel.push(msg0);
    await channel.push(msgBatch0);
    await channel.push(msgBatch1);
    await channel.push(msg2);
    await channel.push(msgBlock);

    const result = await executor.run();

    expect(result.type).toBe("executorBlocked");
    expect(msg0.resolve).toHaveBeenCalledWith("r0");
    expect(msgBatch0.resolve).toHaveBeenCalledWith("batch0");
    expect(msgBatch1.resolve).toHaveBeenCalledWith("batch1");
    expect(msg2.resolve).toHaveBeenCalledWith("r2");
  });

  it("handles partial failures in batchGroup results", async () => {
    const bgEntry = fakeBatchGroupEntry(0, 3);
    const { executor, channel, setMockBatchResults } = createExecutor({
      journalEntries: [bgEntry],
    });

    setMockBatchResults([
      { index: 0, result: { kind: "success", returnValue: "ok" } },
      { index: 1, result: { kind: "failed", error: "item 1 failed" } },
      { index: 2, result: { kind: "canceled" } },
    ]);

    const msg0 = actionMessage("s0", "module:action");
    const msg1 = actionMessage("s1", "module:action");
    const msg2 = actionMessage("s2", "module:action");
    const msgBlock = actionMessage("sBlock", "module:action");

    await channel.push(msg0);
    await channel.push(msg1);
    await channel.push(msg2);
    await channel.push(msgBlock);

    const result = await executor.run();

    expect(result.type).toBe("executorBlocked");
    expect(msg0.resolve).toHaveBeenCalledWith("ok");
    expect(msg1.reject).toHaveBeenCalledWith(new Error("item 1 failed"));
    expect(msg2.reject).toHaveBeenCalledWith(new Error("Canceled"));
  });
});
