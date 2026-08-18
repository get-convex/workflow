import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { workflow } from "./example";

export const parentWorkflow = workflow
  .define({
    args: { prompt: v.string() },
    returns: v.number(),
  })
  .handler(async (step, args) => {
    console.log("Starting nested workflow");
    const length = await step.runWorkflow(internal.nestedWorkflow.child, {
      foo: args.prompt,
    });
    console.log("Length:", length);
    const stepResult = await step.runMutation(internal.nestedWorkflow.step, {
      foo: args.prompt,
    });
    console.log("Step result:", stepResult);
    return stepResult;
  });

export const child = workflow
  .define({
    args: { foo: v.string() },
    returns: v.number(),
  })
  .handler(async (_ctx, args) => {
    console.log("Starting child workflow");
    return args.foo.length;
  });

export const invalidReturn = workflow
  .define({
    args: {},
    returns: v.number(),
  })
  .handler(async () => {
    return "not a number" as unknown as number;
  });

export const step = internalMutation({
  args: { foo: v.string() },
  handler: async (_ctx, args) => {
    console.log("Starting step");
    return args.foo.length;
  },
});
