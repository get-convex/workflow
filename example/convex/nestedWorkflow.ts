import { v } from "convex/values";
import { defineWorkflow } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const parentDef = defineWorkflow(components.workflow, {
  args: { prompt: v.string() },
  returns: v.number(),
}).bind(internal.nestedWorkflow.parentWorkflow);

export const parentWorkflow = parentDef.handler(async (ctx, args) => {
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
  return stepResult;
});

const childDef = defineWorkflow(components.workflow, {
  args: { foo: v.string() },
}).bind(internal.nestedWorkflow.childWorkflow);

export const childWorkflow = childDef.handler(async (_ctx, args) => {
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
