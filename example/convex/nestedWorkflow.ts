import { v } from "convex/values";
import { workflow } from "./example";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

export const parentWorkflow = workflow.define({
  args: { prompt: v.string() },
  handler: async (ctx, args) => {
    console.log("Starting confirmation workflow");
    const length = await ctx.runWorkflow(
      internal.nestedWorkflow.childWorkflow,
      { foo: args.prompt },
    );
    console.log("Length:", length);
    const stepResult = await ctx.runMutation(internal.nestedWorkflow.step, {
      foo: args.prompt,
    });
    console.log("Step result:", stepResult);
  },
});

export const childWorkflow = workflow.define({
  args: { foo: v.string() },
  returns: v.number(),
  handler: async (_ctx, args) => {
    console.log("Starting nested workflow");
    return args.foo.length;
  },
});

export const step = internalMutation({
  args: { foo: v.string() },
  handler: async (_ctx, args) => {
    console.log("Starting step");
    return args.foo.length;
  },
});
