import { defineTable, defineSchema } from "convex/server";
import { v } from "convex/values";
import { vWorkflowId } from "@convex-dev/workflow";

export default defineSchema({
  flows: defineTable({
    in: v.string(),
    workflowId: vWorkflowId,
    out: v.any(),
  }).index("workflowId", ["workflowId"]),
  llmSimulations: defineTable({
    mode: v.union(v.literal("regular"), v.literal("batched")),
    topic: v.string(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    result: v.optional(v.string()),
  }),
});
