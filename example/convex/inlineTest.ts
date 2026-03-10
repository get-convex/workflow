import { v } from "convex/values";
import { WorkflowManager, vWorkflowId } from "@convex-dev/workflow";
import { internal } from "./_generated/api.js";
import { components } from "./_generated/api.js";
import {
  internalMutation,
  internalQuery,
  internalAction,
} from "./_generated/server.js";

const workflow = new WorkflowManager(components.workflow);

// ── Status helper ─────────────────────────────

export const checkStatus = internalQuery({
  args: { workflowId: vWorkflowId },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await workflow.status(ctx, args.workflowId);
  },
});

// ── Helper functions ──────────────────────────

export const getCounter = internalQuery({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, { key }) => {
    const doc = await ctx.db
      .query("flows")
      .filter((q) => q.eq(q.field("in"), key))
      .first();
    return doc ? (doc.out as number) : 0;
  },
});

export const incrementCounter = internalMutation({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, { key }) => {
    const doc = await ctx.db
      .query("flows")
      .filter((q) => q.eq(q.field("in"), key))
      .first();
    const newVal = doc ? (doc.out as number) + 1 : 1;
    if (doc) {
      await ctx.db.patch(doc._id, { out: newVal });
    } else {
      await ctx.db.insert("flows", {
        in: key,
        workflowId: "" as any,
        out: newVal,
      });
    }
    return newVal;
  },
});

export const slowAction = internalAction({
  args: { label: v.string() },
  returns: v.string(),
  handler: async (_ctx, { label }) => {
    return `action:${label}`;
  },
});

// ── Test 1: Sequential inline queries ─────────
// Results come back in order, one at a time.
export const sequentialInlineQueries = workflow.define({
  args: { key: v.string() },
  returns: v.object({ a: v.number(), b: v.number() }),
  shareTransaction: true,
  handler: async (step, args) => {
    const a = await step.runQuery(internal.inlineTest.getCounter, {
      key: args.key,
    });
    const b = await step.runQuery(internal.inlineTest.getCounter, {
      key: args.key + "_other",
    });
    return { a, b };
  },
});

export const startSequential = internalMutation({
  args: { key: v.string() },
  returns: vWorkflowId,
  handler: async (ctx, args) => {
    return await workflow.start(
      ctx,
      internal.inlineTest.sequentialInlineQueries,
      args,
    );
  },
});

// ── Test 2: Parallel inline queries ───────────
// Both pushed to channel before either is awaited.
// First run: batched, both resolve at once.
// Replay: resolved one-by-one from journal.
// resolveOrder should be ["a","b"] in both cases.
export const parallelInlineQueries = workflow.define({
  args: { key: v.string() },
  returns: v.object({
    a: v.number(),
    b: v.number(),
    resolveOrder: v.array(v.string()),
  }),
  shareTransaction: true,
  handler: async (step, args) => {
    const resolveOrder: string[] = [];
    const aPromise = step
      .runQuery(internal.inlineTest.getCounter, { key: args.key })
      .then((val) => {
        resolveOrder.push("a");
        return val;
      });
    const bPromise = step
      .runQuery(internal.inlineTest.getCounter, {
        key: args.key + "_other",
      })
      .then((val) => {
        resolveOrder.push("b");
        return val;
      });
    const [a, b] = await Promise.all([aPromise, bPromise]);
    return { a, b, resolveOrder };
  },
});

export const startParallel = internalMutation({
  args: { key: v.string() },
  returns: vWorkflowId,
  handler: async (ctx, args) => {
    return await workflow.start(
      ctx,
      internal.inlineTest.parallelInlineQueries,
      args,
    );
  },
});

