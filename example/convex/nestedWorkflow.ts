import { v } from "convex/values";
import { defineWorkflow } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

// Workflows

export const parentWorkflow = defineWorkflow(components.workflow, {
  args: { prompt: v.string() },
  returns: v.number(),
}).withHandlerRef(internal.nestedWorkflow.parent);

export const childWorkflow = defineWorkflow(components.workflow, {
  args: { foo: v.string() },
  returns: v.number(),
}).withHandlerRef(internal.nestedWorkflow.child);

// Implementations

export const parent = parentWorkflow.handler(async (step, args) => {
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

export const child = childWorkflow.handler(async (_step, args) => {
  console.log("Starting child workflow");
  return args.foo.length;
});

// Steps

export const step = internalMutation({
  args: { foo: v.string() },
  handler: async (_ctx, args) => {
    console.log("Starting step");
    return args.foo.length;
  },
});
