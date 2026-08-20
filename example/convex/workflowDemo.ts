import { v } from "convex/values";
import type { WorkflowId } from "@convex-dev/workflow";
import { internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server.js";
import { workflow } from "./example.js";

const MIN_STEPS = 6;
const MAX_STEPS = 100;

export const comparisonWorkflow = workflow
  .define({
    args: {
      seed: v.number(),
      stepCount: v.number(),
    },
    returns: v.object({
      finalValue: v.number(),
      completedAt: v.number(),
    }),
  })
  .handler(async (step, args) => {
    let value = args.seed;
    for (let index = 0; index < args.stepCount; index += 1) {
      const ordinal = index + 1;
      switch (index % 3) {
        case 0:
          value = await step.runQuery(
            internal.workflowDemo.queryStage,
            { value },
            { name: `Query ${ordinal}` },
          );
          break;
        case 1:
          value = await step.runMutation(
            internal.workflowDemo.mutationStage,
            { value },
            { name: `Mutation ${ordinal}` },
          );
          break;
        case 2:
          value = await step.runAction(
            internal.workflowDemo.actionStage,
            { value },
            { name: `Action ${ordinal}`, timeRequired: 250 },
          );
          break;
      }
    }
    return { finalValue: value, completedAt: Date.now() };
  });

export const queryStage = internalQuery({
  args: { value: v.number() },
  returns: v.number(),
  handler: async (_ctx, args) => args.value + 1,
});

export const mutationStage = internalMutation({
  args: { value: v.number() },
  returns: v.number(),
  handler: async (_ctx, args) => args.value + 1,
});

export const actionStage = internalAction({
  args: { value: v.number() },
  returns: v.number(),
  handler: async (_ctx, args) => {
    await new Promise((resolve) => setTimeout(resolve, 90));
    return args.value + 1;
  },
});

export const startComparison = mutation({
  args: { stepCount: v.number() },
  returns: v.id("workflowComparisons"),
  handler: async (ctx, args) => {
    if (
      !Number.isInteger(args.stepCount) ||
      args.stepCount < MIN_STEPS ||
      args.stepCount > MAX_STEPS
    ) {
      throw new Error(
        `stepCount must be an integer between ${MIN_STEPS} and ${MAX_STEPS}.`,
      );
    }

    const startedAt = Date.now();
    const workflowArgs = { seed: 0, stepCount: args.stepCount };
    const traditionalWorkflowId: WorkflowId = await workflow.start(
      ctx,
      internal.workflowDemo.comparisonWorkflow,
      workflowArgs,
      { startAsync: true },
    );
    const actionWorkflowId: WorkflowId = await workflow.start(
      ctx,
      internal.workflowDemo.comparisonWorkflow,
      workflowArgs,
      {
        startAsync: true,
        executionMode: { type: "action", stepStartBudgetMs: 60_000 },
      },
    );

    return await ctx.db.insert("workflowComparisons", {
      traditionalWorkflowId,
      actionWorkflowId,
      stepCount: args.stepCount,
      startedAt,
    });
  },
});

export const latestComparison = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const comparison = await ctx.db
      .query("workflowComparisons")
      .order("desc")
      .first();
    if (!comparison) {
      return null;
    }
    const [traditional, action] = await Promise.all([
      workflowSnapshot(ctx, comparison.traditionalWorkflowId),
      workflowSnapshot(ctx, comparison.actionWorkflowId),
    ]);
    return {
      comparisonId: comparison._id,
      stepCount: comparison.stepCount,
      startedAt: comparison.startedAt,
      traditional,
      action,
    };
  },
});

async function workflowSnapshot(ctx: QueryCtx, workflowId: WorkflowId) {
  const [status, history] = await Promise.all([
    workflow.status(ctx, workflowId),
    workflow.listSteps(ctx, workflowId, {
      order: "asc",
      paginationOpts: { cursor: null, numItems: MAX_STEPS + 1 },
    }),
  ]);
  const completedAt =
    status.type === "completed" &&
    typeof status.result === "object" &&
    status.result !== null &&
    "completedAt" in status.result &&
    typeof status.result.completedAt === "number"
      ? status.result.completedAt
      : null;
  return {
    workflowId: workflowId as string,
    status,
    completedAt,
    steps: history.page.map((entry) => ({
      stepId: entry.stepId,
      name: entry.name,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt ?? null,
      resultKind: entry.runResult?.kind ?? null,
    })),
  };
}
