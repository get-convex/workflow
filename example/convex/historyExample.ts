import { v } from "convex/values";
import { workflow } from "./example";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";

export const historyWorkflow = workflow.define({
  args: {},
  handler: async (step) => {
    const h0 = step.meta.getHistory();
    console.log(`Before any steps: ${h0.stepCount} steps, ${h0.size} bytes`);

    await step.runMutation(internal.historyExample.smallStep, {
      value: "hello",
    });
    const h1 = step.meta.getHistory();
    console.log(`After step 1: ${h1.stepCount} steps, ${h1.size} bytes`);

    await step.runAction(internal.historyExample.mediumStep, {
      data: "x".repeat(100),
    });
    const h2 = step.meta.getHistory();
    console.log(`After step 2: ${h2.stepCount} steps, ${h2.size} bytes`);

    await step.runMutation(internal.historyExample.smallStep, {
      value: "world",
    });
    const h3 = step.meta.getHistory();
    console.log(`After step 3: ${h3.stepCount} steps, ${h3.size} bytes`);

    return {
      finalStepCount: h3.stepCount,
      finalSize: h3.size,
    };
  },
  returns: v.object({
    finalStepCount: v.number(),
    finalSize: v.number(),
  }),
});

export const smallStep = internalMutation({
  args: { value: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => {
    return `processed: ${args.value}`;
  },
});

export const mediumStep = internalAction({
  args: { data: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => {
    return `echoed ${args.data.length} chars`;
  },
});
