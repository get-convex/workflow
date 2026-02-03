/**
 * Child workflows for demonstrating proper runWorkflow return type inference.
 *
 * IMPORTANT: To avoid circular type inference issues, child workflows should
 * be defined in a separate file from parent workflows that call them.
 *
 * When parent and child workflows are in the same file, TypeScript may
 * encounter circular dependencies through `internal.*` references, causing
 * type inference to fall back to `any`.
 */
import { v } from "convex/values";
import { workflow } from "./example";

// =============================================================================
// Return type validators
// =============================================================================

/**
 * Validator for text analysis results.
 * Export this so parent workflows can reference the type.
 */
export const vTextAnalysis = v.object({
  length: v.number(),
  wordCount: v.number(),
  uppercase: v.string(),
});

/**
 * Validator for processing status results.
 */
export const vProcessingResult = v.object({
  status: v.union(v.literal("success"), v.literal("partial"), v.literal("failed")),
  processedItems: v.number(),
  message: v.string(),
});

// =============================================================================
// Child Workflows
// =============================================================================

/**
 * Child workflow that analyzes text input.
 * The `returns` validator ensures type safety for callers.
 */
export const analyzeTextWorkflow = workflow.define({
  args: { text: v.string() },
  returns: vTextAnalysis,
  handler: async (_ctx, args) => {
    console.log("Analyzing text:", args.text.substring(0, 50));
    return {
      length: args.text.length,
      wordCount: args.text.split(/\s+/).filter(Boolean).length,
      uppercase: args.text.toUpperCase(),
    };
  },
});

/**
 * Child workflow that processes multiple items.
 * Demonstrates a more complex return type with union literals.
 */
export const processItemsWorkflow = workflow.define({
  args: {
    items: v.array(v.string()),
    failOnEmpty: v.optional(v.boolean()),
  },
  returns: vProcessingResult,
  handler: async (_ctx, args) => {
    console.log(`Processing ${args.items.length} items`);

    if (args.items.length === 0 && args.failOnEmpty) {
      return {
        status: "failed" as const,
        processedItems: 0,
        message: "No items to process",
      };
    }

    const processed = args.items.length;
    return {
      status: processed > 0 ? ("success" as const) : ("partial" as const),
      processedItems: processed,
      message: `Successfully processed ${processed} items`,
    };
  },
});

/**
 * Simple child workflow returning a number.
 */
export const computeLengthWorkflow = workflow.define({
  args: { value: v.string() },
  returns: v.number(),
  handler: async (_ctx, args) => {
    return args.value.length;
  },
});
