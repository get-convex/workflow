import { defineTable, defineSchema } from "convex/server";
import { v } from "convex/values";
import { vWorkflowId } from "@convex-dev/workflow";

export default defineSchema({
  flows: defineTable({
    in: v.string(),
    workflowId: vWorkflowId,
    out: v.any(),
  }).index("workflowId", ["workflowId"]),
  workflowComparisons: defineTable({
    traditionalWorkflowId: vWorkflowId,
    actionWorkflowId: vWorkflowId,
    stepCount: v.number(),
    startedAt: v.number(),
  }),
});
