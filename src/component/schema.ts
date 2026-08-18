import {
  vResultValidator,
  vRetryBehavior,
  vWorkIdValidator,
} from "@convex-dev/workpool";
import { deprecated, literals } from "convex-helpers/validators";
import { defineSchema, defineTable } from "convex/server";
import { type Infer, v, type Validator } from "convex/values";
import { logLevel } from "../logging.js";
import { vActionExecution } from "../execution.js";
import { workpoolOptions } from "../workpoolOptions.js";

export const vOnComplete = v.object({
  fnHandle: v.string(), // mutation
  context: v.optional(v.any()),
});

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
  execution: v.optional(vActionExecution),
  workpoolOptions: v.optional(workpoolOptions),
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

// v.id(table) is validated against the schema of whichever component the
// function is defined in, so ids are only usable inside this component. The
// variants taking v.string() are for validators that cross into the app, where
// these tables don't exist. See `journalDocument`.
const stepVariants = <
  WorkflowId extends Validator<string, "required", any>,
  EventId extends Validator<string, "required", any>,
>(
  vWorkflowsId: WorkflowId,
  vEventsId: EventId,
) =>
  v.union(
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
      workflowId: v.optional(vWorkflowsId),
      ...stepCommonFields,
    }),
    v.object({
      kind: v.literal("event"),
      ...stepCommonFields,
      eventId: v.optional(vEventsId),
      args: v.object({ eventId: v.optional(vEventsId) }),
    }),
    v.object({
      kind: v.literal("sleep"),
      workId: v.optional(vWorkIdValidator),
      ...stepCommonFields,
    }),
  );

export const step = stepVariants(v.id("workflows"), v.id("events"));
export type Step = Infer<typeof step>;

const journalObject = {
  workflowId: v.id("workflows"),
  stepNumber: v.number(),
  step,
  retry: v.optional(v.union(v.boolean(), vRetryBehavior)),
  schedulerOptions: v.optional(
    v.union(
      v.object({ runAt: v.optional(v.number()) }),
      v.object({ runAfter: v.optional(v.number()) }),
    ),
  ),
  timeRequired: v.optional(v.number()),
};

// The document shape as seen outside this component: the workflow mutation
// takes journal entries as args and returns them, and it's defined in the app,
// where `v.id("workflows")` / `v.id("events")` don't resolve. Ids are plain
// strings here for the same reason `_id` is.
export const journalDocument = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  ...journalObject,
  workflowId: v.string(),
  step: stepVariants(v.string(), v.string()),
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
  workflows: defineTable(workflowObject).index("name", ["name"]),
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
