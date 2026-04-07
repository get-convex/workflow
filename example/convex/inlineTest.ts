import { WorkflowManager } from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server.js";

export const workflow = new WorkflowManager(components.workflow);

// ── Test 1: Sequential inline queries ─────────
// Results come back in order, one at a time.
export const sequentialInlineQueries = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({ a: v.number(), b: v.number() }),
  })
  .bind(internal.inlineTest.siq);

export const siq = sequentialInlineQueries.handler(async (step, args) => {
  const a = await step.runQuery(
    internal.inlineTest.getCounter,
    { key: args.key },
    { inline: true },
  );
  const b = await step.runQuery(
    internal.inlineTest.getCounter,
    { key: args.key + "_other" },
    { inline: true },
  );
  return { a, b };
});

// ── Test 2: Parallel inline queries ───────────
// Both pushed to channel before either is awaited.
// First run: batched, both resolve at once.
// Replay: resolved one-by-one from journal.
// resolveOrder should be ["a","b"] in both cases.
export const parallelInlineQueries = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({
      a: v.number(),
      b: v.number(),
      resolveOrder: v.array(v.string()),
    }),
  })
  .bind(internal.inlineTest.piq);
export const piq = parallelInlineQueries.handler(async (step, args) => {
  const resolveOrder: string[] = [];
  const aPromise = step
    .runQuery(
      internal.inlineTest.getCounter,
      { key: args.key },
      { inline: true },
    )
    .then((val) => {
      resolveOrder.push("a");
      return val;
    });
  const bPromise = step
    .runQuery(
      internal.inlineTest.getCounter,
      { key: args.key + "_other" },
      { inline: true },
    )
    .then((val) => {
      resolveOrder.push("b");
      return val;
    });
  const [a, b] = await Promise.all([aPromise, bPromise]);
  return { a, b, resolveOrder };
});

// ── Test 3: Promise.race between inline queries ──
// Checks which promise resolves first.
// Should be "a" in both first-run and replay paths.
export const raceInlineQueries = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({ winner: v.string(), value: v.number() }),
  })
  .bind(internal.inlineTest.riq);
export const riq = raceInlineQueries.handler(async (step, args) => {
  const aPromise = step
    .runQuery(
      internal.inlineTest.getCounter,
      { key: args.key },
      { inline: true },
    )
    .then((val) => ({ winner: "a", value: val }));
  const bPromise = step
    .runQuery(
      internal.inlineTest.getCounter,
      { key: args.key + "_other" },
      { inline: true },
    )
    .then((val) => ({ winner: "b", value: val }));
  return await Promise.race([aPromise, bPromise]);
});

// ── Test 4: Inline mutations ──────────────────
// Verifies mutations execute within the same transaction.
export const inlineMutations = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({ first: v.number(), second: v.number() }),
  })
  .bind(internal.inlineTest.im);
export const im = inlineMutations.handler(async (step, args) => {
  const first = await step.runMutation(
    internal.inlineTest.incrementCounter,
    { key: args.key },
    { inline: true },
  );
  const second = await step.runMutation(
    internal.inlineTest.incrementCounter,
    { key: args.key },
    { inline: true },
  );
  return { first, second };
});

// ── Test 6: Mixed inline + action ─────────────
// The query runs inline, while the action goes through
// workpool. Since not all steps complete inline, executor blocks.
export const mixedInlineAndAction = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({
      queryResult: v.number(),
      actionResult: v.string(),
    }),
  })
  .bind(internal.inlineTest.mia);
export const mia = mixedInlineAndAction.handler(async (step, args) => {
  const queryPromise = step.runQuery(
    internal.inlineTest.getCounter,
    { key: args.key },
    { inline: true },
  );
  const actionPromise = step.runAction(internal.inlineTest.someAction, {
    label: args.key,
  });
  const [queryResult, actionResult] = await Promise.all([
    queryPromise,
    actionPromise,
  ]);
  return { queryResult, actionResult };
});

// ── Test 7: Dependent inline queries ──────────
// Second query uses result of first.
export const dependentInlineQueries = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({ first: v.number(), second: v.number() }),
  })
  .bind(internal.inlineTest.diq);
export const diq = dependentInlineQueries.handler(async (step, args) => {
  const first = await step.runQuery(
    internal.inlineTest.getCounter,
    { key: args.key },
    { inline: true },
  );
  const second = await step.runQuery(
    internal.inlineTest.getCounter,
    { key: first === 0 ? args.key + "_zero" : args.key + "_nonzero" },
    { inline: true },
  );
  return { first, second };
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

export const someAction = internalAction({
  args: { label: v.string() },
  returns: v.string(),
  handler: async (_ctx, { label }) => {
    // TODO: use setTimeout after https://github.com/get-convex/convex-test/pull/78
    // await new Promise((resolve) => setTimeout(resolve, 500));
    return `action:${label}`;
  },
});
