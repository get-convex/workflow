import type { RunResult } from "@convex-dev/workpool";
import { v, type VString } from "convex/values";

export type WorkflowId = string & { __isWorkflowId: true };
export const vWorkflowId = v.string() as VString<WorkflowId>;

export type OnCompleteArgs = {
  /**
   * The ID of the work that completed.
   */
  workflowId: WorkflowId;
  /**
   * The context object passed when enqueuing the work.
   * Useful for passing data from the enqueue site to the onComplete site.
   */
  context: unknown;
  /**
   * The result of the run that completed.
   */
  result: RunResult;
};
