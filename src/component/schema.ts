import { vResultValidator, vWorkIdValidator } from "@convex-dev/workpool";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { logLevel } from "../logging.js";
import { vJournalFields, vWorkflowFields } from "../validators.js";

// The `steps` shape as stored here, with real ids. `../validators.js` has the
// same shape with string ids, for the app side of the component boundary.
const journalFields = vJournalFields(v.id("workflows"), v.id("events"));

/** The step union with this component's ids, for its own function args. */
export const vStepWithIds = journalFields.step;

export const event = {
  workflowId: v.id("workflows"),
  name: v.string(),
  state: v.union(
    v.object({
      kind: v.literal("created"),
    }),
    v.object({
      kind: v.literal("sent"),
      result: vResultValidator,
      sentAt: v.number(),
    }),
    v.object({
      kind: v.literal("waiting"),
      waitingAt: v.number(),
      stepId: v.id("steps"),
    }),
    v.object({
      kind: v.literal("consumed"),
      waitingAt: v.number(),
      sentAt: v.number(),
      consumedAt: v.number(),
      stepId: v.id("steps"),
    }),
  ),
};

export default defineSchema({
  config: defineTable({
    logLevel: v.optional(logLevel),
    maxParallelism: v.optional(v.number()),
  }),
  workflows: defineTable(vWorkflowFields).index("name", ["name"]),
  steps: defineTable(journalFields)
    .index("workflow", ["workflowId", "stepNumber"])
    .index("inProgress", ["step.inProgress", "workflowId"]),
  events: defineTable(event).index("workflowId_state", [
    "workflowId",
    "state.kind",
  ]),
  onCompleteFailures: defineTable(
    v.union(
      v.object({
        workId: v.optional(vWorkIdValidator),
        workflowId: v.optional(v.string()),
        result: vResultValidator,
        context: v.any(),
      }),
      v.object({
        workflowId: v.id("workflows"),
        generationNumber: v.number(),
        runResult: vResultValidator,
        error: v.string(),
      }),
    ),
  ),
});
