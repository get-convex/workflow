import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { assert } from "convex-helpers";
import { enqueueWorkflow, getWorkpool, workpoolOptions } from "./pool.js";
import { getDefaultLogger } from "./utils.js";
import type { Doc } from "./_generated/dataModel.js";

export const timeout = internalMutation({
  args: {
    stepId: v.id("steps"),
    workpoolOptions: workpoolOptions,
    generationNumber: v.number(),
  },
  async handler(ctx, args) {
    const console = await getDefaultLogger(ctx);
    const step = await ctx.db.get("steps", args.stepId);
    assert(step, `Step not found: ${args.stepId}`);
    assert(step.step.kind === "race", `Step is not a race: ${args.stepId}`);
    if (!step.step.inProgress) {
      console.error(`Step ${args.stepId} is not in progress`);
      return;
    }
    const workflow = await ctx.db.get("workflows", step.workflowId);
    assert(workflow, `Workflow ${step.workflowId} not found`);
    if (workflow.generationNumber !== args.generationNumber) {
      console.error(
        `Workflow: ${step.workflowId} already has generation number ${workflow.generationNumber} when completing ${args.stepId}. Expected ${args.generationNumber}`,
      );
      return;
    }

    step.step.runResult = { kind: "failed", error: "Timeout" };
    await consumeRaceEvents(ctx, step);
    step.step.inProgress = false;
    step.step.completedAt = Date.now();
    await ctx.db.replace("steps", step._id, step);

    const workpool = await getWorkpool(ctx, args.workpoolOptions);
    await enqueueWorkflow(ctx, workflow, workpool);
  },
});

export async function consumeRaceEvents(ctx: MutationCtx, step: Doc<"steps">) {
  assert(step.step.kind === "race", `Step is not a race: ${step._id}`);
  assert(step.step.inProgress, `Step ${step._id} is not in progress`);
  const raceEvents = await ctx.db
    .query("events")
    .withIndex("workflowId_state", (q) =>
      q.eq("workflowId", step.workflowId).eq("state.kind", "waiting"),
    )
    .filter((q) => q.eq(q.field("state.stepId"), step._id))
    .collect();
  const consumedAt = Date.now();
  await Promise.all(
    raceEvents.map((event) => {
      assert(
        event.state.kind === "waiting",
        `Race event ${event._id} is not waiting`,
      );
      return ctx.db.patch("events", event._id, {
        state: {
          kind: "consumed",
          stepId: step._id,
          waitingAt: event.state.waitingAt,
          sentAt: consumedAt,
          consumedAt,
        },
      });
    }),
  );
}
