/**
 * Reproduction for GitHub Issue #193:
 * step.runWorkflow return type resolves to `unknown` instead of FunctionReturnType<Workflow>
 *
 * @see https://github.com/get-convex/workflow/issues/193
 *
 * ============================================================================
 * FINDINGS
 * ============================================================================
 *
 * After investigation, the return types ARE correctly inferred when:
 * 1. Child workflows are in a SEPARATE file (see childWorkflows.ts)
 * 2. The `returns` validator is set on the child workflow
 *
 * The issue reported as #193 appears to manifest only when:
 * 1. Parent and child workflows are in the SAME file
 * 2. This causes circular type inference through `internal.*`
 * 3. TypeScript falls back to `any` due to the circular reference
 *
 * This is technically a different issue (circular references) than what was
 * originally reported (return type being `unknown`).
 *
 * ============================================================================
 * VERIFICATION
 * ============================================================================
 *
 * Run: npm run typecheck
 *
 * The parentWorkflow below should compile without errors, proving that
 * return types flow through correctly when child workflows are in a separate file.
 */

import { v } from "convex/values";
import type { Infer } from "convex/values";
import { workflow } from "./example";
import { internal } from "./_generated/api";
import { vChildResult } from "./childWorkflows";

type ChildResult = Infer<typeof vChildResult>;

/**
 * Parent workflow that calls child workflows from a separate file.
 * This demonstrates that return types ARE correctly inferred.
 */
export const parentWorkflow = workflow.define({
  args: { message: v.string() },
  handler: async (step, args) => {
    // Call child workflow from separate file
    const result = await step.runWorkflow(
      internal.childWorkflows.typedChildWorkflow,
      { input: args.message },
    );

    // Type assertion tests - these verify the types are correctly inferred:
    // If result were 'unknown', accessing .status would error
    // If result were 'any', the _wrongType assignment would NOT error
    const _status: "ok" | "error" = result.status;
    const _data: string | undefined = result.data;
    const _count: number = result.count;

    // This SHOULD fail - verifies result is not 'any'
    // @ts-expect-error - status is "ok" | "error", not number
    const _wrongType: number = result.status;

    console.log("Status:", result.status);
    console.log("Data:", result.data);
    console.log("Count:", result.count);

    // Call another child workflow - should return number
    const length = await step.runWorkflow(
      internal.childWorkflows.numberChildWorkflow,
      { value: args.message },
    );

    // Type test - this should compile because length is number
    const doubled: number = length * 2;

    // This SHOULD fail - verifies length is not 'any'
    // @ts-expect-error - length is number, not string
    const _wrongLength: string = length;

    console.log("Doubled:", doubled);
  },
});

/**
 * Alternative with explicit type assertion (workaround if needed)
 */
export const parentWorkflowWithWorkaround = workflow.define({
  args: { message: v.string() },
  handler: async (step, args) => {
    const result = (await step.runWorkflow(
      internal.childWorkflows.typedChildWorkflow,
      { input: args.message },
    )) as ChildResult;

    console.log("Status:", result.status);
  },
});
