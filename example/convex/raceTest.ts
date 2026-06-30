import {
  createEvent,
  defineEvent,
  vEventId,
  vWorkflowId,
  WorkflowManager,
  type EventId,
} from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

export const workflow = new WorkflowManager(components.workflow);

export const basicRace = workflow.define({
  args: {},
  returns: v.string(),
  handler: async (step): Promise<string> => {
    const result = await step.raceEvents([
      { name: "eventA" },
      { name: "eventB" },
    ]);
    return result.name;
  },
});

export const raceWithExtraStep = workflow.define({
  args: {},
  returns: v.string(),
  handler: async (step): Promise<string> => {
    await step.awaitEvent({ name: "block" });
    const result = await step.raceEvents([
      { name: "eventA" },
      { name: "eventB" },
    ]);
    return result.name;
  },
});

export const sendEventA = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      name: "eventA",
      workflowId: args.workflowId,
    });
  },
});

export const sendEventB = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      name: "eventB",
      workflowId: args.workflowId,
    });
  },
});

export const sendBlock = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      name: "block",
      workflowId: args.workflowId,
    });
  },
});

export const raceWithTimeout = workflow.define({
  args: { timeout: v.number() },
  returns: v.string(),
  handler: async (step, args): Promise<string> => {
    const result = await step.raceEvents(
      [{ name: "eventA" }, { name: "eventB" }],
      {
        timeout: args.timeout,
      },
    );
    return result.name;
  },
});

export const raceWithFailureFail = workflow.define({
  args: {},
  returns: v.string(),
  handler: async (step): Promise<string> => {
    const result = await step.raceEvents(
      [{ name: "eventA" }, { name: "eventB" }],
      {
        failure: "fail",
      },
    );
    return result.name;
  },
});

export const raceWithFailureRetry = workflow.define({
  args: {},
  returns: v.string(),
  handler: async (step): Promise<string> => {
    const result = await step.raceEvents(
      [{ name: "eventA" }, { name: "eventB" }],
      {
        failure: "retry",
      },
    );
    return result.name;
  },
});

export const raceWithFailureDiscard = workflow.define({
  args: {},
  returns: v.string(),
  handler: async (step): Promise<string> => {
    const result = await step.raceEvents(
      [{ name: "eventA" }, { name: "eventB" }],
      {
        failure: "discard",
      },
    );
    return result.name;
  },
});

export const sendFailedEventA = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      name: "eventA",
      workflowId: args.workflowId,
      error: "intentional failure",
    });
  },
});

export const sendFailedEventB = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      name: "eventB",
      workflowId: args.workflowId,
      error: "intentional failure",
    });
  },
});

export const raceWithValidators = workflow.define({
  args: {},
  returns: v.any(),
  handler: async (step) => {
    const approvalEvent = defineEvent({
      name: "approval",
      validator: v.object({ proposal: v.string() }),
    });
    const rejectionEvent = defineEvent({
      name: "rejection",
      validator: v.object({ reason: v.string() }),
    });
    const result = await step.raceEvents([approvalEvent, rejectionEvent]);
    return result;
  },
});

export const sendApproval = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      name: "approval",
      workflowId: args.workflowId,
      value: { proposal: "A" },
    });
  },
});

export const sendRejection = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      name: "rejection",
      workflowId: args.workflowId,
      value: { reason: "not needed" },
    });
  },
});

export const raceGoStop = workflow.define({
  args: {},
  returns: v.string(),
  handler: async (step): Promise<string> => {
    const result = await step.raceEvents([{ name: "go" }, { name: "stop" }]);
    return result.name;
  },
});

// Race over events referenced by id (pre-created with `createEvent`), the same
// way `awaitEvent` accepts an id.
export const raceById = workflow.define({
  args: {},
  returns: v.object({ id: vEventId(), name: v.string() }),
  handler: async (step): Promise<{ id: EventId; name: string }> => {
    const idA = await step.runMutation(internal.raceTest.createRaceEvent, {
      workflowId: step.workflowId,
      name: "byIdA",
    });
    const idB = await step.runMutation(internal.raceTest.createRaceEvent, {
      workflowId: step.workflowId,
      name: "byIdB",
    });
    const result = await step.raceEvents([{ id: idA }, { id: idB }]);
    return { id: result.id, name: result.name };
  },
});

export const createRaceEvent = internalMutation({
  args: { workflowId: vWorkflowId, name: v.string() },
  handler: async (ctx, args): Promise<EventId> =>
    createEvent(ctx, components.workflow, {
      name: args.name,
      workflowId: args.workflowId,
    }),
});

export const sendNamed = internalMutation({
  args: { workflowId: vWorkflowId, name: v.string() },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      name: args.name,
      workflowId: args.workflowId,
    });
  },
});

export const sendGo = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      name: "go",
      workflowId: args.workflowId,
    });
  },
});

export const sendStop = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      name: "stop",
      workflowId: args.workflowId,
    });
  },
});
