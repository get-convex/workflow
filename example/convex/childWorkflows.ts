/**
 * Child workflows for testing runWorkflow return type inference.
 * These are in a separate file to avoid circular type references.
 */
import { v } from "convex/values";
import { workflow } from "./example";

// Return type validator
export const vChildResult = v.object({
  status: v.union(v.literal("ok"), v.literal("error")),
  data: v.optional(v.string()),
  count: v.number(),
});

/**
 * Child workflow with a `returns` validator.
 * The return type should be inferred by callers using `step.runWorkflow()`.
 */
export const typedChildWorkflow = workflow.define({
  args: { input: v.string() },
  returns: vChildResult,
  handler: async (_step, args) => {
    return {
      status: "ok" as const,
      data: args.input.toUpperCase(),
      count: args.input.length,
    };
  },
});

/**
 * Simple child workflow returning a number.
 */
export const numberChildWorkflow = workflow.define({
  args: { value: v.string() },
  returns: v.number(),
  handler: async (_step, args) => {
    return args.value.length;
  },
});
