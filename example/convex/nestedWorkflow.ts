import { v } from "convex/values";
import { workflow } from "./example";
import { internal } from "./_generated/api";

export const parentWorkflow = workflow.define({
  args: { prompt: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    console.log("Starting confirmation workflow");
    const length = await ctx.runWorkflow(
      internal.nestedWorkflow.nestedWorkflow,
      { foo: args.prompt },
    );
    console.log("Length:", length);
  },
});

export const nestedWorkflow = workflow.define({
  args: { foo: v.string() },
  returns: v.number(),
  handler: async (_, args) => {
    console.log("Starting nested workflow");
    return args.foo.length;
  },
});
