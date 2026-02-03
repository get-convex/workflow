/**
 * Nested Workflow Example
 *
 * Demonstrates calling child workflows from a parent workflow using
 * `ctx.runWorkflow()`. Return types are properly inferred from the
 * child workflow's `returns` validator.
 *
 * RECOMMENDED PATTERN: For best type inference, define child workflows in a
 * separate file (see childWorkflows.ts). This avoids circular type references
 * that can occur when parent and child workflows are in the same file.
 */
import { v } from "convex/values";
import { workflow } from "./example";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

// =============================================================================
// Simple Child Workflow (same file is OK for simple cases)
// =============================================================================

/**
 * Simple child workflow returning a number.
 */
export const childWorkflow = workflow.define({
  args: { foo: v.string() },
  returns: v.number(),
  handler: async (_ctx, args) => {
    console.log("Starting nested workflow");
    return args.foo.length;
  },
});

// =============================================================================
// Parent Workflow
// =============================================================================

/**
 * Parent workflow demonstrating nested workflow calls.
 *
 * This example calls child workflows from:
 * 1. The same file (childWorkflow above) - works for simple cases
 * 2. A separate file (childWorkflows.ts) - recommended for complex types
 *
 * Return types are properly inferred from the child workflow's `returns` validator.
 */
export const parentWorkflow = workflow.define({
  args: { prompt: v.string() },
  handler: async (ctx, args) => {
    console.log("Starting parent workflow with prompt:", args.prompt);

    // Call child workflow from same file - return type is number
    const length = await ctx.runWorkflow(
      internal.nestedWorkflow.childWorkflow,
      { foo: args.prompt },
    );
    console.log("Length:", length);

    // Call child workflows from separate file (childWorkflows.ts)
    // This is the recommended pattern for complex return types
    const textAnalysis = await ctx.runWorkflow(
      internal.childWorkflows.analyzeTextWorkflow,
      { text: args.prompt },
    );
    // TypeScript knows textAnalysis has: length, wordCount, uppercase
    console.log(`Text analysis: ${textAnalysis.wordCount} words, ${textAnalysis.length} chars`);
    console.log(`Uppercase: ${textAnalysis.uppercase}`);

    const processingResult = await ctx.runWorkflow(
      internal.childWorkflows.processItemsWorkflow,
      { items: args.prompt.split(" "), failOnEmpty: true },
    );
    // TypeScript knows processingResult has: status, processedItems, message
    console.log(`Processing: ${processingResult.status} - ${processingResult.message}`);

    // Also demonstrate mutation call
    const stepResult = await ctx.runMutation(internal.nestedWorkflow.step, {
      foo: args.prompt,
    });
    console.log("Step result:", stepResult);
  },
});

// =============================================================================
// Helper Mutation
// =============================================================================

export const step = internalMutation({
  args: { foo: v.string() },
  returns: v.number(),
  handler: async (_ctx, args) => {
    console.log("Running step mutation");
    return args.foo.length;
  },
});
