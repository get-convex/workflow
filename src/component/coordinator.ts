import type { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { createLogger, DEFAULT_LOG_LEVEL } from "./logging.js";

const COORDINATOR_READ_BATCH = 1000;
const WORKFLOW_BATCH_SIZE = 50;

export async function ensureCoordinatorRunning(ctx: MutationCtx) {
  const state = await ctx.db.query("coordinatorState").first();
  if (state?.scheduled) {
    return;
  }
  if (state) {
    await ctx.db.patch(state._id, { scheduled: true });
  } else {
    await ctx.db.insert("coordinatorState", { scheduled: true });
  }
  await ctx.scheduler.runAfter(0, internal.coordinator.coordinator);
}

export const coordinator = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const ready = await ctx.db
      .query("workflows")
      .withIndex("readyToRun", (q) => q.eq("readyToRun", true))
      .take(COORDINATOR_READ_BATCH);

    if (ready.length === 0) {
      const state = await ctx.db.query("coordinatorState").first();
      if (state) {
        await ctx.db.patch(state._id, { scheduled: false });
      }
      return;
    }

    // Claim all workflows by clearing readyToRun
    for (const workflow of ready) {
      await ctx.db.patch(workflow._id, { readyToRun: undefined });
    }

    // Fan out in batches
    for (let i = 0; i < ready.length; i += WORKFLOW_BATCH_SIZE) {
      const batch = ready.slice(i, i + WORKFLOW_BATCH_SIZE);
      const items = batch.map((w) => ({
        workflowId: w._id,
        generationNumber: w.generationNumber,
        workflowHandle: w.workflowHandle,
      }));
      await ctx.scheduler.runAfter(
        0,
        internal.coordinator.runWorkflowBatch,
        { items },
      );
    }

    // Reschedule self to pick up more
    await ctx.scheduler.runAfter(0, internal.coordinator.coordinator);
  },
});

export const runWorkflowBatch = internalMutation({
  args: {
    items: v.array(
      v.object({
        workflowId: v.id("workflows"),
        generationNumber: v.number(),
        workflowHandle: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { items }) => {
    const console = createLogger(DEFAULT_LOG_LEVEL);
    for (const { workflowId, generationNumber, workflowHandle } of items) {
      const workflow = await ctx.db.get(workflowId);
      if (
        !workflow ||
        workflow.runResult ||
        workflow.generationNumber !== generationNumber
      ) {
        continue;
      }
      try {
        await ctx.runMutation(
          workflowHandle as FunctionHandle<"mutation">,
          { workflowId, generationNumber },
        );
      } catch (e) {
        const error =
          e instanceof Error ? e.message : `Unknown error: ${String(e)}`;
        console.error(
          `Error running workflow ${workflowId}: ${error}`,
        );
        await ctx.db.patch(workflowId, {
          runResult: { kind: "failed", error },
        });
      }
    }
  },
});
