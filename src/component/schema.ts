import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

export const outcome = v.union(
  v.object({
    type: v.literal("success"),
    result: v.any(),
  }),
  v.object({
    type: v.literal("error"),
    error: v.string(),
  }),
);

const workflowObject = {
  startedAt: v.number(),
  workflowHandle: v.string(),
  args: v.any(),

  // User visible workflow status.
  state: v.union(
    v.object({
      type: v.literal("running"),
    }),
    v.object({
      type: v.literal("completed"),
      completedAt: v.number(),
      outcome,
    }),
  ),

  // Internal execution status, used to totally order mutations.
  generationNumber: v.number(),
};

export const workflowDocument = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  ...workflowObject,
});
export type Workflow = Infer<typeof workflowDocument>;

export const STEP_TYPES = ["function", "sleep"] as const;

export const step = v.union(
  v.object({
    type: v.literal("function"),
    inProgress: v.boolean(),

    functionType: v.union(
      v.literal("query"),
      v.literal("mutation"),
      v.literal("action"),
    ),
    handle: v.string(),
    args: v.any(),
    outcome: v.optional(outcome),

    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  }),
  v.object({
    type: v.literal("sleep"),
    inProgress: v.boolean(),

    durationMs: v.number(),
    deadline: v.number(),
  }),
);
export type Step = Infer<typeof step>;

const journalObject = {
  workflowId: v.string(),
  stepNumber: v.number(),
  step,
};

export const journalDocument = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  ...journalObject,
});
export type JournalEntry = Infer<typeof journalDocument>;

export default defineSchema({
  workflows: defineTable(workflowObject),

  // use microtask queue to check when it's "empty"
  // capture logs? only log new ones?

  workflowJournal: defineTable(journalObject)
    .index("workflow", ["workflowId", "stepNumber"])
    .index("inProgress", ["step.type", "step.inProgress", "workflowId"]),
});
