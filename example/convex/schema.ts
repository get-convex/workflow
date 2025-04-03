import { defineTable, defineSchema } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  flows: defineTable({
    in: v.string(),
    workflowId: v.string(),
    out: v.string(),
  }),
});
