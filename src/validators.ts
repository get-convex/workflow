/**
 * Validators for the documents that both the component and the app handle.
 *
 * The workflow mutation is registered in the *app* (see
 * `client/workflowMutation.ts`) but takes and returns the component's own
 * `workflows` / `steps` documents, so these definitions have to live somewhere
 * the client can import without pulling in the component's schema.
 *
 * `v.id(table)` resolves against the schema of whichever component a function
 * is defined in, so the app can't validate the component's ids: it has no
 * `workflows` or `events` table. The documents exported here therefore use
 * plain strings for ids, the same way they already do for `_id`.
 * `component/schema.ts` narrows them back to real ids for its own tables.
 */
import {
  vResultValidator,
  vRetryBehavior,
  vWorkIdValidator,
} from "@convex-dev/workpool";
import { deprecated, literals } from "convex-helpers/validators";
import { type Infer, v, type Validator } from "convex/values";
import { vActionExecution } from "./execution.js";
import { workpoolOptions } from "./workpoolOptions.js";

/**
 * An id field: `v.id(table)` for the component's own tables, `v.string()` for
 * the same document once it has crossed into the app.
 */
type VId = Validator<string, "required", any>;

export const vOnComplete = v.object({
  fnHandle: v.string(), // mutation
  context: v.optional(v.any()),
});

export const vWorkflowFields = {
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
  ...vWorkflowFields,
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

export const vStepFields = <WorkflowsId extends VId, EventsId extends VId>(
  vWorkflowsId: WorkflowsId,
  vEventsId: EventsId,
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

export const vJournalFields = <WorkflowsId extends VId, EventsId extends VId>(
  vWorkflowsId: WorkflowsId,
  vEventsId: EventsId,
) => ({
  workflowId: vWorkflowsId,
  stepNumber: v.number(),
  step: vStepFields(vWorkflowsId, vEventsId),
  retry: v.optional(v.union(v.boolean(), vRetryBehavior)),
  schedulerOptions: v.optional(
    v.union(
      v.object({ runAt: v.optional(v.number()) }),
      v.object({ runAfter: v.optional(v.number()) }),
    ),
  ),
  timeRequired: v.optional(v.number()),
});

export const vStep = vStepFields(v.string(), v.string());
export type Step = Infer<typeof vStep>;

export const journalDocument = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  ...vJournalFields(v.string(), v.string()),
});
export type JournalEntry = Infer<typeof journalDocument>;
