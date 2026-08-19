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
  workflowHarnessCommits: defineTable({
    runId: v.string(),
    operationId: v.string(),
    kind: v.union(v.literal("mutation"), v.literal("action")),
    value: v.string(),
  }).index("by_runId_and_operationId", ["runId", "operationId"]),
  workflowHarnessActionAttempts: defineTable({
    runId: v.string(),
    operationId: v.string(),
    attempts: v.number(),
  }).index("by_runId_and_operationId", ["runId", "operationId"]),
});
