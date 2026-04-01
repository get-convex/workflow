import {
  type EventId,
  vEventId,
  vWorkflowId,
  defineWorkflow,
} from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const signalDef = defineWorkflow(components.workflow, {
  args: {},
}).bind(internal.passingSignals.signalBasedWorkflow);

export const signalBasedWorkflow = signalDef.handler(async (ctx) => {
  console.log("Starting signal based  workflow");
  for (let i = 0; i < 3; i++) {
    const signalId = await ctx.runMutation(
      internal.passingSignals.createSignal,
      { workflowId: ctx.workflowId },
    );
    await ctx.awaitEvent({ id: signalId });
    console.log("Signal received", signalId);
  }
  console.log("All signals received");
});

export const createSignal = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args): Promise<EventId> => {
    const eventId = await signalDef.createEvent(ctx, {
      name: "signal",
      workflowId: args.workflowId,
    });
    // You would normally store this eventId somewhere to be able to send the
    // signal later.
    await ctx.scheduler.runAfter(1000, internal.passingSignals.sendSignal, {
      eventId,
    });
    return eventId;
  },
});

export const sendSignal = internalMutation({
  args: { eventId: vEventId("signal") },
  handler: async (ctx, args) => {
    await signalDef.sendEvent(ctx, { id: args.eventId });
  },
});
