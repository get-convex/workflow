/**
 * Reproduction for GitHub Issue #193:
 * step.runWorkflow return type resolves to `unknown` instead of FunctionReturnType<Workflow>
 *
 * @see https://github.com/get-convex/workflow/issues/193
 *
 * ============================================================================
 * HOW TO VERIFY THE TYPE ISSUE
 * ============================================================================
 *
 * Run: npm run typecheck
 *
 * Expected: No type errors (return type should infer from returns validator)
 * Actual: Circular reference / implicit any errors due to type mismatch
 *
 * ============================================================================
 * ROOT CAUSE DIAGNOSIS
 * ============================================================================
 *
 * The issue stems from a type mismatch between the `WorkflowCtx` interface and
 * the `createWorkflowCtx` function's actual return type.
 *
 * **WorkflowCtx interface (correct):**
 * ```typescript
 * runWorkflow<Workflow extends FunctionReference<"mutation", "internal">>(
 *   workflow: Workflow,
 *   args: FunctionArgs<Workflow>["args"],
 *   opts?: RunOptions,
 * ): Promise<FunctionReturnType<Workflow>>;  // ✅ Returns typed result
 * ```
 *
 * **createWorkflowCtx implementation (problematic):**
 * The function uses `satisfies WorkflowCtx` which only verifies compatibility,
 * but TypeScript still infers the return type from the implementation.
 *
 * In `dist/client/workflowContext.d.ts`:
 * ```typescript
 * export declare function createWorkflowCtx(...): {
 *   runWorkflow: <Workflow>(...) => Promise<unknown>;  // ❌ Returns unknown
 *   // ...
 * };
 * ```
 *
 * The `run()` helper function returns `Promise<unknown>`, and since `satisfies`
 * doesn't change type inference, the compiled declaration file exposes
 * `Promise<unknown>` instead of `Promise<FunctionReturnType<Workflow>>`.
 *
 * **Secondary Issue: Circular Type Inference**
 * When a parent workflow references a child workflow via `internal.*.child`,
 * and both are in the same file, TypeScript encounters circular dependencies.
 * The parent workflow is exported to `internal.*` while also referencing
 * `internal.*`, causing TypeScript to fall back to `any` types.
 *
 * ============================================================================
 * RECOMMENDED FIX
 * ============================================================================
 *
 * Change `createWorkflowCtx` to explicitly return `WorkflowCtx`:
 *
 * ```typescript
 * // Before (src/client/workflowContext.ts):
 * export function createWorkflowCtx(
 *   workflowId: WorkflowId,
 *   sender: BaseChannel<StepRequest>,
 * ) {
 *   return { ... } satisfies WorkflowCtx;
 * }
 *
 * // After:
 * export function createWorkflowCtx(
 *   workflowId: WorkflowId,
 *   sender: BaseChannel<StepRequest>,
 * ): WorkflowCtx {
 *   return { ... } as WorkflowCtx;
 * }
 * ```
 *
 * This ensures the declaration file uses the `WorkflowCtx` interface types
 * instead of inferring `Promise<unknown>` from the implementation.
 *
 * ============================================================================
 */

import { v } from "convex/values";
import type { Infer } from "convex/values";
import { workflow } from "./example";
import { internal } from "./_generated/api";

// =============================================================================
// Define return validator for child workflow
// =============================================================================
export const vChildResult = v.object({
  status: v.union(v.literal("ok"), v.literal("error")),
  data: v.optional(v.string()),
  count: v.number(),
});
type ChildResult = Infer<typeof vChildResult>;

// =============================================================================
// Child workflow WITH returns validator
// =============================================================================
export const childWorkflowWithReturns = workflow.define({
  args: { input: v.string() },
  returns: vChildResult, // ✅ Has returns validator
  handler: async (_step, args): Promise<ChildResult> => {
    // Simulated processing
    return {
      status: "ok",
      data: args.input.toUpperCase(),
      count: args.input.length,
    };
  },
});

// =============================================================================
// Parent workflow - demonstrates the type issue
// =============================================================================
/**
 * This workflow demonstrates the type issue. The `result` variable should
 * be typed as `ChildResult` (from the child's `returns` validator), but
 * instead it resolves to `unknown` or `any` due to the issues described above.
 *
 * TypeScript errors you may see:
 * - TS7022: 'parentWorkflowRepro' implicitly has type 'any' (circular reference)
 * - TS7023: 'handler' implicitly has return type 'any'
 * - TS18046: 'result' is of type 'unknown'
 */
export const parentWorkflowRepro = workflow.define({
  args: { message: v.string() },
  handler: async (step, args) => {
    // Call child workflow that has a `returns` validator
    const result = await step.runWorkflow(
      internal.runWorkflowTypeRepro.childWorkflowWithReturns,
      { input: args.message },
    );

    // ❌ TYPE ERROR: 'result' is of type 'unknown' or has circular ref issues
    // Even though childWorkflowWithReturns has `returns: vChildResult`,
    // TypeScript cannot infer the return type due to the issues described above.
    console.log("Status:", result.status);
    console.log("Data:", result.data);
    console.log("Count:", result.count);

    return {
      processedMessage: `Processed: ${args.message}`,
      // ❌ Cannot use result.status here without type assertion
      childStatus: result.status,
    };
  },
});

// =============================================================================
// Workaround: Explicit type assertion
// =============================================================================
export const parentWorkflowWithWorkaround = workflow.define({
  args: { message: v.string() },
  handler: async (step, args) => {
    // Workaround: Cast the result to the expected type
    const result = (await step.runWorkflow(
      internal.runWorkflowTypeRepro.childWorkflowWithReturns,
      { input: args.message },
    )) as ChildResult;

    // ✅ This works with the type assertion
    console.log("Status:", result.status);
    console.log("Data:", result.data);
    console.log("Count:", result.count);

    return {
      processedMessage: `Processed: ${args.message}`,
      childStatus: result.status,
    };
  },
});
