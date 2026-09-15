import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import {
  anyApi,
  componentsGeneric,
  defineSchema,
  internalMutationGeneric,
} from "convex/server";
import { getConvexSize, v } from "convex/values";
import { WorkflowManager, type WorkflowComponent } from "./index.js";
import workflowTest from "../test.js";

const component = componentsGeneric().workflow as unknown as WorkflowComponent;
const manager = new WorkflowManager(component, {
  workpoolOptions: { maxParallelism: 2 },
});
const measurements = {
  empty: v.number(),
  first: v.number(),
  repeated: v.number(),
  all: v.number(),
  final: v.number(),
  count: v.number(),
};
const functions = {
  measure: manager.define({
    args: {
      mode: v.union(
        v.literal("inline"),
        v.literal("async"),
        v.literal("mixed"),
      ),
    },
    returns: v.object(measurements),
    handler: async (step, { mode }) => {
      const empty = await step.journal.getSize();
      const derived = step.withOptions({ unstableArgs: true });
      const call = (index: number) =>
        step.runMutation(
          anyApi.sizes.value,
          { value: "x".repeat(index + 1) },
          {
            inline: mode === "inline" || (mode === "mixed" && index % 2 === 0),
          },
        );
      const earlier = Array.from({ length: 5 }, (_, index) => call(index));
      const firstRead = step.journal.getSize();
      const repeatedRead = derived.journal.getSize();
      const later = Array.from({ length: 3 }, (_, index) => call(index + 5));
      const first = await firstRead;
      const repeated = await repeatedRead;
      await Promise.all([...earlier, ...later]);
      const all = await step.journal.getSize();
      // Force another replay. Argument matching proves that both readings
      // are identical when later journal entries already exist.
      await step.runMutation(anyApi.sizes.checkpoint, {
        first,
        repeated,
        all,
        count: step.journal.getStepCount(),
      });
      return {
        empty,
        first,
        repeated,
        all,
        final: await step.journal.getSize(),
        count: step.journal.getStepCount(),
      };
    },
  }),
  empty: manager.define({
    args: {},
    returns: v.number(),
    handler: async (step) => await step.journal.getSize(),
  }),
  failure: manager.define({
    args: {},
    returns: v.number(),
    handler: async (step) => {
      const failed = step.runMutation(anyApi.sizes.fail, {}).catch(() => null);
      const size = await step.journal.getSize();
      await failed;
      return size;
    },
  }),
  value: internalMutationGeneric({
    args: { value: v.string() },
    returns: v.string(),
    handler: (_ctx, { value }) => value,
  }),
  checkpoint: internalMutationGeneric({
    args: {
      first: v.number(),
      repeated: v.number(),
      all: v.number(),
      count: v.number(),
    },
    returns: v.null(),
    handler: () => null,
  }),
  fail: internalMutationGeneric({
    args: {},
    returns: v.null(),
    handler: () => {
      throw new Error("expected failure");
    },
  }),
};

function setup() {
  const t = convexTest(defineSchema({}), {
    "./_generated/api.ts": async () => ({}),
    "./sizes.ts": async () => functions,
  });
  workflowTest.register(t);
  return t;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test.each(["inline", "async", "mixed"] as const)(
  "size reads measure the same completed prefix across %s execution and replay",
  async (mode) => {
    const t = setup();
    const workflowId = await t.mutation(anyApi.sizes.measure, {
      args: { mode },
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const { workflow, journalEntries } = await t.query(component.journal.load, {
      workflowId,
    });
    expect(workflow.runResult?.kind).toBe("success");
    if (workflow.runResult?.kind !== "success")
      throw new Error(JSON.stringify(workflow.runResult));
    expect(journalEntries).toHaveLength(9);
    expect(journalEntries.every(({ step }) => !step.inProgress)).toBe(true);
    const size = (count: number) =>
      journalEntries
        .slice(0, count)
        .reduce((sum, entry) => sum + getConvexSize(entry), 0);
    expect(workflow.runResult.returnValue).toEqual({
      empty: 0,
      first: size(5),
      repeated: size(5),
      all: size(8),
      final: size(9),
      count: 9,
    });
    expect(journalEntries[8].step.args).toEqual({
      first: size(5),
      repeated: size(5),
      all: size(8),
      count: 8,
    });
  },
);

test("reading an empty journal records no steps", async () => {
  const t = setup();
  const workflowId = await t.mutation(anyApi.sizes.empty, { args: {} });
  const { workflow, journalEntries } = await t.query(component.journal.load, {
    workflowId,
  });
  expect(workflow.runResult).toEqual({ kind: "success", returnValue: 0 });
  expect(journalEntries).toHaveLength(0);
});

test("size includes a completed failure without throwing the step's error", async () => {
  const t = setup();
  const workflowId = await t.mutation(anyApi.sizes.failure, { args: {} });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const { workflow, journalEntries } = await t.query(component.journal.load, {
    workflowId,
  });
  expect(journalEntries).toHaveLength(1);
  expect(journalEntries[0].step.runResult?.kind).toBe("failed");
  expect(workflow.runResult).toEqual({
    kind: "success",
    returnValue: getConvexSize(journalEntries[0]),
  });
});