// ── Test 3: Promise.race between inline queries ──
// Checks which promise resolves first.
// Should be "a" in both first-run and replay paths.
export const raceInlineQueries = workflow.define({
  args: { key: v.string() },
  returns: v.object({ winner: v.string(), value: v.number() }),
  shareTransaction: true,
  handler: async (step, args) => {
    const aPromise = step
      .runQuery(internal.inlineTest.getCounter, { key: args.key })
      .then((val) => ({ winner: "a", value: val }));
    const bPromise = step
      .runQuery(internal.inlineTest.getCounter, {
        key: args.key + "_other",
      })
      .then((val) => ({ winner: "b", value: val }));
    return await Promise.race([aPromise, bPromise]);
  },
});

export const startRace = internalMutation({
  args: { key: v.string() },
  returns: vWorkflowId,
  handler: async (ctx, args) => {
    return await workflow.start(
      ctx,
      internal.inlineTest.raceInlineQueries,
      args,
    );
  },
});

// ── Test 4: Inline mutations ──────────────────
// Verifies mutations execute within the same transaction.
export const inlineMutations = workflow.define({
  args: { key: v.string() },
  returns: v.object({ first: v.number(), second: v.number() }),
  shareTransaction: true,
  handler: async (step, args) => {
    const first = await step.runMutation(
      internal.inlineTest.incrementCounter,
      { key: args.key },
    );
    const second = await step.runMutation(
      internal.inlineTest.incrementCounter,
      { key: args.key },
    );
    return { first, second };
  },
});

export const startMutations = internalMutation({
  args: { key: v.string() },
  returns: vWorkflowId,
  handler: async (ctx, args) => {
    return await workflow.start(
      ctx,
      internal.inlineTest.inlineMutations,
      args,
    );
  },
});

// ── Test 5: Per-call inline override ──────────
// No shareTransaction on workflow, but { inline: true } per-call.
export const perCallInline = workflow.define({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (step, args) => {
    return await step.runQuery(
      internal.inlineTest.getCounter,
      { key: args.key },
      { inline: true },
    );
  },
});

export const startPerCall = internalMutation({
  args: { key: v.string() },
  returns: vWorkflowId,
  handler: async (ctx, args) => {
    return await workflow.start(
      ctx,
      internal.inlineTest.perCallInline,
      args,
    );
  },
});

// ── Test 6: Mixed inline + action ─────────────
// When batch has non-inline messages, allInline=false
// so all go through workpool. Both still complete.
export const mixedInlineAndAction = workflow.define({
  args: { key: v.string() },
  returns: v.object({
    queryResult: v.number(),
    actionResult: v.string(),
  }),
  shareTransaction: true,
  handler: async (step, args) => {
    const queryPromise = step.runQuery(internal.inlineTest.getCounter, {
      key: args.key,
    });
    const actionPromise = step.runAction(internal.inlineTest.slowAction, {
      label: args.key,
    });
    const [queryResult, actionResult] = await Promise.all([
      queryPromise,
      actionPromise,
    ]);
    return { queryResult, actionResult };
  },
});

export const startMixed = internalMutation({
  args: { key: v.string() },
  returns: vWorkflowId,
  handler: async (ctx, args) => {
    return await workflow.start(
      ctx,
      internal.inlineTest.mixedInlineAndAction,
      args,
    );
  },
});

// ── Test 7: Dependent inline queries ──────────
// Second query uses result of first.
export const dependentInlineQueries = workflow.define({
  args: { key: v.string() },
  returns: v.object({ first: v.number(), second: v.number() }),
  shareTransaction: true,
  handler: async (step, args) => {
    const first = await step.runQuery(internal.inlineTest.getCounter, {
      key: args.key,
    });
    const second = await step.runQuery(internal.inlineTest.getCounter, {
      key: first === 0 ? args.key + "_zero" : args.key + "_nonzero",
    });
    return { first, second };
  },
});

export const startDependent = internalMutation({
  args: { key: v.string() },
  returns: vWorkflowId,
  handler: async (ctx, args) => {
    return await workflow.start(
      ctx,
      internal.inlineTest.dependentInlineQueries,
      args,
    );
  },
});
