import {
  vResultValidator,
  type RunResult,
  vWorkIdValidator,
} from "@convex-dev/workpool";
import { defineSchema, defineTable } from "convex/server";
import { convexToJson, type Infer, v, type Value } from "convex/values";
import { logLevel } from "./logging.js";
import { deprecated, literals } from "convex-helpers/validators";

export function valueSize(value: Value): number {
  return JSON.stringify(convexToJson(value)).length;
}

export function resultSize(result: RunResult): number {
  let size = 0;
  size += result.kind.length;
  switch (result.kind) {
    case "success": {
      size += 8 + valueSize(result.returnValue);
      break;
    }
    case "failed": {
      size += result.error.length;
      break;
    }
    case "canceled": {
      break;
    }
  }
  return size;
}

export const vOnComplete = v.object({
  fnHandle: v.string(), // mutation
  context: v.optional(v.any()),
});
export type OnComplete = Infer<typeof vOnComplete>;

const workflowObject = {
  name: v.optional(v.string()),
  workflowHandle: v.string(),
  args: v.any(),
  onComplete: v.optional(vOnComplete),
  logLevel: deprecated,
  startedAt: deprecated,
  state: deprecated,
  // undefined until it's completed
  runResult: v.optional(vResultValidator),

  // Internal execution status, used to totally order mutations.
  generationNumber: v.number(),
};

export const workflowDocument = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  ...workflowObject,
});
export type Workflow = Infer<typeof workflowDocument>;

const stepCommonFields = {
  name: v.string(),
  inProgress: v.boolean(),
  argsSize: v.number(),
  args: v.any(),
  runResult: v.optional(vResultValidator),
  startedAt: v.number(),
  completedAt: v.optional(v.number()),
};

export const step = v.union(
  v.object({
    kind: v.optional(v.literal("function")),
    functionType: literals("query", "mutation", "action"),
    handle: v.string(),
    workId: v.optional(vWorkIdValidator),
    ...stepCommonFields,
  }),
  v.object({
    kind: v.literal("workflow"),
    handle: v.string(),
    workflowId: v.optional(v.id("workflows")),
    ...stepCommonFields,
  }),
  v.object({
    kind: v.literal("event"),
    ...stepCommonFields,
    eventId: v.optional(v.id("events")),
    args: v.object({ eventId: v.optional(v.id("events")) }),
  }),
);
export type Step = Infer<typeof step>;

function stepSize(step: Step): number {
  let size = 0;
  size += step.name.length;
  size += 1; // inProgress
  if (step.kind) size += step.kind.length;
  switch (step.kind) {
    case undefined:
    case "function":
      size += step.handle.length;
      size += step.functionType.length;
      size += step.workId?.length ?? 0;
      break;
    case "workflow":
      size += step.handle.length;
      size += step.workflowId?.length ?? 0;
      break;
    case "event":
      size += step.eventId?.length ?? 0;
      break;
  }
  size += 8 + step.argsSize;
  if (step.runResult) {
    size += resultSize(step.runResult);
  }
  size += 8; // startedAt
  size += 8; // completedAt
  return size;
}

const journalObject = {
  workflowId: v.id("workflows"),
  stepNumber: v.number(),
  step,
};

export function journalEntrySize(entry: JournalEntry): number {
  let size = 0;
  size += entry.workflowId.length;
  size += 8; // stepNumber
  size += stepSize(entry.step);
  size += entry._id.length;
  size += 8; // _creationTime
  return size;
}

export const journalDocument = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  ...journalObject,
});
export type JournalEntry = Infer<typeof journalDocument>;

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
  workflows: defineTable(workflowObject),
  steps: defineTable(journalObject)
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
