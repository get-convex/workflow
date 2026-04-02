import { v } from "convex/values";
import { defineWorkflow } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

export const parentWorkflow = defineWorkflow(components.workflow, {
  args: { prompt: v.string() },
  returns: v.number(),
}).bind(internal.nestedWorkflow.parent);

export const parent = parentWorkflow.handler(async (ctx, args) => {
  console.log("Starting confirmation workflow");
  const length = await ctx.runWorkflow(internal.nestedWorkflow.child, {
    foo: args.prompt,
  });
  console.log("Length:", length);
  const stepResult = await ctx.runMutation(internal.nestedWorkflow.step, {
    foo: args.prompt,
  });
  console.log("Step result:", stepResult);
  return stepResult;
});

export const childWorkflow = defineWorkflow(components.workflow, {
  args: { foo: v.string() },
}).bind(internal.nestedWorkflow.child);

export const child = childWorkflow.handler(async (_ctx, args) => {
  console.log("Starting nested workflow");
  return args.foo.length;
});

export const step = internalMutation({
  args: { foo: v.string() },
  handler: async (_ctx, args) => {
    console.log("Starting step");
    return args.foo.length;
  },
});
