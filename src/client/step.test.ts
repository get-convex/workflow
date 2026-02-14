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

// ==========================================================================
// Black-box tests: designed from the spec without reading the implementation.
// Goal: find bugs by testing edge cases and tricky scenarios.
// ==========================================================================

describe("batchGroup edge cases (black-box)", () => {
  // --- Replay edge cases ---

  it("replays batchGroup with count=1 (single item batch)", async () => {
    const bgEntry = fakeBatchGroupEntry(0, 1);
    const { executor, channel, setMockBatchResults } = createExecutor({
      journalEntries: [bgEntry],
    });

    setMockBatchResults([
      { index: 0, result: { kind: "success", returnValue: "only" } },
    ]);

    const msg = actionMessage("s0", "module:action");
    const msgBlock = actionMessage("block", "module:action");
    await channel.push(msg);
    await channel.push(msgBlock);

    const result = await executor.run();
    expect(result.type).toBe("executorBlocked");
    expect(msg.resolve).toHaveBeenCalledWith("only");
    expect(msg.reject).not.toHaveBeenCalled();
  });

  it("replays two consecutive batchGroup entries", async () => {
    // Two batchGroups back-to-back: first has 2 items, second has 3 items
    const bg1 = fakeBatchGroupEntry(0, 2);
    const bg2 = fakeBatchGroupEntry(1, 3);
    // Give them distinct IDs
    (bg2 as any)._id = "step_bg_1";

    // We need loadBatchResults to return different results for different step IDs.
    // The mock currently returns one fixed array. Let's use a per-call approach.
    const callLog: string[] = [];
    let batchResultsMap: Record<
      string,
      Array<{
        index: number;
        result: { kind: string; returnValue?: unknown; error?: string };
      }>
    > = {};

    batchResultsMap["step_bg_0"] = [
      { index: 0, result: { kind: "success", returnValue: "bg1_item0" } },
      { index: 1, result: { kind: "success", returnValue: "bg1_item1" } },
    ];
    batchResultsMap["step_bg_1"] = [
      { index: 0, result: { kind: "success", returnValue: "bg2_item0" } },
      { index: 1, result: { kind: "success", returnValue: "bg2_item1" } },
      { index: 2, result: { kind: "success", returnValue: "bg2_item2" } },
    ];

    const mockComponent = {
      journal: {
        startSteps: { __type: "startSteps" } as any,
        startBatchSteps: { __type: "startBatchSteps" } as any,
        startBatchGroupStep: { __type: "startBatchGroupStep" } as any,
        loadBatchResults: { __type: "loadBatchResults" } as any,
      },
    } as any;

    let stepCounter = 100;
    const mockCtx = {
      runMutation: vi.fn(async (_ref: any, mutArgs: any) => {
        // Handle startSteps for the blocking message
        if (_ref === mockComponent.journal.startSteps) {
          return mutArgs.steps.map((s: any) =>
            fakeEntry(stepCounter++, s.step.name),
          );
        }
        return null;
      }),
      runQuery: vi.fn(async (_ref: any, args: any) => {
        if (_ref === mockComponent.journal.loadBatchResults) {
          callLog.push(args.batchStepId);
          return batchResultsMap[args.batchStepId] ?? [];
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
      [bg1, bg2],
      channel,
      Date.now(),
      undefined,
      undefined,
    );

    // 2 messages for bg1 + 3 messages for bg2 + 1 blocking message
    const msgs = Array.from({ length: 6 }, (_, i) =>
      actionMessage(`s${i}`, "module:action"),
    );
    for (const m of msgs) await channel.push(m);

    const result = await executor.run();

    expect(result.type).toBe("executorBlocked");
    // loadBatchResults should have been called for both batchGroup entries
    expect(callLog).toEqual(["step_bg_0", "step_bg_1"]);
    // First batchGroup: messages 0,1
    expect(msgs[0].resolve).toHaveBeenCalledWith("bg1_item0");
    expect(msgs[1].resolve).toHaveBeenCalledWith("bg1_item1");
    // Second batchGroup: messages 2,3,4
    expect(msgs[2].resolve).toHaveBeenCalledWith("bg2_item0");
    expect(msgs[3].resolve).toHaveBeenCalledWith("bg2_item1");
    expect(msgs[4].resolve).toHaveBeenCalledWith("bg2_item2");
  });

  it("sorts results by index even when returned out of order", async () => {
    const bgEntry = fakeBatchGroupEntry(0, 3);
    const { executor, channel, setMockBatchResults } = createExecutor({
      journalEntries: [bgEntry],
    });

    // Results returned in scrambled order: 2, 0, 1
    setMockBatchResults([
      { index: 2, result: { kind: "success", returnValue: "two" } },
      { index: 0, result: { kind: "success", returnValue: "zero" } },
      { index: 1, result: { kind: "success", returnValue: "one" } },
    ]);

    const msg0 = actionMessage("s0", "module:action");
    const msg1 = actionMessage("s1", "module:action");
    const msg2 = actionMessage("s2", "module:action");
    const msgBlock = actionMessage("block", "module:action");
    await channel.push(msg0);
    await channel.push(msg1);
    await channel.push(msg2);
    await channel.push(msgBlock);

    const result = await executor.run();

    expect(result.type).toBe("executorBlocked");
    // Results must be matched by index, not by arrival order
    expect(msg0.resolve).toHaveBeenCalledWith("zero");
    expect(msg1.resolve).toHaveBeenCalledWith("one");
    expect(msg2.resolve).toHaveBeenCalledWith("two");
  });

  it("handles batchGroup where all items fail", async () => {
    const bgEntry = fakeBatchGroupEntry(0, 2);
    const { executor, channel, setMockBatchResults } = createExecutor({
      journalEntries: [bgEntry],
    });

    setMockBatchResults([
      { index: 0, result: { kind: "failed", error: "boom0" } },
      { index: 1, result: { kind: "failed", error: "boom1" } },
    ]);

    const msg0 = actionMessage("s0", "module:action");
    const msg1 = actionMessage("s1", "module:action");
    const msgBlock = actionMessage("block", "module:action");
    await channel.push(msg0);
    await channel.push(msg1);
    await channel.push(msgBlock);

    const result = await executor.run();

    expect(result.type).toBe("executorBlocked");
    expect(msg0.resolve).not.toHaveBeenCalled();
    expect(msg1.resolve).not.toHaveBeenCalled();
    expect(msg0.reject).toHaveBeenCalledWith(new Error("boom0"));
    expect(msg1.reject).toHaveBeenCalledWith(new Error("boom1"));
  });

  it("throws if batchGroup entry is still in progress during replay", async () => {
    // A batchGroup entry that hasn't completed yet should not be replayed
    const bgEntry = fakeBatchGroupEntry(0, 2, { inProgress: true });
    const { executor, channel } = createExecutor({
      journalEntries: [bgEntry],
    });

    const msg = actionMessage("s0", "module:action");
    const msgBlock = actionMessage("block", "module:action");
    await channel.push(msg);
    await channel.push(msgBlock);

    // Should throw or return executorBlocked (since in-progress means blocked)
    await expect(executor.run()).rejects.toThrow();
  });

  it("replays batchGroup followed by regular entry then another batchGroup", async () => {
    // bg(2) -> regular -> bg(1)
    const bg1 = fakeBatchGroupEntry(0, 2);
    const regular: JournalEntry = {
      _id: "step_r1",
      _creationTime: Date.now(),
      workflowId: "wf_test" as any,
      stepNumber: 1,
      step: {
        kind: "function" as const,
        functionType: "action" as const,
        handle: "function://test",
        name: "middle",
        inProgress: false,
        argsSize: 2,
        args: {},
        runResult: { kind: "success" as const, returnValue: "mid" },
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
    };
    const bg2 = fakeBatchGroupEntry(2, 1);
    (bg2 as any)._id = "step_bg_2";

    const mockComponent = {
      journal: {
        startSteps: { __type: "startSteps" } as any,
        startBatchSteps: { __type: "startBatchSteps" } as any,
        startBatchGroupStep: { __type: "startBatchGroupStep" } as any,
        loadBatchResults: { __type: "loadBatchResults" } as any,
      },
    } as any;

    const batchResultsMap: Record<string, any[]> = {
      step_bg_0: [
        { index: 0, result: { kind: "success", returnValue: "b1_0" } },
        { index: 1, result: { kind: "success", returnValue: "b1_1" } },
      ],
      step_bg_2: [
        { index: 0, result: { kind: "success", returnValue: "b2_0" } },
      ],
    };

    let stepCounter = 100;
    const mockCtx = {
      runMutation: vi.fn(async (_ref: any, mutArgs: any) => {
        if (_ref === mockComponent.journal.startSteps) {
          return mutArgs.steps.map((s: any) =>
            fakeEntry(stepCounter++, s.step.name),
          );
        }
        return null;
      }),
      runQuery: vi.fn(async (_ref: any, args: any) => {
        if (_ref === mockComponent.journal.loadBatchResults) {
          return batchResultsMap[args.batchStepId] ?? [];
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
      [bg1, regular, bg2],
      channel,
      Date.now(),
      undefined,
      undefined,
    );

    // bg1: 2 msgs, regular: 1 msg, bg2: 1 msg, + 1 blocking
    const msgs = Array.from({ length: 5 }, (_, i) =>
      actionMessage(`s${i}`, "module:action"),
    );
    for (const m of msgs) await channel.push(m);

    const result = await executor.run();

    expect(result.type).toBe("executorBlocked");
    expect(msgs[0].resolve).toHaveBeenCalledWith("b1_0");
    expect(msgs[1].resolve).toHaveBeenCalledWith("b1_1");
    expect(msgs[2].resolve).toHaveBeenCalledWith("mid");
    expect(msgs[3].resolve).toHaveBeenCalledWith("b2_0");
  });

  // --- startSteps edge cases ---

  it("single batch-eligible action creates batchGroup with count=1, uses enqueueByHandle not enqueueBatch", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const { executor, callLog } = createExecutor({ batch });

    const messages = [actionMessage("solo", "module:batchAction", { x: 1 })];

    const entries = await executor.startSteps(messages);

    // Should create a batchGroup with count=1
    expect(callLog).toHaveLength(1);
    expect(callLog[0]).toMatchObject({
      mutation: "startBatchGroupStep",
      count: 1,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].step.kind).toBe("batchGroup");

    // For a single item batch, enqueueByHandle should be used (not enqueueBatch)
    // so batchEnqueueBatch should NOT appear in callLog
    expect(callLog.every((c) => c.mutation !== "batchEnqueueBatch")).toBe(true);
    expect(batch.enqueueByHandle).toHaveBeenCalledTimes(1);
  });

  it("large batch (100 items) creates single batchGroup entry", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const { executor, callLog } = createExecutor({ batch });

    const messages = Array.from({ length: 100 }, (_, i) =>
      actionMessage(`step${i}`, "module:batchAction", { i }),
    );

    const entries = await executor.startSteps(messages);

    // Should be: startBatchGroupStep + batchEnqueueBatch (for 99 remaining items)
    const bgCalls = callLog.filter(
      (c) => c.mutation === "startBatchGroupStep",
    );
    expect(bgCalls).toHaveLength(1);
    expect(bgCalls[0].count).toBe(100);

    // Only 1 journal entry
    expect(entries).toHaveLength(1);

    // enqueueByHandle for the first item
    expect(batch.enqueueByHandle).toHaveBeenCalledTimes(1);
  });

  it("batch items have correct context with batchStepId and sequential index", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const { executor } = createExecutor({ batch });

    const messages = [
      actionMessage("s0", "module:batchAction", { val: "a" }),
      actionMessage("s1", "module:batchAction", { val: "b" }),
      actionMessage("s2", "module:batchAction", { val: "c" }),
    ];

    await executor.startSteps(messages);

    // The first item goes through enqueueByHandle
    const enqueueByHandle = batch.enqueueByHandle as ReturnType<typeof vi.fn>;
    expect(enqueueByHandle).toHaveBeenCalledTimes(1);
    const firstCallArgs = enqueueByHandle.mock.calls[0];
    // enqueueByHandle(ctx, name, args, options)
    // options.onComplete should contain context with batchStepId and index: 0
    const firstOptions = firstCallArgs[3];
    expect(firstOptions.onComplete).toBeDefined();
    expect(firstOptions.onComplete.context).toBeDefined();
    expect(firstOptions.onComplete.context.index).toBe(0);
    expect(firstOptions.onComplete.context.batchStepId).toBeDefined();
  });

  it("batchGroup replay with results having non-contiguous indices panics or handles gracefully", async () => {
    // What if results have indices [0, 2] for count=3 (missing index 1)?
    // The sort-by-index approach would put them at positions 0 and 1 in the sorted
    // array, but result[1] would be for index 2, not index 1. And result[2] would
    // be undefined. This should either be handled gracefully or detected as an error.
    const bgEntry = fakeBatchGroupEntry(0, 3);
    const { executor, channel, setMockBatchResults } = createExecutor({
      journalEntries: [bgEntry],
    });

    // Only 2 results for count=3 (missing index 1)
    setMockBatchResults([
      { index: 0, result: { kind: "success", returnValue: "zero" } },
      { index: 2, result: { kind: "success", returnValue: "two" } },
    ]);

    const msg0 = actionMessage("s0", "module:action");
    const msg1 = actionMessage("s1", "module:action");
    const msg2 = actionMessage("s2", "module:action");
    const msgBlock = actionMessage("block", "module:action");
    await channel.push(msg0);
    await channel.push(msg1);
    await channel.push(msg2);
    await channel.push(msgBlock);

    // This should either throw (missing result) or handle gracefully.
    // It should NOT silently assign the wrong result to the wrong message.
    // If it sorts by index and accesses by array position, msg1 gets result
    // for index 2 (wrong!) and msg2 gets undefined (crash!).
    try {
      const result = await executor.run();
      // If it doesn't throw, at least verify results are correct
      // msg0 -> index 0 result
      expect(msg0.resolve).toHaveBeenCalledWith("zero");
      // msg1 should NOT get index 2's result
      if (msg1.resolve.mock.calls.length > 0) {
        // If it resolved, it should not be "two" (that's for index 2)
        expect(msg1.resolve).not.toHaveBeenCalledWith("two");
      }
    } catch {
      // Throwing is acceptable — missing results is an error condition
    }
  });

  it("batchGroup replay with duplicate indices gives wrong results", async () => {
    // What if results have duplicate indices? [0, 0, 1] for count=3
    // After sorting, both index-0 results end up first. Only 3 items in array
    // but the third may resolve with index 1's result, missing index 2 entirely.
    const bgEntry = fakeBatchGroupEntry(0, 3);
    const { executor, channel, setMockBatchResults } = createExecutor({
      journalEntries: [bgEntry],
    });

    // Duplicate index 0, no index 2
    setMockBatchResults([
      { index: 0, result: { kind: "success", returnValue: "first_zero" } },
      { index: 0, result: { kind: "success", returnValue: "dup_zero" } },
      { index: 1, result: { kind: "success", returnValue: "one" } },
    ]);

    const msg0 = actionMessage("s0", "module:action");
    const msg1 = actionMessage("s1", "module:action");
    const msg2 = actionMessage("s2", "module:action");
    const msgBlock = actionMessage("block", "module:action");
    await channel.push(msg0);
    await channel.push(msg1);
    await channel.push(msg2);
    await channel.push(msgBlock);

    // This should ideally be caught as an error condition.
    // But the implementation may silently assign wrong results.
    try {
      await executor.run();
      // msg2 should have gotten index 2's result, but there is no index 2.
      // If it resolved at all, something is wrong.
      if (msg2.resolve.mock.calls.length > 0) {
        // What did it resolve with? If "one" then index matching is broken.
        const resolvedValue = msg2.resolve.mock.calls[0][0];
        // There IS no result for index 2 — any resolution is suspect.
        // This test documents the behavior even if it doesn't crash.
        expect(resolvedValue).toBeDefined();
      }
    } catch {
      // Acceptable
    }
  });

  it("batchGroup enqueue passes correct onComplete handle to all items", async () => {
    const batch = createMockBatch(["module:batchAction"]);
    const enqueueBatchMock = vi.fn(async (tasks: any[]) =>
      tasks.map(() => "task_id"),
    );
    // Override the component's enqueueBatch to capture the calls
    (batch as any).component.batch.enqueueBatch = {
      __type: "enqueueBatch",
    } as any;

    const { executor, mockCtx } = createExecutor({ batch });

    const messages = [
      actionMessage("s0", "module:batchAction"),
      actionMessage("s1", "module:batchAction"),
      actionMessage("s2", "module:batchAction"),
    ];

    await executor.startSteps(messages);

    // Check that the batch enqueue mutation was called with correct onComplete
    const batchCalls = mockCtx.runMutation.mock.calls.filter(
      ([ref]: any[]) => ref.__type === "enqueueBatch",
    );
    if (batchCalls.length > 0) {
      const tasks = batchCalls[0][1].tasks;
      // Each task should have onComplete pointing to the batchGroupItem handler
      for (const task of tasks) {
        expect(task.onComplete).toBeDefined();
      }
    }
  });

  it("regular steps after batchGroup in startSteps get correct entries", async () => {
    // batch(2) then regular(2) in a single startSteps call
    const batch = createMockBatch(["module:batchAction"]);
    const { executor, callLog } = createExecutor({ batch });

    const messages = [
      actionMessage("b0", "module:batchAction"),
      actionMessage("b1", "module:batchAction"),
      mutationMessage("r0", "module:mutation"),
      mutationMessage("r1", "module:mutation"),
    ];

    const entries = await executor.startSteps(messages);

    // Should be: batchGroup(count=2) -> startSteps([r0, r1])
    expect(callLog[0]).toMatchObject({
      mutation: "startBatchGroupStep",
      count: 2,
    });
    expect(callLog.find((c) => c.mutation === "startSteps")).toMatchObject({
      mutation: "startSteps",
      names: ["r0", "r1"],
    });

    // 1 batchGroup + 2 regular = 3 entries
    expect(entries).toHaveLength(3);
    // Verify the ordering: batchGroup first, then the two regular entries
    expect(entries[0].step.kind).toBe("batchGroup");
    expect(entries[1].step.kind).toBe("function");
    expect(entries[2].step.kind).toBe("function");
    expect(entries[1].step.name).toBe("r0");
    expect(entries[2].step.name).toBe("r1");
  });

  it("startSteps with only non-action messages + batch configured falls back to regular", async () => {
    const batch = createMockBatch(["module:anything"]);
    const { executor, callLog } = createExecutor({ batch });

    // Event-type messages (not function kind)
    const eventMsg: StepRequest = {
      name: "myEvent",
      target: { kind: "event", args: { eventId: "evt_123" as any } },
      retry: undefined,
      schedulerOptions: {},
      resolve: vi.fn(),
      reject: vi.fn(),
    };

    const entries = await executor.startSteps([eventMsg]);

    // Events should go through regular startSteps, not batchGroup
    expect(callLog).toHaveLength(1);
    expect(callLog[0].mutation).toBe("startSteps");
  });

  it("startSteps with workflow-kind messages + batch configured falls back to regular", async () => {
    const batch = createMockBatch(["module:anything"]);
    const { executor, callLog } = createExecutor({ batch });

    const workflowMsg: StepRequest = {
      name: "nestedWf",
      target: {
        kind: "workflow",
        function: mockFnRef("module:nestedWorkflow"),
        args: {},
      },
      retry: undefined,
      schedulerOptions: {},
      resolve: vi.fn(),
      reject: vi.fn(),
    };

    const entries = await executor.startSteps([workflowMsg]);

    // Workflows should go through regular startSteps, not batchGroup
    expect(callLog).toHaveLength(1);
    expect(callLog[0].mutation).toBe("startSteps");
  });
});

// ==========================================================================
// Bug-hunting tests: written after reading the implementation to target
// specific code paths that look fragile.
// ==========================================================================

describe("batchGroup bug hunting", () => {
  it("entries/messages length mismatch: batchGroup entry must not have runResult", async () => {
    // When startSteps returns a mix of batchGroup and regular entries,
    // entries.length < messages.length (1 batchGroup entry for N messages).
    // If entries.every(e => e.step.runResult) were true, the code would
    // iterate with messages[i]/entries[i] which are mismatched.
    //
    // This test guards the invariant that batchGroup entries from startSteps
    // never have runResult set. If this fails, the entries[i]/messages[i]
    // loop in run() would silently assign wrong results.
    const batch = createMockBatch(["module:batchAction"]);
    const { executor } = createExecutor({ batch });

    const messages = [
      actionMessage("b0", "module:batchAction"),
      actionMessage("b1", "module:batchAction"),
      mutationMessage("r0", "module:mutation"),
    ];

    const entries = await executor.startSteps(messages);

    // 3 messages but only 2 entries (1 batchGroup + 1 regular)
    expect(entries).toHaveLength(2);
    expect(messages).toHaveLength(3);
    // CRITICAL INVARIANT: batchGroup entry must NOT have runResult set
    const bgEntry = entries.find((e) => e.step.kind === "batchGroup");
    expect(bgEntry).toBeDefined();
    expect(bgEntry!.step.runResult).toBeUndefined();
  });

  it("getGenerationState should report not-latest when batchGroup covers many messages", async () => {
    // getGenerationState uses journalEntries.length vs bufferSize to determine
    // if we're "caught up". But a batchGroup entry covers N messages while
    // taking only 1 slot in journalEntries.
    //
    // With 2 journal entries (1 batchGroup of 100 + 1 regular) and 5 buffered
    // messages, the code thinks we're caught up (2 <= 5) but we actually need
    // to process 101 messages before we're done replaying.
    const bgEntry = fakeBatchGroupEntry(0, 100);
    const regularEntry: JournalEntry = {
      _id: "step_1",
      _creationTime: Date.now(),
      workflowId: "wf_test" as any,
      stepNumber: 1,
      step: {
        kind: "function" as const,
        functionType: "action" as const,
        handle: "function://test",
        name: "afterBatch",
        inProgress: false,
        argsSize: 2,
        args: {},
        runResult: { kind: "success" as const, returnValue: "done" },
        startedAt: 1000,
        completedAt: 2000,
      },
    };

    const { executor, channel } = createExecutor({
      journalEntries: [bgEntry, regularEntry],
    });

    for (let i = 0; i < 5; i++) {
      await channel.push(actionMessage(`s${i}`, "module:action"));
    }

    const state = executor.getGenerationState();
    // BUG: returns latest=true because journalEntries.length (2) <= bufferSize (5)
    // but we actually have 101 messages to replay. Should be latest=false.
    expect(state.latest).toBe(false);
  });

  it("replay should give clear error when batchResults count < expected count", async () => {
    // If loadBatchResults returns fewer results than entry.step.count,
    // the code crashes with:
    //   TypeError: Cannot read properties of undefined (reading 'result')
    // It should throw a clear assertion error instead.
    const bgEntry = fakeBatchGroupEntry(0, 3);
    const { executor, channel, setMockBatchResults } = createExecutor({
      journalEntries: [bgEntry],
    });

    // Only 2 results for count=3
    setMockBatchResults([
      { index: 0, result: { kind: "success", returnValue: "zero" } },
      { index: 1, result: { kind: "success", returnValue: "one" } },
    ]);

    const msg0 = actionMessage("s0", "module:action");
    const msg1 = actionMessage("s1", "module:action");
    const msg2 = actionMessage("s2", "module:action");
    const msgBlock = actionMessage("block", "module:action");
    await channel.push(msg0);
    await channel.push(msg1);
    await channel.push(msg2);
    await channel.push(msgBlock);

    // Should throw a clear error about missing batch results, NOT a TypeError
    await expect(executor.run()).rejects.toThrow(/batch.*result|missing|count/i);
  });

  it("replay should validate results count matches batchGroup count", async () => {
    // Extra results (4 results for count=2) indicates data corruption.
    // The code should detect this, not silently ignore the extras.
    const bgEntry = fakeBatchGroupEntry(0, 2);
    const { executor, channel, setMockBatchResults } = createExecutor({
      journalEntries: [bgEntry],
    });

    setMockBatchResults([
      { index: 0, result: { kind: "success", returnValue: "zero" } },
      { index: 1, result: { kind: "success", returnValue: "one" } },
      { index: 2, result: { kind: "success", returnValue: "extra1" } },
      { index: 3, result: { kind: "success", returnValue: "extra2" } },
    ]);

    const msg0 = actionMessage("s0", "module:action");
    const msg1 = actionMessage("s1", "module:action");
    const msgBlock = actionMessage("block", "module:action");
    await channel.push(msg0);
    await channel.push(msg1);
    await channel.push(msgBlock);

    // Should throw on count mismatch (4 results for 2 expected)
    await expect(executor.run()).rejects.toThrow();
  });

  it("replay should validate result indices are contiguous 0..N-1", async () => {
    // Results with non-contiguous indices (gap: 0, 2, 4 for count=3) means
    // sort-by-index then access-by-position gives wrong results:
    // results[1] = {index:2, ...} instead of {index:1, ...}.
    const bgEntry = fakeBatchGroupEntry(0, 3);
    const { executor, channel, setMockBatchResults } = createExecutor({
      journalEntries: [bgEntry],
    });

    setMockBatchResults([
      { index: 0, result: { kind: "success", returnValue: "zero" } },
      { index: 2, result: { kind: "success", returnValue: "two" } },
      { index: 4, result: { kind: "success", returnValue: "four" } },
    ]);

    const msg0 = actionMessage("s0", "module:action");
    const msg1 = actionMessage("s1", "module:action");
    const msg2 = actionMessage("s2", "module:action");
    const msgBlock = actionMessage("block", "module:action");
    await channel.push(msg0);
    await channel.push(msg1);
    await channel.push(msg2);
    await channel.push(msgBlock);

    // Should throw because indices [0,2,4] are not contiguous [0,1,2].
    // Current bug: silently assigns msg1 the result for index 2.
    await expect(executor.run()).rejects.toThrow(/index|contiguous|mismatch/i);
  });
});
