import { defineSchema, defineTable } from "convex/server";
import { convexToJson, Infer, v, Value } from "convex/values";

export function valueSize(value: Value): number {
  return JSON.stringify(convexToJson(value)).length;
}

export const outcome = v.union(
  v.object({
    type: v.literal("success"),
    resultSize: v.number(),
    result: v.any(),
  }),
  v.object({
    type: v.literal("error"),
    error: v.string(),
  }),
);
export type Outcome = Infer<typeof outcome>;

function outcomeSize(outcome: Outcome): number {
  let size = 0;
  size += outcome.type.length;
  switch (outcome.type) {
    case "success": {
      size += 8 + outcome.resultSize;
      break;
    }
    case "error": {
      size += outcome.error.length;
      break;
    }
  }
  return size;
}

export const logLevel = v.union(
  v.literal("DEBUG"),
  v.literal("INFO"),
  v.literal("WARN"),
  v.literal("ERROR"),
);
export type LogLevel = Infer<typeof logLevel>;

const workflowObject = {
  startedAt: v.number(),
  logLevel,

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
    v.object({
      type: v.literal("canceled"),
      canceledAt: v.number(),
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
      v.object({ type: v.literal("query") }),
      v.object({ type: v.literal("mutation") }),
      v.object({
        type: v.literal("action"),
        // Actions are fallible, so we need to schedule a recovery mutation.
        // This gets set when we start executing the action.
        recoveryId: v.optional(v.string()),
      }),
    ),
    handle: v.string(),
    argsSize: v.number(),
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

function stepSize(step: Step): number {
  let size = 0;
  size += step.type.length;
  size += 1; // inProgress
  switch (step.type) {
    case "function": {
      size += step.functionType.type.length;
      if (step.functionType.type === "action") {
        if (step.functionType.recoveryId) {
          size += step.functionType.recoveryId.length;
        }
      }
      size += step.handle.length;
      size += 8 + step.argsSize;
      if (step.outcome) {
        size += outcomeSize(step.outcome);
      }
      size += 8; // startedAt
      size += 8; // completedAt
    }
    case "sleep": {
      size += 8; // durationMs
      size += 8; // deadline
    }
  }
  return size;
}

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

export function journalEntrySize(entry: JournalEntry): number {
  let size = 0;
  size += entry._id.length;
  size += 8; // _creationTime
  size += entry.workflowId.length;
  size += 8; // stepNumber
  size += stepSize(entry.step);
  return size;
}

export default defineSchema({
  workflows: defineTable(workflowObject),
  workflowJournal: defineTable(journalObject)
    .index("workflow", ["workflowId", "stepNumber"])
    .index("inProgress", ["step.type", "step.inProgress", "workflowId"]),
});
